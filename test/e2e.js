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
