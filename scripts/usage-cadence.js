// usageMetadata bir turda kaç kez geliyor, birikimli mi? (sayaç çift saymasın diye)
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig } from '../src/main/config.js';
const cfg = loadConfig();
const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
let done;
const s = await ai.live.connect({ model: cfg.model, config: { responseModalities: [Modality.AUDIO], contextWindowCompression: { triggerTokens: '8000', slidingWindow: {} } }, callbacks: {
  onmessage: (m) => {
    const keys = Object.keys(m).filter((k) => m[k] !== undefined && k !== 'usageMetadata');
    if (m.usageMetadata) console.log('usage', JSON.stringify({ p: m.usageMetadata.promptTokenCount, r: m.usageMetadata.responseTokenCount, t: m.usageMetadata.thoughtsTokenCount, with: keys }));
    if (m.serverContent?.turnComplete) { console.log('-- turnComplete'); done?.(); }
  }, onclose: (e) => e.reason && console.log('kapandı', e.code, e.reason) } });
for (const q of ['Ankara hakkında üç cümle söyle.', 'Peki İzmir?']) await new Promise((r) => { done = r; s.sendRealtimeInput({ text: q }); });
await new Promise((r) => setTimeout(r, 500));
s.close(); process.exit(0);
