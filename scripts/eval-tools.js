// Araç seçimi değerlendirmesi: Doğrudan (Gemini seçer) vs Jev (TypeSafe seçer).
//
//   node scripts/eval-tools.js --jev-only            Jev tek başına (Gemini yok): Türkçe isabet, sıra kararlılığı, gecikme
//   node scripts/eval-tools.js                       uçtan uca, iki kip (her vaka taze Live oturumu, araçlar kuru)
//   node scripts/eval-tools.js --modes jev --limit 5
//
// Vakalar: eval/tool-cases.json. Rapor: out/eval-tools-<zaman>.json + .md
// Jev harcaması uygulamayla aynı deftere (~/.config/atlas-live/jev-usage.json) yazılır; bütçe sınırı geçerli.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnv, ROOT, USER_DATA } from '../src/main/config.js';
import { SettingsStore } from '../src/main/settings.js';
import { LiveSession } from '../src/main/live-session.js';
import { buildToolset, skillRegistry, pickTool } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
import { JevClient, JevLedger } from '../src/main/jev.js';
import { costUsd } from '../src/main/pricing.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/tool-cases.json'), 'utf8')).cases.slice(0, Number(opt('limit', 1e9)));
const base = loadConfig(loadEnv(), new SettingsStore(path.join(USER_DATA, 'settings.json')).get());
const ledger = new JevLedger(path.join(USER_DATA, 'jev-usage.json'), base.jevBudgetUsd);
const jev = new JevClient({ apiKey: base.typesafeKey, ledger });
const spentBefore = ledger.snapshot().total_usd;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
const norm = (c) => (c === 'hicbiri' ? null : c);

// ── 1) Jev tek başına ─────────────────────────────────────

async function jevOnly() {
  const skills = skillRegistry(new TimerManager());
  const rows = [];
  for (const c of cases) {
    const runs = [];
    for (let k = 0; k < 2; k++) runs.push(await pickTool({ jev, skills, said: c.say, summary: null })); // her biri farklı seçenek sırası
    const picks = runs.map((r) => norm(r.choice));
    rows.push({ say: c.say, expect: c.expect, picks, confidences: runs.map((r) => r.confidence), ms: runs.map((r) => r.ms), ok: picks.map((p) => p === c.expect), stable: picks[0] === picks[1] });
    process.stdout.write(picks.every((p) => p === c.expect) ? '.' : 'x');
  }
  console.log();
  const all = rows.flatMap((r) => r.ok);
  const ms = rows.flatMap((r) => r.ms);
  const wrong = rows.filter((r) => r.ok.some((o) => !o));
  const summary = {
    isabet: `${all.filter(Boolean).length}/${all.length} (${pct(all.filter(Boolean).length, all.length)})`,
    araclilarda: pct(rows.filter((r) => r.expect).flatMap((r) => r.ok).filter(Boolean).length, rows.filter((r) => r.expect).length * 2),
    tuzaklarda: pct(rows.filter((r) => !r.expect).flatMap((r) => r.ok).filter(Boolean).length, rows.filter((r) => !r.expect).length * 2),
    sira_kararliligi: pct(rows.filter((r) => r.stable).length, rows.length),
    ms_medyan: median(ms), ms_p95: p95(ms),
  };
  return { summary, rows, wrong };
}

// ── 2) Uçtan uca (Gemini + kip) ───────────────────────────

async function runCase(mode, c) {
  const timers = new TimerManager();
  let session;
  const toolset = buildToolset({
    mode, skills: skillRegistry(timers), dryRun: true,
    jev: mode === 'jev' ? jev : null,
    userText: () => session?.userText ?? '',
  });
  session = new LiveSession({ config: { ...base, toolMode: mode }, toolset });
  const traces = [];
  const usage = [];
  let audio = 0, tFirstTool = null, tFirstAudio = null, tSent = 0;
  session.on('tool', (t) => { if (t.phase === 'call') tFirstTool ??= performance.now(); else traces.push(...t.traces); });
  session.on('audio', () => { audio++; tFirstAudio ??= performance.now(); });
  session.on('usage', (u) => usage.push(u));
  session.on('error', () => {});

  const result = await new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve('zaman aşımı'), 30000);
    session.on('turnComplete', () => { if (audio > 0) { clearTimeout(timer); setTimeout(() => resolve('tamam'), 300); } });
    session.on('state', (s) => { if (s === 'closed') { clearTimeout(timer); resolve('kapandı'); } });
    await session.start();
    await new Promise((r) => (session.state === 'open' ? r() : session.once('state', r)));
    tSent = performance.now();
    session.sendText(c.say);
  });
  session.stop();
  timers.clear();

  const executed = traces.find((t) => t.skill && t.name !== 'arac_bul' && t.name !== 'get_current_time');
  const jevTrace = traces.find((t) => t.jev);
  const textTokens = usage.reduce((s, u) => s + (u.promptTokensDetails?.find((d) => d.modality === 'TEXT')?.tokenCount ?? 0), 0);
  return {
    mode, say: c.say, expect: c.expect, result,
    executed: executed?.skill ?? null,
    ok: (executed?.skill ?? null) === c.expect,
    askedTool: traces.some((t) => t.name !== 'get_current_time'),
    jevPick: jevTrace ? norm(jevTrace.jev.choice) : undefined,
    jevConf: jevTrace?.jev.confidence,
    jevMs: jevTrace?.jev.ms,
    argError: traces.some((t) => t.response?.hata) ? traces.find((t) => t.response?.hata).response.hata : null,
    msToTool: tFirstTool ? Math.round(tFirstTool - tSent) : null,
    msToAudio: tFirstAudio ? Math.round(tFirstAudio - tSent) : null,
    geminiTextTokens: textTokens,
    geminiUsd: usage.reduce((s, u) => s + costUsd(u), 0),
    turns: usage.length,
  };
}

