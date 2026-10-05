import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Gemini Live ses formatları (API sözleşmesi): girdi 16 kHz, çıktı 24 kHz, 16-bit PCM LE mono.
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

export const DEFAULTS = {
  model: 'gemini-3.8-live',
  voice: 'Kore',
  systemInstruction: [
    'Senin adın Atlas. Fido\'nun sesli asistanısın.',
    'Varsayılan dilin Türkçe; kullanıcı başka dilde konuşursa o dile geç.',
    'Konuşur gibi cevap ver: kısa cümleler, doğal tonlama. Liste, madde işareti, markdown kullanma.',
    'Emin değilsen söyle, uydurma.',
  ].join('\n'),
  searchInstruction: 'Bilmediğin güncel bir şey sorulursa Google aramasını kullan.',
};

/** Proje kökündeki .env dosyasını okur; process.env'deki değerler önceliklidir. */
export function loadEnv(file = path.join(ROOT, '.env')) {
  const out = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { ...out, ...process.env };
}

export function loadConfig(env = loadEnv()) {
  return {
    apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
    model: env.ATLAS_MODEL || DEFAULTS.model,
    voice: env.ATLAS_VOICE || DEFAULTS.voice,
    // Ücretsiz katmanda Live + googleSearch kota hatası veriyor; billing açılınca ATLAS_GOOGLE_SEARCH=1.
    googleSearch: env.ATLAS_GOOGLE_SEARCH === '1',
    // Sunucu bağlamı bu kadar token'a ulaşınca eski kısmı atar (yarısına indirir). Live her turda bağlamın
    // tamamını faturaladığı için maliyetin tavanı bu: 8k ≈ son ~5 dk konuşma. Bkz. README maliyet notu.
    contextLimit: Number(env.ATLAS_CONTEXT_LIMIT) || 8000,
    usdTryFallback: Number(env.ATLAS_USD_TRY) || 49.06,
    get systemInstruction() {
      return this.googleSearch ? `${DEFAULTS.systemInstruction}\n${DEFAULTS.searchInstruction}` : DEFAULTS.systemInstruction;
    },
  };
}
