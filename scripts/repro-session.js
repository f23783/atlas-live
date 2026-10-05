// Gerçek kullanımı taklit eder: bağlan → uzun sessizlik (oda gürültüsü) → konuş → sessizlik → konuş. Her olayı yazar.
//   node scripts/repro-session.js [kip=jev_pre] [ilk_sessizlik_sn=15]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnv, ROOT, USER_DATA } from '../src/main/config.js';
import { LiveSession } from '../src/main/live-session.js';
import { buildToolset, skillRegistry } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
import { JevClient, JevLedger } from '../src/main/jev.js';

const [mode = 'jev_pre', lead = '15'] = process.argv.slice(2);
const base = loadConfig(loadEnv(), {});
const jev = new JevClient({ apiKey: base.typesafeKey, ledger: new JevLedger(path.join(USER_DATA, 'jev-usage.json'), base.jevBudgetUsd) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const log = (x) => console.log(`${String(Math.round(performance.now() - t0)).padStart(7)} ms  ${x}`);
let session;
const toolset = buildToolset({ mode, skills: skillRegistry(new TimerManager()), jev, dryRun: true, userText: () => session?.userText ?? '' });
session = new LiveSession({ config: { ...base, toolMode: mode }, toolset });
for (const ev of ['state', 'debug', 'interrupted', 'watchdog']) session.on(ev, (x) => log(`${ev}: ${typeof x === 'string' ? x : JSON.stringify(x ?? '')}`));
session.on('error', (e) => log(`HATA: ${e.message}`));
session.on('tool', (t) => t.phase === 'result' && log(`araç: ${t.traces.map((x) => x.name + (x.skill ? '→' + x.skill : '')).join(',')}`));
let audio = 0;
session.on('audio', () => { if (!audio++) log('model ses veriyor'); });
session.on('turnComplete', () => { log(`turnComplete (ses ${audio})`); audio = 0; });

const noise = () => { const b = Buffer.alloc(1600); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(Math.round((Math.random() - 0.5) * 300), i); return b; };
async function stream(buf) { for (let i = 0; i < buf.length; i += 1600) { session.sendAudio(buf.subarray(i, i + 1600)); await sleep(50); } }
async function quiet(sec) { for (let i = 0; i < sec * 20; i++) { session.sendAudio(noise()); await sleep(50); } }

await session.start();
await new Promise((r) => (session.state === 'open' ? r() : session.once('state', r)));
await quiet(Number(lead));
log('>>> konuşuyor: ram');
await stream(fs.readFileSync(path.join(ROOT, 'eval/audio/ram.pcm')));
await quiet(12);
log('>>> konuşuyor: fıkra');
await stream(fs.readFileSync(path.join(ROOT, 'eval/audio/fikra.pcm')));
await quiet(12);
session.stop();
process.exit(0);
