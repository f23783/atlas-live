// Google araması teşhisi: tek bağlantı, internet gerektiren tek soru, cevap bitince kapanır. Maliyeti yazar.
//   node scripts/search-check.js <model> <varyant>
//   varyant: ara | ara+fn | tam   (tam = iPhone'daki kurulum: arama + fonksiyonlar + döküm + sıkıştırma)
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig, loadEnv } from '../src/main/config.js';
import { costUsd } from '../src/main/pricing.js';
const [model = 'gemini-3.8-live', variant = 'ara'] = process.argv.slice(2);
const cfg = loadConfig(loadEnv(), {});
const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
const fn = { functionDeclarations: [{ name: 'get_current_time', description: 'Saat' }, { name: 'hava_durumu', description: 'Hava', parameters: { type: 'OBJECT', properties: { sehir: { type: 'STRING' } } } }] };
const config = { responseModalities: [Modality.AUDIO], tools: [{ googleSearch: {} }] };
if (variant !== 'ara') config.tools = [fn, { googleSearch: {} }];
if (variant === 'tam') { Object.assign(config, { inputAudioTranscription: {}, outputAudioTranscription: {}, contextWindowCompression: process.env.CWC ? JSON.parse(process.env.CWC) : { triggerTokens: '8000', slidingWindow: {} }, sessionResumption: {} }); for (const k of (process.env.DROP || '').split(',').filter(Boolean)) delete config[k]; }
let usd = 0, grounded = false, audio = 0, text = '';
const result = await new Promise(async (resolve) => {
  const t = setTimeout(() => resolve('zaman aşımı'), 25000);
  let s;
  s = await ai.live.connect({ model, config, callbacks: {
    onmessage: (m) => {
      if (m.usageMetadata) usd += costUsd(m.usageMetadata);
      const sc = m.serverContent;
      if (sc?.groundingMetadata) grounded = true;
      if (sc?.modelTurn?.parts?.some((p) => p.inlineData)) audio++;
      if (sc?.outputTranscription?.text) text += sc.outputTranscription.text;
      if (m.toolCall) s.sendToolResponse({ functionResponses: m.toolCall.functionCalls.map((f) => ({ id: f.id, name: f.name, response: { not: 'test' } })) });
      if (sc?.turnComplete && audio) { clearTimeout(t); resolve('tamam'); s.close(); }
    },
    onclose: (e) => { clearTimeout(t); resolve(`KAPANDI ${e.code} ${e.reason}`); },
  } });
  s.sendRealtimeInput({ text: 'Bugün Türkiye\'de gündemdeki bir haberi internetten bakıp tek cümleyle söyle.' });
});
console.log(`${model} · ${variant} → ${result} · arama:${grounded ? 'evet' : 'hayır'} · ses:${audio} · $${usd.toFixed(5)} (₺${(usd * 49.16).toFixed(2)})`);
if (text) console.log('  model: ' + text.slice(0, 160));
process.exit(0);
