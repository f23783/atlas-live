import { EventEmitter } from 'node:events';
import { GoogleGenAI, Modality } from '@google/genai';
import { INPUT_SAMPLE_RATE } from './config.js';
import { buildToolset } from './tools/index.js';

const MAX_RECONNECTS = 5;
const FATAL_CLOSE = /quota|billing|api key|permission|not found|not supported|invalid/i;

/**
 * Gemini Live oturumunun tek sahibi. Electron'dan bağımsızdır: UI'ı yalnız olaylarla besler,
 * bu yüzden scripts/probe.js ile başsız (headless) da sürülebilir.
 *
 * Olaylar:
 *   state        'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
 *   audio        base64 PCM16 24 kHz parça (modelin sesi)
 *   interrupted  kullanıcı söze girdi; çalan sesi hemen kes
 *   turnComplete model sırasını bitirdi
 *   transcript   { role: 'user' | 'model', text } — artımlı parçalar
 *   tool         { phase: 'call', calls } | { phase: 'result', traces } — trace: araç, argüman, Jev kararı, süre
 *   usage        o turun usageMetadata'sı (turda bir kez, birikimli değil)
 *   error        Error
 */
export class LiveSession extends EventEmitter {
  #ai;
  #cfg;
  #toolset;
  #userText = ''; // bu turda kullanıcının söyledikleri (Jev'e asistanın özeti yanında ham cümle olarak gider)
  #session = null;
  #gen = 0; // her bağlantıya numara; eski bağlantıdan gelen geç callback'ler yok sayılır
  #handle = null; // session resumption handle
  #stopping = false;
  #reconnects = 0;
  #cancelledCalls = new Set();
  #needsKey;
  state = 'idle';

  /** @param {{ config, ai?, toolset? }} o  toolset verilmezse yalnız doğrudan kip, yetenek yok (saat). */
  constructor({ config, ai, toolset }) {
    super();
    this.#cfg = config;
    this.#toolset = toolset ?? buildToolset({ skills: [] });
    this.#needsKey = !ai;
    this.#ai = ai ?? new GoogleGenAI({ apiKey: config.apiKey });
  }

