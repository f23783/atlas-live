// Gemini Live tel biçimini yakalar (iPhone Swift istemcisi için referans): giden/gelen ham JSON çerçeveleri.
//   node scripts/capture-wire.js > out/wire.jsonl
import WebSocket from 'ws';
import { loadConfig, loadEnv } from '../src/main/config.js';
import { LiveSession } from '../src/main/live-session.js';
import { buildToolset, skillRegistry } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';

const redact = (s) => s.replace(/"data":"[A-Za-z0-9+/=]{40,}"/g, '"data":"<base64>"');
const origSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (data, ...rest) {
  console.log(JSON.stringify({ dir: 'OUT', frame: JSON.parse(redact(String(data))) }));
  return origSend.call(this, data, ...rest);
};
const origEmit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (ev, ...args) {
  if (ev === 'message') {
    try { console.log(JSON.stringify({ dir: 'IN', frame: JSON.parse(redact(args[0].toString())) })); } catch {}
  }
  return origEmit.call(this, ev, ...args);
};
const base = loadConfig(loadEnv(), {});
const s = new LiveSession({ config: { ...base, toolMode: 'direct' }, toolset: buildToolset({ mode: 'direct', skills: skillRegistry(new TimerManager()), dryRun: true }) });
let audio = 0;
s.on('audio', () => audio++);
await s.start();
await new Promise((r) => (s.state === 'open' ? r() : s.once('state', r)));
s.sendAudio(Buffer.alloc(3200));
await s.sendText('Saat kaç?');
await new Promise((r) => { const t = setTimeout(r, 15000); s.on('turnComplete', () => audio && (clearTimeout(t), r())); });
s.stop();
process.exit(0);
