// iPhone Vault.swift arama algoritmasının birebir kopyası: gerçek vault + gerçek Jev ile kalite kontrolü.
import fs from 'node:fs'; import path from 'node:path';
import { loadConfig, loadEnv } from '../src/main/config.js';
const ROOT = '/home/fido/Documents/Ai_cli/FidoOS';
const skip = ['📋 Templates/', '.claude/', '.github/', 'CLAUDE.md'];
const stop = new Set('ve ile bir bu şu ne mi mı mu mü da de ki için gibi çok daha en ben sen benim nasıl neydi var yok olan ama'.split(' '));
const terms = (s) => new Set(s.toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !stop.has(w)).map((w) => [...w].slice(0, 5).join('')));
const files = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); const rel = path.relative(ROOT, p); if (f.isDirectory()) { if (f.name !== '.git') walk(p); } else if (rel.endsWith('.md') && !skip.some((s) => rel.startsWith(s))) files.push(rel); } })(ROOT);
const sections = [];
for (const rel of files) {
  let body = fs.readFileSync(path.join(ROOT, rel), 'utf8'); const note = path.basename(rel, '.md'); let modified = '';
  if (body.startsWith('---')) { const e = body.indexOf('\n---', 3); if (e > 0) { const fm = body.slice(0, e); modified = (fm.match(/modified:\s*(\S+)/) || [])[1] || ''; body = body.slice(e + 4); } }
  let heading = note, buf = [];
  const flush = () => { const t = buf.join('\n').trim(); buf = []; if (t.length <= 40) return; for (let i = 0; i < t.length; i += 900) { const piece = t.slice(i, i + 900); sections.push({ note, heading, modified, text: piece, terms: terms(piece), head: terms(note + ' ' + heading) }); } };
  for (const line of body.split('\n')) { if (line.startsWith('#')) { flush(); heading = line.replace(/^[#\s]+/, '').trim(); } else buf.push(line); }
  flush();
}
function candidates(q, limit = 8) {
  const qt = [...terms(q)]; const n = sections.length;
  const df = Object.fromEntries(qt.map((t) => [t, sections.filter((s) => s.terms.has(t) || s.head.has(t)).length]));
  return sections.map((s) => [s, qt.reduce((a, t) => { const idf = Math.log((n + 1) / (df[t] + 1)) + 0.1; return a + (s.terms.has(t) ? idf : 0) + (s.head.has(t) ? 2 * idf : 0); }, 0)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, limit).map((x) => x[0]);
}
const key = loadConfig(loadEnv(), {}).typesafeKey;
async function rerank(q, cands) {
  const state = { soru: q }, questions = {};
  cands.forEach((s, i) => { state['b' + i] = `[${s.note} — ${s.heading}] ` + s.text.slice(0, 500); questions['b' + i] = { type: 'noul', instructions: `\`b${i}\` bölümü, \`soru\` alanındaki soruyu cevaplamak için gereken bilgiyi içeriyor mu?`, criteria: { true: 'Bölüm sorunun cevabını ya da doğrudan ilgili bilgiyi içeriyor.', false: 'Bölüm konuyla ilgisiz ya da yalnız aynı kelimeleri tesadüfen içeriyor.' } }; });
  const t0 = Date.now();
  const r = await (await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions }) })).json();
  return { ms: Date.now() - t0, tok: r.usage?.input_tokens, scored: cands.map((s, i) => [s, r.answers?.['b' + i]?.noul ?? 0]) };
}
console.log(`${files.length} not, ${sections.length} bölüm`);
for (const q of process.argv.slice(2)) {
  const c = candidates(q); const { ms, tok, scored } = await rerank(q, c);
  const top = scored.filter((x) => x[1] >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`\n"${q}"  (Jev ${ms} ms, ${tok} tok)`);
  scored.forEach(([s, p]) => console.log(`  ${p >= 0.5 ? '✓' : ' '} ${p.toFixed(2)}  ${s.note} / ${s.heading}`.slice(0, 120)));
  console.log(`  → bağlama giden: ${top.reduce((a, [s]) => a + Math.min(600, s.text.length), 0)} karakter`);
}
