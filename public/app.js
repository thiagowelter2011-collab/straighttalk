// StraightTalk — cliente (visual de mensageiro clássico: contatos com status, "diz:", chamar atenção)
// Contas, servidores, canais de texto e de voz, compartilhamento de tela.

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const { icon, iconEl } = window.Icons;
Icons.fill();

// Dentro do app do Windows não precisa do botão de baixar o app
if (window.straighttalkDesktop?.isDesktop) document.documentElement.classList.add('desktop');

const S = {
  token: localGet('st-token'),
  user: null,
  media: null,
  servers: [],
  serverId: Number(localGet('st-server')) || null,
  detail: null,                 // { server, channels, members, voice }
  view: 'empty',                // empty | text | voice | dm
  dmUserId: null,               // conversa privada aberta
  reply: null,                  // { key, id, author, text } mensagem sendo respondida
  dms: [],                      // [{ user, lastAt, unread }] conversas privadas, mais recente primeiro
  peers: new Map(),             // userId -> { id, displayName, personalMessage, status }
  textChannel: {},              // serverId -> channelId
  viewVoiceChannelId: null,
  ws: null,
  connId: null,
  messages: new Map(),          // channelId ou 'dm:<userId>' -> [{...}]
  hasMore: new Map(),           // mesma chave -> bool
  unread: new Set(),            // channelIds
  mentions: new Set(),          // channelIds com @menção a você ainda não vista
  unreadServers: new Set(),
  voiceState: new Map(),        // serverId -> { channelId: participants[] }
  voice: null,                  // { serverId, channelId, engine, mediaId, sharing, screenStreamId }
  muted: localGet('st-muted') === '1',
  deafened: localGet('st-deafened') === '1',
  screens: new Map(),           // mediaId -> { stream, el }
  cameras: new Map(),           // mediaId -> { stream, el, local? }
  friends: { friends: [], incoming: [], outgoing: [] },
  speaking: new Set(),          // mediaIds
  volumes: JSON.parse(localGet('st-volumes') || '{}'), // userId -> 0..1
  settings: JSON.parse(localGet('st-settings') || '{}'),
  typing: new Map(),            // channelId ou 'dm:<userId>' -> Map(userId -> {name, until})
  status: localGet('st-status') || 'online', // online | away | busy | invisible
};

/* ================= API ================= */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user) { logout(); throw new Error('Sessão expirada.'); }
  if (res.status === 402 && S.user) { location.reload(); throw new Error(data.error || 'Mensalidade vencida.'); }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

/* ================= Login ================= */

let registering = false;

function showAuth() {
  $('#auth-status').value = S.status;
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#auth-user').focus();
}