  // Dinleyicisiz 'error' EventEmitter'da süreci çökertir; kopma/yeniden bağlanma bilgisi buna değmez.
  #error(err) {
    if (this.listenerCount('error')) this.emit('error', err);
  }

  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  connectConfig() {
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction: [this.#cfg.systemInstruction, this.#toolset.systemNote].filter(Boolean).join('\n'),
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.#cfg.voice } } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Ücretsiz katmanda googleSearch açıkken bağlantı anında 1011 "quota" ile kapanıyor (2026-10-05) → varsayılan kapalı.
      tools: [{ functionDeclarations: this.#toolset.declarations }, ...(this.#cfg.googleSearch ? [{ googleSearch: {} }] : [])],
      // 15 dk sınırını kaldırır ve maliyete tavan koyar (bkz. config.contextLimit).
      contextWindowCompression: { triggerTokens: String(this.#cfg.contextLimit ?? 8000), slidingWindow: {} },
      sessionResumption: this.#handle ? { handle: this.#handle } : {},
    };
  }

  async start() {
    if (this.#needsKey && !this.#cfg.apiKey) throw new Error('GEMINI_API_KEY yok (.env veya ortam değişkeni).');
    this.#stopping = false;
    this.#reconnects = 0;
    await this.#connect('connecting');
  }

  async #connect(phase) {
    const gen = ++this.#gen;
    this.#setState(phase);
    const live = (fn) => (arg) => gen === this.#gen && fn(arg);
    try {
      this.#session = await this.#ai.live.connect({
        model: this.#cfg.model,
        config: this.connectConfig(),
        callbacks: {
          // Sayaç burada sıfırlanmaz: kota/yetki hatasında sunucu soketi açıp hemen kapatır,
          // açılışta sıfırlamak sonsuz yeniden bağlanma döngüsü demek.
          onopen: live(() => this.#setState('open')),
          onmessage: live((m) => this.#onMessage(m)),
          onerror: live((e) => this.#error(new Error(e?.message ?? 'WebSocket hatası'))),
          onclose: live((e) => this.#onClose(e)),
        },
      });
    } catch (err) {
      if (gen !== this.#gen) return;
      this.#error(err);
      await this.#scheduleReconnect();
    }
  }

  #onMessage(m) {
    if (m.usageMetadata) this.emit('usage', m.usageMetadata);
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.#handle = m.sessionResumptionUpdate.newHandle;
    }
    if (m.goAway) {
      // Sunucu bağlantıyı birazdan kapatacak: kapanmayı beklemeden handle ile yeniden bağlan.
      this.#reconnectNow();
      return;
    }
    if (m.toolCall?.functionCalls?.length) this.#handleToolCall(m.toolCall.functionCalls);
    if (m.toolCallCancellation?.ids) for (const id of m.toolCallCancellation.ids) this.#cancelledCalls.add(id);

    const sc = m.serverContent;
    if (!sc) return;
    this.#reconnects = 0; // model gerçekten cevap veriyor → bağlantı sağlıklı
    if (sc.interrupted) this.emit('interrupted');
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) this.emit('audio', part.inlineData.data);
    }
    if (sc.inputTranscription?.text) {
      this.#userText += sc.inputTranscription.text;
      this.emit('transcript', { role: 'user', text: sc.inputTranscription.text });
    }
    if (sc.outputTranscription?.text) this.emit('transcript', { role: 'model', text: sc.outputTranscription.text });
    if (sc.turnComplete) {
      this.#userText = '';
      this.emit('turnComplete');
    }
  }

  /** Toolset'in Jev'e verdiği ham kullanıcı cümlesi. */
  get userText() {
    return this.#userText.trim();
  }

  async #handleToolCall(calls) {
    this.emit('tool', { phase: 'call', calls });
    const done = await Promise.all(calls.map(async (fc) => ({ fc, ...(await this.#toolset.run(fc)) })));
    const live = done.filter(({ fc }) => !this.#cancelledCalls.delete(fc.id));
    if (!live.length) return;
    this.emit('tool', { phase: 'result', traces: live.map((d) => d.trace) });
    this.#session?.sendToolResponse({ functionResponses: live.map(({ fc, response }) => ({ id: fc.id, name: fc.name, response })) });
  }

  #onClose(e) {
    this.#session = null;
    if (this.#stopping) return this.#setState('closed');
    const reason = e?.reason || `kod ${e?.code ?? '?'}`;
    this.#error(new Error(`Bağlantı kapandı: ${reason}`));
    // Kota, anahtar, model adı gibi hatalar yeniden denemeyle düzelmez; denemek sadece kotayı yakar.
    if (e?.code === 1008 || FATAL_CLOSE.test(reason)) return this.#setState('closed');
    this.#scheduleReconnect();
  }

  #reconnectNow() {
    const old = this.#session;
    this.#connect('reconnecting'); // #gen artar → eski bağlantının onclose'u yok sayılır
    try { old?.close(); } catch { /* zaten kapalı */ }
  }

  async #scheduleReconnect() {
    if (this.#stopping) return;
    if (++this.#reconnects > MAX_RECONNECTS) {
      this.#setState('closed');
      this.#error(new Error('Yeniden bağlanılamadı, vazgeçildi.'));
      return;
    }
    this.#setState('reconnecting');
    await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (this.#reconnects - 1), 8000)));
    if (!this.#stopping) await this.#connect('reconnecting');
  }

  /** @param {ArrayBuffer|ArrayBufferView} pcm16 16 kHz mono PCM16 LE */
  sendAudio(pcm16) {
    if (this.state !== 'open' || !this.#session) return false;
    const buf = ArrayBuffer.isView(pcm16) ? Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength) : Buffer.from(pcm16);
    this.#session.sendRealtimeInput({ audio: { data: buf.toString('base64'), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } });
    return true;
  }

  /** Mikrofon kapatılınca: VAD'ın bekleyen sesi işlemesini sağlar. */
  endAudio() {
    if (this.state === 'open') this.#session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  /** Uygulamadan modele bilgi (ör. zamanlayıcı bitti). Model bunu kullanıcıya sesli iletir. */
  sendSystemNote(text) {
    return this.#sendRaw(`[Sistem bildirimi — kullanıcı söylemedi] ${text}`);
  }

  /**
   * Kullanıcının yazdığı metin (yazılı girişte transkript gelmez; Jev için tura kaydedilir).
   * jev_pre kipinde önce Jev'e sorulur; öneri varsa aynı mesaja eklenir (Gemini cevaba başlamadan görür).
   */
  async sendText(text) {
    if (this.state !== 'open' || !this.#session || !text?.trim()) return false;
    let msg = text;
    if (this.#toolset.preRoute) {
      const { note, trace } = await this.#toolset.preRoute(String(text));
      this.emit('tool', { phase: 'result', traces: [trace] });
      if (note) msg = `${text}\n\n${note}`;
    }
    const ok = this.#sendRaw(msg);
    if (ok) this.#userText = String(text);
    return ok;
  }

  #sendRaw(text) {
    if (this.state !== 'open' || !this.#session || !text?.trim()) return false;
    this.#session.sendRealtimeInput({ text });
    return true;
  }

  stop() {
    this.#stopping = true;
    this.#gen++;
    this.#handle = null;
    try { this.#session?.close(); } catch { /* yoksay */ }
    this.#session = null;
    this.#setState('closed');
  }
}
