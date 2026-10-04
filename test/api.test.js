// Testes da API: contas, servidores, canais, mensagens, convites, tokens de mídia.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');
const http = require('http');
const { createApp } = require('../server');
const { createPayments } = require('../lib/payments');

let app, base;

before(async () => {
  process.env.LIVEKIT_URL = 'ws://localhost:7880';
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'secret-de-teste-com-32-caracteres!!';
  // TEST_DATABASE_URL=file:/tmp/x.db roda os mesmos testes pelo driver de banco na nuvem (libsql)
  app = createApp(process.env.TEST_DATABASE_URL ? { dbUrl: process.env.TEST_DATABASE_URL } : { dbFile: ':memory:', dbUrl: '' });
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
  assert.equal(d.data.server.inviteCode, invite, 'qualquer membro pode convidar (só o dono gera link novo)');

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

test('status, mensagem pessoal e chamar atenção (estilo MSN)', async () => {
  const a = await socket(ana);
  const b = await socket(bia);
  await b.wait((m) => m.type === 'hello');
  a.ws.send(JSON.stringify({ type: 'status', status: 'busy' }));
  await b.wait((m) => m.type === 'presence' && m.status === 'busy');
  a.ws.send(JSON.stringify({ type: 'status', status: 'invisible' }));
  await b.wait((m) => m.type === 'presence' && m.status === 'offline' && m.online === false);
  let r = await call('GET', `/api/servers/${serverId}`, null, bia);
  assert.equal(r.data.members.find((m) => m.displayName === 'Ana').status, 'offline', 'invisível aparece offline');
  a.ws.send(JSON.stringify({ type: 'status', status: 'online' }));
  await b.wait((m) => m.type === 'presence' && m.status === 'online');

  r = await call('PATCH', '/api/me', { personalMessage: '  ouvindo   música  ' }, ana);
  assert.equal(r.status, 200);
  r = await call('GET', '/api/me', null, ana);
  assert.equal(r.data.user.personalMessage, 'ouvindo música');
  assert.equal(r.data.user.displayName, 'Ana', 'mudar só a mensagem pessoal não mexe no nome');
  r = await call('PATCH', '/api/me', { personalMessage: 'x'.repeat(121) }, ana);
  assert.equal(r.status, 400);

  a.ws.send(JSON.stringify({ type: 'nudge', channelId: textId }));
  const n = await b.wait((m) => m.type === 'nudge');
  assert.equal(n.name, 'Ana');
  a.ws.send(JSON.stringify({ type: 'nudge', channelId: textId }));
  await a.wait((m) => m.type === 'nudge-wait');
  a.ws.close(); b.ws.close();
});

test('conversa privada: só entre contatos, em tempo real, com não lidas', async () => {
  const anaId = (await call('GET', '/api/me', null, ana)).data.user.id;
  const biaId = (await call('GET', '/api/me', null, bia)).data.user.id;
  const caio = (await call('POST', '/api/register', { username: 'caio', password: '123456', displayName: 'Caio' })).data.token;
  assert.equal((await call('POST', `/api/dm/${anaId}/messages`, { text: 'oi' }, caio)).status, 404, 'sem servidor em comum');
  assert.equal((await call('GET', `/api/dm/${anaId}/messages`, null, caio)).status, 404);
  assert.equal((await call('POST', `/api/dm/${anaId}/messages`, { text: 'eu mesma' }, ana)).status, 400, 'consigo mesma');

  const a = await socket(ana);
  const b = await socket(bia);
  await b.wait((m) => m.type === 'hello');
  let r = await call('POST', `/api/dm/${biaId}/messages`, { text: 'oi bia, só pra você' }, ana);
  assert.equal(r.status, 200);
  const got = await b.wait((m) => m.type === 'dm');
  assert.equal(got.message.text, 'oi bia, só pra você');
  assert.equal(got.from.displayName, 'Ana');
  await a.wait((m) => m.type === 'dm', 2000);
  await call('POST', `/api/dm/${biaId}/messages`, { text: 'segunda' }, ana);

  r = await call('GET', '/api/dm', null, bia);
  assert.equal(r.data.conversations.length, 1);
  assert.equal(r.data.conversations[0].user.displayName, 'Ana');
  assert.equal(r.data.conversations[0].unread, 2);
  r = await call('GET', `/api/dm/${anaId}/messages`, null, bia);
  assert.deepEqual(r.data.messages.map((m) => m.text), ['oi bia, só pra você', 'segunda']);
  assert.equal((await call('POST', `/api/dm/${anaId}/read`, null, bia)).status, 200);
  assert.equal((await call('GET', '/api/dm', null, bia)).data.conversations[0].unread, 0);
  assert.equal((await call('GET', '/api/dm', null, ana)).data.conversations[0].unread, 0, 'quem mandou não tem não lidas');
  assert.equal((await call('GET', '/api/dm', null, caio)).data.conversations.length, 0);

  b.ws.send(JSON.stringify({ type: 'typing', toUserId: anaId }));
  assert.equal((await a.wait((m) => m.type === 'typing')).dmUserId, biaId);
  b.ws.send(JSON.stringify({ type: 'nudge', toUserId: anaId }));
  const n = await a.wait((m) => m.type === 'nudge' && m.fromId === biaId);
  assert.equal(n.toId, anaId);
  a.ws.close(); b.ws.close();
});

test('imagens e arquivos no chat e na conversa particular', async () => {
  const up = async (buf, name, type, token = ana) => {
    const res = await fetch(base + '/api/files', { method: 'POST', body: buf, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } });
    return { status: res.status, data: await res.json() };
  };
  // Imagem maior que um pedaço (512 KB) para testar a remontagem
  const img = Buffer.alloc(1300 * 1024, 7);
  img.write('\x89PNG', 0, 'latin1');
  let r = await up(img, 'foto de férias.png', 'image/png');
  assert.equal(r.status, 200);
  const key = r.data.key;
  assert.equal(r.data.size, img.length);
  assert.equal((await up(Buffer.alloc(9 * 1024 * 1024), 'grande.bin', 'application/octet-stream')).status, 413);

  const sb = await socket(bia);
  await sb.wait((m) => m.type === 'hello');
  r = await call('POST', `/api/channels/${textId}/messages`, { text: '', fileKey: key }, ana);
  assert.equal(r.status, 200);
  assert.equal(r.data.file.name, 'foto de férias.png');
  const got = await sb.wait((m) => m.type === 'message' && m.message.file);
  assert.equal(got.message.file.key, key);
  assert.equal((await call('POST', `/api/channels/${textId}/messages`, { text: 'de novo', fileKey: key }, ana)).status, 400, 'mesmo arquivo duas vezes');
  r = await up(Buffer.from('x'), 'a.txt', 'text/plain', ana);
  assert.equal((await call('POST', `/api/channels/${textId}/messages`, { fileKey: r.data.key }, bia)).status, 400, 'arquivo de outra pessoa');

  let res = await fetch(`${base}/files/${key}/foto.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(img), 'arquivo volta inteiro');

  r = await up(Buffer.from('<svg onload=alert(1)>'), 'x.svg', 'image/svg+xml', bia);
  res = await fetch(`${base}/files/${r.data.key}`);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream', 'svg vira download');
  assert.match(res.headers.get('content-disposition'), /^attachment/);

  const anaId = (await call('GET', '/api/me', null, ana)).data.user.id;
  const doc = await up(Buffer.from('relatório'), 'relatório.pdf', 'application/pdf', bia);
  r = await call('POST', `/api/dm/${anaId}/messages`, { text: 'segue o arquivo', fileKey: doc.data.key }, bia);
  assert.equal(r.status, 200);
  assert.equal(r.data.file.mime, 'application/pdf');
  const hist = await call('GET', `/api/dm/${anaId}/messages`, null, bia);
  assert.equal(hist.data.messages.at(-1).file.name, 'relatório.pdf');

  const msgs = await call('GET', `/api/channels/${textId}/messages`, null, ana);
  const withFile = msgs.data.messages.find((m) => m.file?.key === key);
  assert.equal((await call('DELETE', `/api/messages/${withFile.id}`, null, ana)).status, 200);
  assert.equal((await fetch(`${base}/files/${key}`)).status, 404, 'apagar a mensagem apaga o arquivo');
  sb.ws.close();
});

test('foto de perfil', async () => {
  const up = async (buf, type, token) => (await fetch(base + '/api/files', { method: 'POST', body: buf, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'X-File-Name': 'foto.jpg' } })).json();
  const f1 = await up(Buffer.from('jpeg-1'), 'image/jpeg', bia);
  assert.equal((await call('PATCH', '/api/me', { avatarKey: f1.key }, bia)).status, 200);
  let r = await call('GET', `/api/servers/${serverId}`, null, ana);
  assert.equal(r.data.members.find((m) => m.displayName === 'Bia').avatarKey, f1.key);
  assert.equal((await call('GET', '/api/me', null, bia)).data.user.avatarKey, f1.key);
  assert.equal((await call('POST', `/api/channels/${textId}/messages`, { fileKey: f1.key }, bia)).status, 400, 'foto não vira anexo');
  const txt = await up(Buffer.from('oi'), 'text/plain', bia);
  assert.equal((await call('PATCH', '/api/me', { avatarKey: txt.key }, bia)).status, 400, 'só imagem');
  const alheia = await up(Buffer.from('x'), 'image/png', ana);
  assert.equal((await call('PATCH', '/api/me', { avatarKey: alheia.key }, bia)).status, 400, 'imagem de outra pessoa');
  const f2 = await up(Buffer.from('jpeg-2'), 'image/jpeg', bia);
  await call('PATCH', '/api/me', { avatarKey: f2.key }, bia);
  assert.equal((await fetch(`${base}/files/${f1.key}`)).status, 404, 'foto antiga apagada');
  await call('PATCH', '/api/me', { avatarKey: null }, bia);
  assert.equal((await call('GET', '/api/me', null, bia)).data.user.avatarKey, null);
  assert.equal((await fetch(`${base}/files/${f2.key}`)).status, 404);
});

test('editar, responder e reagir (canal e conversa particular)', async () => {
  const sb = await socket(bia);
  await sb.wait((m) => m.type === 'hello');
  let r = await call('POST', `/api/channels/${textId}/messages`, { text: 'pergunta: pizza hoje?' }, ana);
  const q = r.data;
  r = await call('POST', `/api/channels/${textId}/messages`, { text: 'bora!', replyTo: q.id }, bia);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.replyTo, { id: q.id, author: 'Ana', text: 'pergunta: pizza hoje?' });
  assert.equal((await call('POST', `/api/channels/${textId}/messages`, { text: 'x', replyTo: 999999 }, bia)).status, 400);

  assert.equal((await call('PATCH', `/api/messages/${q.id}`, { text: 'outra' }, bia)).status, 403, 'só o autor edita');
  r = await call('PATCH', `/api/messages/${q.id}`, { text: 'pergunta: pizza amanhã?' }, ana);
  assert.equal(r.status, 200);
  assert.ok(r.data.editedAt);
  const up = await sb.wait((m) => m.type === 'message-updated' && m.message.id === q.id);
  assert.equal(up.message.text, 'pergunta: pizza amanhã?');

  r = await call('POST', `/api/messages/${q.id}/reactions`, { emoji: '🔥' }, bia);
  assert.deepEqual(r.data.reactions.map((x) => x.emoji), ['🔥']);
  await call('POST', `/api/messages/${q.id}/reactions`, { emoji: '🔥' }, ana);
  r = await call('GET', `/api/channels/${textId}/messages`, null, ana);
  assert.equal(r.data.messages.find((m) => m.id === q.id).reactions[0].users.length, 2);
  r = await call('POST', `/api/messages/${q.id}/reactions`, { emoji: '🔥' }, bia);
  assert.deepEqual(r.data.reactions[0].users.length, 1, 'clicar de novo tira a reação');
  assert.equal((await call('POST', `/api/messages/${q.id}/reactions`, { emoji: '<b>' }, bia)).status, 400);

  const anaId = (await call('GET', '/api/me', null, ana)).data.user.id;
  const d1 = (await call('POST', `/api/dm/${anaId}/messages`, { text: 'oi particular' }, bia)).data;
  const d2 = (await call('POST', `/api/dm/${anaId}/messages`, { text: 'respondendo', replyTo: d1.id }, bia)).data;
  assert.equal(d2.replyTo.text, 'oi particular');
  assert.equal((await call('POST', `/api/dm/messages/${d1.id}/reactions`, { emoji: '❤️' }, ana)).data.reactions[0].emoji, '❤️');
  assert.equal((await call('PATCH', `/api/dm/messages/${d1.id}`, { text: 'mudei' }, ana)).status, 403);
  assert.equal((await call('PATCH', `/api/dm/messages/${d1.id}`, { text: 'oi editado' }, bia)).data.text, 'oi editado');
  assert.equal((await call('DELETE', `/api/dm/messages/${d1.id}`, null, ana)).status, 403);
  assert.equal((await call('DELETE', `/api/dm/messages/${d1.id}`, null, bia)).status, 200);
  r = await call('GET', `/api/dm/${anaId}/messages`, null, bia);
  assert.equal(r.data.messages.find((m) => m.id === d2.id).replyTo.deleted, true, 'citação de mensagem apagada');
  const caio = (await call('POST', '/api/login', { username: 'caio', password: '123456' })).data.token;
  assert.equal((await call('POST', `/api/dm/messages/${d2.id}/reactions`, { emoji: '👍' }, caio)).status, 404, 'quem não está na conversa');
  sb.ws.close();
});

test('amigos por nome de usuário: pedido, aceitar, conversar sem servidor e presença', async () => {
  const caio = (await call('POST', '/api/login', { username: 'caio', password: '123456' })).data.token;
  const dani = (await call('POST', '/api/register', { username: 'dani', password: '123456', displayName: 'Dani' })).data.token;
  const caioId = (await call('GET', '/api/me', null, caio)).data.user.id;
  const daniId = (await call('GET', '/api/me', null, dani)).data.user.id;
  assert.equal((await call('POST', `/api/dm/${daniId}/messages`, { text: 'oi' }, caio)).status, 404, 'ainda não são amigos');

  assert.equal((await call('POST', '/api/friends', { username: 'ninguem' }, caio)).status, 404);
  assert.equal((await call('POST', '/api/friends', { username: 'caio' }, caio)).status, 400, 'a si mesmo');
  const sd = await socket(dani);
  await sd.wait((m) => m.type === 'hello');
  let r = await call('POST', '/api/friends', { username: '@Dani' }, caio);
  assert.equal(r.status, 200);
  assert.equal(r.data.accepted, false);
  await sd.wait((m) => m.type === 'friends' && m.fromId === caioId);
  assert.equal((await call('POST', '/api/friends', { username: 'dani' }, caio)).status, 409, 'pedido repetido');
  assert.deepEqual((await call('GET', '/api/friends', null, caio)).data.outgoing.map((u) => u.username), ['dani']);
  r = await call('GET', '/api/friends', null, dani);
  assert.deepEqual(r.data.incoming.map((u) => u.username), ['caio']);
  assert.equal(r.data.friends.length, 0);
  assert.equal((await call('POST', `/api/dm/${daniId}/messages`, { text: 'oi' }, caio)).status, 404, 'pedido sem resposta não libera conversa');
  assert.equal((await call('POST', `/api/friends/${daniId}/accept`, null, caio)).status, 404, 'quem pediu não aceita');

  assert.equal((await call('POST', `/api/friends/${caioId}/accept`, null, dani)).status, 200);
  r = await call('GET', '/api/friends', null, caio);
  assert.deepEqual(r.data.friends.map((u) => [u.username, u.status]), [['dani', 'online']]);
  assert.equal(r.data.outgoing.length, 0);
  assert.equal((await call('POST', `/api/dm/${daniId}/messages`, { text: 'agora sim' }, caio)).status, 200, 'amigos conversam sem servidor em comum');
  await sd.wait((m) => m.type === 'dm' && m.message.text === 'agora sim');

  // Presença chega para amigos mesmo sem servidor em comum
  const sc = await socket(caio);
  await sc.wait((m) => m.type === 'hello');
  sc.ws.send(JSON.stringify({ type: 'status', status: 'busy' }));
  const pres = await sd.wait((m) => m.type === 'presence' && m.userId === caioId && m.status === 'busy');
  assert.equal(pres.friend, true);

  assert.equal((await call('DELETE', `/api/friends/${caioId}`, null, dani)).status, 200);
  assert.equal((await call('GET', '/api/friends', null, caio)).data.friends.length, 0);
  // Quem já conversou continua podendo conversar (histórico), mas a presença para de chegar
  sd.inbox.length = 0;
  sc.ws.send(JSON.stringify({ type: 'status', status: 'away' }));
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(!sd.inbox.some((m) => m.type === 'presence' && m.userId === caioId));

  // Se os dois pedem, vira amizade na hora
  await call('POST', '/api/friends', { username: 'dani' }, caio);
  r = await call('POST', '/api/friends', { username: 'caio' }, dani);
  assert.equal(r.data.accepted, true);
  assert.equal((await call('GET', '/api/friends', null, dani)).data.friends.length, 1);
  sc.ws.close(); sd.ws.close();
});

test('mensalidade pelo Mercado Pago (servidor de mentira)', async () => {
  // Mercado Pago de mentira: guarda as preferências criadas e devolve os pagamentos da lista
  const mpPayments = [];
  const prefs = [];
  const mp = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const out = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== 'Bearer TESTE') return out(401, { message: 'token' });
      if (req.method === 'POST' && u.pathname === '/checkout/preferences') { prefs.push(JSON.parse(body)); return out(201, { id: 'p1', init_point: 'https://mp.test/pagar/p1' }); }
      if (u.pathname === '/v1/payments/search') return out(200, { results: mpPayments.filter((p) => p.external_reference === u.searchParams.get('external_reference') && p.status === 'approved') });
      const m = u.pathname.match(/^\/v1\/payments\/(\d+)$/);
      if (m) { const p = mpPayments.find((x) => String(x.id) === m[1]); return p ? out(200, p) : out(404, {}); }
      out(404, {});
    });
  });
  await new Promise((r) => mp.listen(0, r));
  const pay = createApp({ dbFile: ':memory:', dbUrl: '', payments: createPayments({ token: 'TESTE', price: 15, apiBase: `http://127.0.0.1:${mp.address().port}`, publicUrl: 'https://st.test' }) });
  await new Promise((r) => pay.server.listen(0, r));
  const pbase = `http://127.0.0.1:${pay.server.address().port}`;
  const pcall = async (method, path, body, token) => {
    const res = await fetch(pbase + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  try {
    const t = (await pcall('POST', '/api/register', { username: 'eva', password: '123456' })).data.token;
    let r = await pcall('GET', '/api/me', null, t);
    assert.equal(r.data.billing.locked, true);
    assert.equal(r.data.billing.price, 15);
    assert.equal((await pcall('POST', '/api/servers', { name: 'x' }, t)).status, 402, 'sem pagar não usa');
    const closed = await new Promise((resolve) => {
      const ws = new WebSocket(`${pbase.replace('http', 'ws')}/ws?token=${t}`);
      ws.on('close', (code) => resolve(code));
    });
    assert.equal(closed, 4002);

    r = await pcall('POST', '/api/payment', null, t);
    assert.equal(r.data.url, 'https://mp.test/pagar/p1');
    const evaId = r.data && Number(prefs[0].external_reference.slice(5));
    assert.equal(prefs[0].items[0].unit_price, 15);
    assert.equal(prefs[0].notification_url, 'https://st.test/api/payment/webhook');

    // Pagamento pendente ou de valor menor não libera
    mpPayments.push({ id: 101, status: 'pending', external_reference: `user-${evaId}`, currency_id: 'BRL', transaction_amount: 15 });
    mpPayments.push({ id: 102, status: 'approved', external_reference: `user-${evaId}`, currency_id: 'BRL', transaction_amount: 1 });
    r = await pcall('POST', '/api/payment/check', null, t);
    assert.equal(r.data.billing.locked, true);

    // Aviso do Mercado Pago com pagamento aprovado libera 30 dias
    mpPayments.push({ id: 103, status: 'approved', external_reference: `user-${evaId}`, currency_id: 'BRL', transaction_amount: 15 });
    assert.equal((await pcall('POST', '/api/payment/webhook?type=payment&data.id=103', { type: 'payment', data: { id: '103' } })).status, 200);
    r = await pcall('GET', '/api/me', null, t);
    assert.equal(r.data.billing.locked, false);
    const until = r.data.billing.paidUntil;
    assert.ok(Math.abs(until - (Date.now() + 30 * 864e5)) < 60_000, '30 dias');
    assert.equal((await pcall('POST', '/api/servers', { name: 'x' }, t)).status, 200);

    // O mesmo pagamento não conta duas vezes; um novo soma mais 30 dias
    await pcall('POST', '/api/payment/webhook', { type: 'payment', data: { id: '103' } });
    r = await pcall('POST', '/api/payment/check', null, t);
    assert.equal(r.data.credited, 0);
    assert.equal(r.data.billing.paidUntil, until);
    mpPayments.push({ id: 104, status: 'approved', external_reference: `user-${evaId}`, currency_id: 'BRL', transaction_amount: 15 });
    r = await pcall('POST', '/api/payment/check', null, t);
    assert.equal(r.data.credited, 1);
    assert.equal(r.data.billing.paidUntil, until + 30 * 864e5);
  } finally {
    pay.close();
    mp.close();
  }
});

test('sem a chave do Mercado Pago, criar conta continua grátis', async () => {
  const r = await call('GET', '/api/me', null, ana);
  assert.equal(r.data.billing.enabled, false);
  assert.equal(r.data.billing.locked, false);
});

test('link para baixar o app do Windows', async () => {
  const res = await fetch(base + '/baixar', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /releases\/latest\/download\/StraightTalk-instalador\.exe$/);
  const p = await fetch(base + '/baixar/portatil', { redirect: 'manual' });
  assert.match(p.headers.get('location'), /StraightTalk-portatil\.exe$/);
});

test('sair e apagar servidor', async () => {
  assert.equal((await call('POST', `/api/servers/${serverId}/leave`, null, ana)).status, 400, 'dono não sai');
  assert.equal((await call('POST', `/api/servers/${serverId}/leave`, null, bia)).status, 200);
  assert.equal((await call('GET', `/api/servers/${serverId}`, null, bia)).status, 404);
  assert.equal((await call('DELETE', `/api/servers/${serverId}`, null, ana)).status, 200);
  const me = await call('GET', '/api/me', null, ana);
  assert.equal(me.data.servers.length, 0);
});