function setAuthMode(reg) {
  registering = reg;
  $('#field-display').classList.toggle('hidden', !reg);
  $('#auth-sub').textContent = reg ? 'Crie sua conta' : 'Que bom te ver de novo!';
  $('#auth-submit').textContent = reg ? 'Cadastrar' : 'Entrar';
  $('#auth-switch-text').textContent = reg ? 'Já tem uma conta?' : 'Precisa de uma conta?';
  $('#auth-switch').textContent = reg ? 'Entrar' : 'Cadastre-se';
  $('#auth-pass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
}

$('#auth-switch').addEventListener('click', (e) => { e.preventDefault(); setAuthMode(!registering); });

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const body = { username: $('#auth-user').value, password: $('#auth-pass').value, displayName: $('#auth-display').value };
    const { token } = await api('POST', registering ? '/api/register' : '/api/login', body);
    S.status = $('#auth-status').value;
    localSet('st-status', S.status);
    S.token = token;
    localSet('st-token', token);
    $('#auth-pass').value = '';
    await start();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

async function logout() {
  if (S.voice) leaveVoice();
  try { if (S.token) await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${S.token}` } }); } catch {}
  S.token = null;
  S.user = null;
  // Não deixa conversas da conta anterior na memória
  S.messages.clear();
  S.hasMore.clear();
  S.dms = [];
  S.friends = { friends: [], incoming: [], outgoing: [] };
  S.billing = {};
  S.peers.clear();
  S.dmUserId = null;
  S.view = 'empty';
  localDel('st-token');
  S.ws?.close();
  S.ws = null;
  showAuth();
}

/* ================= Início ================= */

async function start() {
  const me = await api('GET', '/api/me');
  S.billing = me.billing || {};
  if (S.billing.locked) return showPaywall(me.user);
  $('#paywall').classList.add('hidden');
  S.user = me.user;
  S.media = me.media;
  S.servers = me.servers;
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderMe();
  updateControls();
  connectWs();
  loadDms();
  loadFriends();
  renderBilling();
  warnBilling();
  if (new URLSearchParams(location.search).has('pagamento')) { history.replaceState(null, '', '/'); checkPayment(true); }
  await handlePendingInvite();
  const target = S.servers.find((s) => s.id === S.serverId) || S.servers[0];
  if (target) await selectServer(target.id); else renderAll();
}

async function boot() {
  const m = location.pathname.match(/^\/convite\/([\w-]+)/);
  if (m) {
    sessionSet('st-invite', m[1]);
    history.replaceState(null, '', '/');
  }
  if (!S.token) {
    if (sessionGet('st-invite')) setAuthMode(true);
    return showAuth();
  }
  try {
    await start();
  } catch {
    showAuth();
  }
}

/* ================= Mensalidade ================= */

const money = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const day = (t) => new Date(t).toLocaleDateString('pt-BR');
let payPoll = null;

function showPaywall(user) {
  $('#auth').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#paywall').classList.remove('hidden');
  $('#pay-price').textContent = money(S.billing.price);
  $('#pay-title').textContent = S.billing.paidUntil
    ? `Sua mensalidade venceu em ${day(S.billing.paidUntil)}`
    : `Oi, ${user.displayName}! Falta só a mensalidade`;
  $('#pay-msg').textContent = '';
  // Voltou do Mercado Pago: confere na hora
  if (new URLSearchParams(location.search).has('pagamento')) {
    history.replaceState(null, '', '/');
    checkPayment(true);
  }
}

async function openPayment() {
  const { url } = await api('POST', '/api/payment');
  // No app do Windows o link abre no navegador; no site, numa aba nova
  const w = window.open(url, '_blank');
  if (!w && !window.desktop) location.href = url;
}

// quiet: conferência automática, sem mensagem se ainda não caiu
async function checkPayment(quiet) {
  try {
    const { billing } = await api('POST', '/api/payment/check');
    S.billing = billing;
    if (!billing.locked) {
      clearInterval(payPoll);
      payPoll = null;
      if (!$('#paywall').classList.contains('hidden')) {
        $('#paywall').classList.add('hidden');
        await start();
      }
      toast(`Pagamento confirmado! Liberado até ${day(billing.paidUntil)}.`);
      renderBilling();
      return true;
    }
    if (!quiet) $('#pay-msg').textContent = 'Ainda não encontramos o pagamento. Pix costuma cair em segundos; cartão pode levar alguns minutos.';
  } catch (err) {
    if (!quiet) $('#pay-msg').textContent = err.message;
  }
  return false;
}

// Depois de abrir o pagamento, confere sozinho por 15 minutos
function watchPayment() {
  clearInterval(payPoll);
  const until = Date.now() + 15 * 60_000;
  payPoll = setInterval(() => {
    if (Date.now() > until) { clearInterval(payPoll); payPoll = null; return; }
    if (!document.hidden) checkPayment(true);
  }, 8000);
}

$('#pay-go').onclick = async () => {
  $('#pay-go').disabled = true;
  try {
    await openPayment();
    $('#pay-msg').textContent = 'Abrimos o Mercado Pago. Assim que o pagamento for aprovado, o StraightTalk libera sozinho.';
    watchPayment();
  } catch (err) {
    $('#pay-msg').textContent = err.message;
  } finally {
    $('#pay-go').disabled = false;
  }
};
$('#pay-check').onclick = () => checkPayment(false);
$('#pay-logout').onclick = (e) => { e.preventDefault(); $('#paywall').classList.add('hidden'); logout(); };
window.addEventListener('focus', () => { if (payPoll || !$('#paywall').classList.contains('hidden')) checkPayment(true); });

// Nas configurações: até quando está pago, e aviso quando faltam poucos dias
function renderBilling() {
  const b = S.billing || {};
  $('#set-admin').classList.toggle('hidden', !b.admin);
  const show = b.enabled && b.mustPay;
  $('#set-billing').classList.toggle('hidden', !show);
  if (!show) return;
  $('#set-billing-text').textContent = `Mensalidade de ${money(b.price)} paga até ${day(b.paidUntil)}.`;
}

$('#set-billing-pay').onclick = async () => {
  try {
    await openPayment();
    toast('Abrimos o Mercado Pago. Os 30 dias novos somam aos que você já tem.');
    watchPayment();
  } catch (err) { toast(err.message); }
};

// Painel do dono: assinantes e recebimentos
$('#set-admin').onclick = async () => {
  let d;
  try { d = await api('GET', '/api/admin/billing'); } catch (err) { return toast(err.message); }
  $('#adm-sub').textContent = d.enabled
    ? `Mensalidade de ${money(d.price)} ligada. Contas criadas antes da cobrança são grátis.`
    : 'A cobrança está desligada (falta MP_ACCESS_TOKEN no Render).';
  const card = (n, label, cls = '') => el('div', { className: 'adm-card ' + cls }, el('b', { textContent: n }), el('span', { textContent: label }));
  $('#adm-cards').replaceChildren(
    card(d.counts.active, 'assinantes em dia', 'good'),
    card(money(d.revenue.month), `recebido este mês (${d.revenue.monthCount})`, 'good'),
    card(money(d.revenue.total), `recebido no total (${d.revenue.totalCount})`),
    card(d.counts.expired, 'com mensalidade vencida', d.counts.expired ? 'warn' : ''),
    card(d.counts.neverPaid, 'criaram conta e não pagaram'),
    card(d.counts.free, `contas grátis (de ${d.counts.users})`),
  );
  const list = $('#adm-list');
  list.innerHTML = '';
  if (!d.payments.length) list.append(el('p', { className: 'muted small', textContent: 'Nenhum pagamento ainda.' }));
  for (const p of d.payments) {
    const ok = p.paidUntil && p.paidUntil > Date.now();
    list.append(el('div', { className: 'adm-row' },
      el('span', { className: 'who' }, el('b', { textContent: p.displayName }), ` @${p.username}`),
      el('span', { textContent: money(p.amount) }),
      el('span', { className: 'muted', textContent: day(p.createdAt) }),
      el('span', { className: ok ? 'tag good' : 'tag warn', textContent: ok ? `até ${day(p.paidUntil)}` : 'vencida' })));
  }
  $('#dlg-admin').showModal();
};

function warnBilling() {
  const b = S.billing || {};
  if (!b.enabled || !b.mustPay || !b.paidUntil) return;
  const days = Math.ceil((b.paidUntil - Date.now()) / 864e5);
  if (days <= 3) toast(`Sua mensalidade vence ${days <= 1 ? 'amanhã' : `em ${days} dias`}. Renove em Configurações.`);
}

async function handlePendingInvite() {
  const code = sessionGet('st-invite');
  if (!code) return;
  sessionDel('st-invite');
  await acceptInvite(code);
}

async function acceptInvite(code) {
  try {
    const info = await api('GET', `/api/invites/${encodeURIComponent(code)}`);
    if (S.servers.some((s) => s.id === info.serverId)) return selectServer(info.serverId);
    const ok = await formDialog({
      title: `Entrar em ${info.name}?`,
      text: `Você foi convidado para o servidor ${info.name} (${info.members} ${info.members === 1 ? 'membro' : 'membros'}).`,
      okText: 'Aceitar convite',
    });
    if (!ok) return;
    const { serverId } = await api('POST', `/api/invites/${encodeURIComponent(code)}`);
    await refreshServers();
    await selectServer(serverId);
  } catch (err) {
    toast(err.message);
  }
}

async function refreshServers() {
  const me = await api('GET', '/api/me');
  S.servers = me.servers;
  S.user = me.user;
  renderMe();
  renderRail();
}

async function selectServer(id) {
  S.serverId = id;
  localSet('st-server', id);
  S.unreadServers.delete(id);
  try {
    S.detail = await api('GET', `/api/servers/${id}`);
  } catch (err) {
    toast(err.message);
    S.detail = null;
  }
  if (S.detail) S.voiceState.set(id, S.detail.voice);
  const texts = S.detail?.channels.filter((c) => c.type === 'text') || [];
  const remembered = texts.find((c) => c.id === S.textChannel[id]);
  if (S.voice?.serverId === id && S.view === 'voice') {
    S.viewVoiceChannelId = S.voice.channelId;
  } else if (remembered || texts[0]) {
    await openText((remembered || texts[0]).id);
    return;
  } else {
    S.view = 'empty';
  }
  renderAll();
}

async function reloadDetail() {
  if (!S.serverId) return;
  try {
    S.detail = await api('GET', `/api/servers/${S.serverId}`);
    S.voiceState.set(S.serverId, S.detail.voice);
  } catch {
    return;
  }
  const ids = new Set(S.detail.channels.map((c) => c.id));
  if (S.view === 'text' && !ids.has(S.textChannel[S.serverId])) {
    const first = S.detail.channels.find((c) => c.type === 'text');
    if (first) return openText(first.id);
    S.view = 'empty';
  }
  if (S.view === 'voice' && !ids.has(S.viewVoiceChannelId)) S.view = 'empty';
  renderAll();
}

/* ================= Tempo real ================= */

let wsRetry = 0;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(S.token)}&status=${S.status}`);
  S.ws = ws;
  setStatus('conectando…');

  ws.onopen = () => { wsRetry = 0; setStatus('conectado'); };
  ws.onclose = (ev) => {
    if (S.ws !== ws) return;
    if (ev.code === 4001) return logout();
    if (ev.code === 4002) return location.reload();
    setStatus('reconectando…');
    S.connId = null;
    setTimeout(() => { if (S.ws === ws && S.user) connectWs(); }, Math.min(1000 * 2 ** wsRetry++, 10000));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onWs(msg).catch((err) => console.error(err));
  };
}

function wsSend(obj) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

async function onWs(msg) {
  switch (msg.type) {
    case 'hello': {
      const reconnecting = !!S.voice;
      S.connId = msg.connId;
      wsSend({ type: 'status', status: S.status });
      if (reconnecting) {
        // Reconectou: entra de novo no canal de voz em que estava
        const ch = S.voice.channelId;
        leaveVoice();
        joinVoice(ch).catch(() => {});
      }
      if (S.serverId) reloadDetail();
      loadDms();
      loadFriends();
      break;
    }
    case 'message': {
      const m = msg.message;
      const list = S.messages.get(m.channelId);
      if (list && !list.some((x) => x.id === m.id)) list.push(m);
      clearTyping(m.channelId, m.userId);
      const visible = S.view === 'text' && S.serverId === msg.serverId && S.textChannel[S.serverId] === m.channelId;
      const mentioned = m.userId !== S.user.id && mentionsMe(m.text);
      if (m.userId !== S.user.id) {
        if (!visible || document.hidden) { Sounds.play(mentioned ? 'nudge' : 'message'); flashTitle(`${m.author} diz: ${preview(m)}`); }
        const sname = S.servers.find((x) => x.id === msg.serverId)?.name || '';
        if (mentioned && !visible) toast(`${m.author} mencionou você: ${preview(m).slice(0, 80)}`);
        notify(mentioned ? `${m.author} mencionou você (${sname})` : `${m.author} diz: (${sname})`, preview(m), 'ch' + m.channelId, async () => {
          if (S.serverId !== msg.serverId) await selectServer(msg.serverId);
          openText(m.channelId);
        });
      }
      if (visible) appendMessage(m, m.channelId);
      else if (m.userId !== S.user.id) {
        S.unread.add(m.channelId);
        if (mentioned) S.mentions.add(m.channelId);
        if (msg.serverId !== S.serverId) S.unreadServers.add(msg.serverId);
        renderRail();
        renderChannels();
        updateBadge();
      }
      break;
    }
    case 'message-deleted':
      removeMessage(msg.channelId, msg.messageId);
      break;
    case 'message-updated':
    case 'dm-updated':
      updateMessage(msg.message);
      break;
    case 'dm-deleted':
      removeMessage('dm:' + (msg.fromId === S.user.id ? msg.toId : msg.fromId), msg.messageId);
      break;
    case 'dm':
      onDm(msg);
      break;
    case 'dm-read': {
      const c = S.dms.find((x) => x.user.id === msg.userId);
      if (c && c.unread) { c.unread = 0; renderDmList(); renderMembers(); }
      break;
    }
    case 'voice': {
      const st = S.voiceState.get(msg.serverId) || {};
      st[msg.channelId] = msg.participants;
      S.voiceState.set(msg.serverId, st);
      if (S.voice?.channelId === msg.channelId) {
        S.voice.engine.updateParticipants(msg.participants);
        const ids = new Set(msg.participants.map((p) => p.mediaId));
        for (const id of [...S.screens.keys()]) {
          const p = msg.participants.find((x) => x.mediaId === id);
          if (id !== S.voice.mediaId && (!ids.has(id) || (p && !p.sharing))) S.screens.delete(id);
        }
        for (const id of [...S.cameras.keys()]) {
          const p = msg.participants.find((x) => x.mediaId === id);
          if (id !== S.voice.mediaId && (!ids.has(id) || (p && !p.camera))) S.cameras.delete(id);
        }
      }
      if (msg.serverId === S.serverId) { renderChannels(); renderStage(); }
      break;
    }
    case 'friends': {
      const before = S.friends;
      await loadFriends();
      if (!msg.fromId || msg.fromId === S.user.id) break;
      const find = (list) => list.find((u) => u.id === msg.fromId);
      if (msg.accepted) {
        const u = find(S.friends.friends);
        if (u && !find(before.friends)) { Sounds.play('online'); toast(`${u.displayName} agora é seu amigo.`); }
      } else {
        const u = find(S.friends.incoming);
        if (u && !find(before.incoming)) {
          Sounds.play('message');
          toast(`${u.displayName} (@${u.username}) quer ser seu amigo.`);
          notify('Pedido de amizade', `${u.displayName} (@${u.username}) quer ser seu amigo.`, 'friend' + u.id);
        }
      }
      break;
    }
    case 'presence': {
      const peer = S.peers.get(msg.userId);
      if (msg.friend) {
        const f = S.friends.friends.find((x) => x.id === msg.userId);
        const cameOnline = f && f.status === 'offline' && msg.online;
        if (f) f.status = msg.status;
        // Quem está no servidor aberto já ganha o aviso pela lista de membros
        if (cameOnline && !S.detail?.members.some((m) => m.id === msg.userId)) { Sounds.play('online'); toast(`${f.displayName} acabou de entrar.`); }
      }
      if (peer && peer.status !== msg.status) {
        peer.status = msg.status || (msg.online ? 'online' : 'offline');
        renderDmList();
        if (S.view === 'dm' && S.dmUserId === msg.userId) renderMain();
      }
      if (S.detail && msg.serverId === S.serverId) {
        const m = S.detail.members.find((x) => x.id === msg.userId);
        if (m) {
          const cameOnline = !m.online && msg.online;
          m.online = msg.online;
          m.status = msg.status || (msg.online ? 'online' : 'offline');
          renderMembers();
          renderDmList();
          if (cameOnline && m.id !== S.user.id) { Sounds.play('online'); toast(`${m.displayName} acabou de entrar.`); }
        }
      }
      break;
    }
    case 'nudge': {
      const mine = msg.userId === S.user.id;
      const dmPeer = msg.fromId ? (mine ? msg.toId : msg.fromId) : null;
      const visible = dmPeer
        ? S.view === 'dm' && S.dmUserId === dmPeer
        : S.view === 'text' && S.serverId === msg.serverId && S.textChannel[S.serverId] === msg.channelId;
      if (visible) {
        const box = $('#messages');
        const who = dmPeer ? S.peers.get(dmPeer)?.displayName : null;
        box.append(el('div', { className: 'msg system nudge-line', textContent: mine ? `Você chamou a atenção ${who ? 'de ' + who : 'de todos'}.` : `${msg.name} chamou a sua atenção!` }));
        box.scrollTop = box.scrollHeight;
      } else if (!mine) toast(`${msg.name} chamou a sua atenção!`);
      if (!mine) {
        Sounds.play('nudge');
        flashTitle(`${msg.name} chamou a sua atenção!`);
        notify('📳 Chamar atenção', `${msg.name} chamou a sua atenção!`, 'nudge' + msg.userId, () => {
          if (dmPeer) openDm(dmPeer);
          else if (msg.serverId) selectServer(msg.serverId).then(() => openText(msg.channelId));
        });
        const app = $('#app');
        app.classList.remove('nudge');
        void app.offsetWidth;
        app.classList.add('nudge');
      }
      break;
    }
    case 'nudge-wait':
      toast('Espere alguns segundos para chamar atenção de novo.');
      break;
    case 'server-update':
      if (msg.serverId === S.serverId) await reloadDetail();
      await refreshServers();
      break;
    case 'server-removed':
      S.servers = S.servers.filter((s) => s.id !== msg.serverId);
      if (S.voice?.serverId === msg.serverId) leaveVoice();
      if (S.serverId === msg.serverId) {
        S.serverId = null;
        S.detail = null;
        S.view = 'empty';
        if (S.servers[0]) await selectServer(S.servers[0].id); else renderAll();
      } else renderRail();
      break;
    case 'voice-ended':
      if (S.voice) {
        leaveVoice();
        if (msg.reason === 'outra-aba') toast('Você entrou na voz em outra janela.');
      }
      break;
    case 'signal':
      S.voice?.engine.handleSignal(msg.from, msg.data);
      break;
    case 'typing':
      if (msg.userId === S.user.id) break;
      const key = msg.dmUserId ? 'dm:' + msg.dmUserId : msg.channelId;
      if (!S.typing.has(key)) S.typing.set(key, new Map());
      S.typing.get(key).set(msg.userId, { name: msg.name, until: Date.now() + 5000 });
      renderTyping();
      setTimeout(renderTyping, 5100);
      break;
  }
}

/* ================= Canais de texto ================= */

async function openText(channelId) {
  S.textChannel[S.serverId] = channelId;
  S.view = 'text';
  S.unread.delete(channelId);
  S.mentions.delete(channelId);
  updateBadge();
  closeDrawer();
  renderAll();
  if (!S.messages.has(channelId)) {
    try {
      const { messages } = await api('GET', `/api/channels/${channelId}/messages?limit=50`);
      S.messages.set(channelId, messages);
      S.hasMore.set(channelId, messages.length === 50);
    } catch (err) {
      toast(err.message);
      S.messages.set(channelId, []);
    }
    if (S.textChannel[S.serverId] === channelId) renderMessages();
  }
  if (matchMedia('(min-width: 721px)').matches) $('#chat-input').focus();
}

// A conversa aberta agora: um canal de texto do servidor ou uma conversa privada
function currentConv() {
  if (S.view === 'dm' && S.dmUserId) {
    const u = S.peers.get(S.dmUserId);
    return { key: 'dm:' + S.dmUserId, dm: true, userId: S.dmUserId, name: u?.displayName || 'Contato', url: `/api/dm/${S.dmUserId}/messages` };
  }
  const ch = S.view === 'text' ? currentChannel() : null;
  return ch ? { key: ch.id, dm: false, channel: ch, name: '#' + ch.name, url: `/api/channels/${ch.id}/messages` } : null;
}

async function loadOlder(conv) {
  const list = S.messages.get(conv.key) || [];
  const before = list[0]?.id;
  if (!before) return;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const { messages } = await api('GET', `${conv.url}?limit=50&before=${before}`);
  S.messages.set(conv.key, [...messages, ...list]);
  S.hasMore.set(conv.key, messages.length === 50);
  renderMessages(false);
  box.scrollTop = box.scrollHeight - prevHeight;
}

function currentChannel() {
  return S.detail?.channels.find((c) => c.id === S.textChannel[S.serverId]);
}

function renderMessages(scroll = true) {
  const box = $('#messages');
  box.innerHTML = '';
  const conv = currentConv();
  if (!conv) return;
  const list = S.messages.get(conv.key);
  if (!list) { box.append(el('div', { className: 'msg system', textContent: 'Carregando…' })); return; }
  if (S.hasMore.get(conv.key)) {
    const btn = el('button', { className: 'btn small load-more', textContent: 'Carregar mensagens antigas', type: 'button' });
    btn.onclick = () => loadOlder(conv).catch((e) => toast(e.message));
    box.append(btn);
  } else {
    if (conv.dm) box.append(dmCard(conv.userId));
    box.append(el('div', { className: 'msg system first', textContent: conv.dm
      ? `Esta é a sua conversa particular com ${conv.name}. Só vocês dois veem estas mensagens.`
      : `Este é o começo do canal ${conv.name}.` }));
  }
  let prev = null;
  for (const m of list) { box.append(messageNode(m, prev)); prev = m; }
  if (scroll) box.scrollTop = box.scrollHeight;
}

function appendMessage(m, key) {
  const box = $('#messages');
  const list = S.messages.get(key) || [];
  const prev = list[list.length - 2] || null;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.append(messageNode(m, prev));
  if (atBottom || m.userId === S.user.id) box.scrollTop = box.scrollHeight;
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];

function msgUrl(m) { return m.channelId ? `/api/messages/${m.id}` : `/api/dm/messages/${m.id}`; }
function msgKey(m) { return m.channelId ? m.channelId : 'dm:' + (m.fromId === S.user.id ? m.toId : m.fromId); }
function userName(id) {
  if (id === S.user.id) return 'Você';
  return S.detail?.members.find((x) => x.id === id)?.displayName || S.peers.get(id)?.displayName || 'Alguém';
}

function messageNode(m, prev) {
  const first = !prev || prev.userId !== m.userId || m.createdAt - prev.createdAt > 5 * 60_000 || !!m.replyTo;
  const node = el('div', { className: 'msg' + (first ? ' first' : '') + (m.userId !== S.user.id && mentionsMe(m.text) ? ' mentions-me' : '') });
  node.dataset.id = m.id;
  const avatar = el('div', { className: 'avatar' });
  paintAvatar(avatar, m.author, m.authorAvatar);
  const body = el('div', { className: 'body' });
  if (m.replyTo) {
    const q = el('button', { type: 'button', className: 'quote' }, iconEl('reply', 13));
    if (m.replyTo.deleted) q.append(el('span', { className: 'q-text', textContent: 'Mensagem apagada' }));
    else {
      q.append(el('b', { textContent: m.replyTo.author }));
      const qt = el('span', { className: 'q-text' });
      linkify(qt, m.replyTo.text, true);
      q.append(qt);
      q.onclick = () => jumpTo(m.replyTo.id);
    }
    body.append(q);
  }
  if (first) {
    const author = el('span', { className: 'author', textContent: m.author });
    body.append(el('div', { className: 'head' }, author, el('span', { className: 'time', textContent: fmtTime(m.createdAt) })));
  }
  if (m.pinnedAt) body.append(el('div', { className: 'pinned-label' }, iconEl('pin', 12), ' Fixada'));
  if (m.text || m.editedAt) {
    const text = el('div', { className: 'text' });
    linkify(text, m.text, true);
    if (m.editedAt) text.append(el('span', { className: 'edited', textContent: ' (editado)', title: 'Editado ' + fmtTime(m.editedAt) }));
    if (!first) text.title = fmtTime(m.createdAt);
    body.append(text);
  }
  if (m.file) body.append(fileNode(m.file));
  if (m.reactions?.length) {
    const row = el('div', { className: 'reactions' });
    for (const r of m.reactions) {
      const mine = r.users.includes(S.user.id);
      const b = el('button', { type: 'button', className: 'reaction' + (mine ? ' mine' : ''), title: r.users.map(userName).join(', ') },
        el('span', { className: 'r-emoji', textContent: r.emoji }), el('span', { className: 'r-count', textContent: String(r.users.length) }));
      b.onclick = () => react(m, r.emoji);
      row.append(b);
    }
    body.append(row);
  }
  node.append(avatar, body, messageActions(m, node));
  // Celular (sem mouse): tocar na mensagem mostra as ações
  node.onclick = (e) => {
    if (!matchMedia('(hover: none)').matches || e.target.closest('a, button, textarea, video, audio')) return;
    document.querySelectorAll('.msg.show-actions').forEach((x) => { if (x !== node) x.classList.remove('show-actions'); });
    node.classList.toggle('show-actions');
  };
  return node;
}

// Barra que aparece ao passar o mouse: reagir, responder, editar, apagar
function messageActions(m, node) {
  const mine = m.userId === S.user.id;
  const bar = el('div', { className: 'msg-actions' });
  const btn = (ic, title, fn) => {
    const b = el('button', { type: 'button', title }, iconEl(ic, 16));
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    bar.append(b);
    return b;
  };
  btn('smile-plus', 'Reagir', (b) => {
    const open = bar.querySelector('.react-picker');
    document.querySelectorAll('.react-picker').forEach((x) => x.remove());
    if (open) return;
    const pick = el('div', { className: 'react-picker' });
    for (const e of REACTIONS) {
      const o = el('button', { type: 'button', textContent: e });
      o.onclick = (ev) => { ev.stopPropagation(); pick.remove(); react(m, e); };
      pick.append(o);
    }
    b.after(pick);
  });
  btn('reply', 'Responder', () => startReply(m));
  btn('pin', m.pinnedAt ? 'Desafixar' : 'Fixar na conversa', async () => {
    try { updateMessage(await api('POST', `${msgUrl(m)}/pin`, { pinned: !m.pinnedAt })); toast(m.pinnedAt ? 'Mensagem desafixada.' : 'Mensagem fixada. Veja todas no botão de alfinete lá em cima.'); }
    catch (err) { toast(err.message); }
  });
  if (mine) btn('edit', 'Editar', () => startEdit(m, node));
  if (mine || (m.channelId && S.detail?.server.ownerId === S.user.id)) {
    const del = btn('trash', 'Apagar mensagem', async () => {
      if (!(await formDialog({ title: 'Apagar mensagem?', text: preview(m).slice(0, 200), okText: 'Apagar', danger: true }))) return;
      api('DELETE', msgUrl(m)).catch((e) => toast(e.message));
    });
    del.classList.add('danger');
  }
  return bar;
}
document.addEventListener('click', (e) => { if (!e.target.closest('.react-picker')) document.querySelectorAll('.react-picker').forEach((x) => x.remove()); });

async function react(m, emoji) {
  try { updateMessage(await api('POST', `${msgUrl(m)}/reactions`, { emoji })); } catch (err) { toast(err.message); }
}

// Troca uma mensagem já carregada (edição ou reação) e redesenha só ela
function updateMessage(m) {
  const key = msgKey(m);
  const list = S.messages.get(key);
  if (!list) return;
  const i = list.findIndex((x) => x.id === m.id);
  if (i < 0) return;
  list[i] = m;
  if (currentConv()?.key !== key) return;
  const node = $(`#messages .msg[data-id="${m.id}"]`);
  if (node && !node.classList.contains('editing')) node.replaceWith(messageNode(m, list[i - 1] || null));
}

function removeMessage(key, id) {
  const list = S.messages.get(key);
  if (list) S.messages.set(key, list.filter((x) => x.id !== id));
  if (currentConv()?.key === key) renderMessages(false);
}

async function jumpTo(id) {
  let node = $(`#messages .msg[data-id="${id}"]`);
  // Mensagem antiga: vai carregando para trás até achar (no máximo umas 1500 mensagens)
  const conv = currentConv();
  for (let i = 0; !node && conv && i < 30 && S.hasMore.get(conv.key) && currentConv()?.key === conv.key; i++) {
    try { await loadOlder(conv); } catch { break; }
    node = $(`#messages .msg[data-id="${id}"]`);
  }
  if (!node) return toast('Não achei essa mensagem (pode ter sido apagada).');
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

/* Responder */
function startReply(m) {
  const conv = currentConv();
  if (!conv) return;
  S.reply = { key: conv.key, id: m.id, author: m.author, text: preview(m) };
  renderReplyBar();
  input.focus();
}
function cancelReply() { S.reply = null; renderReplyBar(); }
function renderReplyBar() {
  const bar = $('#reply-bar');
  const r = S.reply && S.reply.key === currentConv()?.key ? S.reply : null;
  bar.classList.toggle('hidden', !r);
  if (!r) return;
  const x = el('button', { type: 'button', className: 'icon-btn small', title: 'Cancelar resposta (Esc)' }, iconEl('x', 14));
  x.onclick = cancelReply;
  bar.replaceChildren(iconEl('reply', 14), el('span', {}, 'Respondendo a ', el('b', { textContent: r.author }), ': '),
    el('span', { className: 'q-text', textContent: r.text.slice(0, 120) }), x);
}

/* Editar na própria mensagem: Enter salva, Esc cancela */
function startEdit(m, node) {
  if (node.classList.contains('editing')) return;
  node.classList.add('editing');
  const box = el('div', { className: 'edit-box' });
  const ta = el('textarea', { value: m.text || '', rows: 1, maxLength: 4000 });
  const hint = el('div', { className: 'edit-hint', textContent: 'Enter salva · Esc cancela' });
  box.append(ta, hint);
  const textEl = node.querySelector('.text');
  if (textEl) textEl.replaceWith(box); else node.querySelector('.body').append(box);
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  fit();
  ta.oninput = fit;
  const close = () => {
    const list = S.messages.get(msgKey(m)) || [];
    const cur = list.find((x) => x.id === m.id) || m;
    const i = list.indexOf(cur);
    node.replaceWith(messageNode(cur, list[i - 1] || null));
  };
  ta.onkeydown = async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); input.focus(); }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = ta.value.trim();
      if (text === (m.text || '')) return close();
      try {
        const updated = await api('PATCH', msgUrl(m), { text });
        node.classList.remove('editing');
        const list = S.messages.get(msgKey(m));
        const i = list ? list.findIndex((x) => x.id === m.id) : -1;
        if (i >= 0) list[i] = updated;
        close();
      } catch (err) { toast(err.message); }
    }
  };
}

