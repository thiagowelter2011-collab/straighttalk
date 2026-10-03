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

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'straighttalk.db') } = {}) {
  const db = openDb(dbFile);
  const q = (sql) => db.prepare(sql);
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

  function newSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now());
    return token;
  }

  function userFromToken(token) {
    if (!token) return null;
    return q(`SELECT u.id, u.username, u.display_name AS displayName
              FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(String(token)) || null;
  }

  /* ---------------- Consultas ---------------- */

  const inviteCode = () => crypto.randomBytes(6).toString('base64url');

  function serverRow(id) {
    return q('SELECT id, name, owner_id AS ownerId, invite_code AS inviteCode FROM servers WHERE id = ?').get(id);
  }

  function isMember(serverId, userId) {
    return !!q('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  }

  function requireMember(serverId, user) {
    const s = serverRow(serverId);
    if (!s || !isMember(serverId, user.id)) throw new HttpError(404, 'Servidor não encontrado.');
    return s;
  }

  function requireOwner(serverId, user) {
    const s = requireMember(serverId, user);
    if (s.ownerId !== user.id) throw new HttpError(403, 'Só o dono do servidor pode fazer isso.');
    return s;
  }

  function channelRow(id) {
    return q('SELECT id, server_id AS serverId, name, type, position FROM channels WHERE id = ?').get(id);
  }

  function requireChannel(channelId, user) {
    const c = channelRow(channelId);
    if (!c || !isMember(c.serverId, user.id)) throw new HttpError(404, 'Canal não encontrado.');
    return c;
  }

  function serverIdsOf(userId) {
    return q('SELECT server_id AS id FROM members WHERE user_id = ?').all(userId).map((r) => r.id);
  }

  function listServers(userId) {
    return q(`SELECT s.id, s.name, s.owner_id AS ownerId, s.invite_code AS inviteCode
              FROM servers s JOIN members m ON m.server_id = s.id
              WHERE m.user_id = ? ORDER BY m.joined_at`).all(userId);
  }

  function serverDetail(serverId, viewerId) {
    const s = serverRow(serverId);
    const channels = q('SELECT id, name, type, position FROM channels WHERE server_id = ? ORDER BY type DESC, position, id').all(serverId);
    const members = q(`SELECT u.id, u.username, u.display_name AS displayName
                       FROM members m JOIN users u ON u.id = m.user_id
                       WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE`).all(serverId)
      .map((m) => ({ ...m, online: onlineUsers.has(m.id) }));
    if (s.ownerId !== viewerId) delete s.inviteCode;
    return { server: s, channels, members, voice: voiceSnapshot(serverId) };
  }

  function createServer(name, owner) {
    const t = now();
    const { lastInsertRowid: id } = q('INSERT INTO servers (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)')
      .run(name, owner.id, inviteCode(), t);
    q('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, owner.id, t);
    const addCh = q('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, ?)');
    addCh.run(id, 'geral', 'text', 0);
    addCh.run(id, 'Bate Papo 1', 'voice', 0);
    addCh.run(id, 'Bate Papo 2', 'voice', 1);
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

  function send(conn, msg) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  function toServer(serverId, msg) {
    const members = new Set(q('SELECT user_id AS id FROM members WHERE server_id = ?').all(serverId).map((r) => r.id));
    for (const c of conns.values()) if (members.has(c.user.id)) send(c, msg);
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

  function setPresence(userId, delta) {
    const before = onlineUsers.get(userId) || 0;
    const after = before + delta;
    if (after <= 0) onlineUsers.delete(userId); else onlineUsers.set(userId, after);
    if ((before === 0) !== (after <= 0)) {
      for (const serverId of serverIdsOf(userId)) toServer(serverId, { type: 'presence', serverId, userId, online: after > 0 });
    }
  }

  function kickFromServer(serverId, userId) {
    for (const c of conns.values()) {
      if (c.user.id === userId && c.voice?.serverId === serverId) { leaveVoice(c); send(c, { type: 'voice-ended' }); }
    }
  }

  function onSocketMessage(conn, msg) {
    switch (msg.type) {
      case 'voice-join': {
        const ch = channelRow(Number(msg.channelId));
        if (!ch || ch.type !== 'voice' || !isMember(ch.serverId, conn.user.id)) return;
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
      case 'typing': {
        const ch = channelRow(Number(msg.channelId));
        if (!ch || ch.type !== 'text' || !isMember(ch.serverId, conn.user.id)) return;
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

  route('POST', '/api/register', ({ body, ip }) => {
    throttle(ip);
    const username = cleanName(body.username, 32, 'Usuário').toLowerCase();
    if (!/^[a-z0-9_.]{3,32}$/.test(username)) throw new HttpError(400, 'Usuário: 3 a 32 letras, números, ponto ou _ (sem espaços).');
    const displayName = cleanName(body.displayName || body.username, 32, 'Nome');
    const password = String(body.password || '');
    if (password.length < 6) throw new HttpError(400, 'A senha precisa ter pelo menos 6 caracteres.');
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Esse usuário já existe.');
    const { lastInsertRowid } = q('INSERT INTO users (username, display_name, pass_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, displayName, hashPassword(password), now());
    return { token: newSession(Number(lastInsertRowid)) };
  }, { auth: false });

  route('POST', '/api/login', ({ body, ip }) => {
    throttle(ip);
    const row = q('SELECT id, pass_hash FROM users WHERE username = ?').get(String(body.username || '').trim().toLowerCase());
    if (!row || !checkPassword(String(body.password || ''), row.pass_hash)) {
      failedLogin(ip);
      throw new HttpError(401, 'Usuário ou senha incorretos.');
    }
    return { token: newSession(row.id) };
  }, { auth: false });

  route('POST', '/api/logout', ({ token }) => {
    q('DELETE FROM sessions WHERE token = ?').run(token);
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => ({
    user,
    servers: listServers(user.id),
    media: media.clientConfig(user.id),
  }));

  route('PATCH', '/api/me', ({ user, body }) => {
    const displayName = cleanName(body.displayName, 32, 'Nome');
    q('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, user.id);
    for (const sid of serverIdsOf(user.id)) toServer(sid, { type: 'server-update', serverId: sid });
    return { ok: true };
  });

  route('POST', '/api/servers', ({ user, body }) => {
    if (listServers(user.id).filter((s) => s.ownerId === user.id).length >= 20) throw new HttpError(400, 'Limite de 20 servidores criados.');
    const id = createServer(cleanName(body.name, 50, 'Nome do servidor'), user);
    return serverDetail(id, user.id);
  });

  route('GET', '/api/servers/:id', ({ user, params }) => {
    requireMember(Number(params.id), user);
    return serverDetail(Number(params.id), user.id);
  });

  route('PATCH', '/api/servers/:id', ({ user, params, body }) => {
    const s = requireOwner(Number(params.id), user);
    q('UPDATE servers SET name = ? WHERE id = ?').run(cleanName(body.name, 50, 'Nome do servidor'), s.id);
    toServer(s.id, { type: 'server-update', serverId: s.id });
    return { ok: true };
  });

  route('DELETE', '/api/servers/:id', ({ user, params }) => {
    const s = requireOwner(Number(params.id), user);
    const memberIds = q('SELECT user_id AS id FROM members WHERE server_id = ?').all(s.id).map((r) => r.id);
    for (const uid of memberIds) kickFromServer(s.id, uid);
    q('DELETE FROM servers WHERE id = ?').run(s.id);
    for (const uid of memberIds) toUser(uid, { type: 'server-removed', serverId: s.id });
    return { ok: true };
  });

  route('POST', '/api/servers/:id/leave', ({ user, params }) => {
    const s = requireMember(Number(params.id), user);
    if (s.ownerId === user.id) throw new HttpError(400, 'O dono não pode sair. Apague o servidor.');
    kickFromServer(s.id, user.id);
    q('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(s.id, user.id);
    toUser(user.id, { type: 'server-removed', serverId: s.id });
    toServer(s.id, { type: 'server-update', serverId: s.id });
    return { ok: true };
  });

  route('POST', '/api/servers/:id/invite', ({ user, params }) => {
    const s = requireOwner(Number(params.id), user);
    const code = inviteCode();
    q('UPDATE servers SET invite_code = ? WHERE id = ?').run(code, s.id);
    return { inviteCode: code };
  });

  route('POST', '/api/servers/:id/channels', ({ user, params, body }) => {
    const s = requireOwner(Number(params.id), user);
    const type = body.type === 'voice' ? 'voice' : 'text';
    const count = q('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?').get(s.id).n;
    if (count >= 100) throw new HttpError(400, 'Limite de 100 canais.');
    const pos = q('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ? AND type = ?').get(s.id, type).p;
    const { lastInsertRowid } = q('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, ?)')
      .run(s.id, cleanChannelName(body.name, type), type, pos);
    toServer(s.id, { type: 'server-update', serverId: s.id });
    return channelRow(Number(lastInsertRowid));
  });

  route('PATCH', '/api/channels/:id', ({ user, params, body }) => {
    const c = requireChannel(Number(params.id), user);
    requireOwner(c.serverId, user);
    q('UPDATE channels SET name = ? WHERE id = ?').run(cleanChannelName(body.name, c.type), c.id);
    toServer(c.serverId, { type: 'server-update', serverId: c.serverId });
    return { ok: true };
  });

  route('DELETE', '/api/channels/:id', ({ user, params }) => {
    const c = requireChannel(Number(params.id), user);
    requireOwner(c.serverId, user);
    for (const conn of conns.values()) {
      if (conn.voice?.channelId === c.id) { conn.voice = null; send(conn, { type: 'voice-ended' }); }
    }
    q('DELETE FROM channels WHERE id = ?').run(c.id);
    toServer(c.serverId, { type: 'server-update', serverId: c.serverId });
    return { ok: true };
  });

  route('GET', '/api/invites/:code', ({ params }) => {
    const s = q('SELECT id, name FROM servers WHERE invite_code = ?').get(params.code);
    if (!s) throw new HttpError(404, 'Convite inválido ou expirado.');
    const n = q('SELECT COUNT(*) AS n FROM members WHERE server_id = ?').get(s.id).n;
    return { serverId: s.id, name: s.name, members: n };
  }, { auth: false });

  route('POST', '/api/invites/:code', ({ user, params }) => {
    const s = q('SELECT id FROM servers WHERE invite_code = ?').get(params.code);
    if (!s) throw new HttpError(404, 'Convite inválido ou expirado.');
    if (!isMember(s.id, user.id)) {
      q('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(s.id, user.id, now());
      toServer(s.id, { type: 'server-update', serverId: s.id });
    }
    return { serverId: s.id };
  });

  route('GET', '/api/channels/:id/messages', ({ user, params, query }) => {
    const c = requireChannel(Number(params.id), user);
    if (c.type !== 'text') throw new HttpError(400, 'Canal de voz não tem mensagens.');
    const before = Number(query.get('before')) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Number(query.get('limit')) || 50, 100);
    const rows = q(`SELECT m.*, u.display_name AS author FROM messages m JOIN users u ON u.id = m.user_id
                    WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(c.id, before, limit);
    return { messages: rows.reverse().map(messagePayload) };
  });

  route('POST', '/api/channels/:id/messages', ({ user, params, body }) => {
    const c = requireChannel(Number(params.id), user);
    if (c.type !== 'text') throw new HttpError(400, 'Canal de voz não tem mensagens.');
    const text = String(body.text || '').trim();
    if (!text) throw new HttpError(400, 'Mensagem vazia.');
    if (text.length > 4000) throw new HttpError(400, 'Mensagem longa demais (máximo 4000 caracteres).');
    const { lastInsertRowid } = q('INSERT INTO messages (channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?)')
      .run(c.id, user.id, text, now());
    const row = q(`SELECT m.*, u.display_name AS author FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`)
      .get(Number(lastInsertRowid));
    const message = messagePayload(row);
    toServer(c.serverId, { type: 'message', serverId: c.serverId, message });
    return message;
  });

  route('DELETE', '/api/messages/:id', ({ user, params }) => {
    const m = q('SELECT m.id, m.user_id, c.server_id, c.id AS channel_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?')
      .get(Number(params.id));
    if (!m || !isMember(m.server_id, user.id)) throw new HttpError(404, 'Mensagem não encontrada.');
    if (m.user_id !== user.id && serverRow(m.server_id).ownerId !== user.id) throw new HttpError(403, 'Você não pode apagar essa mensagem.');
    q('DELETE FROM messages WHERE id = ?').run(m.id);
    toServer(m.server_id, { type: 'message-deleted', serverId: m.server_id, channelId: m.channel_id, messageId: m.id });
    return { ok: true };
  });

  route('GET', '/api/voice/:id/token', ({ user, params, query }) => {
    const c = requireChannel(Number(params.id), user);
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
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!r) return json(res, 404, { error: 'Rota não encontrada.' });
    try {
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = userFromToken(token);
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

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const user = userFromToken(url.searchParams.get('token'));
    if (!user) return ws.close(4001, 'unauthorized');

    const conn = { id: crypto.randomUUID(), user, ws, voice: null, alive: true };
    conns.set(conn.id, conn);
    setPresence(user.id, +1);
    send(conn, { type: 'hello', connId: conn.id });

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try { onSocketMessage(conn, msg); } catch (err) { console.error(err); }
    });
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
  const { server } = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`StraightTalk rodando em http://localhost:${PORT}`);
    console.log(media.livekitEnabled() ? `Mídia: LiveKit (${process.env.LIVEKIT_URL})` : 'Mídia: P2P' + (process.env.TURN_URLS ? ' + TURN' : ''));
  });
}
