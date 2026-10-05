import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, VOICES } from '../src/main/settings.js';
import { loadConfig } from '../src/main/config.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-set-')), 'settings.json');

describe('SettingsStore', () => {
  it('geçerli ayarı kaydeder ve yeniden yükler', () => {
    const f = tmp();
    new SettingsStore(f).set({ voice: 'Puck', contextLimit: 16000 });
    expect(new SettingsStore(f).get()).toEqual({ voice: 'Puck', contextLimit: 16000 });
  });

  it('geçersiz değeri ve bilinmeyen alanı reddeder, dosyaya yazmaz', () => {
    const f = tmp();
    const s = new SettingsStore(f);
    expect(() => s.set({ voice: 'Yok' })).toThrow(/Geçersiz/);
    expect(() => s.set({ apiKey: 'x' })).toThrow(/Bilinmeyen/);
    expect(() => s.set({ contextLimit: 5 })).toThrow(/Geçersiz/);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('elle bozulmuş dosyadan yalnız geçerli alanları alır', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ voice: 'Charon', model: 'uydurma', googleSearch: 'evet' }));
    expect(new SettingsStore(f).get()).toEqual({ voice: 'Charon' });
  });

  it('30 ses var, adlar benzersiz', () => {
    expect(new Set(VOICES.map((v) => v.name)).size).toBe(30);
  });
});

describe('loadConfig önceliği', () => {
  it('varsayılan < .env < settings', () => {
    const env = { ATLAS_VOICE: 'Leda', ATLAS_CONTEXT_LIMIT: '16000' };
    expect(loadConfig(env, {}).voice).toBe('Leda');
    expect(loadConfig(env, { voice: 'Puck' }).voice).toBe('Puck');
    expect(loadConfig(env, {}).contextLimit).toBe(16000);
    expect(loadConfig({}, {}).voice).toBe('Kore');
    expect(loadConfig({ ATLAS_GOOGLE_SEARCH: '1' }, { googleSearch: false }).googleSearch).toBe(false);
  });
});