function preview(m) {
  return m.text || (m.file ? `📎 ${m.file.name}` : '');
}

function fileUrl(f) { return `/files/${f.key}/${encodeURIComponent(f.name)}`; }

function fmtSize(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

// Imagem, vídeo e áudio aparecem no chat; outros arquivos viram um cartão para baixar
function fileNode(f) {
  const url = fileUrl(f);
  const box = el('div', { className: 'attachment' });
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.mime)) {
    const img = el('img', { src: url, alt: f.name, loading: 'lazy', title: `${f.name} (${fmtSize(f.size)})` });
    img.onload = () => {
      const msgs = $('#messages');
      if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < img.clientHeight + 120) msgs.scrollTop = msgs.scrollHeight;
    };
    box.append(el('a', { href: url, target: '_blank', rel: 'noopener', className: 'att-img' }, img));
  } else if (/^video\/(mp4|webm)$/.test(f.mime)) {
    box.append(el('video', { src: url, controls: true, preload: 'metadata', className: 'att-video' }));
  } else if (/^audio\//.test(f.mime)) {
    box.append(el('audio', { src: url, controls: true, preload: 'metadata' }));
  } else {
    box.append(el('a', { href: url, className: 'att-file', download: f.name },
      el('span', { className: 'att-icon' }, iconEl('file', 22)),
      el('span', { className: 'att-name', textContent: f.name }),
      el('span', { className: 'att-size', textContent: fmtSize(f.size) })));
  }
  return box;
}

// Envia imagens/arquivos para a conversa aberta (botão 📎, colar ou arrastar)
async function sendFiles(files) {
  const conv = currentConv();
  if (!conv || !files.length) return;
  for (const file of files) {
    if (file.size > 8 * 1024 * 1024) { toast(`${file.name || 'Arquivo'} passa de 8 MB.`); continue; }
    const name = file.name || `imagem-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${(file.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`;
    toast(`Enviando ${name}…`);
    try {
      const res = await fetch('/api/files', {
        method: 'POST', body: file,
        headers: { Authorization: `Bearer ${S.token}`, 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
      });
      const up = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(up.error || `Erro ${res.status}`);
      const m = await api('POST', conv.url, { text: '', fileKey: up.key });
      const list = S.messages.get(conv.key);
      if (list && !list.some((x) => x.id === m.id)) { list.push(m); if (currentConv()?.key === conv.key) appendMessage(m, conv.key); }
      toast(`${name} enviado.`);
    } catch (err) {
      toast(`Não foi possível enviar ${name}: ${err.message}`);
    }
  }
}

$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = () => {
  const files = [...$('#file-input').files];
  $('#file-input').value = '';
  sendFiles(files);
};

const input = $('#chat-input');
let lastTypingSent = 0;

input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); sendFiles(files); }
});
/* ---- @menções: lista que aparece ao digitar @ ---- */

let mentionSel = 0;
function mentionCandidates() {
  const before = input.value.slice(0, input.selectionStart);
  const m = before.match(/(?:^|[^\w.@])@([\w.]{0,32})$/);
  if (!m) return null;
  const q = m[1].toLowerCase();
  let people = [];
  if (S.view === 'text' && S.detail) people = S.detail.members;
  else if (S.view === 'dm') { const u = S.peers.get(S.dmUserId); if (u) people = [u]; }
  const list = people.filter((p) => p.id !== S.user.id && p.username &&
    (p.username.startsWith(q) || p.displayName.toLowerCase().includes(q))).slice(0, 8);
  return list.length ? { q, list, start: before.length - m[1].length - 1 } : null;
}
function renderMentionPop() {
  const pop = $('#mention-pop');
  const c = mentionCandidates();
  if (!c) { pop.classList.add('hidden'); return; }
  mentionSel = Math.min(mentionSel, c.list.length - 1);
  pop.replaceChildren(...c.list.map((p, i) => {
    const av = el('div', { className: 'avatar' });
    paintAvatar(av, p.displayName, p.avatarKey);
    const o = el('button', { type: 'button', className: 'mention-opt' + (i === mentionSel ? ' sel' : '') }, av, el('b', { textContent: p.displayName }), el('span', { textContent: '@' + p.username }));
    o.onmousedown = (e) => { e.preventDefault(); pickMention(p); };
    return o;
  }));
  pop.classList.remove('hidden');
}
function pickMention(p) {
  const c = mentionCandidates();
  if (!c) return;
  const end = input.selectionStart;
  input.value = input.value.slice(0, c.start) + '@' + p.username + ' ' + input.value.slice(end);
  const pos = c.start + p.username.length + 2;
  input.setSelectionRange(pos, pos);
  mentionSel = 0;
  $('#mention-pop').classList.add('hidden');
  input.focus();
}
function mentionKey(e) {
  if ($('#mention-pop').classList.contains('hidden')) return false;
  const c = mentionCandidates();
  if (!c) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : -1) + c.list.length) % c.list.length;
    renderMentionPop();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(c.list[mentionSel]); return true; }
  if (e.key === 'Escape') { e.preventDefault(); $('#mention-pop').classList.add('hidden'); return true; }
  return false;
}
input.addEventListener('blur', () => setTimeout(() => $('#mention-pop').classList.add('hidden'), 150));

