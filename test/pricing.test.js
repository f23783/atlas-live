import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costUsd, UsageLedger } from '../src/main/pricing.js';

describe('costUsd', () => {
  it('modaliteye göre fiyatlar, düşünme token\'larını çıktı olarak ekler', () => {
    // Gerçek bir turdan (2026-10-05 ölçümü)
    const u = {
      promptTokenCount: 755,
      responseTokenCount: 189,
      thoughtsTokenCount: 83,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 403 }, { modality: 'AUDIO', tokenCount: 313 }],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 189 }],
    };
    const expected = (403 * 0.75 + 313 * 3 + 189 * 12 + 83 * 4.5) / 1e6;
    expect(costUsd(u)).toBeCloseTo(expected, 12);
  });

  it('ayrıntı yoksa toplamı ses fiyatıyla sayar (kötümser), boşsa 0', () => {
    expect(costUsd({ promptTokenCount: 1000, responseTokenCount: 1000 })).toBeCloseTo((1000 * 3 + 1000 * 12) / 1e6, 12);
    expect(costUsd(undefined)).toBe(0);
  });
});

describe('UsageLedger', () => {
  it('günlük toplamı dosyaya yazar ve yeniden yükler', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-')), 'usage.json');
    const a = new UsageLedger(file);
    a.add(0.1);
    a.add(0.05);
    const b = new UsageLedger(file);
    expect(b.todayUsd).toBeCloseTo(0.15, 12);
    expect(b.monthUsd).toBeCloseTo(0.15, 12);
  });
});
