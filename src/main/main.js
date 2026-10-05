import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { ROOT } from './config.js';
import { registerIpc } from './ipc.js';

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 360,
    backgroundColor: '#0b0d12',
    title: 'Atlas',
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  // Yalnız mikrofon izni ver, gerisini reddet.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) =>
    cb(perm === 'media' && (details.mediaTypes ?? []).every((t) => t === 'audio')));
  const stopLive = registerIpc(() => win);
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  app.on('before-quit', stopLive);
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
