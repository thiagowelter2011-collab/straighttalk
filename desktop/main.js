// StraightTalk para Windows (Electron)
// Abre o site do StraightTalk numa janela própria e cuida do que o navegador não faz sozinho:
// escolher qual tela/janela compartilhar (com áudio do sistema) e lembrar o endereço do servidor.

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const pkg = require('./package.json');
const ICON = path.join(__dirname, 'build', 'icon.png');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')); } catch { return {}; }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2));
}

function serverUrl() {
  return process.env.STRAIGHTTALK_URL || readConfig().serverUrl || pkg.straighttalk?.serverUrl || '';
}

function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  return u.origin;
}

let win = null;

function openSetup(error) {
  win.loadFile(path.join(__dirname, 'pages', 'setup.html'), {
    query: { url: serverUrl(), error: error || '' },
  });
}

function openApp() {
  const url = serverUrl();
  if (!url) return openSetup();
  win.loadURL(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#313338',
    title: 'StraightTalk',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // mantém a voz fluida com a janela minimizada
    },
  });
  win.removeMenu();

  // Links externos abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const base = serverUrl();
    if (url.startsWith('file:') || (base && url.startsWith(base))) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && !url.startsWith('file:') && code !== -3) openSetup(`Não consegui abrir ${url} (${desc}).`);
  });

  // Ctrl+Shift+S: trocar o servidor · Ctrl+R / F5: recarregar · F12: ferramentas
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (ctrl && input.shift && input.key.toLowerCase() === 's') { e.preventDefault(); openSetup(); }
    else if ((ctrl && input.key.toLowerCase() === 'r') || input.key === 'F5') { e.preventDefault(); win.webContents.reload(); }
    else if (input.key === 'F12') { e.preventDefault(); win.webContents.toggleDevTools(); }
  });

  openApp();
}

/* ---------------- Escolher tela para compartilhar ---------------- */

function pickSource(parent) {
  return new Promise(async (resolve) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    const picker = new BrowserWindow({
      parent,
      modal: true,
      width: 760,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Compartilhar tela',
      backgroundColor: '#313338',
      icon: ICON,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    picker.removeMenu();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler('picker:sources');
      ipcMain.removeAllListeners('picker:choose');
      resolve(value);
      if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.handle('picker:sources', () => sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL(),
      icon: s.appIcon ? s.appIcon.toDataURL() : null,
    })));
    ipcMain.on('picker:choose', (_e, choice) => {
      const source = choice && sources.find((s) => s.id === choice.id);
      finish(source ? { source, audio: !!choice.audio } : null);
    });
    picker.on('closed', () => finish(null));
    picker.loadFile(path.join(__dirname, 'pages', 'picker.html'));
  });
}

/* ---------------- Inicialização ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('app.straighttalk.desktop');
    const ses = session.defaultSession;

    // Microfone, tela, notificações e área de transferência para o site do StraightTalk
    const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    // getDisplayMedia() do site abre o nosso seletor de tela
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      const choice = await pickSource(BrowserWindow.fromWebContents(request.frame) || win);
      if (!choice) return callback({});
      callback({
        video: choice.source,
        // "loopback" captura o áudio do sistema (só no Windows)
        audio: choice.audio && process.platform === 'win32' ? 'loopback' : undefined,
      });
    });

    ipcMain.handle('setup:save', async (_e, raw) => {
      const url = normalizeUrl(raw);
      if (!url) throw new Error('Digite o endereço do servidor.');
      writeConfig({ ...readConfig(), serverUrl: url });
      openApp();
      return url;
    });
    ipcMain.handle('app:info', () => ({ version: app.getVersion(), serverUrl: serverUrl() }));

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
