// worker.js — Archive.FLO
// Cloudflare Worker: Discord interactions + REST API + serves dashboard

import { verifyKey } from 'discord-interactions';

// ─── COMMANDS ────────────────────────────────────────────────────────────────

const COMMANDS = [
  {
    name: 'log-channel',
    description: 'Scrape and archive all messages in this channel',
    options: [],
  },
  {
    name: 'log-user',
    description: 'Scrape and archive all visible messages from a user across every channel',
    options: [
      {
        name: 'user',
        type: 6, // USER
        description: 'The user to archive',
        required: true,
      },
    ],
  },
  {
    name: 'archive-status',
    description: 'Show the archive status for this channel or a user',
    options: [
      {
        name: 'user',
        type: 6,
        description: 'Check status for a specific user (optional)',
        required: false,
      },
    ],
  },
];

// ─── DISCORD HELPERS ─────────────────────────────────────────────────────────

async function discordRequest(env, path, opts = {}) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...opts,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }
  return res.json();
}

// Fetch ALL messages from a channel, paginating backwards from cursor
async function fetchAllMessages(env, channelId, afterId = null) {
  const messages = [];
  let before = null;
  let keepGoing = true;

  // If we have a cursor (afterId), we fetch forwards from there
  // Discord doesn't support "after + paginate" easily so we fetch all and filter
  while (keepGoing) {
    const qs = before ? `?before=${before}&limit=100` : '?limit=100';
    let batch;
    try {
      batch = await discordRequest(env, `/channels/${channelId}/messages${qs}`);
    } catch (e) {
      break;
    }
    if (!batch.length) break;

    for (const msg of batch) {
      // Skip messages we've already logged (cursor check)
      if (afterId && BigInt(msg.id) <= BigInt(afterId)) {
        keepGoing = false;
        break;
      }
      messages.push(msg);
    }

    if (batch.length < 100) break;
    before = batch[batch.length - 1].id;

    // Rate limit safety
    await sleep(300);
  }

  return messages;
}

// Get all text channels the bot can see in a guild
async function fetchGuildChannels(env, guildId) {
  const channels = await discordRequest(env, `/guilds/${guildId}/channels`);
  return channels.filter(c => c.type === 0 || c.type === 5); // GUILD_TEXT + GUILD_NEWS
}

