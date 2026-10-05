// Başsız backend testi: Electron olmadan gerçek API'ye bağlanır, metin yollar, sesi WAV'a yazar.
//   npm run probe -- "Merhaba, saat kaç?"
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, OUTPUT_SAMPLE_RATE, ROOT } from '../src/main/config.js';
import { LiveSession } from '../src/main/live-session.js';

const prompt = process.argv.slice(2).join(' ') || 'Merhaba Atlas, kendini bir cümleyle tanıt.';
const cfg = loadConfig();
const s = new LiveSession({ config: cfg });
const chunks = [];
const t0 = performance.now();
let tFirstAudio = null;
const ms = () => `${Math.round(performance.now() - t0)} ms`;

s.on('state', (st) => console.log(`[${ms()}] durum: ${st}`));
s.on('error', (e) => console.error(`[${ms()}] HATA: ${e.message}`));
s.on('tool', ({ phase, calls }) => console.log(`[${ms()}] araç ${phase}:`, JSON.stringify(calls)));
s.on('audio', (b64) => {
  tFirstAudio ??= performance.now();
  chunks.push(Buffer.from(b64, 'base64'));
});
let modelText = '';
s.on('transcript', ({ role, text }) => { if (role === 'model') modelText += text; });
s.on('turnComplete', () => {
  const pcm = Buffer.concat(chunks);
  const out = path.join(ROOT, 'out', 'probe.wav');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([wavHeader(pcm.length, OUTPUT_SAMPLE_RATE), pcm]));
  console.log(`\nmodel: ${modelText.trim()}`);
  console.log(`ilk ses: ${Math.round(tFirstAudio - tSent)} ms · ses süresi: ${(pcm.length / 2 / OUTPUT_SAMPLE_RATE).toFixed(1)} sn → ${out}`);
  s.stop();
  process.exit(0);
});

let tSent;
await s.start();
await new Promise((r) => (s.state === 'open' ? r() : s.once('state', r)));
console.log(`[${ms()}] model=${cfg.model} ses=${cfg.voice} → "${prompt}"`);
tSent = performance.now();
s.sendText(prompt);
setTimeout(() => { console.error('60 sn içinde cevap yok.'); process.exit(1); }, 60_000);

function wavHeader(dataLen, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}
