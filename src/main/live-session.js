import { EventEmitter } from 'node:events';
import { GoogleGenAI, Modality } from '@google/genai';
import { INPUT_SAMPLE_RATE } from './config.js';
import { toolConfig, runToolCalls, LOCAL_TOOLS } from './tools.js';

const MAX_RECONNECTS = 5;

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
 *   tool         { phase: 'call' | 'result', calls }
 *   error        Error
 */
export class LiveSession extends EventEmitter {
  #ai;
  #cfg;
  #tools;
  #session = null;
  #gen = 0; // her bağlantıya numara; eski bağlantıdan gelen geç callback'ler yok sayılır
  #handle = null; // session resumption handle
  #stopping = false;
  #reconnects = 0;
  #cancelledCalls = new Set();
  #needsKey;
  state = 'idle';

  constructor({ config, ai, tools = LOCAL_TOOLS }) {
    super();
    this.#cfg = config;
    this.#tools = tools;
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
      systemInstruction: this.#cfg.systemInstruction,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.#cfg.voice } } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: toolConfig(this.#tools),
      // 15 dk sınırını kaldırır; bağlantı ~10 dk'da yenilenince handle ile kaldığımız yerden devam ederiz.
      contextWindowCompression: { slidingWindow: {} },
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
          onopen: live(() => {
            this.#reconnects = 0;
            this.#setState('open');
          }),
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
    if (sc.interrupted) this.emit('interrupted');
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) this.emit('audio', part.inlineData.data);
    }
    if (sc.inputTranscription?.text) this.emit('transcript', { role: 'user', text: sc.inputTranscription.text });
    if (sc.outputTranscription?.text) this.emit('transcript', { role: 'model', text: sc.outputTranscription.text });
    if (sc.turnComplete) this.emit('turnComplete');
  }

  async #handleToolCall(calls) {
    this.emit('tool', { phase: 'call', calls });
    const responses = (await runToolCalls(calls, this.#tools)).filter((r) => !this.#cancelledCalls.delete(r.id));
    if (!responses.length) return;
    this.emit('tool', { phase: 'result', calls: responses });
    this.#session?.sendToolResponse({ functionResponses: responses });
  }

  #onClose(e) {
    this.#session = null;
    if (this.#stopping) return this.#setState('closed');
    this.#error(new Error(`Bağlantı kapandı: ${e?.reason || e?.code || 'bilinmiyor'}`));
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

  sendText(text) {
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
