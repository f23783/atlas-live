import { AudioEngine } from './audio.js';

const $ = (id) => document.getElementById(id);
const ui = {
  orb: $('orb'), canvas: $('orbCanvas'), hint: $('hint'), meta: $('meta'),
  status: $('status'), statusText: $('statusText'),
  transcript: $('transcript'), empty: $('empty'), toast: $('toast'),
  cost: $('cost'),
  settings: $('settings'),
  mic: $('mic'), composer: $('composer'), input: $('textInput'), send: document.querySelector('.send'),
};

const audio = new AudioEngine();
let conn = 'idle'; // idle | connecting | open | reconnecting
let micOn = true;
let busy = false; // bağlan/kapat sürerken çift tıklamayı engelle

// ── Bağlantı ─────────────────────────────────────────────

async function connect() {
  busy = true;
  setConn('connecting');
  try {
    await audio.start((pcm) => window.atlas.sendAudio(pcm));
  } catch (e) {
    busy = false;
    setConn('idle');
    return toast(e.name === 'NotAllowedError' ? 'Mikrofon izni verilmedi.' : `Mikrofon açılamadı: ${e.message}`);
  }
  audio.setMuted(!micOn);
  const res = await window.atlas.start();
  busy = false;
  if (!res.ok) {
    await audio.stop();
    setConn('idle');
    toast(res.error);
  }
}

async function disconnect() {
  busy = true;
  await window.atlas.stop();
  await audio.stop();
  busy = false;
  setConn('idle');
}

ui.orb.addEventListener('click', () => {
  if (busy) return;
  conn === 'idle' ? connect() : disconnect();
});

// ── Backend olayları ─────────────────────────────────────

window.atlas.onEvent(({ type, payload }) => {
  switch (type) {
    case 'state':
      // 'closed' kullanıcı kapatmadıysa kalıcı hata demek (kota, anahtar…): sesi de kapat.
      if (payload === 'closed') { if (!busy && conn !== 'idle') audio.stop().then(() => setConn('idle')); }
      else setConn(payload);
      break;
    case 'audio':
      audio.play(payload);
      break;
    case 'interrupted':
      audio.flush();
      endTurn(true);
      break;
    case 'turnComplete':
      endTurn(false);
      break;
    case 'transcript':
      appendTranscript(payload.role, payload.text);
      break;
    case 'tool':
      if (payload.phase === 'result') for (const t of payload.traces) { addChip(chipText(t)); lab.log(t); }
      break;
    case 'timer':
      toast(`⏰ ${payload.label}: süre doldu.`);
      break;
    case 'settings':
      showInfo(payload);
      if (conn !== 'idle') { endTurn(false); addChip(`yeni ayar: ses ${payload.voice} · ${payload.model}`); }
      break;
    case 'cost':
      showCost(payload, true);
      lab.setBudget(payload.jev);
      break;
    case 'error':
      toast(payload);
      break;
  }
});

const SKILL_LABELS = { get_current_time: 'saat', zamanlayici: 'zamanlayıcı', medya: 'medya', hava_durumu: 'hava durumu', sistem_durumu: 'sistem durumu' };
const label = (n) => SKILL_LABELS[n] ?? n;
const pctf = (x) => `%${Math.round(x * 100)}`;
// Jev kuruşun binde biri mertebesinde harcar: küçük tutarlarda anlamlı basamak göster.
const usd = (x) => `$${x >= 0.01 ? x.toFixed(2) : x.toPrecision(2)}`;

function chipText(t) {
  if (t.jev) {
    const who = t.name === 'on_secim' ? 'Jev ön-seçim' : 'Jev';
    return t.jev.choice === 'hicbiri' ? `${who} → araç yok` : `${who} → ${label(t.jev.choice)} (${pctf(t.jev.confidence)})`;
  }
  if (t.response?.hata && t.name === 'on_secim') return `Jev ulaşılamadı ✗`;
  const tail = t.response?.hata ? ' ✗' : t.dryRun && t.response?.kuru ? ' (kuru)' : '';
  return `araç: ${label(t.skill ?? t.name)}${tail}`;
}

