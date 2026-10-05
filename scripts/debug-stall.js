// jev_pre takılmasını teşhis: bir vakayı N kez koşar, araç cevabından sonra sunucudan gelen her mesajı özetler.
//   node scripts/debug-stall.js "ram ne kadar dolu" 4
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { loadConfig, loadEnv, USER_DATA } from '../src/main/config.js';
import { LiveSession } from '../src/main/live-session.js';
import { buildToolset, skillRegistry } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
import { JevClient, JevLedger } from '../src/main/jev.js';

const [say = 'ram ne kadar dolu', n = '3', mode = 'jev_pre'] = process.argv.slice(2);
const base = loadConfig(loadEnv(), {});
const jev = new JevClient({ apiKey: base.typesafeKey, ledger: new JevLedger(path.join(USER_DATA, 'jev-usage.json'), base.jevBudgetUsd) });
const real = new GoogleGenAI({ apiKey: base.apiKey });
for (let i = 0; i < Number(n); i++) {
  const log = [];
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  // live.connect'i sar: her ham mesajı kaydet
  const ai = { live: { connect: (o) => real.live.connect({ ...o, callbacks: { ...o.callbacks, onmessage: (m) => {
    const sc = m.serverContent;
    const k = [m.toolCall && `toolCall(${m.toolCall.functionCalls.map((f) => f.name).join(',')})`, sc?.modelTurn && `modelTurn(${sc.modelTurn.parts.map((p) => (p.inlineData ? 'ses' : p.text ? `metin:${p.text.slice(0, 60)}` : p.thought ? 'düşünce' : Object.keys(p).join('+'))).join(',')})`,
      sc?.outputTranscription && `yazı:"${sc.outputTranscription.text}"`, sc?.turnComplete && 'turnComplete', sc?.generationComplete && 'generationComplete', sc?.interrupted && 'interrupted', m.usageMetadata && 'usage', m.goAway && 'goAway', m.sessionResumptionUpdate && 'resumption', m.setupComplete && 'setup'].filter(Boolean);
    if (k.length) log.push(`${ms()} ${k.join(' ')}`);
    o.callbacks.onmessage(m);
  } } }) } };
  let session;
  const toolset = buildToolset({ mode, skills: skillRegistry(new TimerManager()), jev, dryRun: true, userText: () => session?.userText ?? '' });
  session = new LiveSession({ config: { ...base, toolMode: mode }, ai, toolset });
  session.on('tool', (t) => t.phase === 'result' && log.push(`${ms()} >> araç sonucu: ${t.traces.map((x) => `${x.name}${x.skill ? `→${x.skill}` : ''}`).join(',')}`));
  session.on('error', (e) => log.push(`${ms()} HATA ${e.message}`));
  let audio = 0;
  session.on('audio', () => audio++);
  await session.start();
  await new Promise((r) => (session.state === 'open' ? r() : session.once('state', r)));
  await session.sendText(say);
  await new Promise((r) => { const t = setTimeout(r, 25000); session.on('turnComplete', () => audio && (clearTimeout(t), setTimeout(r, 300))); });
  session.stop();
  console.log(`\n=== koşu ${i + 1}: ${audio ? 'SES GELDİ' : 'TAKILDI'} (${audio} ses parçası)`);
  console.log(log.filter((l) => !/ modelTurn\(ses(,ses)*\)$/.test(l)).join('\n'));
}
process.exit(0);
