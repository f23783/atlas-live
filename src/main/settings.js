import fs from 'node:fs';
import path from 'node:path';

// Gemini TTS'teki 30 hazır ses; native audio Live modelleri hepsini destekliyor (ai.google.dev, 2026-10-05).
// Tanımlar Google'ın İngilizce etiketlerinin çevirisi; cinsiyet/aksan bilgisi resmi listede yok.
export const VOICES = [
  ['Zephyr', 'Parlak'], ['Puck', 'Neşeli'], ['Charon', 'Bilgilendirici'], ['Kore', 'Kararlı'],
  ['Fenrir', 'Heyecanlı'], ['Leda', 'Genç'], ['Orus', 'Kararlı'], ['Aoede', 'Ferah'],
  ['Callirrhoe', 'Rahat'], ['Autonoe', 'Parlak'], ['Enceladus', 'Nefesli'], ['Iapetus', 'Net'],
  ['Umbriel', 'Rahat'], ['Algieba', 'Yumuşak'], ['Despina', 'Yumuşak'], ['Erinome', 'Net'],
  ['Algenib', 'Boğuk'], ['Rasalgethi', 'Bilgilendirici'], ['Laomedeia', 'Neşeli'], ['Achernar', 'Hafif'],
  ['Alnilam', 'Kararlı'], ['Schedar', 'Dengeli'], ['Gacrux', 'Olgun'], ['Pulcherrima', 'Atak'],
  ['Achird', 'Samimi'], ['Zubenelgenubi', 'Gündelik'], ['Vindemiatrix', 'Nazik'], ['Sadachbia', 'Canlı'],
  ['Sadaltager', 'Bilgili'], ['Sulafat', 'Sıcak'],
].map(([name, trait]) => ({ name, trait }));

export const MODELS = [
  { id: 'gemini-3.8-live', label: 'Hızlı', note: 'En düşük gecikme. Günlük konuşma için.' },
  { id: 'gemini-3.8-live-extended-thinking', label: 'Derin düşünen', note: 'Zor sorularda daha iyi, cevaba başlaması daha uzun sürer.' },
];

export const CONTEXT_LIMITS = [8000, 16000, 32000];

// Kullanıcının arayüzden değiştirebildiği alanlar. Öncelik: varsayılan < .env < settings.json.
const SCHEMA = {
  voice: (v) => VOICES.some((x) => x.name === v),
  model: (v) => MODELS.some((x) => x.id === v),
  contextLimit: (v) => CONTEXT_LIMITS.includes(v),
  googleSearch: (v) => typeof v === 'boolean',
  toolMode: (v) => v === 'direct' || v === 'jev',
};

export class SettingsStore {
  constructor(file) {
    this.file = file;
    try { this.data = clean(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { this.data = {}; }
  }

  get() {
    return { ...this.data };
  }

  /** Geçersiz alanları sessizce atmaz: hata fırlatır, UI yanlış bir şey kaydettiğini bilsin. */
  set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!SCHEMA[k]) throw new Error(`Bilinmeyen ayar: ${k}`);
      if (!SCHEMA[k](v)) throw new Error(`Geçersiz değer: ${k}=${JSON.stringify(v)}`);
    }
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    return this.get();
  }
}

/** Elle bozulmuş bir settings.json uygulamayı düşürmesin: yalnız geçerli alanları al. */
function clean(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([k, v]) => SCHEMA[k]?.(v)));
}
