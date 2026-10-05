import { describe, it, expect, vi } from 'vitest';
import { buildToolset, skillRegistry, validateArgs } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
import { JevClient, JevLedger } from '../src/main/jev.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const skills = () => skillRegistry(new TimerManager());
const names = (ts) => ts.declarations.map((d) => d.name);

/** Jev'i taklit eder: verilen seçim ve güvenle cevap döner, gelen soruyu kaydeder. */
function fakeJev(choice, confidence = 0.9) {
  const calls = [];
  return {
    calls,
    ask: vi.fn(async (state, questions) => {
      calls.push({ state, questions });
      const opts = Object.keys(questions.arac.criteria);
      return { answers: { arac: { choice, confidence, probabilities: Object.fromEntries(opts.map((o) => [o, o === choice ? confidence : (1 - confidence) / (opts.length - 1)])) } }, ms: 5, inputTokens: 400, usd: 0.0000168 };
    }),
  };
}

describe('buildToolset', () => {
  it('doğrudan kipte saat + 4 yetenek, Jev kipinde saat + arac_bul/arac_calistir', () => {
    expect(names(buildToolset({ mode: 'direct', skills: skills() }))).toEqual(['get_current_time', 'zamanlayici', 'medya', 'hava_durumu', 'sistem_durumu']);
    expect(names(buildToolset({ mode: 'jev', skills: skills(), jev: fakeJev('medya') }))).toEqual(['get_current_time', 'arac_bul', 'arac_calistir']);
  });

  it('Jev kipinde doğrudan yetenek çağrısını reddeder (Gemini arac_bul\'u atlayamasın)', async () => {
    const ts = buildToolset({ mode: 'jev', skills: skills(), jev: fakeJev('medya') });
    const { response } = await ts.run({ name: 'medya', args: { islem: 'durum' } });
    expect(response.hata).toMatch(/Bilinmeyen/);
  });

  it('arac_bul: Jev\'e kullanıcının ham cümlesini + özeti yollar, seçilen aracın şemasını döner, trace\'e yazar', async () => {
    const jev = fakeJev('medya');
    const ts = buildToolset({ mode: 'jev', skills: skills(), jev, userText: () => 'müziği biraz kıs' });
    const { response, trace } = await ts.run({ name: 'arac_bul', args: { ihtiyac: 'sesi azaltmak' } });
    expect(jev.calls[0].state).toEqual({ kullanicinin_sozu: 'müziği biraz kıs', asistanin_ozeti: 'sesi azaltmak' });
    expect(Object.keys(jev.calls[0].questions.arac.criteria).sort()).toEqual(['hava_durumu', 'hicbiri', 'medya', 'sistem_durumu', 'zamanlayici']);
    expect(response.arac).toBe('medya');
    expect(response.parametre_semasi.properties.islem.enum).toContain('ses_azalt');
    expect(trace.jev).toMatchObject({ choice: 'medya', confidence: 0.9, tokens: 400 });
  });

  it('arac_bul: "hicbiri" ve düşük güvende araç önermez', async () => {
    const none = await buildToolset({ mode: 'jev', skills: skills(), jev: fakeJev('hicbiri') }).run({ name: 'arac_bul', args: { ihtiyac: 'x' } });
    expect(none.response.arac).toBeNull();
    const unsure = await buildToolset({ mode: 'jev', skills: skills(), jev: fakeJev('hava_durumu', 0.3) }).run({ name: 'arac_bul', args: { ihtiyac: 'x' } });
    expect(unsure.response.arac).toBeNull();
    expect(unsure.response.mesaj).toMatch(/Emin olamadım/);
  });

  it('arac_calistir: JSON ve şemayı doğrular, kuru kipte yan etki yapmaz', async () => {
    const ts = buildToolset({ mode: 'jev', skills: skills(), jev: fakeJev('medya'), dryRun: true });
    expect((await ts.run({ name: 'arac_calistir', args: { ad: 'medya', argumanlar_json: '{bozuk' } })).response.hata).toMatch(/JSON/);
    expect((await ts.run({ name: 'arac_calistir', args: { ad: 'medya', argumanlar_json: '{"islem":"uc"}' } })).response.hata).toMatch(/şunlardan biri/);
    const ok = await ts.run({ name: 'arac_calistir', args: { ad: 'medya', argumanlar_json: '{"islem":"ses_azalt","deger":10}' } });
    expect(ok.response).toEqual({ kuru: true, islem: 'ses_azalt', deger: 10 });
    expect(ok.trace.skill).toBe('medya');
  });

  it('zamanlayıcı: kurar, listeler, iptal eder', async () => {
    const timers = new TimerManager();
    const t = buildToolset({ mode: 'direct', skills: skillRegistry(timers) });
    const set = await t.run({ name: 'zamanlayici', args: { islem: 'kur', sure_saniye: 600, etiket: 'çay' } });
    expect(set.response.kuruldu).toMatchObject({ etiket: 'çay', sure: '10 dakika' });
    expect((await t.run({ name: 'zamanlayici', args: { islem: 'listele' } })).response.zamanlayicilar).toHaveLength(1);
    expect((await t.run({ name: 'zamanlayici', args: { islem: 'iptal' } })).response.iptal_edildi.label).toBe('çay');
    expect(timers.list()).toHaveLength(0);
  });
});

