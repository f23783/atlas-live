import { EventEmitter } from 'node:events';
import { Modality } from '@google/genai';

export const SCRIBE_MODEL = 'gemini-3.5-transcribe-live';

/**
 * Paralel canlı döküm (gemini-3.5-transcribe-live). Ajan oturumu sırayı istemciye bıraktığında (jev_pre sesli),
 * kullanıcı konuşurken metni buradan alırız — ajanın kendi dökümü ancak sıra kapanınca geliyor (2026-10-05 deneyi).
 *
 * Olaylar:
 *   interim  ara metin (o ana kadarki cümle, birikimli) — "konuşma başladı" sinyali de bu
 *   final    kesin metin parçası (konuşmacı duraklayınca)
 *   usage    usageMetadata (maliyet sayacı için)
 *   error    Error
 * Durumsuzdur: koparsa sessizce yeniden bağlanır.
 */
export class Scribe extends EventEmitter {
  #ai;
  #session = null;
  #stopped = true;
  #gen = 0;
  #languages;

  constructor({ ai, languages = ['tr-TR'] }) {
    super();
    this.#ai = ai;
    this.#languages = languages;
  }

  async start() {
    this.#stopped = false;
    await this.#connect();
  }

  async #connect() {
    const gen = ++this.#gen;
    const live = (fn) => (arg) => gen === this.#gen && fn(arg);
    this.#session = await this.#ai.live.connect({
      model: SCRIBE_MODEL,
      config: { responseModalities: [Modality.TEXT], inputAudioTranscription: { languageCodes: this.#languages } },
      callbacks: {
        onmessage: live((m) => {
          const sc = m.serverContent;
          if (sc?.interimInputTranscription?.text) this.emit('interim', sc.interimInputTranscription.text);
          if (sc?.inputTranscription?.text) this.emit('final', sc.inputTranscription.text);
          if (m.usageMetadata) this.emit('usage', m.usageMetadata);
        }),
        onclose: live((e) => {
          this.emit('debug', `döküm kapandı: kod=${e?.code} sebep=${e?.reason || '-'}`);
          this.#session = null;
          if (this.#stopped) return;
          if (this.listenerCount('error')) this.emit('error', new Error(`Döküm bağlantısı kapandı: ${e?.reason || e?.code}`));
          setTimeout(() => !this.#stopped && this.#connect().catch((err) => this.listenerCount('error') && this.emit('error', err)), 800);
        }),
      },
    });
  }

  /** @param {Buffer} pcm16 16 kHz mono PCM16 LE */
  send(pcm16) {
    this.#session?.sendRealtimeInput({ audio: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  }

  stop() {
    this.#stopped = true;
    this.#gen++;
    try { this.#session?.close(); } catch { /* yoksay */ }
    this.#session = null;
  }
}