/* ---- Painel lateral: busca e mensagens fixadas ---- */

function showSidePanel(title, messages, empty) {
  $('#side-title').textContent = title;
  const box = $('#side-list');
  box.innerHTML = '';
  if (!messages.length) box.append(el('p', { className: 'muted small side-empty', textContent: empty }));
  const conv = currentConv();
  for (const m of messages) {
    const ch = m.channelId && S.detail?.channels.find((c) => c.id === m.channelId);
    const item = el('button', { type: 'button', className: 'side-item' },
      el('div', { className: 'side-head' }, el('b', { textContent: m.author }),
        ch && ch.id !== conv?.channel?.id ? el('span', { className: 'muted', textContent: ' em #' + ch.name }) : null,
        el('span', { className: 'muted side-time', textContent: fmtTime(m.createdAt) })));
    const t = el('div', { className: 'side-text' });
    linkify(t, m.text || (m.file ? '📎 ' + m.file.name : ''), true);
    item.append(t);
    item.onclick = async () => {
      if (m.channelId && S.textChannel[S.serverId] !== m.channelId) await openText(m.channelId);
      jumpTo(m.id);
    };
    box.append(item);
  }
  $('#side-panel').classList.remove('hidden');
}

$('#side-close').onclick = () => $('#side-panel').classList.add('hidden');

$('#btn-pins').onclick = async () => {
  const conv = currentConv();
  if (!conv) return;
  if (!$('#side-panel').classList.contains('hidden') && $('#side-title').textContent.startsWith('Fixadas')) return $('#side-panel').classList.add('hidden');
  try {
    const { messages } = await api('GET', conv.dm ? `/api/dm/${conv.userId}/pins` : `/api/channels/${conv.channel.id}/pins`);
    showSidePanel(`Fixadas em ${conv.name}`, messages, 'Nenhuma mensagem fixada. Passe o mouse numa mensagem e clique no alfinete.');
  } catch (err) { toast(err.message); }
};

function openSearch() {
  const f = $('#search-form');
  f.classList.toggle('hidden');
  if (!f.classList.contains('hidden')) $('#search-input').focus();
}
$('#btn-search').onclick = openSearch;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && (S.view === 'text' || S.view === 'dm')) {
    e.preventDefault();
    $('#search-form').classList.remove('hidden');
    $('#search-input').focus();
    $('#search-input').select();
  }
});
$('#search-form').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  const conv = currentConv();
  if (!conv || !q) return;
  try {
    const { messages } = await api('GET', conv.dm ? `/api/dm/${conv.userId}/search?q=${encodeURIComponent(q)}` : `/api/servers/${S.serverId}/search?q=${encodeURIComponent(q)}`);
    showSidePanel(`Busca: "${q}"`, messages, 'Nada encontrado.');
  } catch (err) { toast(err.message); }
};
$('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#search-form').classList.add('hidden'); input.focus(); } });

const textView = $('#view-text');
textView.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  textView.classList.add('dropping');
});
textView.addEventListener('dragleave', (e) => { if (!textView.contains(e.relatedTarget)) textView.classList.remove('dropping'); });
textView.addEventListener('drop', (e) => {
  textView.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  sendFiles(files);
});

input.addEventListener('keydown', (e) => {
  if (mentionKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
  if (e.key === 'Escape' && S.reply) { e.preventDefault(); cancelReply(); }
  // Seta para cima com a caixa vazia: editar a última mensagem que você mandou
  if (e.key === 'ArrowUp' && !input.value) {
    const conv = currentConv();
    const last = conv && [...(S.messages.get(conv.key) || [])].reverse().find((x) => x.userId === S.user.id && (x.text || x.file));
    const node = last && $(`#messages .msg[data-id="${last.id}"]`);
    if (node) { e.preventDefault(); startEdit(last, node); }
  }
});
input.addEventListener('input', () => {
  renderMentionPop();
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
  const conv = currentConv();
  if (conv && input.value && Date.now() - lastTypingSent > 3000) {
    lastTypingSent = Date.now();
    wsSend(conv.dm ? { type: 'typing', toUserId: conv.userId } : { type: 'typing', channelId: conv.channel.id });
  }
});
$('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

async function sendMessage() {
  const conv = currentConv();
  const text = input.value.trim();
  if (!conv || !text) return;
  input.value = '';
  input.style.height = 'auto';
  lastTypingSent = 0;
  try {
    const reply = S.reply?.key === conv.key ? S.reply : null;
    const m = await api('POST', conv.url, { text, replyTo: reply?.id });
    if (reply && S.reply === reply) cancelReply();
    const list = S.messages.get(conv.key);
    if (list && !list.some((x) => x.id === m.id)) { list.push(m); if (currentConv()?.key === conv.key) appendMessage(m, conv.key); }
  } catch (err) {
    toast(err.message);
    input.value = text;
  }
}

function clearTyping(key, userId) {
  S.typing.get(key)?.delete(userId);
  renderTyping();
}

function renderTypingAndReply() { renderTyping(); renderReplyBar(); }

function renderTyping() {
  const conv = currentConv();
  const box = $('#typing');
  if (!conv) { box.textContent = ''; return; }
  const map = S.typing.get(conv.key);
  const names = map ? [...map.values()].filter((t) => t.until > Date.now()).map((t) => t.name) : [];
  box.textContent = !names.length ? '' :
    names.length === 1 ? `${names[0]} está digitando…` :
    names.length <= 3 ? `${names.join(', ')} estão digitando…` : 'Várias pessoas estão digitando…';
}

/* ================= Conversas privadas ================= */

// Topo da conversa particular: foto grande no quadrinho, como no MSN
function dmCard(userId) {
  const u = S.peers.get(userId) || {};
  const av = el('div', { className: 'avatar' });
  paintAvatar(av, u.displayName, u.avatarKey);
  const frame = el('div', { className: 'frame' }, av);
  frame.dataset.status = peerStatus(userId);
  const who = el('div', { className: 'who' }, el('div', { className: 'name', textContent: u.displayName || 'Contato' }));
  if (u.personalMessage) {
    const pm = el('div', { className: 'pm' });
    linkify(pm, u.personalMessage, true);
    who.append(pm);
  }
  const card = el('div', { className: 'dm-card' }, frame, who);
  const action = friendAction(userId, u);
  if (action) card.append(action);
  return card;
}

function rememberPeer(u) {
  if (!u || u.id === S.user?.id) return;
  const old = S.peers.get(u.id) || {};
  S.peers.set(u.id, { ...old, ...u, status: u.status || old.status || 'offline' });
}

function peerStatus(userId) {
  const m = S.detail?.members.find((x) => x.id === userId);
  if (m) return m.online ? (m.status || 'online') : 'offline';
  return S.peers.get(userId)?.status || 'offline';
}

/* ================= Amigos ================= */

const isFriend = (id) => S.friends.friends.some((f) => f.id === id);

async function loadFriends() {
  try {
    S.friends = await api('GET', '/api/friends');
  } catch { return; }
  for (const f of S.friends.friends) rememberPeer(f);
  for (const u of [...S.friends.incoming, ...S.friends.outgoing]) if (!S.peers.has(u.id)) rememberPeer(u);
  renderDmList();
  if (S.view === 'dm') renderMain();
}

async function addFriend(username) {
  const r = await api('POST', '/api/friends', { username });
  await loadFriends();
  const u = S.friends.friends.find((f) => f.id === r.userId) || S.friends.outgoing.find((f) => f.id === r.userId);
  toast(r.accepted ? `Vocês agora são amigos!` : `Pedido enviado para ${u?.displayName || username}.`);
  return r;
}

function addFriendDialog() {
  return formDialog({
    title: 'Adicionar amigo',
    text: 'Digite o nome de usuário da pessoa (o que ela usa para entrar). Quando ela aceitar, vocês podem conversar e ligar sem estar no mesmo servidor.',
    fields: [{ name: 'username', label: 'Nome de usuário', placeholder: 'ex.: bia', maxlength: 33 }],
    okText: 'Enviar pedido',
    onSubmit: ({ username }) => addFriend(username),
  });
}

async function answerFriend(userId, accept) {
  try {
    if (accept) await api('POST', `/api/friends/${userId}/accept`);
    else await api('DELETE', `/api/friends/${userId}`);
    await loadFriends();
  } catch (err) { toast(err.message); }
}

async function removeFriend(u) {
  const ok = await formDialog({ title: `Desfazer amizade com ${u.displayName}?`, text: 'Vocês continuam vendo as conversas antigas.', okText: 'Desfazer amizade', danger: true });
  if (ok) answerFriend(u.id, false);
}

// Botão do cartão da conversa particular, conforme a amizade
function friendAction(userId, u) {
  if (isFriend(userId)) return null;
  const btn = (text, iconName, cls, onclick) => {
    const b = el('button', { className: 'btn small ' + cls, type: 'button' }, iconEl(iconName, 15), ' ' + text);
    b.onclick = onclick;
    return b;
  };
  if (S.friends.incoming.some((x) => x.id === userId)) return btn('Aceitar amizade', 'check', 'primary', () => answerFriend(userId, true));
  if (S.friends.outgoing.some((x) => x.id === userId)) return el('span', { className: 'muted small-note', textContent: 'Pedido de amizade enviado' });
  if (!u.username) return null;
  return btn('Adicionar amigo', 'user-plus', 'primary', () => addFriend(u.username).catch((err) => toast(err.message)));
}

function renderFriends() {
  const ul = $('#friend-list');
  if (!ul) return;
  ul.innerHTML = '';
  const order = { online: 0, busy: 1, away: 2, offline: 3 };
  const rowFor = (u, extraClass, title) => {
    const av = el('div', { className: 'avatar' });
    paintAvatar(av, u.displayName, u.avatarKey);
    const frame = el('div', { className: 'frame' }, av);
    return el('li', { className: 'channel dm ' + extraClass, title }, frame);
  };
  const action = (iconName, title, fn) => {
    const b = el('button', { type: 'button', title }, iconEl(iconName, 15));
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };
  for (const u of S.friends.incoming) {
    const li = rowFor(u, 'friend-request', `@${u.username} quer ser seu amigo`);
    li.querySelector('.frame').dataset.status = 'offline';
    li.append(el('span', { className: 'ch-name' }, u.displayName, el('small', { textContent: ' quer ser seu amigo' })),
      el('span', { className: 'ch-actions always' }, action('check', 'Aceitar', () => answerFriend(u.id, true)), action('x', 'Recusar', () => answerFriend(u.id, false))));
    ul.append(li);
  }
  const friends = [...S.friends.friends].sort((a, b) => (order[peerStatus(a.id)] ?? 3) - (order[peerStatus(b.id)] ?? 3));
  for (const f of friends) {
    const u = S.peers.get(f.id) || f;
    const st = peerStatus(f.id);
    const c = S.dms.find((x) => x.user.id === f.id);
    const li = rowFor(u, st === 'offline' ? 'offline' : '', `@${u.username}: clique para conversar`);
    li.querySelector('.frame').dataset.status = st;
    li.append(el('span', { className: 'ch-name', textContent: u.displayName }));
    if (c?.unread) li.append(el('span', { className: 'badge', textContent: c.unread > 99 ? '99+' : String(c.unread) }));
    li.append(el('span', { className: 'ch-actions' }, action('x', 'Desfazer amizade', () => removeFriend(u))));
    if (S.view === 'dm' && S.dmUserId === f.id) li.classList.add('active');
    if (c?.unread) li.classList.add('unread');
    li.onclick = () => openDm(f.id);
    ul.append(li);
  }
  for (const u of S.friends.outgoing) {
    const li = rowFor(u, 'friend-pending', `Esperando @${u.username} aceitar`);
    li.querySelector('.frame').dataset.status = 'offline';
    li.append(el('span', { className: 'ch-name' }, u.displayName, el('small', { textContent: ' (pedido enviado)' })),
      el('span', { className: 'ch-actions' }, action('x', 'Cancelar pedido', () => answerFriend(u.id, false))));
    ul.append(li);
  }
  if (!ul.children.length) ul.append(el('li', { className: 'friends-empty muted', textContent: 'Adicione amigos pelo nome de usuário para conversar sem precisar de servidor.' }));
  $('#friends-count').textContent = S.friends.incoming.length ? String(S.friends.incoming.length) : '';
  $('#friends-count').classList.toggle('hidden', !S.friends.incoming.length);
}

async function loadDms() {
  try {
    const { conversations } = await api('GET', '/api/dm');
    S.dms = conversations;
    for (const c of conversations) rememberPeer(c.user);
  } catch { return; }
  renderDmList();
  renderMembers();
}

async function openDm(userId) {
  const member = S.detail?.members.find((m) => m.id === userId);
  if (member) rememberPeer({ id: member.id, username: member.username, displayName: member.displayName, personalMessage: member.personalMessage, avatarKey: member.avatarKey, status: peerStatus(member.id) });
  S.view = 'dm';
  S.dmUserId = userId;
  closeDrawer();
  $('#app').classList.remove('show-members');
  markDmRead(userId);
  renderAll();
  const key = 'dm:' + userId;
  if (!S.messages.has(key)) {
    try {
      const { messages, user } = await api('GET', `/api/dm/${userId}/messages?limit=50`);
      rememberPeer(user);
      S.messages.set(key, messages);
      S.hasMore.set(key, messages.length === 50);
    } catch (err) {
      toast(err.message);
      S.messages.set(key, []);
    }
    if (S.view === 'dm' && S.dmUserId === userId) renderMain();
  }
  if (matchMedia('(min-width: 721px)').matches) $('#chat-input').focus();
}

function markDmRead(userId) {
  const c = S.dms.find((x) => x.user.id === userId);
  if (!c?.unread) return;
  c.unread = 0;
  api('POST', `/api/dm/${userId}/read`).catch(() => {});
}

function onDm(msg) {
  const m = msg.message;
  const mine = m.fromId === S.user.id;
  const peerId = mine ? m.toId : m.fromId;
  const key = 'dm:' + peerId;
  if (!mine) rememberPeer(msg.from);
  const list = S.messages.get(key);
  if (list && !list.some((x) => x.id === m.id)) list.push(m);
  clearTyping(key, m.fromId);
  const visible = S.view === 'dm' && S.dmUserId === peerId;
  let c = S.dms.find((x) => x.user.id === peerId);
  if (!c) {
    const u = S.peers.get(peerId);
    if (!u) { loadDms(); } else { c = { user: u, lastAt: m.createdAt, unread: 0 }; S.dms.unshift(c); }
  }
  if (c) {
    c.lastAt = m.createdAt;
    S.dms = [c, ...S.dms.filter((x) => x !== c)];
    if (!mine && !(visible && !document.hidden)) c.unread++;
  }
  if (!mine) {
    if (!visible || document.hidden) { Sounds.play('message'); flashTitle(`${m.author} diz: ${preview(m)}`); }
    if (!visible) toast(`${m.author} diz: ${preview(m).slice(0, 80)}`);
    notify(`${m.author} diz:`, preview(m), 'dm' + peerId, () => openDm(peerId));
  }
  if (visible) {
    if (list) appendMessage(m, key);
    if (!mine && !document.hidden) api('POST', `/api/dm/${peerId}/read`).catch(() => {});
  }
  renderDmList();
  renderMembers();
  updateBadge();
}

// Ao voltar para a janela, a conversa aberta conta como lida
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.view === 'dm' && S.dmUserId) { markDmRead(S.dmUserId); renderDmList(); renderMembers(); }
});