describe('jev_pre (ön-seçim)', () => {
  it('Gemini tüm araçları doğrudan görür ve çağırabilir', async () => {
    const ts = buildToolset({ mode: 'jev_pre', skills: skills(), jev: fakeJev('medya'), dryRun: true });
    expect(names(ts)).toEqual(['get_current_time', 'zamanlayici', 'medya', 'hava_durumu', 'sistem_durumu']);
    const r = await ts.run({ name: 'medya', args: { islem: 'ses_azalt' } });
    expect(r.response).toMatchObject({ kuru: true, islem: 'ses_azalt' });
    expect(r.trace.skill).toBe('medya');
  });

  it('araç gerekiyorsa kısa ipucu üretir; gerekmiyorsa, emin değilse ya da Jev çökerse ipucu yok', async () => {
    const yes = await buildToolset({ mode: 'jev_pre', skills: skills(), jev: fakeJev('hava_durumu') }).preRoute('yarın şemsiye lazım mı');
    expect(yes.note).toBe('[İpucu: hava_durumu aracını kullan]');
    expect(yes.trace).toMatchObject({ name: 'on_secim', skill: 'hava_durumu' });
    expect((await buildToolset({ mode: 'jev_pre', skills: skills(), jev: fakeJev('hicbiri') }).preRoute('fıkra anlat')).note).toBeNull();
    expect((await buildToolset({ mode: 'jev_pre', skills: skills(), jev: fakeJev('medya', 0.3) }).preRoute('x')).note).toBeNull();
    const down = await buildToolset({ mode: 'jev_pre', skills: skills(), jev: { ask: async () => { throw new Error('ağ yok'); } } }).preRoute('x');
    expect(down.note).toBeNull();
    expect(down.trace.response.hata).toMatch(/ağ yok/);
  });
});

describe('validateArgs', () => {
  const schema = { properties: { islem: { type: 'STRING', enum: ['a', 'b'] }, n: { type: 'INTEGER' } }, required: ['islem'] };
  it('eksik, bilinmeyen, enum dışı ve sayı olmayan değeri yakalar', () => {
    expect(validateArgs(schema, {})).toMatch(/Eksik/);
    expect(validateArgs(schema, { islem: 'a', x: 1 })).toMatch(/Bilinmeyen/);
    expect(validateArgs(schema, { islem: 'c' })).toMatch(/şunlardan/);
    expect(validateArgs(schema, { islem: 'a', n: 'on' })).toMatch(/sayı/);
    expect(validateArgs(schema, { islem: 'a', n: 3 })).toBeNull();
  });
});

describe('JevClient bütçesi', () => {
  it('harcamayı deftere yazar, bütçe bitince çağırmadan reddeder', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-')), 'jev-usage.json');
    const ledger = new JevLedger(file, 0.001);
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1_000_000 } }) }));
    const jev = new JevClient({ apiKey: 'k', ledger, fetchImpl });
    const r = await jev.ask({}, {});
    expect(r.usd).toBeCloseTo(0.042, 9);
    expect(new JevLedger(file, 0.001).snapshot()).toMatchObject({ calls: 1, total_usd: 0.042 });
    await expect(jev.ask({}, {})).rejects.toThrow(/bütçesi doldu/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
