// Faturalanan token'ları ölçer: aynı oturumda birkaç tur metin sorar, her turun usageMetadata'sını yazar.
// Amaç: Live API her turda birikmiş bağlamı yeniden faturalıyor mu?   node scripts/usage.js
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig } from '../src/main/config.js';

const cfg = loadConfig();
const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
const questions = ['Merhaba, bir cümleyle kendini tanıt.', 'Ankara hakkında iki cümle söyle.', 'Az önce hangi şehirden bahsettin?'];
let resolveTurn;
const s = await ai.live.connect({
  model: cfg.model,
  config: { responseModalities: [Modality.AUDIO], systemInstruction: cfg.systemInstruction },
  callbacks: {
    onmessage: (m) => {
      if (m.usageMetadata) last = m.usageMetadata;
      if (m.serverContent?.turnComplete) resolveTurn();
    },
    onclose: (e) => e.reason && console.error('kapandı:', e.reason),
  },
});
let last = null;
for (const q of questions) {
  last = null;
  await new Promise((r) => { resolveTurn = r; s.sendRealtimeInput({ text: q }); });
  await new Promise((r) => setTimeout(r, 300)); // usageMetadata turnComplete'ten hemen sonra gelebilir
  console.log(`\n"${q}"\n`, JSON.stringify(last));
}
s.close();
process.exit(0);