function renderDmList() {
  updateBadge();
  renderFriends();
  const ul = $('#dm-list');
  if (!ul) return;
  ul.innerHTML = '';
  // Amigos já aparecem na lista de amigos; aqui ficam as outras conversas
  const others = S.dms.filter((c) => !isFriend(c.user.id));
  $('#dm-title').classList.toggle('hidden', !others.length);
  for (const c of others) {
    const u = S.peers.get(c.user.id) || c.user;
    const av = el('div', { className: 'avatar' });
    paintAvatar(av, u.displayName, u.avatarKey);
    const frame = el('div', { className: 'frame' }, av);
    frame.dataset.status = peerStatus(u.id);
    const li = el('li', { className: 'channel dm', title: 'Conversa particular com ' + u.displayName }, frame,
      el('span', { className: 'ch-name', textContent: u.displayName }),
      c.unread ? el('span', { className: 'badge', textContent: c.unread > 99 ? '99+' : String(c.unread) }) : null);
    if (S.view === 'dm' && S.dmUserId === u.id) li.classList.add('active');
    if (c.unread) li.classList.add('unread');
    li.onclick = () => openDm(u.id);
    ul.append(li);
  }
}

/* ================= Voz ================= */

function engineCallbacks() {
  return {
    onScreen(mediaId, stream, videoEl) {
      if (stream) S.screens.set(mediaId, { stream, el: videoEl || null });
      else S.screens.delete(mediaId);
      renderStage();
      renderChannels();
    },
    onCamera(mediaId, stream, videoEl) {
      if (stream) S.cameras.set(mediaId, { stream, el: videoEl || null });
      else S.cameras.delete(mediaId);
      renderStage();
    },
    onCameraEnded() {
      if (!S.voice) return;
      cameraOff();
    },
    onSpeaking(mediaId, on) {
      if (on) S.speaking.add(mediaId); else S.speaking.delete(mediaId);
      document.querySelectorAll(`[data-media="${CSS.escape(mediaId)}"]`).forEach((n) => n.classList.toggle('speaking', on));
    },
    onShareEnded() {
      if (!S.voice) return;
      S.voice.sharing = false;
      S.voice.screenStreamId = null;
      S.screens.delete(S.voice.mediaId);
      sendVoiceState();
      updateControls();
      renderStage();
    },
    onDisconnected() {
      if (!S.voice) return;
      toast('A conexão de voz caiu.');
      leaveVoice();
    },
    onMicError() {
      toast('Sem acesso ao microfone. Você entra só ouvindo.');
    },
  };
}

async function joinVoice(channelId) {
  if (S.voice?.channelId === channelId) { showVoiceView(channelId); return; }
  if (S.voice) leaveVoice();
  if (!S.connId) { toast('Ainda conectando, tente de novo.'); return; }
  const ch = S.detail.channels.find((c) => c.id === channelId);
  const settings = { ...S.settings };
  const engine = S.media.mode === 'livekit'
    ? new StraightTalkMedia.LiveKitEngine({
        settings,
        callbacks: engineCallbacks(),
        getToken: (id) => api('GET', `/api/voice/${id}/token?session=${encodeURIComponent(S.connId.slice(0, 8))}`),
      })
    : new StraightTalkMedia.P2PEngine({
        send: wsSend,
        iceServers: S.media.iceServers,
        myConnId: S.connId,
        settings,
        callbacks: engineCallbacks(),
      });
  engine.muted = S.muted;
  engine.deafened = S.deafened;
  S.voice = { serverId: S.serverId, channelId, channelName: ch?.name, engine, mediaId: null, sharing: false, screenStreamId: null, camera: false, cameraStreamId: null };
  showVoiceView(channelId);
  try {
    const mediaId = await engine.join(channelId);
    if (S.voice?.engine !== engine) { engine.leave(); return; }
    S.voice.mediaId = mediaId;
    engine.setMuted(S.muted);
    engine.setDeafened(S.deafened);
    for (const [uid, v] of Object.entries(S.volumes)) applyUserVolume(Number(uid), v);
    wsSend({ type: 'voice-join', channelId, mediaId, muted: S.muted, deafened: S.deafened });
  } catch (err) {
    console.error(err);
    if (S.voice?.engine === engine) leaveVoice();
    toast('Não foi possível entrar na voz: ' + (err.message || err));
  }
  updateControls();
  renderAll();
}

function leaveVoice() {
  if (!S.voice) return;
  S.voice.engine.leave();
  wsSend({ type: 'voice-leave' });
  S.voice = null;
  S.screens.clear();
  S.cameras.clear();
  S.speaking.clear();
  updateControls();
  renderAll();
}

function showVoiceView(channelId) {
  S.view = 'voice';
  S.viewVoiceChannelId = channelId;
  closeDrawer();
  renderAll();
}

function sendVoiceState() {
  if (!S.voice) return;
  wsSend({ type: 'voice-state', muted: S.muted, deafened: S.deafened, sharing: S.voice.sharing, screenStream: S.voice.screenStreamId,
    camera: S.voice.camera, cameraStream: S.voice.cameraStreamId });
}

function toggleMute() {
  S.muted = !S.muted;
  if (!S.muted && S.deafened) S.deafened = false;
  applyAudioState();
}

function toggleDeafen() {
  S.deafened = !S.deafened;
  S.muted = S.deafened;
  applyAudioState();
}

function applyAudioState() {
  localSet('st-muted', S.muted ? '1' : '0');
  localSet('st-deafened', S.deafened ? '1' : '0');
  if (S.voice) {
    S.voice.engine.setMuted(S.muted);
    S.voice.engine.setDeafened(S.deafened);
    sendVoiceState();
  }
  updateControls();
}

function applyUserVolume(userId, v) {
  if (!S.voice) return;
  const list = S.voiceState.get(S.voice.serverId)?.[S.voice.channelId] || [];
  for (const p of list) if (p.userId === userId) S.voice.engine.setVolume(p.mediaId, v);
}

