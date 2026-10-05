// Sesli uçtan uca test: eval/audio kayıtlarını uygulamanın LiveSession'ına mikrofon gibi (gerçek zamanlı) besler.
//   node scripts/voice-test.js [kip=jev_pre] [kayıtlar=yagmur,soguk,ram,fikra,muzik]
// Araçlar kuru çalışır. Süreler "kayıt bitti" anından (kayıtta 0,4 sn sessizlik payı var).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnv, ROOT, USER_DATA } from '../src/main/config.js';
import { LiveSession } from '../src/main/live-session.js';
import { buildToolset, skillRegistry } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
import { JevClient, JevLedger } from '../src/main/jev.js';

const [mode = 'jev_pre', list = 'yagmur,soguk,ram,fikra,muzik'] = process.argv.slice(2);
const base = loadConfig(loadEnv(), {});
const jev = new JevClient({ apiKey: base.typesafeKey, ledger: new JevLedger(path.join(USER_DATA, 'jev-usage.json'), base.jevBudgetUsd) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const slug of list.split(',')) {
  const pcm = fs.readFileSync(path.join(ROOT, 'eval/audio', `${slug}.pcm`));
  let session;
  const toolset = buildToolset({ mode, skills: skillRegistry(new TimerManager()), jev: mode === 'direct' ? null : jev, dryRun: true, userText: () => session?.userText ?? '' });
  session = new LiveSession({ config: { ...base, toolMode: mode }, toolset });
  let tEnd = null, firstAudio = null;
  const ev = [];
  const at = () => (tEnd ? Math.round(performance.now() - tEnd) : -1);
  session.on('userLive', (e) => e.final && ev.push(`${at()} döküm: "${e.text}"`));
  session.on('transcript', (e) => e.role === 'user' && ev.push(`${at()} döküm(ajan): "${e.text}"`));
  session.on('tool', (t) => t.phase === 'result' && t.traces.forEach((x) => ev.push(`${at()} ${x.name}${x.jev ? ` → ${x.jev.choice} (${x.jev.ms} ms${x.speculative ? ', önceden' : ''})` : ''}${x.skill && !x.jev ? ` ${JSON.stringify(x.args)}` : ''}`)));
  session.on('audio', () => { if (!firstAudio) { firstAudio = at(); ev.push(`${firstAudio} İLK SES`); } });
  session.on('watchdog', () => ev.push(`${at()} BEKÇİ dürttü`));
  session.on('error', (e) => ev.push(`${at()} hata: ${e.message}`));
  await session.start();
  await new Promise((r) => (session.state === 'open' ? r() : session.once('state', r)));
  for (let i = 0; i < pcm.length; i += 1600) { session.sendAudio(pcm.subarray(i, i + 1600)); await sleep(50); }
  tEnd = performance.now();
  const silence = Buffer.alloc(1600);
  const iv = setInterval(() => session.sendAudio(silence), 50); // mikrofon açık kalır
  await new Promise((r) => { const t = setTimeout(r, 15000); session.on('turnComplete', () => firstAudio && (clearTimeout(t), r())); });
  clearInterval(iv);
  session.stop();
  console.log(`\n== ${slug} (${mode}) ${firstAudio ? `ilk ses ${firstAudio} ms` : 'SES YOK'}\n  ${ev.join('\n  ')}`);
  await sleep(800);
}
process.exit(0);
