// Servidor do StraightTalk
//  - API de contas, servidores, canais e mensagens (SQLite)
//  - WebSocket para mensagens em tempo real, presença e estado dos canais de voz
//  - Sinalização WebRTC no modo P2P, ou tokens do LiveKit no modo SFU (ver lib/media.js)
// A voz e a tela não passam por este processo.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { openDb } = require('./lib/db');
const media = require('./lib/media');

const PUBLIC = path.join(__dirname, 'public');
const LIVEKIT_UMD = path.join(path.dirname(require.resolve('livekit-client')), 'livekit-client.umd.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp({
  dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'straighttalk.db'),
  dbUrl = process.env.DATABASE_URL,
  dbToken = process.env.DATABASE_AUTH_TOKEN,
} = {}) {
  const db = openDb({ file: dbFile, url: dbUrl, authToken: dbToken });
  const now = () => Date.now();

  /* ---------------- Senhas e sessões ---------------- */

  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  function checkPassword(password, stored) {
    const [, saltHex, hashHex] = stored.split(':');
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  }

  async function newSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', token, userId, now());
    return token;
  }

  async function userFromToken(token) {
    if (!token) return null;
    return (await db.get(`SELECT u.id, u.username, u.display_name AS displayName, u.personal_message AS personalMessage
              FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, String(token))) || null;
  }

  /* ---------------- Consultas ---------------- */

  const inviteCode = () => crypto.randomBytes(6).toString('base64url');

  async function serverRow(id) {
    return await db.get('SELECT id, name, owner_id AS ownerId, invite_code AS inviteCode FROM servers WHERE id = ?', id);
  }

  async function isMember(serverId, userId) {
    return !!await db.get('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
  }

  async function requireMember(serverId, user) {
    const s = await serverRow(serverId);
    if (!s || !(await isMember(serverId, user.id))) throw new HttpError(404, 'Servidor não encontrado.');
    return s;
  }

  async function requireOwner(serverId, user) {
    const s = await requireMember(serverId, user);
    if (s.ownerId !== user.id) throw new HttpError(403, 'Só o dono do servidor pode fazer isso.');
    return s;
  }

  async function channelRow(id) {
    return await db.get('SELECT id, server_id AS serverId, name, type, position FROM channels WHERE id = ?', id);
  }

  async function requireChannel(channelId, user) {
    const c = await channelRow(channelId);
    if (!c || !(await isMember(c.serverId, user.id))) throw new HttpError(404, 'Canal não encontrado.');
    return c;
  }

  async function serverIdsOf(userId) {
    return (await db.all('SELECT server_id AS id FROM members WHERE user_id = ?', userId)).map((r) => r.id);
  }

  async function listServers(userId) {
    return await db.all(`SELECT s.id, s.name, s.owner_id AS ownerId, s.invite_code AS inviteCode
              FROM servers s JOIN members m ON m.server_id = s.id
              WHERE m.user_id = ? ORDER BY m.joined_at`, userId);
  }

  async function serverDetail(serverId, viewerId) {
    const s = await serverRow(serverId);
    const channels = await db.all('SELECT id, name, type, position FROM channels WHERE server_id = ? ORDER BY type DESC, position, id', serverId);
    const members = (await db.all(`SELECT u.id, u.username, u.display_name AS displayName, u.personal_message AS personalMessage
                       FROM members m JOIN users u ON u.id = m.user_id
                       WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE`, serverId))
      .map((m) => ({ ...m, status: visibleStatus(m.id), online: visibleStatus(m.id) !== 'offline' }));
    if (s.ownerId !== viewerId) delete s.inviteCode;
    return { server: s, channels, members, voice: voiceSnapshot(serverId) };
  }

  async function createServer(name, owner) {
    const t = now();
    const { lastInsertRowid: id } = await db.run('INSERT INTO servers (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)', name, owner.id, inviteCode(), t);
    await db.run('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)', id, owner.id, t);
    const addCh = 'INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, ?)';
    await db.run(addCh, id, 'geral', 'text', 0);
    await db.run(addCh, id, 'Bate Papo 1', 'voice', 0);
    await db.run(addCh, id, 'Bate Papo 2', 'voice', 1);
    memberCache.delete(id);
    return Number(id);
  }

  function messagePayload(row) {
    return { id: row.id, channelId: row.channel_id, userId: row.user_id, author: row.author, text: row.text, createdAt: row.created_at };
  }

  /* ---------------- Validação ---------------- */

  function cleanName(v, max, label) {
    const s = String(v ?? '').trim().replace(/\s+/g, ' ');
    if (!s) throw new HttpError(400, `${label} é obrigatório.`);
    if (s.length > max) throw new HttpError(400, `${label} pode ter no máximo ${max} caracteres.`);
    return s;
  }

  function cleanChannelName(v, type) {
    let s = cleanName(v, 40, 'Nome do canal');
    if (type === 'text') s = s.toLowerCase().replace(/\s+/g, '-');
    return s;
  }

  /* ---------------- Tempo real (WebSocket) ---------------- */

  const conns = new Map();        // connId -> { id, user, ws, voice }
  const onlineUsers = new Map();  // userId -> número de conexões
  const userStatus = new Map();   // userId -> online | away | busy | invisible (escolhido pela pessoa)
  const STATUSES = new Set(['online', 'away', 'busy', 'invisible']);
  const lastNudge = new Map();    // userId -> quando chamou atenção pela última vez

  // O que os outros veem: invisível aparece como offline
  function visibleStatus(userId) {
    if (!onlineUsers.has(userId)) return 'offline';
    const s = userStatus.get(userId) || 'online';
    return s === 'invisible' ? 'offline' : s;
  }

  async function announcePresence(userId, before) {
    const status = visibleStatus(userId);
    if (status === before) return;
    for (const serverId of await serverIdsOf(userId)) {
      toServer(serverId, { type: 'presence', serverId, userId, online: status !== 'offline', status });
    }
  }

  function send(conn, msg) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  // Quem é membro de cada servidor fica em memória, para os avisos em tempo real não esperarem o banco
  const memberCache = new Map(); // serverId -> Promise<Set<userId>>

  function membersOf(serverId) {
    let p = memberCache.get(serverId);
    if (!p) {
      p = db.all('SELECT user_id AS id FROM members WHERE server_id = ?', serverId).then((rows) => new Set(rows.map((r) => r.id)));
      p.catch(() => memberCache.delete(serverId));
      memberCache.set(serverId, p);
    }
    return p;
  }

  async function toServer(serverId, msg) {
    try {
      const members = await membersOf(serverId);
      for (const c of conns.values()) if (members.has(c.user.id)) send(c, msg);
    } catch (err) { console.error(err); }
  }

  function toUser(userId, msg) {
    for (const c of conns.values()) if (c.user.id === userId) send(c, msg);
  }

  function voiceParticipants(channelId) {
    return [...conns.values()].filter((c) => c.voice?.channelId === channelId).map((c) => ({
      connId: c.id,
      userId: c.user.id,
      name: c.user.displayName,
      mediaId: c.voice.mediaId,
      muted: c.voice.muted,
      deafened: c.voice.deafened,
      sharing: c.voice.sharing,
      screenStream: c.voice.screenStream,
    }));
  }

  function voiceSnapshot(serverId) {
    const out = {};
    for (const c of conns.values()) {
      if (c.voice?.serverId === serverId) out[c.voice.channelId] ||= voiceParticipants(c.voice.channelId);
    }
    return out;
  }

  function broadcastVoice(serverId, channelId) {
    toServer(serverId, { type: 'voice', serverId, channelId, participants: voiceParticipants(channelId) });
  }

  function leaveVoice(conn) {
    if (!conn.voice) return;
    const { serverId, channelId } = conn.voice;
    conn.voice = null;
    broadcastVoice(serverId, channelId);
  }

  async function setPresence(userId, delta) {
    try { await updatePresence(userId, delta); } catch (err) { console.error(err); }
  }

  async function updatePresence(userId, delta) {
    const before = visibleStatus(userId);
    const after = (onlineUsers.get(userId) || 0) + delta;
    if (after <= 0) { onlineUsers.delete(userId); userStatus.delete(userId); } else onlineUsers.set(userId, after);
    await announcePresence(userId, before);
  }

  function kickFromServer(serverId, userId) {
    for (const c of conns.values()) {
      if (c.user.id === userId && c.voice?.serverId === serverId) { leaveVoice(c); send(c, { type: 'voice-ended' }); }
    }
  }

  async function onSocketMessage(conn, msg) {
    switch (msg.type) {
      case 'voice-join': {
        const ch = await channelRow(Number(msg.channelId));
        if (!ch || ch.type !== 'voice' || !(await isMember(ch.serverId, conn.user.id))) return;
        if (!conns.has(conn.id)) return; // a conexão caiu enquanto esperávamos o banco
        // Uma pessoa só fica em um canal de voz por vez (como no Discord)
        for (const c of conns.values()) {
          if (c.user.id === conn.user.id && c !== conn && c.voice) { leaveVoice(c); send(c, { type: 'voice-ended', reason: 'outra-aba' }); }
        }
        if (conn.voice) leaveVoice(conn);
        conn.voice = {
          serverId: ch.serverId, channelId: ch.id,
          mediaId: String(msg.mediaId || conn.id).slice(0, 80),
          muted: !!msg.muted, deafened: !!msg.deafened, sharing: false, screenStream: null,
        };
        broadcastVoice(ch.serverId, ch.id);
        break;
      }
      case 'voice-leave':
        leaveVoice(conn);
        break;
      case 'voice-state': {
        if (!conn.voice) return;
        for (const k of ['muted', 'deafened', 'sharing']) if (k in msg) conn.voice[k] = !!msg[k];
        if ('screenStream' in msg) conn.voice.screenStream = msg.screenStream ? String(msg.screenStream).slice(0, 100) : null;
        broadcastVoice(conn.voice.serverId, conn.voice.channelId);
        break;
      }
      case 'signal': {
        // Só repassa entre pessoas do mesmo canal de voz
        const target = conns.get(msg.to);
        if (target && conn.voice && target.voice?.channelId === conn.voice.channelId) {
          send(target, { type: 'signal', from: conn.id, data: msg.data });
        }
        break;
      }
      case 'status': {
        if (!STATUSES.has(msg.status)) return;
        const before = visibleStatus(conn.user.id);
        userStatus.set(conn.user.id, msg.status);
        await announcePresence(conn.user.id, before);
        break;
      }
      case 'nudge': {
        // "Chamar atenção": treme a janela de quem está no servidor
        const ch = await channelRow(Number(msg.channelId));
        if (!ch || ch.type !== 'text' || !(await isMember(ch.serverId, conn.user.id))) return;
        const t = now();
        if (t - (lastNudge.get(conn.user.id) || 0) < 8000) return send(conn, { type: 'nudge-wait' });
        lastNudge.set(conn.user.id, t);
        toServer(ch.serverId, { type: 'nudge', serverId: ch.serverId, channelId: ch.id, userId: conn.user.id, name: conn.user.displayName });
        break;
      }
      case 'typing': {
        const ch = await channelRow(Number(msg.channelId));
        if (!ch || ch.type !== 'text' || !(await isMember(ch.serverId, conn.user.id))) return;
        toServer(ch.serverId, { type: 'typing', channelId: ch.id, userId: conn.user.id, name: conn.user.displayName });
        break;
      }
    }
  }

  /* ---------------- Rotas HTTP ---------------- */

  const loginAttempts = new Map(); // ip -> { count, until }

  function throttle(ip) {
    const a = loginAttempts.get(ip);
    if (a && a.until > now() && a.count >= 10) throw new HttpError(429, 'Muitas tentativas. Espere um minuto.');
  }

  function failedLogin(ip) {
    const a = loginAttempts.get(ip);
    if (!a || a.until < now()) loginAttempts.set(ip, { count: 1, until: now() + 60_000 });
    else a.count++;
  }

  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth });
  };

  route('POST', '/api/register', async ({ body, ip }) => {
    throttle(ip);
    const username = cleanName(body.username, 32, 'Usuário').toLowerCase();
    if (!/^[a-z0-9_.]{3,32}$/.test(username)) throw new HttpError(400, 'Usuário: 3 a 32 letras, números, ponto ou _ (sem espaços).');
    const displayName = cleanName(body.displayName || body.username, 32, 'Nome');
    const password = String(body.password || '');
    if (password.length < 6) throw new HttpError(400, 'A senha precisa ter pelo menos 6 caracteres.');
    if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'Esse usuário já existe.');
    const { lastInsertRowid } = await db.run('INSERT INTO users (username, display_name, pass_hash, created_at) VALUES (?, ?, ?, ?)', username, displayName, hashPassword(password), now());
    return { token: await newSession(lastInsertRowid) };
  }, { auth: false });

  route('POST', '/api/login', async ({ body, ip }) => {
    throttle(ip);
    const row = await db.get('SELECT id, pass_hash FROM users WHERE username = ?', String(body.username || '').trim().toLowerCase());
    if (!row || !checkPassword(String(body.password || ''), row.pass_hash)) {
      failedLogin(ip);
      throw new HttpError(401, 'Usuário ou senha incorretos.');
    }
    return { token: await newSession(row.id) };
  }, { auth: false });

  route('POST', '/api/logout', async ({ token }) => {
    await db.run('DELETE FROM sessions WHERE token = ?', token);
    return { ok: true };
  });

  route('GET', '/api/me', async ({ user }) => ({
    user,
    servers: await listServers(user.id),
    media: media.clientConfig(user.id),
  }));

  route('PATCH', '/api/me', async ({ user, body }) => {
    if ('displayName' in body) {
      const displayName = cleanName(body.displayName, 32, 'Nome');
      await db.run('UPDATE users SET display_name = ? WHERE id = ?', displayName, user.id);
      for (const c of conns.values()) if (c.user.id === user.id) c.user.displayName = displayName;
    }
    if ('personalMessage' in body) {
      const pm = String(body.personalMessage ?? '').trim().replace(/\s+/g, ' ');
      if (pm.length > 120) throw new HttpError(400, 'A mensagem pessoal pode ter no máximo 120 caracteres.');
      await db.run('UPDATE users SET personal_message = ? WHERE id = ?', pm, user.id);
    }
    for (const sid of await serverIdsOf(user.id)) toServer(sid, { type: 'server-update', serverId: sid });
    return { ok: true };
  });

  route('POST', '/api/servers', async ({ user, body }) => {
    if ((await listServers(user.id)).filter((s) => s.ownerId === user.id).length >= 20) throw new HttpError(400, 'Limite de 20 servidores criados.');
    const id = await createServer(cleanName(body.name, 50, 'Nome do servidor'), user);
    return serverDetail(id, user.id);
  });

  route('GET', '/api/servers/:id', async ({ user, params }) => {
    await requireMember(Number(params.id), user);
    return serverDetail(Number(params.id), user.id);
  });

  route('PATCH', '/api/servers/:id', async ({ user, params, body }) => {
    const s = await requireOwner(Number(params.id), user);
    await db.run('UPDATE servers SET name = ? WHERE id = ?', cleanName(body.name, 50, 'Nome do servidor'), s.id);
    toServer(s.id, { type: 'server-update', serverId: s.id });
    return { ok: true };
  });

  route('DELETE', '/api/servers/:id', async ({ user, params }) => {
    const s = await requireOwner(Number(params.id), user);
    const memberIds = [...await membersOf(s.id)];
    for (const uid of memberIds) kickFromServer(s.id, uid);
    // Apaga em ordem, sem depender de ON DELETE CASCADE (nem todo banco na nuvem liga as chaves estrangeiras)
    await db.run('DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)', s.id);
    await db.run('DELETE FROM channels WHERE server_id = ?', s.id);
    await db.run('DELETE FROM members WHERE server_id = ?', s.id);
    await db.run('DELETE FROM servers WHERE id = ?', s.id);
    memberCache.delete(s.id);
    for (const uid of memberIds) toUser(uid, { type: 'server-removed', serverId: s.id });
    return { ok: true };
  });

  route('POST', '/api/servers/:id/leave', async ({ user, params }) => {
    const s = await requireMember(Number(params.id), user);
    if (s.ownerId === user.id) throw new HttpError(400, 'O dono não pode sair. Apague o servidor.');
    kickFromServer(s.id, user.id);
    await db.run('DELETE FROM members WHERE server_id = ? AND user_id = ?', s.id, user.id);
    memberCache.delete(s.id);
    toUser(user.id, { type: 'server-removed', serverId: s.id });
    toServer(s.id, { type: 'server-update', serverId: s.id });
    return { ok: true };
  });

  route('POST', '/api/servers/:id/invite', async ({ user, params }) => {
    const s = await requireOwner(Number(params.id), user);
    const code = inviteCode();
    await db.run('UPDATE servers SET invite_code = ? WHERE id = ?', code, s.id);
    return { inviteCode: code };
  });

  route('POST', '/api/servers/:id/channels', async ({ user, params, body }) => {
    const s = await requireOwner(Number(params.id), user);
    const type = body.type === 'voice' ? 'voice' : 'text';
    const count = (await db.get('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', s.id)).n;
    if (count >= 100) throw new HttpError(400, 'Limite de 100 canais.');
    const pos = (await db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ? AND type = ?', s.id, type)).p;
    const { lastInsertRowid } = await db.run('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, ?)', s.id, cleanChannelName(body.name, type), type, pos);
    toServer(s.id, { type: 'server-update', serverId: s.id });
    return channelRow(lastInsertRowid);
  });

  route('PATCH', '/api/channels/:id', async ({ user, params, body }) => {
    const c = await requireChannel(Number(params.id), user);
    await requireOwner(c.serverId, user);
    await db.run('UPDATE channels SET name = ? WHERE id = ?', cleanChannelName(body.name, c.type), c.id);
    toServer(c.serverId, { type: 'server-update', serverId: c.serverId });
    return { ok: true };
  });

  route('DELETE', '/api/channels/:id', async ({ user, params }) => {
    const c = await requireChannel(Number(params.id), user);
    await requireOwner(c.serverId, user);
    for (const conn of conns.values()) {
      if (conn.voice?.channelId === c.id) { conn.voice = null; send(conn, { type: 'voice-ended' }); }
    }
    await db.run('DELETE FROM messages WHERE channel_id = ?', c.id);
    await db.run('DELETE FROM channels WHERE id = ?', c.id);
    toServer(c.serverId, { type: 'server-update', serverId: c.serverId });
    return { ok: true };
  });

  route('GET', '/api/invites/:code', async ({ params }) => {
    const s = await db.get('SELECT id, name FROM servers WHERE invite_code = ?', params.code);
    if (!s) throw new HttpError(404, 'Convite inválido ou expirado.');
    const n = (await db.get('SELECT COUNT(*) AS n FROM members WHERE server_id = ?', s.id)).n;
    return { serverId: s.id, name: s.name, members: n };
  }, { auth: false });

  route('POST', '/api/invites/:code', async ({ user, params }) => {
    const s = await db.get('SELECT id FROM servers WHERE invite_code = ?', params.code);
    if (!s) throw new HttpError(404, 'Convite inválido ou expirado.');
    if (!(await isMember(s.id, user.id))) {
      await db.run('INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)', s.id, user.id, now());
      memberCache.delete(s.id);
      toServer(s.id, { type: 'server-update', serverId: s.id });
    }
    return { serverId: s.id };
  });

  route('GET', '/api/channels/:id/messages', async ({ user, params, query }) => {
    const c = await requireChannel(Number(params.id), user);
    if (c.type !== 'text') throw new HttpError(400, 'Canal de voz não tem mensagens.');
    const before = Number(query.get('before')) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Number(query.get('limit')) || 50, 100);
    const rows = await db.all(`SELECT m.*, u.display_name AS author FROM messages m JOIN users u ON u.id = m.user_id
                    WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, c.id, before, limit);
    return { messages: rows.reverse().map(messagePayload) };
  });

  route('POST', '/api/channels/:id/messages', async ({ user, params, body }) => {
    const c = await requireChannel(Number(params.id), user);
    if (c.type !== 'text') throw new HttpError(400, 'Canal de voz não tem mensagens.');
    const text = String(body.text || '').trim();
    if (!text) throw new HttpError(400, 'Mensagem vazia.');
    if (text.length > 4000) throw new HttpError(400, 'Mensagem longa demais (máximo 4000 caracteres).');
    const { lastInsertRowid } = await db.run('INSERT INTO messages (channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?)', c.id, user.id, text, now());
    const row = await db.get(`SELECT m.*, u.display_name AS author FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`, lastInsertRowid);
    const message = messagePayload(row);
    toServer(c.serverId, { type: 'message', serverId: c.serverId, message });
    return message;
  });

  route('DELETE', '/api/messages/:id', async ({ user, params }) => {
    const m = await db.get('SELECT m.id, m.user_id, c.server_id, c.id AS channel_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?', Number(params.id));
    if (!m || !(await isMember(m.server_id, user.id))) throw new HttpError(404, 'Mensagem não encontrada.');
    if (m.user_id !== user.id && (await serverRow(m.server_id)).ownerId !== user.id) throw new HttpError(403, 'Você não pode apagar essa mensagem.');
    await db.run('DELETE FROM messages WHERE id = ?', m.id);
    toServer(m.server_id, { type: 'message-deleted', serverId: m.server_id, channelId: m.channel_id, messageId: m.id });
    return { ok: true };
  });

  route('GET', '/api/voice/:id/token', async ({ user, params, query }) => {
    const c = await requireChannel(Number(params.id), user);
    if (c.type !== 'voice') throw new HttpError(400, 'Esse não é um canal de voz.');
    if (!media.livekitEnabled()) throw new HttpError(400, 'Servidor de mídia não configurado.');
    const identity = `u${user.id}-${String(query.get('session') || crypto.randomBytes(4).toString('hex')).slice(0, 16)}`;
    return {
      url: process.env.LIVEKIT_URL,
      identity,
      token: media.livekitToken({ identity, name: user.displayName, room: `st-${c.serverId}-${c.id}` }),
    };
  });

  /* ---------------- HTTP ---------------- */

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) { reject(new HttpError(413, 'Requisição grande demais.')); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON inválido.')); }
      });
      req.on('error', reject);
    });
  }

  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function serveStatic(req, res, pathname) {
    let file;
    if (pathname === '/vendor/livekit-client.js') file = LIVEKIT_UMD;
    else {
      file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
      if (pathname === '/' || !path.extname(file)) file = path.join(PUBLIC, 'index.html');
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Não encontrado'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, version: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null });
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!r) return json(res, 404, { error: 'Rota não encontrada.' });
    try {
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      await db.ready;
      const user = await userFromToken(token);
      if (r.auth && !user) throw new HttpError(401, 'Faça login de novo.');
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const out = await r.handler({ req, user, token, body, params, query: url.searchParams, ip });
      json(res, 200, out);
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      json(res, 500, { error: 'Erro interno.' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://x');
    // Guarda o que chegar enquanto o login é conferido no banco
    const early = [];
    const buffer = (raw) => early.push(raw);
    ws.on('message', buffer);
    let user = null;
    try { await db.ready; user = await userFromToken(url.searchParams.get('token')); } catch (err) { console.error(err); }
    ws.off('message', buffer);
    if (!user) return ws.close(4001, 'unauthorized');
    if (ws.readyState !== ws.OPEN) return;

    const conn = { id: crypto.randomUUID(), user, ws, voice: null, alive: true };
    conns.set(conn.id, conn);
    // Quem entra como invisível não aparece online nem por um instante
    const initial = url.searchParams.get('status');
    if (STATUSES.has(initial) && !onlineUsers.has(user.id)) userStatus.set(user.id, initial);
    setPresence(user.id, +1);
    send(conn, { type: 'hello', connId: conn.id });

    ws.on('pong', () => { conn.alive = true; });
    // Mensagens da mesma conexão são tratadas em ordem, uma de cada vez
    let queue = Promise.resolve();
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      queue = queue.then(() => onSocketMessage(conn, msg)).catch((err) => console.error(err));
    };
    ws.on('message', onMessage);
    early.forEach(onMessage);
    ws.on('close', () => {
      leaveVoice(conn);
      conns.delete(conn.id);
      setPresence(user.id, -1);
    });
  });

  // Derruba conexões mortas e mantém túneis/proxies abertos
  const heartbeat = setInterval(() => {
    for (const c of conns.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, 25000);

  function close() {
    clearInterval(heartbeat);
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.close();
    db.close();
  }

  return { server, close, db };
}

module.exports = { createApp };

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  const { server, db } = createApp();
  db.ready.catch((err) => { console.error('Não consegui abrir o banco de dados:', err.message); process.exit(1); });
  server.listen(PORT, HOST, () => {
    console.log(`StraightTalk rodando em http://localhost:${PORT}`);
    console.log(`Banco: ${db.kind === 'libsql' ? 'nuvem (DATABASE_URL)' : 'arquivo local'}`);
    console.log(media.livekitEnabled() ? `Mídia: LiveKit (${process.env.LIVEKIT_URL})` : 'Mídia: P2P' + (process.env.TURN_URLS ? ' + TURN' : ''));
  });
}
