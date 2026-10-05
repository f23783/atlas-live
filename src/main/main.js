import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { ROOT } from './config.js';
import { registerIpc } from './ipc.js';
import { attachTheme } from './theme.js';

let win = null;
// Doğrulama: ATLAS_SNAPSHOT=dosya.png → pencere gizli açılır, ekran görüntüsü alınır, uygulama kapanır.
const SNAPSHOT = process.env.ATLAS_SNAPSHOT;
const SNAPSHOT_ASK = process.env.ATLAS_SNAPSHOT_ASK; // verilirse: mikrofon kapalı bağlan, bu metni sor, cevaptan sonra çek

function createWindow() {
  win = new BrowserWindow({
    width: 460,
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
  win.loadFile(path.join(ROOT, 'src/renderer/index.html'), SNAPSHOT_ASK ? { query: { ask: SNAPSHOT_ASK } } : undefined);
  win.on('closed', () => (win = null));
  if (SNAPSHOT) {
    win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message}`));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      (await import('node:fs')).writeFileSync(SNAPSHOT, img.toPNG());
      app.quit();
    }, SNAPSHOT_ASK ? 14000 : 1500));
  }
}

app.whenReady().then(() => {
  // Yalnız mikrofon izni ver, gerisini reddet.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) =>
    cb(perm === 'media' && (details.mediaTypes ?? []).every((t) => t === 'audio')));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  const stopLive = registerIpc(() => win);
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  app.on('before-quit', stopLive);
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
