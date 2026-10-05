// Ses motoru: mikrofon yakalama (16 kHz) + model sesi çalma (24 kHz). Gemini Live'ın beklediği formatlar.

// Bu RMS'in üstü "kullanıcı konuşuyor" sayılır (süre ölçümü için; oda gürültüsü ~0,002–0,01, konuşma ~0,03+).
export const VOICE_LEVEL = 0.025;

export class AudioEngine {
  inLevel = 0;
  lastVoiceAt = null; // kullanıcının sesinin eşiği son geçtiği an — "sustuğu an" ölçümü
  outLevel = 0;
  queued = 0;
  muted = false;

  /** Mikrofon iznini alır ve iki ses bağlamını kurar. Bağlantıdan ÖNCE çağrılır: izin reddi API'ye gitmeden yakalanır. */
  async start(onChunk) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.inCtx = new AudioContext({ sampleRate: 16000 });
    await this.inCtx.audioWorklet.addModule('worklets/capture.js');
    const src = this.inCtx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.inCtx, 'capture');
    this.capture.port.onmessage = ({ data }) => {
      this.inLevel = this.muted ? 0 : data.level;
      if (!this.muted && data.level > VOICE_LEVEL) this.lastVoiceAt = performance.now();
      if (!this.muted) onChunk(data.pcm);
    };
    src.connect(this.capture);
    this.capture.connect(this.inCtx.destination); // sessiz çıkış; düğümün işlenmesi garanti olsun diye

    this.outCtx = new AudioContext({ sampleRate: 24000 });
    await this.outCtx.audioWorklet.addModule('worklets/playback.js');
    this.player = new AudioWorkletNode(this.outCtx, 'playback', { outputChannelCount: [1] });
    this.player.port.onmessage = ({ data }) => {
      this.outLevel = data.level;
      this.queued = data.queued;
    };
    this.player.connect(this.outCtx.destination);
  }

  /** @param {Uint8Array} bytes PCM16 LE 24 kHz */
  play(bytes) {
    if (!this.player) return;
    const copy = bytes.slice(); // hizalı, sahipli kopya → transfer edilebilir
    this.player.port.postMessage({ pcm: copy.buffer }, [copy.buffer]);
  }

  /** Kullanıcı söze girdi: çalan ve kuyruktaki sesi hemen kes. */
  flush() {
    this.player?.port.postMessage({ type: 'clear' });
    this.queued = 0;
  }

  get speaking() {
    return this.queued > 0;
  }

  setMuted(m) {
    this.muted = m;
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !m;
  }

  async stop() {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    await Promise.allSettled([this.inCtx?.close(), this.outCtx?.close()]);
    this.stream = this.inCtx = this.outCtx = this.capture = this.player = null;
    this.inLevel = this.outLevel = this.queued = 0;
  }
}