async function toggleShare() {
  if (!S.voice) return toast('Entre num canal de voz primeiro.');
  if (S.voice.sharing) {
    S.voice.engine.stopShare();
    callbacksShareEnded();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Este navegador não permite compartilhar a tela.');
  $('#dlg-share').showModal();
}

let cameraBusy = false;
async function toggleCamera() {
  if (!S.voice) return toast('Entre num canal de voz primeiro.');
  if (cameraBusy) return;
  if (S.voice.camera) {
    S.voice.engine.stopCamera();
    cameraOff();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) return toast('Este navegador não permite usar a câmera.');
  cameraBusy = true;
  const voice = S.voice;
  try {
    const id = await voice.engine.startCamera({ deviceId: S.settings.camId });
    if (S.voice !== voice) { voice.engine.stopCamera(); return; }
    S.voice.camera = true;
    S.voice.cameraStreamId = id;
    S.cameras.set(S.voice.mediaId, { stream: S.voice.engine.localCamera, el: null, local: true });
    sendVoiceState();
    updateControls();
    renderStage();
    renderChannels();
  } catch (err) {
    console.error(err);
    if (err.name === 'NotAllowedError') toast('Sem permissão para usar a câmera.');
    else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') toast('Nenhuma câmera encontrada.');
    else toast('Não foi possível ligar a câmera.');
  } finally {
    cameraBusy = false;
  }
}

function cameraOff() {
  S.voice.camera = false;
  S.voice.cameraStreamId = null;
  S.cameras.delete(S.voice.mediaId);
  sendVoiceState();
  updateControls();
  renderStage();
  renderChannels();
}

function callbacksShareEnded() {
  S.voice.sharing = false;
  S.voice.screenStreamId = null;
  S.screens.delete(S.voice.mediaId);
  sendVoiceState();
  updateControls();
  renderStage();
  renderChannels();
}

$('#dlg-share').addEventListener('close', async () => {
  if ($('#dlg-share').returnValue !== 'ok' || !S.voice) return;
  const mode = $('#dlg-share input[name=mode]:checked').value;
  const audio = $('#share-audio').checked;
  try {
    const id = await S.voice.engine.startShare({ mode, audio });
    S.voice.sharing = true;
    S.voice.screenStreamId = id;
    S.screens.set(S.voice.mediaId, { stream: S.voice.engine.localScreen, el: null, local: true });
    sendVoiceState();
    updateControls();
    renderStage();
    renderChannels();
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Não foi possível compartilhar a tela.');
  }
});

/* ================= Render ================= */

function renderAll() {
  renderRail();
  renderChannels();
  renderDmList();
  renderMain();
  renderMembers();
}

function renderMe() {
  $('#me-name').textContent = S.user.displayName;
  $('#me-name').title = '@' + S.user.username;
  $('#me-frame').dataset.status = S.status === 'invisible' ? 'offline' : S.status;
  $('#me-status').value = S.status;
  if (document.activeElement !== $('#me-pm')) $('#me-pm').value = S.user.personalMessage || '';
  paintAvatar($('#me-avatar'), S.user.displayName, S.user.avatarKey);
  $('#set-avatar-remove')?.classList.toggle('hidden', !S.user.avatarKey);
  $('#me-avatar').dataset.media = S.voice?.mediaId || '';
}

function renderRail() {
  const box = $('#rail-servers');
  box.innerHTML = '';
  for (const s of S.servers) {
    const b = el('button', { className: 'rail-btn', title: s.name, textContent: initials(s.name), type: 'button' });
    if (s.id === S.serverId) b.classList.add('active');
    if (S.unreadServers.has(s.id)) b.classList.add('unread');
    b.onclick = () => selectServer(s.id);
    box.append(b);
  }
}

function isOwner() {
  return S.detail && S.detail.server.ownerId === S.user.id;
}

function renderChannels() {
  $('#server-name').textContent = S.detail?.server.name || 'StraightTalk';
  $('#btn-server-menu').classList.toggle('hidden', !S.detail);
  $('#btn-invite').classList.toggle('hidden', !S.detail);
  const textUl = $('#text-channels');
  const voiceUl = $('#voice-channels');
  textUl.innerHTML = '';
  voiceUl.innerHTML = '';
  document.querySelectorAll('.server-only').forEach((n) => n.classList.toggle('hidden', !S.detail));
  if (!S.detail) return;

  for (const c of S.detail.channels.filter((c) => c.type === 'text')) {
    const li = el('li', { className: 'channel' },
      el('span', { className: 'ch-icon' }, iconEl('hash', 16)),
      el('span', { className: 'ch-name', textContent: c.name }),
      ownerActions(c));
    if (S.view === 'text' && S.textChannel[S.serverId] === c.id) li.classList.add('active');
    if (S.unread.has(c.id)) li.classList.add('unread');
    if (S.mentions.has(c.id)) li.querySelector('.ch-name').after(el('span', { className: 'badge mention-badge', textContent: '@', title: 'Mencionaram você aqui' }));
    li.onclick = (e) => { if (!e.target.closest('.ch-actions')) openText(c.id); };
    textUl.append(li);
  }

  const vstate = S.voiceState.get(S.serverId) || {};
  for (const c of S.detail.channels.filter((c) => c.type === 'voice')) {
    const li = el('li', { className: 'channel' },
      el('span', { className: 'ch-icon' }, iconEl('volume', 16)),
      el('span', { className: 'ch-name', textContent: c.name }),
      ownerActions(c));
    if (S.view === 'voice' && S.viewVoiceChannelId === c.id) li.classList.add('active');
    li.onclick = (e) => { if (!e.target.closest('.ch-actions')) joinVoice(c.id); };
    voiceUl.append(li);
    const people = vstate[c.id] || [];
    if (people.length) {
      const ul = el('ul', { className: 'voice-users' });
      for (const p of people) ul.append(voiceUserNode(p));
      voiceUl.append(ul);
    }
  }

  const v = S.voice;
  $('#voice-panel').classList.toggle('hidden', !v);
  if (v) {
    const sname = S.servers.find((s) => s.id === v.serverId)?.name || '';
    $('#voice-where').textContent = `${v.channelName || 'Voz'} / ${sname}`;
  }
}

function ownerActions(c) {
  if (!isOwner()) return null;
  const box = el('span', { className: 'ch-actions' });
  const ren = el('button', { title: 'Renomear', type: 'button' }, iconEl('edit', 14));
  ren.onclick = async () => {
    const r = await formDialog({
      title: 'Renomear canal', fields: [{ name: 'name', label: 'Nome do canal', value: c.name, maxlength: 40 }], okText: 'Salvar',
      onSubmit: (v) => api('PATCH', `/api/channels/${c.id}`, { name: v.name }),
    });
    if (r) reloadDetail();
  };
  const del = el('button', { title: 'Apagar', type: 'button' }, iconEl('trash', 14));
  del.onclick = async () => {
    const r = await formDialog({
      title: `Apagar ${c.type === 'text' ? '#' : ''}${c.name}?`,
      text: c.type === 'text' ? 'Todas as mensagens deste canal serão apagadas.' : 'Quem estiver na voz será desconectado.',
      okText: 'Apagar', danger: true,
      onSubmit: () => api('DELETE', `/api/channels/${c.id}`),
    });
    if (r) reloadDetail();
  };
  box.append(ren, del);
  return box;
}

function voiceUserNode(p) {
  const av = el('div', { className: 'avatar' });
  paintAvatar(av, p.name, p.avatarKey);
  av.dataset.media = p.mediaId;
  if (S.speaking.has(p.mediaId)) av.classList.add('speaking');
  const icons = el('span', { className: 'icons' });
  if (p.sharing) icons.append(el('span', { className: 'live', textContent: 'AO VIVO' }));
  if (p.camera) icons.append(el('span', { title: 'Câmera ligada', className: 'state-ic cam-ic' }, iconEl('video', 14)));
  if (p.deafened) icons.append(el('span', { title: 'Áudio desativado', className: 'state-ic' }, iconEl('headphones-off', 14)));
  else if (p.muted) icons.append(el('span', { title: 'Mudo', className: 'state-ic' }, iconEl('mic-off', 14)));
  const li = el('li', { className: 'voice-user' }, av, el('span', { className: 'name', textContent: p.name }), icons);
  if (p.userId !== S.user.id) {
    li.title = 'Clique para ajustar o volume';
    li.onclick = (e) => {
      e.stopPropagation();
      if (e.target.tagName === 'INPUT') return;
      const existing = li.querySelector('input[type=range]');
      if (existing) return existing.remove();
      const range = el('input', { type: 'range', min: 0, max: 1, step: 0.05, title: 'Volume' });
      range.value = S.volumes[p.userId] ?? 1;
      range.oninput = () => {
        S.volumes[p.userId] = Number(range.value);
        localSet('st-volumes', JSON.stringify(S.volumes));
        applyUserVolume(p.userId, Number(range.value));
      };
      icons.before(range);
    };
  }
  return li;
}

function renderMain() {
  const title = $('#main-title');
  const inConv = S.view === 'text' || S.view === 'dm';
  document.querySelectorAll('.conv-only').forEach((b) => b.classList.toggle('hidden', !inConv));
  if (!inConv) { $('#side-panel').classList.add('hidden'); $('#search-form').classList.add('hidden'); }
  $('#view-empty').classList.toggle('hidden', S.view !== 'empty');
  $('#view-text').classList.toggle('hidden', S.view !== 'text' && S.view !== 'dm');
  $('#view-voice').classList.toggle('hidden', S.view !== 'voice');
  if (S.view === 'text') {
    const ch = currentChannel();
    title.replaceChildren(...(ch ? [iconEl('hash', 17), ` ${ch.name}`] : []));
    input.placeholder = ch ? `Conversar em #${ch.name}` : '';
    $('#btn-nudge').title = 'Chamar a atenção de todos na conversa';
    renderMessages();
    renderTypingAndReply();
  } else if (S.view === 'dm') {
    const u = S.peers.get(S.dmUserId);
    const name = u?.displayName || 'Contato';
    const st = peerStatus(S.dmUserId);
    title.replaceChildren(iconEl('chat', 17), ` ${name}`, el('span', { className: 'title-status', textContent: STATUS_LABEL[st] || 'Offline' }));
    input.placeholder = `Conversar com ${name}`;
    $('#btn-nudge').title = `Chamar a atenção de ${name}`;
    renderMessages();
    renderTypingAndReply();
  } else if (S.view === 'voice') {
    const ch = S.detail?.channels.find((c) => c.id === S.viewVoiceChannelId);
    title.replaceChildren(...(ch ? [iconEl('volume', 17), ` ${ch.name}`] : []));
    renderStage();
  } else {
    title.textContent = S.detail?.server.name || '';
  }
}

const tiles = new Map(); // chave -> elemento (reaproveitado para não piscar o vídeo)

function renderStage() {
  if (S.view !== 'voice') return;
  const stage = $('#stage');
  const chId = S.viewVoiceChannelId;
  const inThis = S.voice?.channelId === chId;
  const people = (S.voiceState.get(S.serverId) || {})[chId] || [];
  const wanted = [];

  if (inThis) {
    for (const [mediaId, scr] of S.screens) {
      const owner = mediaId === S.voice.mediaId ? { name: S.user.displayName + ' (você)' } : people.find((p) => p.mediaId === mediaId);
      if (!owner) continue;
      wanted.push(screenTile(mediaId, scr, owner.name));
    }
  }
  for (const p of people) wanted.push(personTile(p));

  const keep = new Set(wanted);
  for (const [k, node] of tiles) if (!keep.has(node)) { node.remove(); tiles.delete(k); }
  wanted.forEach((node, i) => { if (stage.children[i] !== node) stage.insertBefore(node, stage.children[i] || null); });
  if (stage.classList.contains('focused') && !stage.querySelector('.tile.focus')) stage.classList.remove('focused');

  if (!people.length) {
    if (!stage.querySelector('.stage-empty')) stage.append(el('div', { className: 'empty-view stage-empty muted', textContent: 'Ninguém na voz ainda.' }));
  } else stage.querySelector('.stage-empty')?.remove();

  $('#vb-join').classList.toggle('hidden', inThis);
  for (const id of ['#vb-mic', '#vb-cam', '#vb-share', '#vb-hangup']) $(id).classList.toggle('hidden', !inThis);
}

function screenTile(mediaId, scr, name) {
  const key = 'screen:' + mediaId;
  let tile = tiles.get(key);
  if (!tile) {
    tile = el('div', { className: 'tile screen' });
    const video = scr.el || el('video', { autoplay: true, playsInline: true, muted: true });
    if (!scr.el) video.srcObject = scr.stream;
    video.muted = true;
    video.play?.().catch(() => {});
    const focus = el('button', { className: 'icon-btn', title: 'Destacar', type: 'button' }, iconEl('search', 16));
    focus.onclick = () => toggleFocus(tile);
    const full = el('button', { className: 'icon-btn', title: 'Tela cheia', type: 'button' }, iconEl('maximize', 16));
    full.onclick = () => tile.requestFullscreen?.();
    tile.ondblclick = () => tile.requestFullscreen?.();
    tile.append(video, el('div', { className: 'label' }, iconEl('monitor', 14), ` ${name}`), el('div', { className: 'tile-actions' }, focus, full));
    tile._stream = scr.stream;
    tiles.set(key, tile);
  } else if (tile._stream !== scr.stream && !scr.el) {
    tile.querySelector('video').srcObject = scr.stream;
    tile._stream = scr.stream;
  }
  return tile;
}

function personTile(p) {
  const key = 'person:' + p.mediaId;
  let tile = tiles.get(key);
  if (!tile) {
    tile = el('div', { className: 'tile person' }, el('div', { className: 'avatar' }), el('div', { className: 'label' }));
    tile.ondblclick = () => tile.classList.contains('has-video') && tile.requestFullscreen?.();
    tiles.set(key, tile);
  }
  const cam = S.voice?.channelId === S.viewVoiceChannelId ? S.cameras.get(p.mediaId) : null;
  const shown = cam ? (cam.el || cam.stream) : null;
  if (tile._cam !== shown) {
    tile.querySelector('video')?.remove();
    if (cam) {
      const video = cam.el || el('video', { autoplay: true, playsInline: true, muted: true });
      if (!cam.el) video.srcObject = cam.stream;
      video.muted = true;
      video.classList.add('cam');
      video.play?.().catch(() => {});
      tile.prepend(video);
    }
    tile._cam = shown;
  }
  tile.classList.toggle('has-video', !!cam);
  tile.classList.toggle('mirror', !!cam?.local);
  tile.dataset.media = p.mediaId;
  tile.classList.toggle('speaking', S.speaking.has(p.mediaId));
  paintAvatar(tile.querySelector('.avatar'), p.name, p.avatarKey);
  tile.querySelector('.label').replaceChildren(...(p.deafened ? [iconEl('headphones-off', 14)] : p.muted ? [iconEl('mic-off', 14)] : []),
    `${p.name}${p.userId === S.user.id ? ' (você)' : ''}`);
  return tile;
}

function toggleFocus(tile) {
  const stage = $('#stage');
  const was = tile.classList.contains('focus');
  stage.querySelectorAll('.tile').forEach((t) => t.classList.remove('focus'));
  stage.classList.toggle('focused', !was);
  if (!was) tile.classList.add('focus');
}

function renderMembers() {
  const box = $('#members-list');
  box.innerHTML = '';
  if (!S.detail) return;
  const on = S.detail.members.filter((m) => m.online);
  const off = S.detail.members.filter((m) => !m.online);
  for (const [label, list, online] of [['Online', on, true], ['Offline', off, false]]) {
    if (!list.length) continue;
    box.append(el('div', { className: 'member-group', textContent: `${label} (${list.length})` }));
    for (const m of list) {
      const status = online ? (m.status || 'online') : 'offline';
      const av = el('div', { className: 'avatar' });
      paintAvatar(av, m.displayName, m.avatarKey);
      const frame = el('div', { className: 'frame' }, av);
      frame.dataset.status = status;
      const who = el('div', { className: 'who' }, el('span', { className: 'name', textContent: m.displayName + (online && status !== 'online' ? ` (${STATUS_LABEL[status]})` : '') }));
      if (m.personalMessage) {
        const pm = el('span', { className: 'pm' });
        linkify(pm, m.personalMessage, true);
        who.append(pm);
      }
      const unread = S.dms.find((c) => c.user.id === m.id)?.unread || 0;
      const me = m.id === S.user.id;
      const row = el('div', { className: 'member' + (online ? ' online' : '') + (me ? '' : ' clickable'), title: me ? '@' + m.username : `@${m.username}: clique para conversar em particular` }, frame, who,
        unread ? el('span', { className: 'badge', textContent: unread > 99 ? '99+' : String(unread) }) : null,
        m.id === S.detail.server.ownerId ? el('span', { className: 'crown', title: 'Dono', textContent: '👑' }) : null);
      if (!me) row.onclick = () => openDm(m.id);
      if (S.view === 'dm' && S.dmUserId === m.id) row.classList.add('active');
      box.append(row);
    }
  }
}

function updateControls() {
  for (const id of ['#btn-mic', '#vb-mic']) {
    const b = $(id);
    b.innerHTML = icon(S.muted ? 'mic-off' : 'mic', id === '#vb-mic' ? 20 : 18);
    b.classList.toggle('off', S.muted);
    b.title = S.muted ? 'Ativar microfone' : 'Silenciar microfone';
  }
  const d = $('#btn-deafen');
  d.innerHTML = icon(S.deafened ? 'headphones-off' : 'headphones');
  d.classList.toggle('off', S.deafened);
  d.title = S.deafened ? 'Ativar áudio' : 'Desativar áudio';
  const sharing = !!S.voice?.sharing;
  $('#btn-share').innerHTML = icon(sharing ? 'monitor-x' : 'monitor', 16) + (sharing ? ' Parar tela' : ' Tela');
  $('#btn-share').title = sharing ? 'Parar de compartilhar a tela' : 'Compartilhar tela';
  $('#btn-share').classList.toggle('on', sharing);
  $('#vb-share').classList.toggle('on', sharing);
  $('#vb-share').title = sharing ? 'Parar de compartilhar' : 'Compartilhar tela';
  const cam = !!S.voice?.camera;
  $('#btn-cam').innerHTML = icon(cam ? 'video-off' : 'video', 16) + (cam ? ' Desligar' : ' Câmera');
  $('#btn-cam').title = cam ? 'Desligar câmera' : 'Ligar câmera';
  $('#btn-cam').classList.toggle('on', cam);
  $('#vb-cam').innerHTML = icon(cam ? 'video' : 'video-off', 20);
  $('#vb-cam').classList.toggle('on', cam);
  $('#vb-cam').title = cam ? 'Desligar câmera' : 'Ligar câmera';
  if (S.user) renderMe();
}

function setStatus(t) { $('#conn-status').textContent = t; }

/* ================= Botões ================= */

$('#btn-mic').onclick = toggleMute;
$('#vb-mic').onclick = toggleMute;
$('#btn-deafen').onclick = toggleDeafen;
$('#btn-share').onclick = toggleShare;
$('#vb-share').onclick = toggleShare;
$('#btn-cam').onclick = toggleCamera;
$('#btn-add-friend').onclick = () => addFriendDialog();
$('#vb-cam').onclick = toggleCamera;
$('#btn-hangup').onclick = () => leaveVoice();
$('#vb-hangup').onclick = () => leaveVoice();
$('#vb-join').onclick = () => joinVoice(S.viewVoiceChannelId);
$('#voice-where').onclick = async (e) => {
  e.preventDefault();
  if (!S.voice) return;
  if (S.serverId !== S.voice.serverId) await selectServer(S.voice.serverId);
  showVoiceView(S.voice.channelId);
};

$('#btn-members').onclick = () => {
  const app = $('#app');
  if (matchMedia('(max-width: 1100px)').matches) app.classList.toggle('show-members');
  else app.classList.toggle('no-members');
};
$('#btn-drawer').onclick = () => $('#app').classList.toggle('drawer');
function closeDrawer() { $('#app').classList.remove('drawer'); }
$('#view-empty').onclick = closeDrawer;

$('#btn-add-server').onclick = async () => {
  const r = await formDialog({
    title: 'Criar servidor',
    text: 'Um servidor é onde você e seus amigos conversam. Ele já vem com um canal de texto e dois de voz.',
    fields: [{ name: 'name', label: 'Nome do servidor', value: `Servidor de ${S.user.displayName}`, maxlength: 50 }],
    okText: 'Criar',
    onSubmit: (v) => api('POST', '/api/servers', { name: v.name }),
  });
  if (!r) return;
  await refreshServers();
  await selectServer(r.result.server.id);
};

$('#btn-join-server').onclick = async () => {
  const r = await formDialog({
    title: 'Entrar num servidor',
    text: 'Cole o link ou o código do convite.',
    fields: [{ name: 'code', label: 'Convite', placeholder: 'https://…/convite/abc123' }],
    okText: 'Continuar',
  });
  if (!r) return;
  const code = r.values.code.trim().split('/').filter(Boolean).pop();
  if (code) acceptInvite(code);
};

$('#btn-invite').onclick = () => { if (S.detail) showInvite(S.detail.server); };

$('#btn-server-menu').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#server-menu');
  const header = $('.server-header');
  menu.style.top = header.offsetTop + header.offsetHeight + 2 + 'px';
  menu.classList.toggle('hidden');
  menu.querySelectorAll('.owner-only').forEach((b) => b.classList.toggle('hidden', !isOwner()));
  menu.querySelectorAll('.member-only').forEach((b) => b.classList.toggle('hidden', isOwner()));
};
document.addEventListener('click', (e) => { if (!e.target.closest('#server-menu')) $('#server-menu').classList.add('hidden'); });

