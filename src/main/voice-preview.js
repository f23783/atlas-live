import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, Modality } from '@google/genai';

const SAMPLE_TEXT = 'Merhaba Fido, ben Atlas. Sesim kulağına nasıl geliyor?';

/**
 * Bir sesin örneğini üretir: kısa bir Live oturumu açar, sabit cümleyi okutur, PCM'i (24 kHz) diske önbellekler.
 * Her ses+model için bir kez üretilir; maliyeti tek kısa tur (~₺0,05). Aynı anda tek üretim.
 */
export class VoicePreview {
  #queue = Promise.resolve();

  constructor({ dir, apiKey, ai }) {
    this.dir = dir;
    this.ai = ai ?? new GoogleGenAI({ apiKey });
  }

  sample(voice, model) {
    const file = path.join(this.dir, `${model}__${voice}.pcm`);
    if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file));
    const job = this.#queue.then(() => this.#generate(voice, model, file));
    this.#queue = job.catch(() => {});
    return job;
  }

  async #generate(voice, model, file) {
    if (fs.existsSync(file)) return fs.readFileSync(file); // kuyrukta beklerken üretilmiş olabilir
    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session?.close(); reject(new Error('Ses örneği 20 sn içinde gelmedi.')); }, 20000);
      let session;
      const finish = (err) => { clearTimeout(timer); session?.close(); err ? reject(err) : resolve(); };
      this.ai.live
        .connect({
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            systemInstruction: 'Kullanıcının yazdığı cümleyi aynen, doğal bir tonla Türkçe sesli oku. Başka hiçbir şey söyleme.',
          },
          callbacks: {
            onmessage: (m) => {
              for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, 'base64'));
              if (m.serverContent?.turnComplete) finish(chunks.length ? null : new Error('Model ses döndürmedi.'));
            },
            onclose: (e) => e?.reason && finish(new Error(e.reason)),
          },
        })
        .then((s) => { session = s; s.sendRealtimeInput({ text: SAMPLE_TEXT }); })
        .catch(finish);
    });
    const pcm = Buffer.concat(chunks);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, pcm);
    return pcm;
  }
}
