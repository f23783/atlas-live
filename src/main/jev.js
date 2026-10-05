import fs from 'node:fs';
import path from 'node:path';

// TypeSafe Jev: girdi $0,042 / 1M token, çıktı ücretsiz (docs.typesafe.ai/models, 2026-10-05).
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6;

/** Jev harcama defteri. Fido'nun verdiği bütçe (varsayılan $10) aşılmadan önce çağrıyı reddeder. */
export class JevLedger {
  constructor(file, budgetUsd) {
    this.file = file;
    this.budgetUsd = budgetUsd;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = { total_usd: 0, calls: 0, input_tokens: 0, days: {} }; }
  }

  get remainingUsd() {
    return this.budgetUsd - this.data.total_usd;
  }

  add(inputTokens) {
    // Dosyayı yeniden oku: eval betiği ile uygulama aynı anda harcıyor olabilir.
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* ilk kayıt */ }
    const usd = inputTokens * JEV_USD_PER_INPUT_TOKEN;
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
    this.data.total_usd += usd;
    this.data.calls += 1;
    this.data.input_tokens += inputTokens;
    this.data.days[day] = (this.data.days[day] ?? 0) + usd;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    return usd;
  }

  snapshot() {
    return { total_usd: this.data.total_usd, calls: this.data.calls, budget_usd: this.budgetUsd, remaining_usd: this.remainingUsd };
  }
}

export class JevClient {
  constructor({ apiKey, ledger, model = 'jev-latest', fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.ledger = ledger;
    this.model = model;
    this.fetch = fetchImpl;
  }

  /** @returns {{ answers, ms, inputTokens, usd, model }} */
  async ask(state, questions) {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY yok (.env).');
    // Bir çağrı ~500 token ≈ $0,00002; güvenlik payı olarak $0,001 kalmışsa dur.
    if (this.ledger && this.ledger.remainingUsd < 0.001) throw new Error(`Jev bütçesi doldu ($${this.ledger.budgetUsd}).`);
    const t0 = performance.now();
    const res = await this.fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, state, questions }),
      signal: AbortSignal.timeout(6000),
    });
    const ms = Math.round(performance.now() - t0);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Jev ${res.status}: ${body?.error?.message ?? body?.detail ?? JSON.stringify(body).slice(0, 200)}`);
    const inputTokens = body.usage?.input_tokens ?? 0;
    const usd = this.ledger ? this.ledger.add(inputTokens) : inputTokens * JEV_USD_PER_INPUT_TOKEN;
    return { answers: body.answers, ms, inputTokens, usd, model: body.model };
  }
}
