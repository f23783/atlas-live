// Sessizlik faturalanıyor mu? Önce yalnız metin turu, sonra 10 sn sessiz ses + aynı metin turu; prompt AUDIO token'larını karşılaştır.
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig } from '../src/main/config.js';
const cfg = loadConfig();
const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
async function run(silenceSec) {
  let last = null, done;
  const s = await ai.live.connect({ model: cfg.model, config: { responseModalities: [Modality.AUDIO] }, callbacks: {
    onmessage: (m) => { if (m.usageMetadata) last = m.usageMetadata; if (m.serverContent?.turnComplete) done?.(); } } });
  const chunk = Buffer.alloc(3200); // 100 ms, 16 kHz PCM16; hafif gürültü (gerçek oda sessizliği gibi)
  for (let i = 0; i < chunk.length; i += 2) chunk.writeInt16LE(Math.round((Math.random() - 0.5) * 40), i);
  for (let t = 0; t < silenceSec * 10; t++) { s.sendRealtimeInput({ audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); await new Promise((r) => setTimeout(r, 100)); }
  await new Promise((r) => { done = r; s.sendRealtimeInput({ text: 'Sadece tamam de.' }); });
  await new Promise((r) => setTimeout(r, 400));
  s.close();
  const a = last?.promptTokensDetails?.find((d) => d.modality === 'AUDIO')?.tokenCount ?? 0;
  console.log(`${silenceSec} sn sessizlik → prompt AUDIO ${a}, toplam prompt ${last?.promptTokenCount}`);
}
await run(0);
await run(10);
process.exit(0);
