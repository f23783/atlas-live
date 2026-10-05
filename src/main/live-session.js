import { EventEmitter } from 'node:events';
import { GoogleGenAI, Modality } from '@google/genai';
import { INPUT_SAMPLE_RATE } from './config.js';
import { buildToolset } from './tools/index.js';
import { Scribe } from './scribe.js';

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
 *   watchdog     { ms } — araç sonucundan sonra model susunca bekçi dürttü
 *   userLive     { text, final } — istemci sırası kipinde kullanıcının canlı dökümü (paralel döküm modelinden)
 *   scribeUsage  döküm oturumunun usageMetadata'sı
 *
 * Sıra kipi: toolset.preRoute varsa (jev_pre) sırayı İSTEMCİ tutar: sunucu VAD kapalı, ses paralel döküm
 * modeline de akar; ilk ara metinde activityStart, kesin metinde Jev ipucu + activityEnd. Gerekçe ve ölçüm:
 * scripts/probe-parallel.js (ajanın kendi dökümü ancak sıra kapanınca geliyor, Jev'e yetişmiyor).
 *   error        Error
 */
/** Ara ve kesin döküm karşılaştırması: noktalama, boşluk ve büyük/küçük harf farkı önemsiz. */
const normalize = (t) => t.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, '');

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
  #watchdog = null; // araç sonucundan sonra model susarsa dürtmek için
  #openedAt = 0;
  #lastReason = '';
  // istemci sırası (jev_pre sesli)
  #clientTurns;
  #scribe = null;
  #turnOpen = false;
  #preroll = []; // sıra kapalıyken son ~1,5 sn ses: konuşmanın ilk hecesi kaybolmasın
  #finalText = '';
  #closeTimer = null;
  #speculate = null; // { key, promise } — ara metin durulunca Jev'e önceden sorulan karar
  #specTimer = null;
  state = 'idle';

  /** @param {{ config, ai?, toolset?, scribe? }} o  toolset verilmezse yalnız doğrudan kip, yetenek yok (saat). */
  constructor({ config, ai, toolset, scribe }) {
    super();
    this.#cfg = config;
    this.#toolset = toolset ?? buildToolset({ skills: [] });
    this.#needsKey = !ai;
    this.#ai = ai ?? new GoogleGenAI({ apiKey: config.apiKey });
    this.#clientTurns = Boolean(this.#toolset.preRoute);
    if (this.#clientTurns) this.#scribe = scribe ?? new Scribe({ ai: this.#ai });
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
      // İstemci sırasında kullanıcı dökümü paralel döküm modelinden gelir; ajanınki geç ve tekrar olurdu.
      ...(this.#clientTurns ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } : { inputAudioTranscription: {} }),
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
    if (this.#scribe) {
      this.#scribe.on('interim', (t) => this.#onInterim(t));
      this.#scribe.on('final', (t) => this.#onFinal(t));
      this.#scribe.on('usage', (u) => this.emit('scribeUsage', u));
      this.#scribe.on('error', (e) => this.#error(e));
      this.#scribe.on('debug', (d) => this.emit('debug', d));
      await this.#scribe.start();
    }
    await this.#connect('connecting');
  }

  // ── İstemci sırası ──────────────────────────────────────

  #onInterim(text) {
    if (this.state !== 'open') return;
    clearTimeout(this.#closeTimer); // kesin metinden sonra konuşma sürdüyse sırayı kapatma
    this.#closeTimer = null;
    if (!this.#turnOpen) {
      this.emit('debug', `sıra açıldı (ilk ara metin: "${text}", tampon ${this.#preroll.length})`);
      this.#turnOpen = true;
      this.#session?.sendRealtimeInput({ activityStart: {} }); // model konuşuyorsa bu onu keser (söze girme)
      for (const b of this.#preroll) this.#sendAgentAudio(b);
      this.#preroll = [];
    }
    this.emit('userLive', { text: `${this.#finalText}${text}`, final: false });
    // Ara metin ~250 ms değişmezse Jev'e şimdiden sor; kesin metin aynı çıkarsa sustuktan sonra beklemeyiz.
    clearTimeout(this.#specTimer);
    const full = `${this.#finalText}${text}`;
    this.#specTimer = setTimeout(() => this.#prefetch(full), 250);
  }

  #prefetch(text) {
    if (!this.#toolset.preRoute || !text.trim()) return;
    const key = normalize(text);
    if (this.#speculate?.key === key) return;
    this.#speculate = { key, promise: this.#toolset.preRoute(text.trim()) };
  }

  #onFinal(text) {
    if (!this.#turnOpen) return;
    this.#finalText += text;
    this.emit('userLive', { text: this.#finalText, final: false });
    // Kısa bir bekleme: cümle ortasında duraklamada yeni ara metin gelirse sıra açık kalır.
    clearTimeout(this.#closeTimer);
    this.#closeTimer = setTimeout(() => this.#closeTurn(), this.#cfg.turnGraceMs ?? 200);
  }

  async #closeTurn() {
    this.#closeTimer = null;
    const text = this.#finalText.trim();
    this.#finalText = '';
    this.emit('userLive', { text, final: true });
    clearTimeout(this.#specTimer);
    if (text && this.#toolset.preRoute) {
      const spec = this.#speculate?.key === normalize(text) ? this.#speculate.promise : null;
      this.#speculate = null;
      const { note, trace } = await (spec ?? this.#toolset.preRoute(text));
      trace.speculative = Boolean(spec);
      this.emit('tool', { phase: 'result', traces: [trace] });
      // Not: realtime metin yerine clientContent — "konuşmayı tetiklemeyen bağlam" ekler (deneyde 8/8).
      if (note && this.#session) this.#session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: note }] }], turnComplete: false });
    }
    this.#userText = text;
    this.#turnOpen = false;
    this.#session?.sendRealtimeInput({ activityEnd: {} });
    this.emit('debug', `sıra kapandı: "${text}"`);
  }

  #sendAgentAudio(buf) {
    this.#session?.sendRealtimeInput({ audio: { data: buf.toString('base64'), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } });
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
          onopen: live(() => { this.#openedAt = Date.now(); this.#setState('open'); }),
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
    if (m.toolCall?.functionCalls?.length) {
      this.#disarmWatchdog(); // model hareket etti
      this.#handleToolCall(m.toolCall.functionCalls);
    }
    if (m.toolCallCancellation?.ids) for (const id of m.toolCallCancellation.ids) this.#cancelledCalls.add(id);

    const sc = m.serverContent;
    if (!sc) return;
    this.#reconnects = 0; // model gerçekten cevap veriyor → bağlantı sağlıklı
    if (sc.modelTurn || sc.outputTranscription || sc.interrupted) this.#disarmWatchdog();
    if (sc.interrupted) this.emit('interrupted');
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) this.emit('audio', part.inlineData.data);
    }
    if (sc.inputTranscription?.text && !this.#clientTurns) {
      this.#userText += sc.inputTranscription.text;
      this.emit('transcript', { role: 'user', text: sc.inputTranscription.text });
    }
    if (sc.outputTranscription?.text) this.emit('transcript', { role: 'model', text: sc.outputTranscription.text });
    if (sc.turnComplete) {
      if (!this.#turnOpen) this.#userText = '';
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
    this.#armWatchdog();
  }

  // Bekçi: ölçümde (2026-10-05) Gemini bazen araç sonucunu alıp hiç konuşmadı (50 denemede 7, sebep kanıtlanamadı).
  // Sonuçtan sonra watchdogMs içinde ses/yazı gelmezse bir kez dürt; kaç kez gerektiği 'watchdog' olayıyla ölçülür.
  #armWatchdog() {
    this.#disarmWatchdog();
    const ms = this.#cfg.watchdogMs ?? 6000;
    if (!ms) return;
    this.#watchdog = setTimeout(() => {
      this.#watchdog = null;
      if (this.state !== 'open') return;
      this.#sendRaw('[Sistem bildirimi — kullanıcı söylemedi] Araç sonucu geldi. Şimdi kullanıcıya kısaca sesli cevap ver.');
      this.emit('watchdog', { ms });
    }, ms);
  }

  #disarmWatchdog() {
    clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }

  #onClose(e) {
    this.emit('debug', `ajan kapandı: kod=${e?.code} sebep=${e?.reason || '-'} turAçık=${this.#turnOpen}`);
    this.#session = null;
    if (this.#stopping) return this.#setState('closed');
    const reason = e?.reason || `kod ${e?.code ?? '?'}`;
    this.#error(new Error(`Bağlantı kapandı: ${reason}`));
    // Kota, anahtar, model adı gibi hatalar yeniden denemeyle düzelmez; denemek sadece kotayı yakar.
    if (e?.code === 1008 || FATAL_CLOSE.test(reason)) return this.#setState('closed');
    // Açılır açılmaz ölen bağlantı: kaldığı yerden devam anahtarı bozuk durumu geri getiriyor olabilir → temiz başla.
    if (this.#handle && Date.now() - this.#openedAt < 3000) {
      this.emit('debug', 'açılır açılmaz kapandı: devam anahtarı bırakıldı, temiz oturum');
      this.#handle = null;
    }
    this.#lastReason = reason;
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
      this.#error(new Error(`Yeniden bağlanılamadı (${this.#lastReason || 'bilinmiyor'}). Model sunucu tarafında sorun çıkarıyor olabilir: Ayarlar → Model'den yedeği dene.`));
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
    if (!this.#clientTurns) {
      this.#sendAgentAudio(buf);
      return true;
    }
    this.#scribe.send(buf);
    if (this.#turnOpen) this.#sendAgentAudio(buf);
    else {
      this.#preroll.push(buf);
      if (this.#preroll.length > 30) this.#preroll.shift(); // 30 × 50 ms
    }
    return true;
  }

  /** Mikrofon kapatılınca: VAD'ın bekleyen sesi işlemesini sağlar; istemci sırasında açık sırayı kapatır. */
  endAudio() {
    if (this.state !== 'open') return;
    if (this.#clientTurns) {
      if (this.#turnOpen && !this.#closeTimer) this.#closeTurn();
      return;
    }
    this.#session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  /** Uygulamadan modele bilgi (ör. zamanlayıcı bitti). Model bunu kullanıcıya sesli iletir. */
  sendSystemNote(text) {
    return this.#sendRaw(`[Sistem bildirimi — kullanıcı söylemedi] ${text}`);
  }

  /**
   * Kullanıcının yazdığı metin (yazılı girişte transkript gelmez; Jev için tura kaydedilir).
   * jev_pre'de önce Jev'e sorulur; ipucu sesli akıştaki gibi clientContent ile eklenir.
   */
  async sendText(text) {
    if (this.state !== 'open' || !this.#session || !text?.trim()) return false;
    let note = null;
    if (this.#toolset.preRoute) {
      const r = await this.#toolset.preRoute(String(text));
      note = r.note;
      this.emit('tool', { phase: 'result', traces: [r.trace] });
    }
    if (this.state !== 'open' || !this.#session) return false;
    // Sunucu VAD kapalıyken de düz metin kendi başına bir tur (activityStart/End ile sarmak 1007 "Precondition
    // check failed" ile bağlantıyı düşürüyor — 2026-10-05). İpucu metinden önce bağlam olarak: deneyde 4/4.
    if (note) this.#session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: note }] }], turnComplete: false });
    this.#sendRaw(text);
    this.#userText = String(text);
    return true;
  }

  #sendRaw(text) {
    if (this.state !== 'open' || !this.#session || !text?.trim()) return false;
    this.#session.sendRealtimeInput({ text }); // istemci sırasında da sarmadan: bkz. sendText
    return true;
  }

  stop() {
    this.#disarmWatchdog();
    clearTimeout(this.#closeTimer);
    clearTimeout(this.#specTimer);
    this.#scribe?.stop();
    this.#scribe?.removeAllListeners();
    this.#turnOpen = false;
    this.#stopping = true;
    this.#gen++;
    this.#handle = null;
    try { this.#session?.close(); } catch { /* yoksay */ }
    this.#session = null;
    this.#setState('closed');
  }
}
