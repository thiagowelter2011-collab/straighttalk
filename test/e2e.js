// Teste de ponta a ponta no navegador (Chromium headless, microfone falso).
// Uso: node test/e2e.js http://localhost:3000 [pasta-de-prints]
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = process.argv[3] || '.';
const tag = Date.now().toString(36);

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  async function person(name) {
    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1400, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_|WebSocket/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
    await page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
        const g = c.getContext('2d'); let i = 0;
        setInterval(() => { g.fillStyle = `hsl(${i++ % 360} 70% 45%)`; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('TELA ' + i, 80, 360); }, 33);
        return c.captureStream(30);
      };
    });
    return page;
  }
  async function register(page, user, display, url = BASE) {
    await page.goto(url);
    if (await page.isVisible('#auth-switch') && (await page.textContent('#auth-submit')) === 'Entrar') await page.click('#auth-switch');
    await page.fill('#auth-display', display);
    await page.fill('#auth-user', user);
    await page.fill('#auth-pass', 'senha123');
    await page.click('#auth-submit');
  }

  const ana = await person('Ana');
  await register(ana, `ana${tag}`, 'Ana');
  await ana.click('#btn-add-server');
  await ana.fill('#dlg-fields input', 'Cúpula Teste');
  await ana.click('#dlg-ok');
  await ana.waitForSelector('#text-channels .channel');
  await ana.click('#btn-server-menu');
  await ana.click('[data-act=invite]');
  const invite = await ana.inputValue('#dlg-fields input');
  await ana.click('#dlg-ok');
  console.log('convite', invite);

  const bia = await person('Bia');
  await register(bia, `bia${tag}`, 'Bia', invite);
  await bia.waitForSelector('#dlg-form[open]');
  await bia.click('#dlg-ok');
  await bia.waitForSelector('#text-channels .channel.active');

  await ana.fill('#chat-input', 'oi bia, bem-vinda! https://example.com');
  await ana.press('#chat-input', 'Enter');
  await bia.waitForSelector('.msg .text >> text=bem-vinda');
  await bia.fill('#chat-input', 'valeu ana');
  await bia.press('#chat-input', 'Enter');
  await ana.waitForSelector('.msg .text >> text=valeu ana');
  console.log('chat ok');

  // Estilo mensageiro: emoticons, mensagem pessoal, status e chamar atenção
  await bia.fill('#chat-input', 'adorei (L) :)');
  await bia.click('#btn-send');
  await ana.waitForSelector('.msg .text .emo >> text=❤️');
  await ana.fill('#me-pm', 'testando o StraightTalk (Y)');
  await ana.press('#me-pm', 'Enter');
  await bia.waitForSelector('.member .pm >> text=testando o StraightTalk');
  await ana.selectOption('#me-status', 'busy');
  await bia.waitForSelector('.member .frame[data-status="busy"]');
  await ana.selectOption('#me-status', 'online');
  await bia.click('#btn-nudge');
  await ana.waitForSelector('.nudge-line >> text=Bia chamou a sua atenção!');
  console.log('emoticons, mensagem pessoal, status e chamar atenção ok');

  // Conversa particular: clicar no contato abre um chat só entre os dois
  await ana.click('.member.clickable >> text=Bia');
  await ana.waitForSelector('#main-title >> text=💬 Bia');
  await ana.fill('#chat-input', 'segredo só nosso ;)');
  await ana.press('#chat-input', 'Enter');
  await bia.waitForSelector('#dm-list .channel.dm.unread .badge >> text=1');
  await bia.click('#dm-list .channel.dm >> text=Ana');
  await bia.waitForSelector('.msg .text >> text=segredo só nosso');
  await bia.waitForSelector('#dm-list .channel.dm.active:not(.unread)');
  await bia.fill('#chat-input', 'combinado');
  await bia.press('#chat-input', 'Enter');
  await ana.waitForSelector('.msg .text >> text=combinado');
  await ana.click('#btn-nudge');
  await bia.waitForSelector('.nudge-line >> text=Ana chamou a sua atenção!');
  await bia.screenshot({ path: `${OUT}/v2-particular.png` });
  await ana.click('#text-channels .channel >> nth=0');
  await ana.waitForSelector('.msg .text >> text=valeu ana');
  if (await ana.isVisible('.msg .text >> text=segredo só nosso')) throw new Error('mensagem particular apareceu no canal');
  await bia.click('#text-channels .channel >> nth=0');
  console.log('conversa particular ok');

  // Imagem e arquivo no chat (o print da tela serve de imagem de teste)
  await bia.waitForSelector('.msg .text >> text=valeu ana');
  const shot = await ana.screenshot({ clip: { x: 0, y: 0, width: 400, height: 300 } });
  await ana.setInputFiles('#file-input', [
    { name: 'print.png', mimeType: 'image/png', buffer: shot },
    { name: 'lista de compras.txt', mimeType: 'text/plain', buffer: Buffer.from('pão, leite, café') },
  ]);
  await bia.waitForFunction(() => { const i = document.querySelector('.att-img img'); return i && i.complete && i.naturalWidth === 400; }, null, { timeout: 15000 });
  await bia.waitForSelector('.att-file >> text=lista de compras.txt');
  const txt = await bia.evaluate(async () => (await fetch(document.querySelector('.att-file').href)).text());
  if (txt !== 'pão, leite, café') throw new Error('arquivo veio diferente: ' + txt);
  await bia.screenshot({ path: `${OUT}/v2-arquivos.png` });
  console.log('imagens e arquivos ok');

  // Foto de perfil no quadrinho
  await bia.setInputFiles('#avatar-input', { name: 'eu.png', mimeType: 'image/png', buffer: shot });
  await bia.waitForSelector('#me-avatar.photo');
  await ana.waitForSelector('.member .avatar.photo', { timeout: 10000 });
  await ana.click('.member.clickable >> text=Bia');
  await ana.waitForSelector('.dm-card .avatar.photo');
  await ana.screenshot({ path: `${OUT}/v2-foto.png` });
  await ana.click('#text-channels .channel >> nth=0');
  console.log('foto de perfil ok');

  const caio = await person('Caio');
  await register(caio, `caio${tag}`, 'Caio', invite);
  await caio.waitForSelector('#dlg-form[open]');
  await caio.click('#dlg-ok');
  await caio.waitForSelector('#text-channels .channel.active');

  for (const p of [ana, bia, caio]) { await p.click('#voice-channels .channel >> nth=0'); await p.waitForTimeout(700); }
  await ana.waitForFunction(() => document.querySelectorAll('#stage .tile.person').length === 3, null, { timeout: 15000 });
  console.log('voz: 3 pessoas no canal');

  await ana.click('#vb-share');
  await ana.click('#dlg-share button[value=ok]');
  for (const [n, p] of [['Bia', bia], ['Caio', caio]]) {
    await p.waitForFunction(() => { const v = document.querySelector('#stage .tile.screen video'); return v && v.videoWidth > 0; }, null, { timeout: 20000 });
  }
  await bia.waitForTimeout(3000);
  const info = await bia.evaluate(() => ({
    screen: [...document.querySelectorAll('#stage .tile.screen video')].map((v) => `${v.videoWidth}x${v.videoHeight}`),
    audios: document.querySelectorAll('#audio-sink audio').length,
    speaking: document.querySelectorAll('#stage .tile.speaking').length,
    voiceList: [...document.querySelectorAll('.voice-user .name')].map((e) => e.textContent),
    live: document.querySelectorAll('.voice-user .live').length,
    mode: S.media.mode,
  }));
  console.log('Bia vê:', JSON.stringify(info));
  await bia.screenshot({ path: `${OUT}/v2-voz.png` });
  await ana.click('#view-voice'); // nada
  await ana.click('#text-channels .channel >> nth=0');
  await ana.screenshot({ path: `${OUT}/v2-chat.png` });

  await ana.click('#btn-share'); // parar
  await bia.waitForFunction(() => !document.querySelector('#stage .tile.screen'), null, { timeout: 10000 });
  console.log('parar compartilhamento ok');
  await ana.click('#btn-mic');
  await bia.waitForFunction(() => [...document.querySelectorAll('.voice-user')].some((li) => li.textContent.includes('Ana') && li.textContent.includes('🔇')), null, { timeout: 5000 });
  console.log('mudo ok');
  await caio.click('#btn-hangup');
  await bia.waitForFunction(() => document.querySelectorAll('#stage .tile.person').length === 2, null, { timeout: 5000 });
  console.log('sair da voz ok');
  console.log('erros no console:', errors.length ? errors.slice(0, 8) : 'nenhum');
  if (process.env.E2E_CLEANUP) {
    // No site de verdade: apaga o servidor de teste (as contas ana/bia/caio de teste ficam)
    await ana.evaluate(() => fetch(`/api/servers/${S.serverId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${S.token}` } }));
    console.log('servidor de teste apagado');
  }
  await browser.close();
  if (!info.screen.length || info.audios < 2) process.exit(1);
})().catch((e) => { console.error('FALHOU', e); process.exit(1); });
