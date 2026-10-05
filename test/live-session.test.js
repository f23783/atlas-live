import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiveSession } from '../src/main/live-session.js';

/** @google/genai'nin live.connect'ini taklit eder; her bağlantının callback'lerini ve gönderilenleri tutar. */
function fakeAi() {
  const conns = [];
  return {
    conns,
    live: {
      connect: vi.fn(async ({ callbacks, config }) => {
        const conn = {
          callbacks, config, sent: [], toolResponses: [], closed: false,
          sendRealtimeInput: (p) => conn.sent.push(p),
          sendToolResponse: (p) => conn.toolResponses.push(p),
          close: () => { conn.closed = true; callbacks.onclose?.({ reason: 'client' }); },
        };
        conns.push(conn);
        queueMicrotask(() => callbacks.onopen?.());
        return conn;
      }),
    },
  };
}

const cfg = { apiKey: '', model: 'gemini-3.8-live', voice: 'Kore', systemInstruction: 'test' };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LiveSession', () => {
  let ai, s;
  beforeEach(async () => {
    ai = fakeAi();
    s = new LiveSession({ config: cfg, ai });
    await s.start();
    await tick();
  });

  it('ses modunda, transkript ve sliding window ile bağlanır', () => {
    expect(s.state).toBe('open');
    const c = ai.conns[0].config;
    expect(c.responseModalities).toEqual(['AUDIO']);
    expect(c.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(c.contextWindowCompression).toEqual({ triggerTokens: '8000', slidingWindow: {} });
    expect(c.inputAudioTranscription).toEqual({});
  });

  it('PCM sesi base64 + 16 kHz mime ile gönderir', () => {
    s.sendAudio(new Int16Array([1, -1]));
    expect(ai.conns[0].sent[0].audio).toEqual({ data: Buffer.from([1, 0, 255, 255]).toString('base64'), mimeType: 'audio/pcm;rate=16000' });
  });

  it('sunucu içeriğini olaylara çevirir', () => {
    const got = [];
    for (const ev of ['audio', 'interrupted', 'turnComplete', 'transcript']) s.on(ev, (x) => got.push([ev, x]));
    ai.conns[0].callbacks.onmessage({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QUJD' } }] },
        inputTranscription: { text: 'selam' },
        outputTranscription: { text: 'merhaba' },
        turnComplete: true,
      },
    });
    ai.conns[0].callbacks.onmessage({ serverContent: { interrupted: true } });
    expect(got).toEqual([
      ['audio', 'QUJD'],
      ['transcript', { role: 'user', text: 'selam' }],
      ['transcript', { role: 'model', text: 'merhaba' }],
      ['turnComplete', undefined],
      ['interrupted', undefined],
    ]);
  });

  it('usageMetadata\'yı usage olayı olarak iletir', () => {
    const got = [];
    s.on('usage', (u) => got.push(u));
    ai.conns[0].callbacks.onmessage({ usageMetadata: { promptTokenCount: 5 }, serverContent: { turnComplete: true } });
    expect(got).toEqual([{ promptTokenCount: 5 }]);
  });

  it('araç çağrısını çalıştırıp cevabı id ile geri yollar', async () => {
    ai.conns[0].callbacks.onmessage({ toolCall: { functionCalls: [{ id: 'c1', name: 'get_current_time', args: {} }, { id: 'c2', name: 'yok' }] } });
    await tick();
    const [resp] = ai.conns[0].toolResponses;
    expect(resp.functionResponses[0]).toMatchObject({ id: 'c1', name: 'get_current_time' });
    expect(resp.functionResponses[0].response.now).toBeTruthy();
    expect(resp.functionResponses[1].response.hata).toMatch(/Bilinmeyen/);
  });

  it('bekçi: araç sonucundan sonra model susarsa bir kez dürter; model konuşursa dürtmez', async () => {
    const w = new LiveSession({ config: { ...cfg, watchdogMs: 30 }, ai });
    await w.start();
    await tick();
    const conn = ai.conns.at(-1);
    const fired = [];
    w.on('watchdog', (e) => fired.push(e));
    conn.callbacks.onmessage({ toolCall: { functionCalls: [{ id: 'a', name: 'get_current_time', args: {} }] } });
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toHaveLength(1);
    expect(conn.sent.at(-1).text).toMatch(/Araç sonucu geldi/);
    conn.callbacks.onmessage({ toolCall: { functionCalls: [{ id: 'b', name: 'get_current_time', args: {} }] } });
    await tick();
    conn.callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AA==' } }] } } });
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toHaveLength(1);
    w.stop();
  });

  it('goAway gelince son handle ile yeniden bağlanır, eski bağlantının kapanışı hata üretmez', async () => {
    const errors = [];
    s.on('error', (e) => errors.push(e));
    ai.conns[0].callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'h-1' } });
    ai.conns[0].callbacks.onmessage({ goAway: { timeLeft: '5s' } });
    await tick();
    expect(ai.conns).toHaveLength(2);
    expect(ai.conns[0].closed).toBe(true);
    expect(ai.conns[1].config.sessionResumption).toEqual({ handle: 'h-1' });
    expect(s.state).toBe('open');
    expect(errors).toEqual([]);
  });

  it('kota hatasında yeniden denemez; açılıp hemen kapanan bağlantıda döngüye girmez', async () => {
    const errors = [];
    s.on('error', (e) => errors.push(e.message));
    ai.conns[0].callbacks.onclose({ code: 1011, reason: 'You exceeded your current quota, please check your plan and billing details.' });
    expect(s.state).toBe('closed');
    await new Promise((r) => setTimeout(r, 600));
    expect(ai.conns).toHaveLength(1);
    expect(errors[0]).toMatch(/quota/);
  });

  it('beklenmedik kapanışta yeniden bağlanır; stop() sonrası bağlanmaz', async () => {
    ai.conns[0].callbacks.onclose({ reason: 'net' });
    expect(s.state).toBe('reconnecting');
    await new Promise((r) => setTimeout(r, 600));
    expect(ai.conns).toHaveLength(2);
    s.stop();
    expect(s.state).toBe('closed');
    expect(await s.sendText('x')).toBe(false);
    await new Promise((r) => setTimeout(r, 600));
    expect(ai.conns).toHaveLength(2);
  });
});
