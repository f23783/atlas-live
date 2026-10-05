import { ipcMain } from 'electron';
import { LiveSession } from './live-session.js';
import { loadConfig } from './config.js';

// IPC sözleşmesi (preload.cjs ile birebir):
//   invoke  live:start → { ok, error? } · live:stop · live:text(text) · live:info → { model, voice, hasKey, googleSearch }
//   send    live:audio(ArrayBuffer PCM16 16 kHz) · live:audio-end
//   main→UI live:event { type, payload }
const FORWARDED = ['state', 'interrupted', 'turnComplete', 'transcript', 'tool'];

export function registerIpc(getWindow) {
  let session = null;
  const emit = (type, payload) => getWindow()?.webContents.send('live:event', { type, payload });

  ipcMain.handle('live:start', async () => {
    session?.stop();
    session = new LiveSession({ config: loadConfig() });
    for (const ev of FORWARDED) session.on(ev, (p) => emit(ev, p));
    // Ses base64 olarak gelir; UI'a ham bayt yolla (IPC'de Uint8Array olarak varır, çözme maliyeti yok).
    session.on('audio', (b64) => emit('audio', Buffer.from(b64, 'base64')));
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
  ipcMain.handle('live:info', () => {
    const c = loadConfig();
    return { model: c.model, voice: c.voice, hasKey: Boolean(c.apiKey), googleSearch: c.googleSearch };
  });
  ipcMain.handle('live:text', (_e, text) => session?.sendText(String(text)) ?? false);
  ipcMain.on('live:audio', (_e, pcm) => session?.sendAudio(pcm));
  ipcMain.on('live:audio-end', () => session?.endAudio());

  return () => session?.stop();
}