function setConn(s) {
  conn = s;
  const open = s === 'open';
  ui.status.dataset.state = s;
  ui.statusText.textContent = { idle: 'Kapalı', connecting: 'Bağlanıyor', open: 'Bağlı', reconnecting: 'Yeniden bağlanıyor' }[s] ?? s;
  ui.orb.setAttribute('aria-label', s === 'idle' ? 'Bağlan' : 'Bağlantıyı kes');
  for (const el of [ui.mic, ui.input, ui.send]) el.disabled = !open;
  lab.setEnabled(open);
  if (open) ui.input.focus();
}

// ── Transkript ───────────────────────────────────────────
// Bir tur = kullanıcı balonu + model balonu. Kullanıcının yazıya dökümü bazen model konuşmaya
// başladıktan sonra gelir; o yüzden kullanıcı balonu her zaman modelinkinin ÖNÜNE yerleşir.

let turn = { user: null, model: null };

function bubble(role) {
  ui.empty.remove();
  const el = document.createElement('div');
  el.className = `msg ${role} live`;
  return el;
}

function appendTranscript(role, text) {
  const stick = nearBottom();
  if (!turn[role]) {
    turn[role] = bubble(role);
    if (role === 'user' && turn.model) ui.transcript.insertBefore(turn.user, turn.model);
    else ui.transcript.append(turn[role]);
  }
  turn[role].textContent += text;
  if (stick) scrollDown();
}

function endTurn(cut) {
  for (const el of [turn.user, turn.model]) el?.classList.remove('live');
  if (cut && turn.model) turn.model.classList.add('cut');
  if (turn.user) turn.user.textContent = turn.user.textContent.trim();
  if (turn.model) turn.model.textContent = turn.model.textContent.trim();
  turn = { user: null, model: null };
}

function addChip(text) {
  ui.empty.remove();
  const el = document.createElement('div');
  el.className = 'chip';
  el.textContent = text;
  turn.model ? ui.transcript.insertBefore(el, turn.model) : ui.transcript.append(el);
  scrollDown();
}

const nearBottom = () => ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 60;
const scrollDown = () => (ui.transcript.scrollTop = ui.transcript.scrollHeight);

// ── Girdi ────────────────────────────────────────────────

async function sendText(text) {
  if (!text || conn !== 'open') return;
  endTurn(false);
  appendTranscript('user', text);
  turn.user.classList.remove('live');
  await window.atlas.sendText(text);
}

ui.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = ui.input.value.trim();
  ui.input.value = '';
  sendText(text);
});

function setMic(on) {
  micOn = on;
  audio.setMuted(!on);
  if (!on) window.atlas.endAudio(); // VAD bekleyen sesi işlesin
  ui.mic.setAttribute('aria-pressed', String(on));
  ui.mic.setAttribute('aria-label', on ? 'Mikrofonu kapat' : 'Mikrofonu aç');
}
ui.mic.addEventListener('click', () => setMic(!micOn));

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'm' && conn === 'open') { e.preventDefault(); setMic(!micOn); }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); window.atlas.openSettings(); }
  if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); lab.toggle(); }
});
ui.settings.addEventListener('click', () => window.atlas.openSettings());

// ── Maliyet ──────────────────────────────────────────────
// Tahmin: ücretli katman fiyatı × gerçek token sayısı (her turun usageMetadata'sı). Ücretsiz katmanda fatura 0.

const tl = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2 });

function showCost(c, flash) {
  ui.cost.hidden = false;
  ui.cost.innerHTML = '';
  const b = (v) => Object.assign(document.createElement('b'), { textContent: tl.format(v) });
  ui.cost.append('oturum ', b(c.session), ' · bugün ', b(c.today));
  ui.cost.title =
    `Bu ay: ${tl.format(c.month)}\n` +
    `Tahmini — ücretli katman fiyatıyla, gerçek token sayısından.\n` +
    `Kur: ${c.rate.toLocaleString('tr-TR')} (${c.rateSource})`;
  if (flash) {
    ui.cost.classList.add('flash');
    requestAnimationFrame(() => requestAnimationFrame(() => ui.cost.classList.remove('flash')));
  }
}

// ── Bildirim ─────────────────────────────────────────────