// Fetch reactions for a message (who reacted with what)
async function fetchReactions(env, channelId, messageId, emoji) {
  try {
    const users = await discordRequest(env, `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`);
    return users.map(u => ({ userId: u.id, username: u.username }));
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── DB HELPERS ──────────────────────────────────────────────────────────────

async function saveMessages(env, messages, guildId, channelId, channelName) {
  if (!messages.length) return 0;
  let saved = 0;

  for (const msg of messages) {
    // Skip system messages, empty non-attachment messages
    if (!msg.content && !msg.attachments?.length && !msg.embeds?.length) continue;

    // Reactions: [{emoji, count, users:[{userId,username}]}]
    const reactions = [];
    if (msg.reactions?.length) {
      for (const r of msg.reactions) {
        const emojiStr = r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name;
        const users = await fetchReactions(env, channelId, msg.id, emojiStr);
        reactions.push({ emoji: emojiStr, count: r.count, users });
        await sleep(150);
      }
    }

    // Attachments: images + files
    const attachments = (msg.attachments || []).map(a => ({
      id: a.id,
      url: a.url,
      filename: a.filename,
      contentType: a.content_type || '',
      width: a.width || null,
      height: a.height || null,
    }));

    const ts = new Date(msg.timestamp).toISOString();

    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO messages (
          message_id, guild_id, channel_id, channel_name,
          user_id, username, display_name,
          content, attachments, reactions,
          created_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).bind(
        msg.id,
        guildId,
        channelId,
        channelName,
        msg.author.id,
        msg.author.username,
        msg.member?.nick || msg.author.global_name || msg.author.username,
        msg.content || '',
        JSON.stringify(attachments),
        JSON.stringify(reactions),
        ts,
      ).run();
      saved++;
    } catch (e) {
      console.error('DB insert error:', e.message);
    }
  }

  return saved;
}

// ─── SCRAPE JOBS ─────────────────────────────────────────────────────────────

async function scrapeChannel(env, guildId, channelId, channelName, followupUrl) {
  try {
    // Get cursor
    const cursorRow = await env.DB.prepare(
      'SELECT last_message_id FROM channel_cursors WHERE channel_id = ?'
    ).bind(channelId).first();
    const cursor = cursorRow?.last_message_id || null;

    await editFollowup(followupUrl, `⏳ Scraping **#${channelName}**... (this may take a while)`);

    const messages = await fetchAllMessages(env, channelId, cursor);

    if (!messages.length) {
      await editFollowup(followupUrl, `✅ **#${channelName}** is already up to date. No new messages.`);
      return;
    }

    const saved = await saveMessages(env, messages, guildId, channelId, channelName);

    // Update cursor to newest message
    const newestId = messages[0].id; // Discord returns newest first
    await env.DB.prepare(`
      INSERT OR REPLACE INTO channel_cursors (channel_id, guild_id, channel_name, last_message_id, last_scraped)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).bind(channelId, guildId, channelName, newestId).run();

    await editFollowup(followupUrl,
      `✅ **#${channelName}** archived.\n` +
      `> **${saved}** new messages logged\n` +
      `> Cursor updated — re-running this command will only fetch new messages.`
    );
  } catch (e) {
    await editFollowup(followupUrl, `❌ Error scraping **#${channelName}**: ${e.message}`);
  }
}

async function scrapeUser(env, guildId, userId, username, followupUrl) {
  try {
    await editFollowup(followupUrl, `⏳ Fetching all channels for **${username}**...`);

    const channels = await fetchGuildChannels(env, guildId);
    let totalSaved = 0;
    let channelsDone = 0;

    for (const ch of channels) {
      try {
        // Get cursor for this channel (reuse same cursor table — channel-level)
        // For user scrapes we don't use cursors (always full scrape filtered by user)
        // but we DO check what's already in the DB to avoid re-inserting
        const messages = await fetchAllMessages(env, ch.id, null);
        const userMessages = messages.filter(m => m.author.id === userId);

        if (userMessages.length) {
          const saved = await saveMessages(env, userMessages, guildId, ch.id, ch.name);
          totalSaved += saved;
        }

        channelsDone++;
        if (channelsDone % 5 === 0) {
          await editFollowup(followupUrl,
            `⏳ Scanning **${username}** — ${channelsDone}/${channels.length} channels done, ${totalSaved} messages so far...`
          );
        }

        await sleep(500);
      } catch {
        // Can't read this channel, skip
      }
    }

    // Store user record
    await env.DB.prepare(`
      INSERT OR REPLACE INTO user_scrapes (user_id, guild_id, username, last_scraped, total_messages)
      VALUES (?, ?, ?, datetime('now'), (SELECT COUNT(*) FROM messages WHERE user_id = ? AND guild_id = ?))
    `).bind(userId, guildId, username, userId, guildId).run();

    await editFollowup(followupUrl,
      `✅ **${username}** fully archived.\n` +
      `> **${totalSaved}** new messages logged across **${channels.length}** channels.`
    );
  } catch (e) {
    await editFollowup(followupUrl, `❌ Error scraping user **${username}**: ${e.message}`);
  }
}

async function editFollowup(url, content) {
  try {
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch {}
}

// ─── OPENROUTER AI ───────────────────────────────────────────────────────────

async function queryAI(env, question, messages) {
  const context = messages.map((m, i) =>
    `[${i + 1}] ${m.created_at?.slice(0, 16)} | #${m.channel_name} | ${m.display_name || m.username}: ${m.content}`
  ).join('\n');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://archive.flo',
      'X-Title': 'Archive.FLO',
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'anthropic/claude-3-haiku',
      max_tokens: 1500,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are Archive.FLO, an intelligence analysis system for the Government of Florenzia. You analyse archived Discord messages to answer questions about individuals, events, and discussions. Be precise, cite message indices when relevant, and structure your response clearly.`,
        },
        {
          role: 'user',
          content: `ARCHIVED MESSAGES:\n${context || 'No messages found.'}\n\nQUESTION: ${question}`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  return data.choices[0]?.message?.content || 'No response.';
}

// ─── REST API HANDLERS ───────────────────────────────────────────────────────

async function handleAPI(env, request, url) {
  const path = url.pathname;
  const apiKey = env.API_KEY;

  // Auth
  if (apiKey) {
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${apiKey}`) {
      return json({ error: 'Unauthorized' }, 401);
    }
  }

  // GET /api/stats
  if (path === '/api/stats' && request.method === 'GET') {
    const total = (await env.DB.prepare('SELECT COUNT(*) as c FROM messages').first()).c;
    const users = (await env.DB.prepare('SELECT COUNT(DISTINCT user_id) as c FROM messages').first()).c;
    const channels = (await env.DB.prepare('SELECT COUNT(DISTINCT channel_id) as c FROM messages').first()).c;
    const today = (await env.DB.prepare("SELECT COUNT(*) as c FROM messages WHERE date(archived_at) = date('now')").first()).c;
    const topUsers = await env.DB.prepare('SELECT username, display_name, user_id, COUNT(*) as count FROM messages GROUP BY user_id ORDER BY count DESC LIMIT 10').all();
    const topChannels = await env.DB.prepare('SELECT channel_name, channel_id, COUNT(*) as count FROM messages GROUP BY channel_id ORDER BY count DESC LIMIT 10').all();
    const activity = await env.DB.prepare("SELECT date(archived_at) as date, COUNT(*) as count FROM messages WHERE archived_at >= datetime('now', '-30 days') GROUP BY date(archived_at) ORDER BY date ASC").all();
    return json({ total, users, channels, today, topUsers: topUsers.results, topChannels: topChannels.results, activity: activity.results });
  }

  // GET /api/messages?channel_id=&user_id=&page=&limit=
  if (path === '/api/messages' && request.method === 'GET') {
    const p = url.searchParams;
    const channelId = p.get('channel_id');
    const userId = p.get('user_id');
    const page = parseInt(p.get('page') || '1');
    const limit = Math.min(parseInt(p.get('limit') || '100'), 200);
    const offset = (page - 1) * limit;

    let where = ['1=1'];
    const binds = [];
    if (channelId) { where.push('channel_id = ?'); binds.push(channelId); }
    if (userId) { where.push('user_id = ?'); binds.push(userId); }

    const whereStr = where.join(' AND ');
    const total = (await env.DB.prepare(`SELECT COUNT(*) as c FROM messages WHERE ${whereStr}`).bind(...binds).first()).c;
    const rows = await env.DB.prepare(`SELECT * FROM messages WHERE ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();

    return json({ messages: rows.results, total, page, limit });
  }

  // GET /api/channels
  if (path === '/api/channels' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM channel_cursors ORDER BY last_scraped DESC').all();
    return json(rows.results);
  }

  // GET /api/users
  if (path === '/api/users' && request.method === 'GET') {
    const rows = await env.DB.prepare(`
      SELECT u.user_id, u.username, u.last_scraped, u.total_messages,
             COUNT(DISTINCT m.channel_id) as channels_active
      FROM user_scrapes u
      LEFT JOIN messages m ON m.user_id = u.user_id
      GROUP BY u.user_id
      ORDER BY u.last_scraped DESC
    `).all();
    return json(rows.results);
  }

  // GET /api/search?q=&channel_id=&user_id=
  if (path === '/api/search' && request.method === 'GET') {
    const q = url.searchParams.get('q');
    if (!q) return json({ error: 'q required' }, 400);
    const channelId = url.searchParams.get('channel_id');
    const userId = url.searchParams.get('user_id');

    let where = ["content LIKE ?"];
    const binds = [`%${q}%`];
    if (channelId) { where.push('channel_id = ?'); binds.push(channelId); }
    if (userId) { where.push('user_id = ?'); binds.push(userId); }

    const rows = await env.DB.prepare(
      `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`
    ).bind(...binds).all();
    return json({ query: q, results: rows.results });
  }

  // POST /api/query — AI natural language query
  if (path === '/api/query' && request.method === 'POST') {
    const body = await request.json();
    const { question, channel_id, user_id, search_terms } = body;
    if (!question) return json({ error: 'question required' }, 400);

    let where = ['1=1'];
    const binds = [];
    if (channel_id) { where.push('channel_id = ?'); binds.push(channel_id); }
    if (user_id) { where.push('user_id = ?'); binds.push(user_id); }
    if (search_terms?.length) {
      where.push(`(${search_terms.map(() => 'content LIKE ?').join(' OR ')})`);
      binds.push(...search_terms.map(t => `%${t}%`));
    }

    const rows = await env.DB.prepare(
      `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 150`
    ).bind(...binds).all();

    const response = await queryAI(env, question, rows.results);
    return json({ question, response, context_messages: rows.results.length });
  }

  return json({ error: 'Not found' }, 404);
}

// ─── DISCORD INTERACTION HANDLER ─────────────────────────────────────────────

async function handleDiscord(env, request, ctx) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const rawBody = await request.text();

  // Verify Discord signature
  const isValid = await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!isValid) return new Response('Invalid signature', { status: 401 });

  const interaction = JSON.parse(rawBody);

  // PING
  if (interaction.type === 1) return json({ type: 1 });

  // Slash command
  if (interaction.type === 2) {
    const { name, options } = interaction.data;
    const guildId = interaction.guild_id;
    const channelId = interaction.channel_id;
    const channelName = interaction.channel?.name || channelId;

    // Immediately defer (we'll edit later since scraping takes time)
    const deferResponse = json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

    // Follow-up URL for editing the deferred response
    const followupUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`;

    if (name === 'log-channel') {
      ctx.waitUntil(scrapeChannel(env, guildId, channelId, channelName, followupUrl));
      return deferResponse;
    }

    if (name === 'log-user') {
      const userOpt = options?.find(o => o.name === 'user');
      const userId = userOpt?.value;
      const resolvedUser = interaction.data.resolved?.users?.[userId];
      const username = resolvedUser?.global_name || resolvedUser?.username || userId;
      ctx.waitUntil(scrapeUser(env, guildId, userId, username, followupUrl));
      return deferResponse;
    }

    if (name === 'archive-status') {
      const userOpt = options?.find(o => o.name === 'user');

      if (userOpt) {
        const userId = userOpt.value;
        const row = await env.DB.prepare('SELECT * FROM user_scrapes WHERE user_id = ?').bind(userId).first();
        const msgCount = (await env.DB.prepare('SELECT COUNT(*) as c FROM messages WHERE user_id = ?').bind(userId).first()).c;
        if (!row) return json({ type: 4, data: { content: '❌ This user has not been archived yet. Use `/log-user`.', flags: 64 } });
        return json({ type: 4, data: { content: `📊 **${row.username}**\n> Messages archived: **${msgCount}**\n> Last scraped: ${row.last_scraped}`, flags: 64 } });
      } else {
        const row = await env.DB.prepare('SELECT * FROM channel_cursors WHERE channel_id = ?').bind(channelId).first();
        const msgCount = (await env.DB.prepare('SELECT COUNT(*) as c FROM messages WHERE channel_id = ?').bind(channelId).first()).c;
        if (!row) return json({ type: 4, data: { content: '❌ This channel has not been archived yet. Use `/log-channel`.', flags: 64 } });
        return json({ type: 4, data: { content: `📊 **#${channelName}**\n> Messages archived: **${msgCount}**\n> Last scraped: ${row.last_scraped}\n> Cursor: \`${row.last_message_id}\``, flags: 64 } });
      }
    }
  }

  return json({ error: 'Unknown interaction' }, 400);
}

// ─── DASHBOARD (serves index.html) ───────────────────────────────────────────

async function serveDashboard(env) {
  const html = await env.ASSETS?.fetch(new Request('https://dummy/index.html'));
  if (html) return html;
  return new Response('Dashboard not found. Run wrangler deploy with --assets.', { status: 404 });
}

// ─── DEPLOY COMMANDS (one-time setup route) ───────────────────────────────────

async function deployCommands(env) {
  const res = await fetch(
    `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(COMMANDS),
    }
  );
  const data = await res.json();
  return json({ ok: res.ok, commands: data });
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      });
    }

    // Discord interactions
    if (url.pathname === '/discord' && request.method === 'POST') {
      return handleDiscord(env, request, ctx);
    }

    // One-time command deploy (protect with a secret param)
    if (url.pathname === '/setup-commands') {
      const secret = url.searchParams.get('secret');
      if (secret !== env.SETUP_SECRET) return new Response('Forbidden', { status: 403 });
      return deployCommands(env);
    }

    // API routes
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(env, request, url);
    }

    // Dashboard
    return serveDashboard(env);
  },
};
