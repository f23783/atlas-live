import { ipcMain } from 'electron';
import { LiveSession } from './live-session.js';
import { loadConfig } from './config.js';

// IPC sözleşmesi (preload.cjs ile birebir):
//   invoke  live:start → { ok, error? } · live:stop · live:text(text)
//   send    live:audio(ArrayBuffer PCM16 16 kHz) · live:audio-end
//   main→UI live:event { type, payload }
const FORWARDED = ['state', 'audio', 'interrupted', 'turnComplete', 'transcript', 'tool'];

export function registerIpc(getWindow) {
  let session = null;
  const emit = (type, payload) => getWindow()?.webContents.send('live:event', { type, payload });

  ipcMain.handle('live:start', async () => {
    session?.stop();
    session = new LiveSession({ config: loadConfig() });
    for (const ev of FORWARDED) session.on(ev, (p) => emit(ev, p));
    session.on('error', (e) => emit('error', e.message));
    try {
      await session.start();
      return { ok: true };
    } catch (e) {
      session = null;
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('live:stop', () => { session?.stop(); session = null; });
  ipcMain.handle('live:text', (_e, text) => session?.sendText(String(text)) ?? false);
  ipcMain.on('live:audio', (_e, pcm) => session?.sendAudio(pcm));
  ipcMain.on('live:audio-end', () => session?.endAudio());

  return () => session?.stop();
}