$('#server-menu').onclick = async (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act || !S.detail) return;
  $('#server-menu').classList.add('hidden');
  const s = S.detail.server;
  if (act === 'invite') return showInvite(s);
  if (act === 'new-text' || act === 'new-voice') {
    const type = act === 'new-text' ? 'text' : 'voice';
    const r = await formDialog({
      title: type === 'text' ? 'Criar canal de texto' : 'Criar canal de voz',
      fields: [{ name: 'name', label: 'Nome do canal', placeholder: type === 'text' ? 'novo-canal' : 'Bate Papo 3', maxlength: 40 }],
      okText: 'Criar canal',
      onSubmit: (v) => api('POST', `/api/servers/${s.id}/channels`, { name: v.name, type }),
    });
    if (!r) return;
    await reloadDetail();
    if (type === 'text') openText(r.result.id);
    return;
  }
  if (act === 'rename') {
    const r = await formDialog({
      title: 'Renomear servidor', fields: [{ name: 'name', label: 'Nome do servidor', value: s.name, maxlength: 50 }], okText: 'Salvar',
      onSubmit: (v) => api('PATCH', `/api/servers/${s.id}`, { name: v.name }),
    });
    if (r) { await refreshServers(); await reloadDetail(); }
    return;
  }
  if (act === 'delete') {
    await formDialog({
      title: `Apagar ${s.name}?`, text: 'Todos os canais e mensagens serão apagados. Isso não pode ser desfeito.',
      fields: [{ name: 'confirm', label: 'Digite o nome do servidor para confirmar', placeholder: s.name }],
      okText: 'Apagar servidor', danger: true,
      onSubmit: (v) => {
        if (v.confirm.trim() !== s.name) throw new Error('O nome não confere.');
        return api('DELETE', `/api/servers/${s.id}`);
      },
    });
    return;
  }
  if (act === 'leave') {
    await formDialog({
      title: `Sair de ${s.name}?`, text: 'Você só volta com um novo convite.', okText: 'Sair', danger: true,
      onSubmit: () => api('POST', `/api/servers/${s.id}/leave`),
    });
  }
};

async function showInvite(s) {
  const link = s.inviteCode ? `${location.origin}/convite/${s.inviteCode}` : null;
  if (!link) return toast('Só o dono do servidor pode ver o convite.');
  const r = await formDialog({
    title: `Convidar amigos para ${s.name}`,
    text: 'Mande este link. Quem abrir cria uma conta (ou entra) e já cai no servidor.',
    fields: [{ name: 'link', label: 'Link de convite', value: link, readonly: true, copy: true }],
    okText: 'Pronto',
    extra: s.ownerId === S.user.id ? { label: 'Gerar novo link', danger: false } : undefined,
  });
  if (r?.extra) {
    const { inviteCode } = await api('POST', `/api/servers/${s.id}/invite`);
    S.detail.server.inviteCode = inviteCode;
    toast('Link novo gerado. O antigo parou de funcionar.');
    showInvite(S.detail.server);
  }
}

/* ================= Configurações ================= */

$('#btn-settings').onclick = async () => {
  $('#set-name').value = S.user.displayName;
  $('#set-noise').value = StraightTalkMedia.noiseMode(S.settings);
  $('#set-theme').value = themeChoice();
  $('#set-sounds').checked = S.settings.sounds !== false;
  $('#set-notify').checked = notificationsOn() || (S.settings.notify !== false && window.Notification?.permission === 'default');
  $('#set-media').textContent = S.media.mode === 'livekit'
    ? 'Voz e tela via servidor de mídia (SFU), com TURN para redes fechadas.'
    : 'Voz e tela direto entre as pessoas (P2P)' + (S.media.iceServers.length > 1 ? ', com TURN para redes fechadas.' : '.');
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === 'audioinput' && d.label)) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {}
    }
    fillSelect($('#set-mic'), devices.filter((d) => d.kind === 'audioinput'), S.settings.micId);
    fillSelect($('#set-cam'), devices.filter((d) => d.kind === 'videoinput'), S.settings.camId);
    fillSelect($('#set-speaker'), devices.filter((d) => d.kind === 'audiooutput'), S.settings.speakerId);
    $('#set-speaker').disabled = !('setSinkId' in HTMLMediaElement.prototype);
  } catch {}
  $('#dlg-settings').showModal();
};

function fillSelect(sel, list, current) {
  sel.innerHTML = '';
  sel.append(el('option', { value: '', textContent: 'Padrão do sistema' }));
  for (const d of list) {
    if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
    const o = el('option', { value: d.deviceId, textContent: d.label || 'Dispositivo' });
    if (d.deviceId === current) o.selected = true;
    sel.append(o);
  }
}

$('#dlg-settings').addEventListener('close', async () => {
  const v = $('#dlg-settings').returnValue;
  if (v === 'logout') return logout();
  if (v !== 'ok') return;
  const micChanged = S.settings.micId !== ($('#set-mic').value || undefined) ||
    StraightTalkMedia.noiseMode(S.settings) !== $('#set-noise').value;
  S.settings.micId = $('#set-mic').value || undefined;
  S.settings.speakerId = $('#set-speaker').value || undefined;
  S.settings.camId = $('#set-cam').value || undefined;
  S.settings.noiseMode = $('#set-noise').value;
  applyTheme($('#set-theme').value);
  delete S.settings.noiseSuppression;
  S.settings.sounds = $('#set-sounds').checked;
  S.settings.notify = $('#set-notify').checked;
  localSet('st-settings', JSON.stringify(S.settings));
  S.voice?.engine.setSpeaker?.(S.settings.speakerId);
  const name = $('#set-name').value.trim();
  if (name && name !== S.user.displayName) {
    try {
      await api('PATCH', '/api/me', { displayName: name });
      S.user.displayName = name;
      renderMe();
      await refreshServers();
    } catch (err) { toast(err.message); }
  }
  if (micChanged && S.voice) {
    const ch = S.voice.channelId;
    leaveVoice();
    joinVoice(ch);
  }
});

/* ================= Diálogo genérico ================= */

function formDialog({ title, text, fields = [], okText = 'OK', danger = false, onSubmit, extra }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-form');
    $('#dlg-title').textContent = title;
    $('#dlg-text').textContent = text || '';
    $('#dlg-error').textContent = '';
    const box = $('#dlg-fields');
    box.innerHTML = '';
    const inputs = {};
    for (const f of fields) {
      const inp = el('input', { name: f.name, value: f.value || '', placeholder: f.placeholder || '', readOnly: !!f.readonly });
      if (f.maxlength) inp.maxLength = f.maxlength;
      inputs[f.name] = inp;
      let row = inp;
      if (f.copy) {
        const btn = el('button', { className: 'btn primary', type: 'button', textContent: 'Copiar' });
        btn.onclick = async () => {
          try { await navigator.clipboard.writeText(inp.value); btn.textContent = 'Copiado!'; }
          catch { inp.select(); document.execCommand('copy'); btn.textContent = 'Copiado!'; }
        };
        row = el('div', { className: 'copy-row' }, inp, btn);
      }
      box.append(el('label', {}, f.label, row));
    }
    const ok = $('#dlg-ok');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    const menu = ok.parentElement;
    menu.querySelector('.extra')?.remove();
    let extraClicked = false;
    if (extra) {
      const b = el('button', { className: 'btn extra', type: 'button', textContent: extra.label });
      b.onclick = () => { extraClicked = true; dlg.close('ok'); };
      menu.prepend(b);
    }
    const form = $('#dlg-form-el');
    let result;
    const onSubmitEvt = async (e) => {
      if (e.submitter?.value !== 'ok') return;
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
      try {
        ok.disabled = true;
        result = onSubmit ? await onSubmit(values) : undefined;
        cleanup();
        dlg.close('ok');
        resolve({ values, result });
      } catch (err) {
        $('#dlg-error').textContent = err.message;
      } finally {
        ok.disabled = false;
      }
    };
    const onClose = () => {
      cleanup();
      if (extraClicked) resolve({ extra: true });
      else if (dlg.returnValue !== 'ok') resolve(null);
    };
    const cleanup = () => {
      form.removeEventListener('submit', onSubmitEvt);
      dlg.removeEventListener('close', onClose);
    };
    form.addEventListener('submit', onSubmitEvt);
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    dlg.showModal();
    const first = Object.values(inputs).find((i) => !i.readOnly);
    if (first) { first.focus(); first.select(); }
  });
}

