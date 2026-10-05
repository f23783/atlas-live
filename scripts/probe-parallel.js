// Deney: paralel döküm (gemini-3.5-transcribe-live) ile sesli ön-seçim.
//   ses → [döküm oturumu] ara/kesin metin   +   [ajan oturumu, sunucu VAD kapalı]
//   ilk ara metin → activityStart (+ tampon) · kesin metin → Jev → NOT → activityEnd
//   node scripts/probe-parallel.js yagmur
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig, loadEnv, ROOT, USER_DATA } from '../src/main/config.js';
import { buildToolset, skillRegistry } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
import { JevClient, JevLedger } from '../src/main/jev.js';

const [slug = 'yagmur', how = 'client'] = process.argv.slice(2); // how: client (sendClientContent) | realtime (metin)
const cfg = loadConfig(loadEnv(), {});
const jev = new JevClient({ apiKey: cfg.typesafeKey, ledger: new JevLedger(path.join(USER_DATA, 'jev-usage.json'), cfg.jevBudgetUsd) });
const ts = buildToolset({ mode: 'jev_pre', skills: skillRegistry(new TimerManager()), jev, dryRun: true });
// how=hint: Gemini tüm araçları doğrudan görür, Jev yalnız tek satırlık ipucu verir (şema yok)
const tsDirect = buildToolset({ mode: 'direct', skills: skillRegistry(new TimerManager()), dryRun: true });
const pcm = fs.readFileSync(path.join(ROOT, 'eval/audio', `${slug}.pcm`));
const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
let t0 = performance.now(), tEnd = null;
const ms = () => Math.round(performance.now() - (tEnd ?? t0));
const log = (x) => console.log(`${String(ms()).padStart(6)} ms ${tEnd ? '(sustuktan sonra)' : '(konuşurken)     '}  ${x}`);

let agent, opened = false, buffer = [], audio = 0, finished;
const done = new Promise((r) => (finished = r));

agent = await ai.live.connect({
  model: cfg.model,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: how === 'hint' ? cfg.systemInstruction : [cfg.systemInstruction, ts.systemNote].join('\n'),
    tools: [{ functionDeclarations: (how === 'hint' ? tsDirect : ts).declarations }],
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
  },
  callbacks: {
    onmessage: async (m) => {
      const sc = m.serverContent;
      if (sc?.outputTranscription?.text) log(`model: "${sc.outputTranscription.text}"`);
      if (sc?.modelTurn?.parts?.some((p) => p.inlineData) && !audio++) log('İLK SES ◀');
      if (m.toolCall) {
        log(`toolCall ${m.toolCall.functionCalls.map((f) => `${f.name}(${JSON.stringify(f.args)})`).join(' ')}`);
        const res = [];
        for (const fc of m.toolCall.functionCalls) res.push({ id: fc.id, name: fc.name, response: (await (how === 'hint' ? tsDirect : ts).run(fc)).response });
        agent.sendToolResponse({ functionResponses: res });
      }
      if (sc?.turnComplete && audio) finished();
    },
    onclose: (e) => { log(`ajan kapandı ${e.code} ${e.reason}`); finished(); },
  },
});

let finalText = '';
const scribe = await ai.live.connect({
  model: 'gemini-3.5-transcribe-live',
  config: { responseModalities: [Modality.TEXT], inputAudioTranscription: { languageCodes: ['tr-TR'] } },
  callbacks: {
    onmessage: async (m) => {
      const sc = m.serverContent;
      if (sc?.interimInputTranscription?.text) {
        log(`ara: "${sc.interimInputTranscription.text}"`);
        if (!opened) { // konuşma başladı: sırayı aç, tamponu boşalt
          opened = true;
          agent.sendRealtimeInput({ activityStart: {} });
          for (const b of buffer) agent.sendRealtimeInput({ audio: { data: b.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
          log(`activityStart (+${buffer.length} tampon parçası)`);
          buffer = [];
        }
      }
      if (sc?.inputTranscription?.text) {
        finalText += sc.inputTranscription.text;
        log(`KESİN: "${sc.inputTranscription.text}"`);
        const { note, trace } = await ts.preRoute(finalText.trim());
        log(`Jev: ${trace.jev?.choice} (%${Math.round((trace.jev?.confidence ?? 0) * 100)}, ${trace.jev?.ms} ms)`);
        if (note && how === 'client') agent.sendClientContent({ turns: [{ role: 'user', parts: [{ text: note }] }], turnComplete: false });
        if (note && how === 'realtime') agent.sendRealtimeInput({ text: note });
        if (note && how === 'hint') agent.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `[İpucu: ${trace.skill} aracını kullan]` }] }], turnComplete: false });
        agent.sendRealtimeInput({ activityEnd: {} });
        log(`${note ? 'NOT + ' : ''}activityEnd ▶`);
      }
    },
    onclose: (e) => e.reason && log(`döküm kapandı ${e.code} ${e.reason}`),
  },
});

await new Promise((r) => setTimeout(r, 300));
for (let i = 0; i < pcm.length; i += 1600) {
  const chunk = pcm.subarray(i, i + 1600);
  scribe.sendRealtimeInput({ audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  if (opened) agent.sendRealtimeInput({ audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  else { buffer.push(chunk); if (buffer.length > 30) buffer.shift(); } // son 1,5 sn
  await new Promise((r) => setTimeout(r, 50));
}
tEnd = performance.now();
log('--- kullanıcı sustu ---');
// sessizlik akmaya devam etsin (gerçek mikrofon gibi): döküm modeli duraklamayı görsün
const silence = Buffer.alloc(1600);
const iv = setInterval(() => { scribe.sendRealtimeInput({ audio: { data: silence.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); }, 50);
await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
clearInterval(iv);
agent.close(); scribe.close();
process.exit(0);