async function endToEnd(modes) {
  const out = {};
  for (const mode of modes) {
    const rows = [];
    for (const c of cases) {
      let r = await runCase(mode, c);
      if (r.result !== 'tamam') { await sleep(3000); r = await runCase(mode, c); } // tek seferlik yeniden deneme (ağ/kota)
      rows.push(r);
      process.stdout.write(r.result !== 'tamam' ? '!' : r.ok ? '.' : 'x');
      await sleep(1200); // ücretsiz katman limitlerine nazik ol
    }
    console.log(` ${mode}`);
    const tool = rows.filter((r) => r.expect), trap = rows.filter((r) => !r.expect);
    const msA = rows.map((r) => r.msToAudio).filter((x) => x != null);
    const msAT = tool.map((r) => r.msToAudio).filter((x) => x != null);
    out[mode] = {
      summary: {
        uctan_uca_isabet: `${rows.filter((r) => r.ok).length}/${rows.length} (${pct(rows.filter((r) => r.ok).length, rows.length)})`,
        araclilarda: pct(tool.filter((r) => r.ok).length, tool.length),
        tuzaklarda: pct(trap.filter((r) => r.ok).length, trap.length),
        ...(mode === 'jev' && {
          jev_secimi_dogru: pct(rows.filter((r) => r.jevPick !== undefined && r.jevPick === r.expect).length, rows.filter((r) => r.jevPick !== undefined).length),
          gemini_arac_bul_cagirdi: `${rows.filter((r) => r.jevPick !== undefined).length}/${rows.length}`,
          jev_ms_medyan: median(rows.map((r) => r.jevMs).filter((x) => x != null)),
        }),
        arguman_hatasi: rows.filter((r) => r.argError).length,
        ilk_ses_ms_medyan: median(msA),
        ilk_ses_ms_medyan_aracli: median(msAT),
        ilk_ses_ms_p95: p95(msA),
        gemini_metin_token_ort: Math.round(rows.reduce((s, r) => s + r.geminiTextTokens, 0) / rows.length),
        gemini_usd_toplam: +rows.reduce((s, r) => s + r.geminiUsd, 0).toFixed(5),
        hatali_oturum: rows.filter((r) => r.result !== 'tamam').length,
      },
      rows,
    };
  }
  return out;
}

// ── Çalıştır + rapor ──────────────────────────────────────

if (!base.apiKey) throw new Error('GEMINI_API_KEY yok.');
if (!base.typesafeKey) throw new Error('TYPESAFE_API_KEY yok.');
const report = { tarih: new Date().toISOString(), model: base.model, jev_model: 'jev-latest', vaka: cases.length };

if (flag('jev-only')) {
  report.jev_only = await jevOnly();
} else {
  report.uctan_uca = await endToEnd(opt('modes', 'direct,jev').split(','));
}
report.jev_harcama_usd = +(ledger.snapshot().total_usd - spentBefore).toFixed(6);
report.jev_toplam_usd = ledger.snapshot().total_usd;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(ROOT, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `eval-tools-${stamp}.json`), JSON.stringify(report, null, 1));

const md = [`# Araç seçimi değerlendirmesi — ${report.tarih}`, `${cases.length} vaka · ${base.model} · Jev harcaması bu koşu: $${report.jev_harcama_usd} (toplam $${report.jev_toplam_usd.toFixed(6)} / $${base.jevBudgetUsd})`, ''];
if (report.jev_only) {
  md.push('## Jev tek başına (ham cümle, 2 farklı seçenek sırası)', '```', JSON.stringify(report.jev_only.summary, null, 1), '```', '', '### Yanlışlar');
  for (const r of report.jev_only.wrong) md.push(`- "${r.say}" → beklenen **${r.expect ?? 'hiçbiri'}**, Jev: ${r.picks.map((p, i) => `${p ?? 'hiçbiri'} (%${Math.round(r.confidences[i] * 100)})`).join(' / ')}`);
}
for (const [mode, m] of Object.entries(report.uctan_uca ?? {})) {
  md.push(`## Uçtan uca — ${mode}`, '```', JSON.stringify(m.summary, null, 1), '```', '', '### Yanlışlar');
  for (const r of m.rows.filter((x) => !x.ok)) md.push(`- "${r.say}" → beklenen **${r.expect ?? 'hiçbiri'}**, çalışan: ${r.executed ?? 'hiçbiri'}${r.jevPick !== undefined ? `, Jev: ${r.jevPick ?? 'hiçbiri'} (%${Math.round((r.jevConf ?? 0) * 100)})` : ''}${r.argError ? `, hata: ${r.argError}` : ''}${r.result !== 'tamam' ? ` [${r.result}]` : ''}`);
}
fs.writeFileSync(path.join(outDir, `eval-tools-${stamp}.md`), md.join('\n'));
console.log(md.join('\n'));
process.exit(0);