/* ================= Status, mensagem pessoal, emoticons e chamar atenção ================= */

const STATUS_LABEL = { online: 'Disponível', busy: 'Ocupado', away: 'Ausente', invisible: 'Invisível', offline: 'Offline' };

$('#me-status').onchange = () => {
  S.status = $('#me-status').value;
  localSet('st-status', S.status);
  wsSend({ type: 'status', status: S.status });
  renderMe();
};

async function savePersonalMessage() {
  const pm = $('#me-pm').value.trim();
  if (pm === (S.user.personalMessage || '')) return;
  try {
    await api('PATCH', '/api/me', { personalMessage: pm });
    S.user.personalMessage = pm;
  } catch (err) {
    toast(err.message);
    $('#me-pm').value = S.user.personalMessage || '';
  }
}
$('#me-pm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#me-pm').blur(); }
  if (e.key === 'Escape') { $('#me-pm').value = S.user.personalMessage || ''; $('#me-pm').blur(); }
});
$('#me-pm').addEventListener('blur', savePersonalMessage);

// Atalhos de texto que viram emoticons, como nos mensageiros antigos
const EMOTICONS = [
  [':)', '🙂'], [':-)', '🙂'], [':D', '😃'], [':-D', '😃'], [';)', '😉'], [';-)', '😉'], [':(', '🙁'], [':-(', '🙁'],
  [':P', '😛'], [':-P', '😛'], [':p', '😛'], [':O', '😮'], [':o', '😮'], [":'(", '😢'], [':@', '😠'], [':S', '😕'], [':s', '😕'],
  [':$', '😳'], [':|', '😐'], ['(H)', '😎'], ['(h)', '😎'], ['(A)', '😇'], ['(a)', '😇'], ['(6)', '😈'],
  ['(L)', '❤️'], ['(l)', '❤️'], ['(U)', '💔'], ['(u)', '💔'], ['(Y)', '👍'], ['(y)', '👍'], ['(N)', '👎'], ['(n)', '👎'],
  ['(K)', '💋'], ['(k)', '💋'], ['(F)', '🌹'], ['(f)', '🌹'], ['(*)', '⭐'], ['(C)', '☕'], ['(c)', '☕'], ['(B)', '🍺'], ['(b)', '🍺'],
  ['(^)', '🎂'], ['(G)', '🎁'], ['(g)', '🎁'], ['(8)', '🎵'], ['(I)', '💡'], ['(i)', '💡'], ['(mp)', '📱'], ['(co)', '💻'],
  ['(S)', '🌙'], ['(#)', '☀️'], ['(R)', '🌈'], ['(r)', '🌈'], ['(Z)', '👦'], ['(X)', '👧'], ['(@)', '🐱'], ['(&)', '🐶'],
  ['(sn)', '🐌'], ['(tu)', '🐢'], ['(pi)', '🍕'], ['(so)', '⚽'], ['(ap)', '✈️'], ['(e)', '📧'], ['(o)', '⏰'], ['+o(', '🤢'],
];
const EMO_RE = new RegExp(EMOTICONS.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'g');
const EMO_MAP = new Map(EMOTICONS);

function emoticonify(node, text) {
  let last = 0;
  for (const m of text.matchAll(EMO_RE)) {
    if (m.index > last) node.append(document.createTextNode(text.slice(last, m.index)));
    node.append(el('span', { className: 'emo', textContent: EMO_MAP.get(m[0]), title: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
}

// Painel de emoticons: um de cada (o atalho principal)
(() => {
  const box = $('#emoticons');
  const seen = new Set();
  for (const [code, emo] of EMOTICONS) {
    if (seen.has(emo)) continue;
    seen.add(emo);
    const b = el('button', { type: 'button', textContent: emo, title: code });
    b.onclick = () => {
      const i = input.selectionStart ?? input.value.length;
      const pad = i > 0 && !/\s$/.test(input.value.slice(0, i)) ? ' ' : '';
      input.setRangeText(pad + code + ' ', i, input.selectionEnd ?? i, 'end');
      box.classList.add('hidden');
      input.focus();
      input.dispatchEvent(new Event('input'));
    };
    box.append(b);
  }
})();
$('#btn-emoticons').onclick = (e) => { e.stopPropagation(); $('#emoticons').classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!e.target.closest('#emoticons')) $('#emoticons').classList.add('hidden'); });

$('#btn-nudge').onclick = () => {
  const conv = currentConv();
  if (conv) wsSend(conv.dm ? { type: 'nudge', toUserId: conv.userId } : { type: 'nudge', channelId: conv.channel.id });
};

// Sons feitos na hora (sem arquivos): mensagem nova, contato online, chamar atenção
const Sounds = (() => {
  let ctx = null;
  const unlock = () => { try { ctx ||= new AudioContext(); if (ctx.state === 'suspended') ctx.resume(); } catch {} };
  addEventListener('pointerdown', unlock, { once: false, passive: true });
  addEventListener('keydown', unlock, { passive: true });
  function tone(freq, start, dur, type = 'sine', vol = 0.18) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime + start);
    g.gain.setValueAtTime(0, ctx.currentTime + start);
    g.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + start);
    o.stop(ctx.currentTime + start + dur + 0.05);
  }
  const SOUNDS = {
    message: () => { tone(1046.5, 0, 0.18); tone(1318.5, 0.09, 0.32); },
    online: () => { tone(659.3, 0, 0.2, 'triangle'); tone(784, 0.1, 0.2, 'triangle'); tone(1046.5, 0.2, 0.4, 'triangle'); },
    nudge: () => { for (let i = 0; i < 8; i++) tone(i % 2 ? 140 : 110, i * 0.07, 0.09, 'square', 0.08); },
  };
  return {
    play(name) {
      if (S.settings.sounds === false || !ctx || ctx.state !== 'running') return;
      try { SOUNDS[name](); } catch {}
    },
  };
})();

// Título da aba pisca com a mensagem enquanto a janela não está em foco
let titleTimer = null;
function flashTitle(text) {
  if (!document.hidden) return;
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => { document.title = (on = !on) ? text.slice(0, 60) : 'StraightTalk'; }, 1000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { clearInterval(titleTimer); titleTimer = null; document.title = 'StraightTalk'; }
});

/* ================= Tema claro / escuro ================= */

function themeChoice() { return localGet('st-theme') || 'auto'; }
function currentTheme() {
  const t = themeChoice();
  return t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
}
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') { localSet('st-theme', choice); document.documentElement.dataset.theme = choice; }
  else { localDel('st-theme'); delete document.documentElement.dataset.theme; }
  $('#btn-theme').innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon');
  $('#btn-theme').title = currentTheme() === 'dark' ? 'Mudar para o modo claro' : 'Mudar para o modo escuro';
}
$('#btn-theme').onclick = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(themeChoice()));
applyTheme(themeChoice());

/* ================= Foto de perfil ================= */

// Recorta o centro da imagem e reduz para 160x160 antes de enviar
function shrinkImage(file, size = 160) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Não consegui ler a imagem.'))), 'image/jpeg', 0.9);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Esse arquivo não é uma imagem.')); };
    img.src = url;
  });
}

async function setAvatar(file) {
  try {
    const blob = await shrinkImage(file);
    const res = await fetch('/api/files', {
      method: 'POST', body: blob,
      headers: { Authorization: `Bearer ${S.token}`, 'Content-Type': 'image/jpeg', 'X-File-Name': 'foto.jpg' },
    });
    const up = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(up.error || `Erro ${res.status}`);
    await api('PATCH', '/api/me', { avatarKey: up.key });
    S.user.avatarKey = up.key;
    renderMe();
    toast('Foto de perfil atualizada.');
  } catch (err) {
    toast(err.message);
  }
}

$('#me-frame').title = 'Clique para trocar sua foto de perfil';
$('#me-frame').onclick = () => $('#avatar-input').click();
$('#avatar-input').onchange = () => {
  const f = $('#avatar-input').files[0];
  $('#avatar-input').value = '';
  if (f) setAvatar(f);
};
$('#set-avatar-pick').onclick = () => $('#avatar-input').click();
$('#set-avatar-remove').onclick = async () => {
  try {
    await api('PATCH', '/api/me', { avatarKey: null });
    S.user.avatarKey = null;
    renderMe();
    toast('Foto removida.');
  } catch (err) { toast(err.message); }
};

/* ================= Avisos na área de trabalho ================= */

const desktop = window.straighttalkDesktop;

function notificationsOn() {
  return S.settings.notify !== false && 'Notification' in window && Notification.permission === 'granted';
}

function askNotificationPermission() {
  if (S.settings.notify === false || !('Notification' in window) || Notification.permission !== 'default') return;
  Notification.requestPermission().catch(() => {});
}

// Aviso do Windows (ou do navegador) quando a janela não está na frente
function notify(title, body, tag, onClick) {
  if (document.hasFocus() && !document.hidden) return;
  desktop?.attention?.();
  if (!notificationsOn()) return;
  try {
    const n = new Notification(title, { body: String(body || '').slice(0, 200), tag, icon: '/icon.png', silent: true });
    n.onclick = () => {
      n.close();
      window.focus();
      desktop?.focus?.();
      onClick?.();
    };
  } catch {}
}

// O navegador só deixa pedir permissão depois de um clique
document.addEventListener('click', () => { if (S.user) askNotificationPermission(); }, { once: true });
$('#set-notify').addEventListener('change', () => { if ($('#set-notify').checked) { S.settings.notify = true; askNotificationPermission(); } });

// Número de conversas com novidade no ícone da barra de tarefas (app do Windows)
let lastBadge = -1;
function updateBadge() {
  const n = S.dms.reduce((t, c) => t + (c.unread || 0), 0) + S.unread.size;
  if (n === lastBadge) return;
  lastBadge = n;
  if (!desktop?.setBadge) return;
  if (!n) return desktop.setBadge(null, '');
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#e8401c';
  g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.font = `bold ${n > 9 ? 16 : 20}px Segoe UI, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(n > 99 ? '99+' : String(n), 16, 17);
  desktop.setBadge(c.toDataURL('image/png'), `${n} novas`);
}

/* ================= Utilidades ================= */

function hue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function nameColor(name) { return `hsl(${hue(name)} 60% 65%)`; }
function paintAvatar(node, name, avatarKey) {
  if (avatarKey) {
    node.textContent = '';
    node.style.background = `#fff center / cover no-repeat url("/files/${avatarKey}/foto")`;
    node.classList.add('photo');
    return;
  }
  node.classList.remove('photo');
  node.textContent = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  node.style.background = `hsl(${hue(name)} 45% 42%)`;
}
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 3).map((w) => [...w][0]).join('').toUpperCase() || '?';
}
function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Hoje às ${hm}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Ontem às ${hm}`;
  return `${d.toLocaleDateString('pt-BR')} ${hm}`;
}
function linkify(node, text, emoticons = false) {
  for (const part of text.split(/(https?:\/\/[^\s]+)/g)) {
    if (/^https?:\/\//.test(part)) node.append(el('a', { href: part, textContent: part, target: '_blank', rel: 'noopener noreferrer' }));
    else if (part && emoticons) {
      // @menções viram destaque; as suas ficam com outra cor
      for (const bit of part.split(MENTION_SPLIT)) {
        if (MENTION_ONE.test(bit)) node.append(el('span', { className: 'mention' + (bit.slice(1).toLowerCase() === S.user?.username ? ' to-me' : ''), textContent: bit }));
        else if (bit) emoticonify(node, bit);
      }
    } else if (part) node.append(document.createTextNode(part));
  }
}

const MENTION_SPLIT = /((?<![\w.@])@[a-zA-Z0-9_.]{3,32}(?![\w]))/;
const MENTION_ONE = /^@[a-zA-Z0-9_.]{3,32}$/;
function mentionsMe(text) {
  if (!text || !S.user) return false;
  const u = S.user.username.replace(/[.]/g, '\\.');
  return new RegExp(`(^|[^\\w.@])@${u}(?![\\w])`, 'i').test(text);
}
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }
function localDel(k) { try { localStorage.removeItem(k); } catch {} }
function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
function sessionDel(k) { try { sessionStorage.removeItem(k); } catch {} }

boot();
