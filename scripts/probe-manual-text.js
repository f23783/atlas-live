// Deney: sunucu VAD kapalıyken (istemci sırası) metin turu nasıl gönderilir?
//   node scripts/probe-manual-text.js <varyant>
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig, loadEnv } from '../src/main/config.js';
import { buildToolset, skillRegistry } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
const decls = buildToolset({ mode: 'direct', skills: skillRegistry(new TimerManager()) }).declarations;
const serverVad = process.argv[3] === 'sunucu'; // karşılaştırma: sunucu VAD açık
const cfg = loadConfig(loadEnv(), {});
const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
const hint = '[İpucu: hava_durumu aracını kullan]';
const VARIANTS = {
  'akt+metin': (s) => { s.sendRealtimeInput({ activityStart: {} }); s.sendRealtimeInput({ text: 'Dışarısı soğuk mu?' }); s.sendRealtimeInput({ activityEnd: {} }); },
  'akt+metin+client': (s) => { s.sendRealtimeInput({ activityStart: {} }); s.sendRealtimeInput({ text: 'Dışarısı soğuk mu?' }); s.sendClientContent({ turns: [{ role: 'user', parts: [{ text: hint }] }], turnComplete: false }); s.sendRealtimeInput({ activityEnd: {} }); },
  'metin': (s) => s.sendRealtimeInput({ text: 'Dışarısı soğuk mu?' }),
  'client-tam': (s) => s.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'Dışarısı soğuk mu?' }, { text: hint }] }], turnComplete: true }),
  'metin+ipucu': (s) => s.sendRealtimeInput({ text: `Dışarısı soğuk mu?\n${hint}` }),
  'client-ipucu>metin': (s) => { s.sendClientContent({ turns: [{ role: 'user', parts: [{ text: hint }] }], turnComplete: false }); s.sendRealtimeInput({ text: 'Dışarısı soğuk mu?' }); },
};
for (const name of (process.argv[2] ?? Object.keys(VARIANTS).join(',')).split(',')) {
  let spoke = false;
  const r = await new Promise(async (resolve) => {
    const t = setTimeout(() => resolve('cevap yok (12 sn)'), 12000);
    const s = await ai.live.connect({
      model: cfg.model,
      config: {
        responseModalities: [Modality.AUDIO],
        tools: [{ functionDeclarations: decls }],
        systemInstruction: cfg.systemInstruction,
        ...(serverVad ? {} : { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }),
      },
      callbacks: {
        onmessage: (m) => {
          if (m.toolCall) { clearTimeout(t); resolve(`araç: ${m.toolCall.functionCalls[0].name}`); s.close(); }
          if (m.serverContent?.modelTurn) spoke = true;
          if (m.serverContent?.turnComplete && spoke) { clearTimeout(t); resolve('sesle cevap, ARAÇSIZ'); s.close(); }
        },
        onclose: (e) => { clearTimeout(t); resolve(`KAPANDI ${e.code} ${e.reason}`); },
      },
    });
    VARIANTS[name](s);
  });
  console.log(name.padEnd(18), r);
}
process.exit(0);
