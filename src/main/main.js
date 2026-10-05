import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { ROOT } from './config.js';
import { registerIpc } from './ipc.js';
import { attachTheme } from './theme.js';

let win = null;
let settingsWin = null;
const BASE_W = 460, LAB_W = 520; // ana sütun / test paneli genişliği
// Doğrulama: ATLAS_SNAPSHOT=dosya.png → pencere gizli açılır, ekran görüntüsü alınır, uygulama kapanır.
const SNAPSHOT = process.env.ATLAS_SNAPSHOT;
const SNAPSHOT_ASK = process.env.ATLAS_SNAPSHOT_ASK; // verilirse: mikrofon kapalı bağlan, bu metni sor, cevaptan sonra çek

function createWindow() {
  win = new BrowserWindow({
    width: BASE_W,
    height: 720,
    minWidth: 360,
    backgroundColor: '#0b0d12',
    title: 'Atlas',
    show: !SNAPSHOT,
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenuBarVisibility(false);
  attachTheme(win);
  const query = { ...(SNAPSHOT_ASK && { ask: SNAPSHOT_ASK }), ...(process.env.ATLAS_SNAPSHOT_LAB && { lab: '1' }) };
  win.loadFile(path.join(ROOT, 'src/renderer/index.html'), Object.keys(query).length ? { query } : undefined);
  win.on('closed', () => (win = null));
  if (SNAPSHOT) {
    // ATLAS_SNAPSHOT_SETTINGS=1 → ayar penceresinin görüntüsü
    const target = () => (process.env.ATLAS_SNAPSHOT_SETTINGS ? openSettings() : win);
    win.webContents.once('did-finish-load', () => {
      const w = target();
      w.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message}`));
      setTimeout(async () => {
        if (process.env.ATLAS_SNAPSHOT_SETTINGS === 'bottom') await w.webContents.executeJavaScript("document.querySelector('.page').scrollTop = 1e6");
        const img = await w.webContents.capturePage();
        (await import('node:fs')).writeFileSync(SNAPSHOT, img.toPNG());
        app.quit();
      }, SNAPSHOT_ASK ? 14000 : 1500);
    });
  }
}

function openSettings() {
  if (settingsWin) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    parent: win ?? undefined,
    width: 520,
    height: 700,
    minWidth: 380,
    backgroundColor: '#1a1110',
    title: 'Atlas — Ayarlar',
    show: !SNAPSHOT,
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  attachTheme(settingsWin);
  settingsWin.loadFile(path.join(ROOT, 'src/renderer/settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
  return settingsWin;
}

// Test paneli açılınca pencere sağa doğru genişler, kapanınca eski genişliğine döner.
function setLabOpen(open) {
  if (!win) return;
  const [w, h] = win.getSize();
  const target = open ? Math.max(w, BASE_W + LAB_W) : BASE_W;
  win.setMinimumSize(open ? BASE_W + 360 : 360, 500);
  if (w !== target) win.setSize(target, h);
}

app.whenReady().then(() => {
  // Yalnız mikrofon izni ver, gerisini reddet.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) =>
    cb(perm === 'media' && (details.mediaTypes ?? []).every((t) => t === 'audio')));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  const stopLive = registerIpc({ getWindow: () => win, openSettings, setLabOpen });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  app.on('before-quit', stopLive);
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
