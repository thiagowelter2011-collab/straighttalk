// Testes da API: contas, servidores, canais, mensagens, convites, tokens de mídia.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');
const { createApp } = require('../server');

let app, base;

before(async () => {
  process.env.LIVEKIT_URL = 'ws://localhost:7880';
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'secret-de-teste-com-32-caracteres!!';
  app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

function socket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
    ws.on('open', () => resolve({ ws, inbox, wait: (pred, ms = 2000) => waitFor(inbox, pred, ms) }));
    ws.on('error', reject);
  });
}

async function waitFor(inbox, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = inbox.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout esperando mensagem');
}

let ana, bia, serverId, textId, voiceId, invite;

test('cadastro e login', async () => {
  let r = await call('POST', '/api/register', { username: 'ana', password: '123456', displayName: 'Ana' });
  assert.equal(r.status, 200);
  ana = r.data.token;
  r = await call('POST', '/api/register', { username: 'ANA', password: '123456' });
  assert.equal(r.status, 409, 'usuário duplicado (sem diferenciar maiúsculas)');
  r = await call('POST', '/api/register', { username: 'bia', password: '123' });
  assert.equal(r.status, 400, 'senha curta');
  r = await call('POST', '/api/register', { username: 'bia', password: 'segredo', displayName: 'Bia' });
  bia = r.data.token;
  r = await call('POST', '/api/login', { username: 'ana', password: 'errada' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { username: 'Ana', password: '123456' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/me', null, 'token-falso');
  assert.equal(r.status, 401);
});

test('criar servidor com canais padrão', async () => {
  const r = await call('POST', '/api/servers', { name: 'Cúpula' }, ana);
  assert.equal(r.status, 200);
  serverId = r.data.server.id;
  invite = r.data.server.inviteCode;
  assert.ok(invite);
  textId = r.data.channels.find((c) => c.type === 'text').id;
  voiceId = r.data.channels.find((c) => c.type === 'voice').id;
  assert.equal(r.data.channels.length, 3);
  const me = await call('GET', '/api/me', null, ana);
  assert.equal(me.data.servers.length, 1);
  assert.equal(me.data.media.mode, 'livekit');
});

test('quem não é membro não vê o servidor', async () => {
  const r = await call('GET', `/api/servers/${serverId}`, null, bia);
  assert.equal(r.status, 404);
  const m = await call('GET', `/api/channels/${textId}/messages`, null, bia);
  assert.equal(m.status, 404);
});

test('convite: Bia entra e recebe mensagens em tempo real', async () => {
  const info = await call('GET', `/api/invites/${invite}`);
  assert.equal(info.data.name, 'Cúpula');
  const j = await call('POST', `/api/invites/${invite}`, null, bia);
  assert.equal(j.data.serverId, serverId);
  const d = await call('GET', `/api/servers/${serverId}`, null, bia);
  assert.equal(d.data.members.length, 2);
  assert.equal(d.data.server.inviteCode, undefined, 'só o dono vê o convite');

  const sb = await socket(bia);
  await sb.wait((m) => m.type === 'hello');
  const sent = await call('POST', `/api/channels/${textId}/messages`, { text: 'oi bia' }, ana);
  assert.equal(sent.status, 200);
  const got = await sb.wait((m) => m.type === 'message');
  assert.equal(got.message.text, 'oi bia');
  assert.equal(got.message.author, 'Ana');
  sb.ws.close();
});

test('histórico de mensagens com paginação', async () => {
  for (let i = 0; i < 60; i++) await call('POST', `/api/channels/${textId}/messages`, { text: `m${i}` }, bia);
  const p1 = await call('GET', `/api/channels/${textId}/messages?limit=50`, null, ana);
  assert.equal(p1.data.messages.length, 50);
  assert.equal(p1.data.messages.at(-1).text, 'm59');
  const p2 = await call('GET', `/api/channels/${textId}/messages?limit=50&before=${p1.data.messages[0].id}`, null, ana);
  assert.equal(p2.data.messages.length, 11);
  assert.equal(p2.data.messages[0].text, 'oi bia');
});

test('apagar mensagem: autor ou dono sim, outro não', async () => {
  const m = await call('POST', `/api/channels/${textId}/messages`, { text: 'da ana' }, ana);
  const r = await call('DELETE', `/api/messages/${m.data.id}`, null, bia);
  assert.equal(r.status, 403);
  const m2 = await call('POST', `/api/channels/${textId}/messages`, { text: 'da bia' }, bia);
  assert.equal((await call('DELETE', `/api/messages/${m2.data.id}`, null, ana)).status, 200);
});

test('canais: só o dono cria, renomeia e apaga', async () => {
  let r = await call('POST', `/api/servers/${serverId}/channels`, { name: 'x', type: 'text' }, bia);
  assert.equal(r.status, 403);
  r = await call('POST', `/api/servers/${serverId}/channels`, { name: 'Jogos Online', type: 'text' }, ana);
  assert.equal(r.data.name, 'jogos-online');
  r = await call('PATCH', `/api/channels/${r.data.id}`, { name: 'games' }, ana);
  assert.equal(r.status, 200);
  const d = await call('GET', `/api/servers/${serverId}`, null, ana);
  const g = d.data.channels.find((c) => c.name === 'games');
  assert.ok(g);
  assert.equal((await call('DELETE', `/api/channels/${g.id}`, null, ana)).status, 200);
});

test('voz: estado compartilhado e sinalização só dentro do canal', async () => {
  const sa = await socket(ana);
  const sb = await socket(bia);
  const ha = await sa.wait((m) => m.type === 'hello');
  const hb = await sb.wait((m) => m.type === 'hello');
  sa.ws.send(JSON.stringify({ type: 'voice-join', channelId: voiceId, mediaId: ha.connId }));
  const v1 = await sb.wait((m) => m.type === 'voice' && m.participants.length === 1);
  assert.equal(v1.participants[0].name, 'Ana');

  // Bia ainda não está na voz: sinal não é repassado
  sb.ws.send(JSON.stringify({ type: 'signal', to: ha.connId, data: { x: 1 } }));
  sb.ws.send(JSON.stringify({ type: 'voice-join', channelId: voiceId, mediaId: hb.connId }));
  await sa.wait((m) => m.type === 'voice' && m.participants.length === 2);
  sb.ws.send(JSON.stringify({ type: 'signal', to: ha.connId, data: { x: 2 } }));
  const sig = await sa.wait((m) => m.type === 'signal');
  assert.equal(sig.data.x, 2, 'só o sinal enviado dentro do canal chega');

  sa.ws.send(JSON.stringify({ type: 'voice-state', muted: true, sharing: true, screenStream: 'abc' }));
  const st = await sb.wait((m) => m.type === 'voice' && m.participants.some((p) => p.muted && p.sharing));
  assert.equal(st.participants.find((p) => p.name === 'Ana').screenStream, 'abc');

  const d = await call('GET', `/api/servers/${serverId}`, null, bia);
  assert.equal(d.data.voice[voiceId].length, 2, 'snapshot de voz no detalhe do servidor');
  const online = d.data.members.filter((m) => m.online).length;
  assert.equal(online, 2);

  sa.ws.close();
  await sb.wait((m) => m.type === 'voice' && m.participants.length === 1 && m.participants[0].name === 'Bia');
  sb.ws.close();
});

test('token do LiveKit', async () => {
  let r = await call('GET', `/api/voice/${textId}/token`, null, ana);
  assert.equal(r.status, 400, 'canal de texto não dá token');
  r = await call('GET', `/api/voice/${voiceId}/token?session=abc`, null, ana);
  assert.equal(r.status, 200);
  const payload = JSON.parse(Buffer.from(r.data.token.split('.')[1], 'base64url'));
  assert.equal(payload.video.room, `st-${serverId}-${voiceId}`);
  assert.equal(payload.iss, 'devkey');
  assert.match(payload.sub, /^u\d+-abc$/);
});

test('TURN com credenciais temporárias no modo P2P', () => {
  const media = require('../lib/media');
  delete process.env.LIVEKIT_URL;
  process.env.TURN_URLS = 'turn:turn.exemplo.com:3478';
  process.env.TURN_SECRET = 'segredo';
  const cfg = media.clientConfig(7);
  assert.equal(cfg.mode, 'p2p');
  const turn = cfg.iceServers.find((s) => s.username);
  assert.match(turn.username, /^\d+:7$/);
  const crypto = require('crypto');
  assert.equal(turn.credential, crypto.createHmac('sha1', 'segredo').update(turn.username).digest('base64'));
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
});

test('sair e apagar servidor', async () => {
  assert.equal((await call('POST', `/api/servers/${serverId}/leave`, null, ana)).status, 400, 'dono não sai');
  assert.equal((await call('POST', `/api/servers/${serverId}/leave`, null, bia)).status, 200);
  assert.equal((await call('GET', `/api/servers/${serverId}`, null, bia)).status, 404);
  assert.equal((await call('DELETE', `/api/servers/${serverId}`, null, ana)).status, 200);
  const me = await call('GET', '/api/me', null, ana);
  assert.equal(me.data.servers.length, 0);
});
