// Mikrofon → PCM16 LE. AudioContext 16 kHz açıldığı için yeniden örnekleme tarayıcıda yapılır.
// 800 örnek = 50 ms'lik parçalar: gecikme ile IPC sıklığı arasında denge.
const CHUNK = 800;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(CHUNK);
    this.n = 0;
    this.sum = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.sum += v * v;
      if (this.n === CHUNK) {
        this.port.postMessage({ pcm: this.buf.buffer, level: Math.sqrt(this.sum / CHUNK) }, [this.buf.buffer]);
        this.buf = new Int16Array(CHUNK);
        this.n = 0;
        this.sum = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
