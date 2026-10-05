// Sesli testler için "kullanıcı" kayıtları üretir: Gemini'ye (Puck sesi) cümleyi okutur, 16 kHz PCM'e çevirir.
//   node scripts/make-utterances.js        → eval/audio/<slug>.pcm (başta/sonda 0,4 sn sessizlik)
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, Modality } from '@google/genai';
import { loadConfig, ROOT } from '../src/main/config.js';

const SENTENCES = {
  yagmur: "Yarın Ankara'da yağmur yağacak mı?",
  soguk: 'Dışarısı soğuk mu?',
  ram: 'RAM ne kadar dolu?',
  fikra: 'Bana kısa bir fıkra anlat.',
  muzik: 'Müziği biraz kıs.',
};
const cfg = loadConfig();
const ai = new GoogleGenAI({ apiKey: cfg.apiKey });

async function speak(text) {
  const chunks = [];
  await new Promise(async (resolve, reject) => {
    const s = await ai.live.connect({
      model: cfg.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        systemInstruction: 'Kullanıcının yazdığı cümleyi aynen, doğal bir soru tonuyla Türkçe sesli oku. Başka hiçbir şey söyleme.',
      },
      callbacks: {
        onmessage: (m) => {
          for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, 'base64'));
          if (m.serverContent?.turnComplete && chunks.length) { s.close(); resolve(); }
        },
        onclose: (e) => e?.reason && reject(new Error(e.reason)),
      },
    });
    s.sendRealtimeInput({ text });
  });
  return Buffer.concat(chunks);
}

/** 24 kHz → 16 kHz, doğrusal ara değer (konuşma için yeterli). */
function resample(pcm24) {
  const src = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);
  const out = new Int16Array(Math.floor((src.length * 2) / 3));
  for (let i = 0; i < out.length; i++) {
    const x = (i * 3) / 2, i0 = Math.floor(x), f = x - i0;
    out[i] = Math.round(src[i0] * (1 - f) + (src[Math.min(i0 + 1, src.length - 1)] ?? 0) * f);
  }
  return Buffer.from(out.buffer);
}

const pad = Buffer.alloc(16000 * 2 * 0.4);
for (const [slug, text] of Object.entries(SENTENCES)) {
  const pcm = Buffer.concat([pad, resample(await speak(text)), pad]);
  fs.writeFileSync(path.join(ROOT, 'eval/audio', `${slug}.pcm`), pcm);
  console.log(`${slug}: ${(pcm.length / 32000).toFixed(1)} sn — "${text}"`);
}
process.exit(0);
