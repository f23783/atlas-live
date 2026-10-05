// Her Live modeline TEK bağlantı dener, kabul/ret sebebini yazar.  node scripts/check-models.js <model>...
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig } from '../src/main/config.js';
const ai = new GoogleGenAI({ apiKey: loadConfig().apiKey });
for (const model of process.argv.slice(2)) {
  const r = await new Promise(async (res) => {
    const t = setTimeout(() => res('zaman aşımı'), 20000);
    let s;
    try {
      s = await ai.live.connect({ model, config: { responseModalities: [Modality.AUDIO], ...JSON.parse(process.env.EXTRA ?? '{}') }, callbacks: {
        onmessage: (m) => {
          if (m.serverContent?.modelTurn) { clearTimeout(t); res('✓ ses geldi'); s.close(); } },
        onclose: (e) => { clearTimeout(t); res(`kapandı kod=${e.code} sebep=${e.reason}`); } } });
      s.sendRealtimeInput({ text: 'Sadece merhaba de.' });
    } catch (e) { res('connect hata: ' + e.message); }
  });
  console.log(model.padEnd(42), r);
}
process.exit(0);
