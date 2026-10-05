// Modelin sesi (PCM16 LE, 24 kHz) için kuyruk. Parçalar ağdan düzensiz gelir; burada boşluksuz çalınır.
// { type: 'clear' } → kullanıcı söze girdi, kuyruğu anında boşalt.
class Playback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];
    this.off = 0;
    this.queued = 0;
    this.blocks = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'clear') {
        this.q = [];
        this.off = 0;
        this.queued = 0;
        return;
      }
      const i16 = new Int16Array(data.pcm);
      const f = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000;
      this.q.push(f);
      this.queued += f.length;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.q.length) {
      const cur = this.q[0];
      const n = Math.min(out.length - i, cur.length - this.off);
      out.set(cur.subarray(this.off, this.off + n), i);
      i += n;
      this.off += n;
      this.queued -= n;
      if (this.off >= cur.length) {
        this.q.shift();
        this.off = 0;
      }
    }
    // ~21 ms'de bir (4 blok × 128 örnek) seviye ve kuyruk bilgisi: orb animasyonu ve "konuşuyor" durumu için.
    if (++this.blocks % 4 === 0) {
      let sum = 0;
      for (let k = 0; k < out.length; k++) sum += out[k] * out[k];
      this.port.postMessage({ level: Math.sqrt(sum / out.length), queued: this.queued });
    }
    return true;
  }
}

registerProcessor('playback', Playback);