let toastTimer;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.hidden = true), 7000);
}
ui.toast.addEventListener('click', () => (ui.toast.hidden = true));

// ── Durum metni + orb ────────────────────────────────────

function hintText() {
  if (conn === 'idle') return 'Başlamak için dokun';
  if (conn === 'connecting') return 'Bağlanıyor…';
  if (conn === 'reconnecting') return 'Bağlantı yenileniyor…';
  if (audio.speaking) return 'Konuşuyor';
  return micOn ? 'Dinliyorum' : 'Mikrofon kapalı — yazabilirsin';
}

const ctx = ui.canvas.getContext('2d');
let palette = {};
let paletteAt = -Infinity;
let lvl = 0;
let hue = 0; // 0 = dinleme rengi, 1 = konuşma rengi (yumuşak geçiş)

function readPalette(now) {
  if (now - paletteAt < 500) return; // matugen canlı değişebilir; ucuzca yarım saniyede bir oku
  paletteAt = now;
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['accent', 'accent-soft', 'user', 'user-soft', 'outline', 'bg']) palette[k] = cs.getPropertyValue(`--${k}`).trim();
}

function rgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function frame(now) {
  readPalette(now);
  const W = ui.canvas.width, C = W / 2;
  const active = conn === 'open';
  const speaking = active && audio.speaking;
  const target = !active ? 0 : speaking ? audio.outLevel * 3.2 : audio.inLevel * 5;
  lvl += (Math.min(target, 1) - lvl) * 0.18;
  hue += ((speaking ? 1 : 0) - hue) * 0.08;

  const base = active ? mix(rgb(palette.user), rgb(palette.accent), hue) : rgb(palette.outline);
  const soft = active ? mix(rgb(palette['user-soft']), rgb(palette['accent-soft']), hue) : rgb(palette.outline);
  const pulse = conn === 'connecting' || conn === 'reconnecting' ? (Math.sin(now / 260) + 1) / 2 : 0;
  const t = now / 1000;

  ctx.clearRect(0, 0, W, W);

  // dış hale
  const glowR = 150 + lvl * 90 + pulse * 30;
  const g = ctx.createRadialGradient(C, C, 40, C, C, glowR + 60);
  g.addColorStop(0, rgba(base, active ? 0.32 + lvl * 0.3 : 0.12 + pulse * 0.15));
  g.addColorStop(1, rgba(base, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, W);

  // sesle dalgalanan halkalar
  for (let r = 0; r < 3; r++) {
    ctx.beginPath();
    const R = 112 + r * 20 + lvl * (26 + r * 14);
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 90) {
      const wob = Math.sin(a * (3 + r) + t * (1.4 + r * 0.5)) * (2 + lvl * 16) + Math.sin(a * 7 - t * 2.1) * lvl * 6;
      const x = C + Math.cos(a) * (R + wob), y = C + Math.sin(a) * (R + wob);
      a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(base, (active ? 0.55 : 0.3) - r * 0.14);
    ctx.lineWidth = 3 - r * 0.6;
    ctx.stroke();
  }

  // çekirdek
  const coreR = 96 + lvl * 22 + pulse * 6;
  const core = ctx.createRadialGradient(C - coreR * 0.3, C - coreR * 0.35, coreR * 0.1, C, C, coreR);
  core.addColorStop(0, rgba(base, active ? 0.95 : 0.5));
  core.addColorStop(1, rgba(soft, active ? 0.9 : 0.35));
  ctx.beginPath();
  ctx.arc(C, C, coreR, 0, Math.PI * 2);
  ctx.fillStyle = core;
  ctx.fill();

  const h = hintText();
  if (ui.hint.textContent !== h) ui.hint.textContent = h;
  requestAnimationFrame(frame);

}

// ── Test paneli ──────────────────────────────────────────
// Gemini ile araçları denemek için: kip geçişi (Doğrudan/Jev), kuru çalıştırma, hazır cümleler, çağrı kaydı.

const PRESETS = [
  ['Müziği duraklat', 'medya'],
  ['Sesi yüzde 30 yap', 'medya'],
  ['Şu an ne çalıyor?', 'medya'],
  ['3 dakikalık çay zamanlayıcısı kur', 'zamanlayici'],
  ['Kaç zamanlayıcım var?', 'zamanlayici'],
  ["Yarın Ankara'da yağmur var mı?", 'hava_durumu'],
  ["İzmir'de hava nasıl?", 'hava_durumu'],
  ['Ekran kartı kaç derece?', 'sistem_durumu'],
  ['Disk ne kadar dolu?', 'sistem_durumu'],
  ['Bana kısa bir fıkra anlat', null],
  ["Fransa'nın başkenti neresi?", null],
];

const lab = (() => {
  const el = {
    panel: $('lab'), btn: $('labBtn'), seg: $('modeSeg'), dry: $('dryRun'),
    meta: $('labMeta'), presets: $('presets'), stats: $('labStats'), log: $('labLog'),
  };
  const stats = { calls: 0, jevMs: [], jevConf: [] };
  let info = null;
  let budget = null;

  for (const [text, expect] of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = expect ? `Beklenen araç: ${label(expect)}` : 'Tuzak: araç gerekmemeli';
    if (!expect) b.classList.add('trap');
    b.addEventListener('click', () => sendText(text));
    el.presets.append(b);
  }

  function setOpen(open) {
    el.panel.hidden = !open;
    document.body.classList.toggle('lab-open', open);
    el.btn.setAttribute('aria-pressed', String(open));
    window.atlas.setLabOpen(open);
    try { localStorage.setItem('lab', open ? '1' : ''); } catch { /* depolama yok */ }
  }
  el.btn.addEventListener('click', () => setOpen(el.panel.hidden));

  for (const b of el.seg.children) {
    b.addEventListener('click', async () => {
      if (b.dataset.mode === info?.toolMode) return;
      if (b.dataset.mode !== 'direct' && !info?.hasJevKey) return meta('TYPESAFE_API_KEY yok — .env dosyasına ekle.', true);
      meta(conn === 'idle' ? 'Kaydediliyor…' : 'Kip değişiyor, oturum yeniden başlıyor…');
      const r = await window.atlas.saveSettings({ toolMode: b.dataset.mode });
      if (!r.ok) meta(r.error, true);
    });
  }
  el.dry.addEventListener('change', () => window.atlas.setDryRun(el.dry.checked));

  function meta(text, warn = false) {
    el.meta.textContent = text;
    el.meta.classList.toggle('warn', warn);
  }

  function setInfo(i) {
    info = i;
    for (const b of el.seg.children) b.setAttribute('aria-checked', String(b.dataset.mode === i.toolMode));
    meta({
      direct: 'Doğrudan: Gemini dört aracın tanımını görür ve kendisi seçer.',
      jev: 'Jev: Gemini önce arac_bul der, aracı Jev seçer, sonra arac_calistir (iki tur).',
      jev_pre: 'Ön-seçim: Jev cümleye Gemini\'den önce bakar, öneriyi mesaja ekler (tek tur). Şimdilik yalnız yazılı girişte.',
    }[i.toolMode] ?? i.toolMode);
    setBudget(i.cost?.jev);
  }

  function setBudget(j) {
    if (j) budget = j;
    renderStats();
  }

  function renderStats() {
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const ms = avg(stats.jevMs), conf = avg(stats.jevConf);
    const cells = [
      [stats.calls, 'araç çağrısı'],
      [ms == null ? '—' : `${Math.round(ms)} ms`, 'Jev ort. süre'],
      [conf == null ? '—' : pctf(conf), 'Jev ort. güven'],
      [budget ? usd(budget.total_usd) : '—', budget ? `Jev harcama / $${budget.budget_usd}` : 'Jev harcama'],
    ];
    el.stats.replaceChildren(...cells.map(([v, k]) => {
      const d = document.createElement('div');
      d.className = 'stat';
      d.append(Object.assign(document.createElement('b'), { textContent: v }), Object.assign(document.createElement('span'), { textContent: k }));
      return d;
    }));
  }

  function log(t) {
    el.log.querySelector('.empty')?.remove();
    stats.calls++;
    const e = document.createElement('div');
    const err = Boolean(t.response?.hata);
    e.className = `entry ${t.jev ? 'jev' : t.mode === 'direct' ? 'direct' : ''} ${err ? 'err' : ''}`;
    const row = document.createElement('div');
    row.className = 'row';
    const add = (cls, text) => row.append(Object.assign(document.createElement('span'), { className: cls, textContent: text }));
    const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (t.jev) {
      stats.jevMs.push(t.jev.ms);
      stats.jevConf.push(t.jev.confidence);
      add('tag', t.name === 'on_secim' ? 'ÖN-SEÇİM' : 'JEV');
      add('skill', t.jev.choice === 'hicbiri' ? 'hiçbiri' : label(t.jev.choice));
      add('num', `güven ${pctf(t.jev.confidence)} · ${t.jev.ms} ms · ${t.jev.tokens} tok · ${usd(t.jev.usd)} · ${time}`);
      e.append(row);
      const said = document.createElement('div');
      said.className = 'said';
      said.textContent = `“${t.jev.userText || '(ham cümle yok)'}”${t.args?.ihtiyac ? ` → Gemini'nin özeti: “${t.args.ihtiyac}”` : ' (ön-seçim, Gemini\'den önce)'}`;
      e.append(said, probBar(t.jev.probabilities));
    } else {
      add('tag', t.name === 'arac_calistir' ? 'ÇALIŞTIR' : t.mode === 'direct' ? 'DOĞRUDAN' : 'ARAÇ');
      add('skill', label(t.skill ?? t.name));
      add('num', `${t.ms} ms${t.dryRun ? ' · kuru' : ''} · ${time}`);
      e.append(row);
      const pre = document.createElement('pre');
      const args = t.name === 'arac_calistir' ? t.args : t.args;
      pre.textContent = `${JSON.stringify(args)}\n→ ${JSON.stringify(t.response).slice(0, 400)}`;
      e.append(pre);
    }
    el.log.prepend(e);
    renderStats();
  }

  function probBar(p) {
    const wrap = document.createElement('div');
    const bar = document.createElement('div');
    bar.className = 'bar-p';
    const sorted = Object.entries(p).sort((a, b) => b[1] - a[1]);
    const colors = ['var(--accent)', 'var(--user)', 'var(--text-muted)', 'var(--outline)', 'var(--bg-high)'];
    sorted.forEach(([, v], i) => {
      const s = document.createElement('i');
      s.style.width = `${v * 100}%`;
      s.style.background = colors[Math.min(i, colors.length - 1)];
      bar.append(s);
    });
    const txt = document.createElement('div');
    txt.className = 'probs';
    txt.textContent = sorted.filter(([, v]) => v >= 0.01).map(([k, v]) => `${label(k)} ${pctf(v)}`).join(' · ');
    wrap.append(bar, txt);
    return wrap;
  }

  function setEnabled(on) {
    for (const b of el.presets.children) b.disabled = !on;
  }

  let initial = false;
  try { initial = localStorage.getItem('lab') === '1'; } catch { /* depolama yok */ }
  if (initial) setOpen(true);
  setEnabled(false);
  return { log, setInfo, setBudget, setEnabled, toggle: () => setOpen(el.panel.hidden) };
})();

function showInfo(i) {
  ui.meta.textContent = `${i.model} · ses: ${i.voice} · bellek ${Math.round(i.contextLimit / 1000)}k${i.googleSearch ? ' · arama açık' : ''}`;
  showCost(i.cost, false);
  lab.setInfo(i);
}

window.atlas.info().then((i) => {
  showInfo(i);
  if (!i.hasKey) toast('GEMINI_API_KEY bulunamadı: proje kökündeki .env dosyasına ekle.');
});
requestAnimationFrame(frame);

// Doğrulama modu (main.js ATLAS_SNAPSHOT_ASK): mikrofon kapalı bağlan, metni sor.
const ask = new URLSearchParams(location.search).get('ask');
if (new URLSearchParams(location.search).get('lab') && document.getElementById('lab').hidden) lab.toggle();
if (ask) {
  setMic(false);
  connect().then(() => setTimeout(() => {
    ui.input.value = ask;
    ui.composer.requestSubmit();
  }, 800));
}
