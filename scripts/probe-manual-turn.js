// Deney: sunucu VAD'ı kapalıyken (sırayı istemci tutar) ön-seçim notu sesli tura girebiliyor mu?
//   node scripts/probe-manual-turn.js yagmur [once|sonra]
//   once : ses → transkript bekle → Jev → NOT → activityEnd
//   sonra: ses → transkript bekle → Jev → activityEnd → NOT
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig, loadEnv, ROOT, USER_DATA } from '../src/main/config.js';
import { buildToolset, skillRegistry } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
import { JevClient, JevLedger } from '../src/main/jev.js';

const [slug = 'yagmur', variant = 'once'] = process.argv.slice(2);
const cfg = loadConfig(loadEnv(), {});
const jev = new JevClient({ apiKey: cfg.typesafeKey, ledger: new JevLedger(path.join(USER_DATA, 'jev-usage.json'), cfg.jevBudgetUsd) });
const ts = buildToolset({ mode: 'jev_pre', skills: skillRegistry(new TimerManager()), jev, dryRun: true });
const pcm = fs.readFileSync(path.join(ROOT, 'eval/audio', `${slug}.pcm`));
const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
let t0 = 0;
const ms = () => Math.round(performance.now() - t0);
const log = (x) => console.log(`${String(ms()).padStart(6)} ms  ${x}`);
let transcript = '', lastTr = 0, audio = 0, s;
const done = new Promise((resolve) => {
  ai.live.connect({
    model: cfg.model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: [cfg.systemInstruction, ts.systemNote].join('\n'),
      tools: [{ functionDeclarations: ts.declarations }],
      inputAudioTranscription: {}, outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    },
    callbacks: {
      onmessage: async (m) => {
        const sc = m.serverContent;
        if (sc?.inputTranscription?.text) { transcript += sc.inputTranscription.text; lastTr = performance.now(); log(`girdi yazısı: "${sc.inputTranscription.text}"`); }
        if (sc?.outputTranscription?.text) log(`model: "${sc.outputTranscription.text}"`);
        if (sc?.modelTurn?.parts?.some((p) => p.inlineData)) { if (!audio++) log('İLK SES'); }
        if (m.toolCall) {
          log(`toolCall ${m.toolCall.functionCalls.map((f) => `${f.name}(${JSON.stringify(f.args)})`).join(' ')}`);
          const responses = [];
          for (const fc of m.toolCall.functionCalls) { const r = await ts.run(fc); responses.push({ id: fc.id, name: fc.name, response: r.response }); }
          s.sendToolResponse({ functionResponses: responses });
        }
        if (sc?.interrupted) log('interrupted');
        if (sc?.turnComplete) { log(`turnComplete (ses parçası ${audio})`); if (audio) resolve(); }
      },
      onclose: (e) => { log(`kapandı ${e.code} ${e.reason}`); resolve(); },
    },
  }).then(async (sess) => {
    s = sess;
    await new Promise((r) => setTimeout(r, 300));
    s.sendRealtimeInput({ activityStart: {} });
    for (let i = 0; i < pcm.length; i += 1600) { // 50 ms parçalar, gerçek zamanlı
      s.sendRealtimeInput({ audio: { data: pcm.subarray(i, i + 1600).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
      await new Promise((r) => setTimeout(r, 50));
    }
    t0 = performance.now();
    log('--- ses bitti (kullanıcı sustu) ---');
    if (variant === 'yaris') { // sırayı hemen bitir, transkripti ve Jev'i sonra yetiştirmeye çalış
      s.sendRealtimeInput({ activityEnd: {} });
      log('activityEnd (hemen)');
    }
    // transkript dursun: son parçadan 200 ms geçsin, en çok 1500 ms bekle
    while (ms() < 1500 && (!transcript || performance.now() - lastTr < 200)) await new Promise((r) => setTimeout(r, 25));
    log(`transkript: "${transcript.trim()}"`);
    const { note, trace } = await ts.preRoute(transcript.trim());
    log(`Jev: ${trace.jev?.choice} (%${Math.round((trace.jev?.confidence ?? 0) * 100)}, ${trace.jev?.ms} ms) not=${note ? 'var' : 'yok'}`);
    if (variant === 'yaris') { if (note) { s.sendRealtimeInput({ text: note }); log('NOT (yarış)'); } }
    else if (variant === 'once') { if (note) s.sendRealtimeInput({ text: note }); s.sendRealtimeInput({ activityEnd: {} }); log('NOT → activityEnd'); }
    else { s.sendRealtimeInput({ activityEnd: {} }); if (note) s.sendRealtimeInput({ text: note }); log('activityEnd → NOT'); }
  });
});
await Promise.race([done, new Promise((r) => setTimeout(r, 25000))]);
s?.close();
process.exit(0);
