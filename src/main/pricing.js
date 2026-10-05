import fs from 'node:fs';
import path from 'node:path';

// Gemini 3.8 Live ücretli katman, USD / 1M token (ai.google.dev/gemini-api/docs/pricing, 2026-10-05).
// Düşünme token'ları usageMetadata'da toplamın dışında gelir ama "output (including thinking)" olarak faturalanır.
export const PRICES = {
  input: { TEXT: 0.75, AUDIO: 3.0, IMAGE: 1.0, VIDEO: 1.0 },
  output: { TEXT: 4.5, AUDIO: 12.0 },
  thoughts: 4.5,
};

// gemini-3.5-transcribe-live ücretli katman, USD / 1M token (aynı sayfa, 2026-10-05): ses girdi $3,50, metin çıktı $21.
export const TRANSCRIBE_PRICES = {
  input: { TEXT: 3.5, AUDIO: 3.5 },
  output: { TEXT: 21.0, AUDIO: 21.0 },
  thoughts: 21.0,
};

/** Tek turun usageMetadata'sından USD maliyet. Live her turda bir usageMetadata yollar; birikimli değildir. */
export function costUsd(u, prices = PRICES) {
  if (!u) return 0;
  const side = (details, table, total, fallback) => {
    if (!details?.length) return (total ?? 0) * fallback;
    return details.reduce((s, d) => s + (d.tokenCount ?? 0) * (table[d.modality] ?? fallback), 0);
  };
  const usd =
    side(u.promptTokensDetails, prices.input, u.promptTokenCount, prices.input.AUDIO) +
    side(u.responseTokensDetails, prices.output, u.responseTokenCount, prices.output.AUDIO) +
    (u.thoughtsTokenCount ?? 0) * prices.thoughts;
  return usd / 1e6;
}

/** TCMB günlük USD döviz satış kuru; ulaşılamazsa yedek değer. */
export async function fetchUsdTry(fallback) {
  try {
    const res = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml', { signal: AbortSignal.timeout(4000) });
    const xml = await res.text();
    const m = xml.match(/Kod="USD"[\s\S]*?<ForexSelling>([\d.]+)<\/ForexSelling>/);
    const date = xml.match(/Tarih="([^"]+)"/)?.[1];
    if (m) return { rate: Number(m[1]), source: `TCMB ${date ?? ''}`.trim() };
  } catch { /* çevrimdışı vb. */ }
  return { rate: fallback, source: 'yedek kur (.env ATLAS_USD_TRY)' };
}

/** Günlük harcama defteri (USD), userData/usage.json: { "2026-10-05": 0.42, ... } */
export class UsageLedger {
  constructor(file) {
    this.file = file;
    try { this.days = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.days = {}; }
  }

  static today() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' }); // YYYY-MM-DD
  }

  add(usd) {
    const d = UsageLedger.today();
    this.days[d] = (this.days[d] ?? 0) + usd;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.days, null, 1));
    return this.days[d];
  }

  get todayUsd() {
    return this.days[UsageLedger.today()] ?? 0;
  }

  get monthUsd() {
    const m = UsageLedger.today().slice(0, 7);
    return Object.entries(this.days).reduce((s, [d, v]) => (d.startsWith(m) ? s + v : s), 0);
  }
}
