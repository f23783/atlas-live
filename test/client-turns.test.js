import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { LiveSession } from '../src/main/live-session.js';

// Bağlantı taklidi: gönderilen her şeyi sırasıyla kaydeder.
function fakeAi() {
  const conns = [];
  return {
    conns,
    live: {
      connect: vi.fn(async ({ callbacks, config }) => {
        const conn = { config, callbacks, log: [],
          sendRealtimeInput: (p) => conn.log.push(Object.keys(p)[0] === 'audio' ? 'audio' : Object.keys(p)[0] === 'text' ? `text:${p.text}` : Object.keys(p)[0]),
          sendClientContent: (p) => conn.log.push(`client:${p.turns[0].parts[0].text}`),
          sendToolResponse: () => {}, close: () => {} };
        conns.push(conn);
        queueMicrotask(() => callbacks.onopen?.());
        return conn;
      }),
    },
  };
}
class FakeScribe extends EventEmitter { sent = 0; async start() {} send() { this.sent++; } stop() {} }

const toolset = (note) => ({
  declarations: [], systemNote: null, run: async () => ({ response: {}, trace: {} }),
  preRoute: vi.fn(async (t) => ({ note, trace: { name: 'on_secim', jev: { choice: 'x' }, userText: t } })),
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const pcm = () => Buffer.alloc(1600);

async function setup(note = '[İpucu: hava_durumu aracını kullan]') {
  const ai = fakeAi(), scribe = new FakeScribe(), ts = toolset(note);
  const s = new LiveSession({ config: { apiKey: '', model: 'm', voice: 'Kore', systemInstruction: '', turnGraceMs: 20 }, ai, toolset: ts, scribe });
  await s.start();
  await tick();
  return { s, ai, scribe, ts, conn: ai.conns[0] };
}

describe('istemci sırası (jev_pre sesli)', () => {
  it('sunucu VAD kapalı, ajan dökümü kapalı', async () => {
    const { conn } = await setup();
    expect(conn.config.realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    expect(conn.config.inputAudioTranscription).toBeUndefined();
  });

  it('konuşma öncesi ses yalnız dökümcüye gider; ilk ara metinde sıra açılır ve tampon boşalır', async () => {
    const { s, scribe, conn } = await setup();
    for (let i = 0; i < 5; i++) s.sendAudio(pcm());
    expect(scribe.sent).toBe(5);
    expect(conn.log).toEqual([]);
    scribe.emit('interim', 'Yarın');
    expect(conn.log).toEqual(['activityStart', 'audio', 'audio', 'audio', 'audio', 'audio']);
    s.sendAudio(pcm());
    expect(conn.log.at(-1)).toBe('audio');
  });

  it('kesin metin → Jev ipucu (clientContent) → activityEnd; userLive olayları', async () => {
    const { s, scribe, conn, ts } = await setup();
    const live = [];
    s.on('userLive', (e) => live.push(e));
    scribe.emit('interim', 'Yarın yağmur');
    scribe.emit('final', 'Yarın yağmur var mı?');
    await tick(40);
    expect(ts.preRoute).toHaveBeenCalledWith('Yarın yağmur var mı?');
    expect(conn.log.slice(-2)).toEqual(['client:[İpucu: hava_durumu aracını kullan]', 'activityEnd']);
    expect(live.at(-1)).toEqual({ text: 'Yarın yağmur var mı?', final: true });
    expect(s.userText).toBe('Yarın yağmur var mı?');
  });

  it('cümle ortası duraklama: kesin metinden sonra yeni ara metin gelirse sıra kapanmaz, metinler birleşir', async () => {
    const { scribe, conn, ts } = await setup();
    scribe.emit('interim', 'Yarın');
    scribe.emit('final', 'Yarın ');
    await tick(5);
    scribe.emit('interim', 'Ankarada');
    await tick(40);
    expect(conn.log).not.toContain('activityEnd');
    scribe.emit('final', 'Ankara’da yağmur var mı?');
    await tick(40);
    expect(ts.preRoute).toHaveBeenCalledWith('Yarın Ankara’da yağmur var mı?');
    expect(conn.log.filter((x) => x === 'activityStart')).toHaveLength(1);
  });

  it('ara metin durulunca Jev önceden sorulur; kesin metin aynıysa tekrar sorulmaz', async () => {
    const { scribe, conn, ts } = await setup();
    const traces = [];
    scribe.emit('interim', 'yarın yağmur var mı');
    await tick(300); // 250 ms durulma
    expect(ts.preRoute).toHaveBeenCalledTimes(1);
    scribe.emit('final', 'Yarın yağmur var mı?');
    await tick(40);
    expect(ts.preRoute).toHaveBeenCalledTimes(1);
    expect(conn.log.at(-1)).toBe('activityEnd');
  });

  it('ipucu yoksa yalnız activityEnd; yazılı giriş ve sistem notu SARILMAZ (sarmak 1007 hatası)', async () => {
    const { s, scribe, conn } = await setup(null);
    scribe.emit('interim', 'fıkra');
    scribe.emit('final', 'fıkra anlat');
    await tick(40);
    expect(conn.log.slice(-1)).toEqual(['activityEnd']);
    expect(conn.log.some((x) => x.startsWith('client:'))).toBe(false);
    conn.log.length = 0;
    await s.sendText('saat kaç');
    expect(conn.log).toEqual(['text:saat kaç']);
    conn.log.length = 0;
    s.sendSystemNote('zamanlayıcı bitti');
    expect(conn.log).toHaveLength(1);
    expect(conn.log[0]).toMatch(/^text:\[Sistem bildirimi/);
  });

  it('yazılı girişte ipucu metinden önce clientContent ile gider', async () => {
    const { s, conn } = await setup();
    await s.sendText('dışarısı soğuk mu');
    expect(conn.log).toEqual(['client:[İpucu: hava_durumu aracını kullan]', 'text:dışarısı soğuk mu']);
  });
});
