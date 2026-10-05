const $ = (id) => document.getElementById(id);
const ui = { voices: $('voices'), models: $('models'), contexts: $('contexts'), search: $('search'), save: $('save'), close: $('close'), status: $('status') };

// Bellek seçeneklerinin açıklaması: ~1.500 ses token'ı/dk konuşma. Maliyet, 1 saatlik kesintisiz
// konuşmanın 2026-10-05 tahmini (49,06 TL kur, ücretli katman) — bkz. Atlas-Live notu.
const CONTEXT_INFO = {
  8000: { label: '8k', memory: 'son ~5 dk', hour: '≈ ₺230 / saat' },
  16000: { label: '16k', memory: 'son ~10 dk', hour: '≈ ₺430 / saat' },
  32000: { label: '32k', memory: 'son ~20 dk', hour: '≈ ₺760 / saat' },
};

let saved; // kayıtlı ayarlar
let draft; // ekrandaki seçim
let connected = false;

const ICONS = `<svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg class="i-stop" viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>`;

async function init() {
  const data = await window.atlas.getSettings();
  saved = data.settings;
  draft = { ...saved };
  connected = data.connected;

  for (const v of data.voices) {
    const card = el('div', { className: 'voice', role: 'radio', tabIndex: 0, dataset: { value: v.name } });
    const txt = el('span', { className: 'txt' });
    const name = el('span', { className: 'name', textContent: v.name });
    if (v.name === saved.voice) name.append(el('span', { className: 'now', textContent: 'şu an' }));
    txt.append(name, el('span', { className: 'trait', textContent: v.trait }));
    const play = el('button', { className: 'play', type: 'button', title: `${v.name} sesini dinle`, innerHTML: ICONS });
    play.setAttribute('aria-label', `${v.name} sesini dinle`);
    play.addEventListener('click', (e) => { e.stopPropagation(); togglePreview(v.name, play); });
    card.append(txt, play);
    card.addEventListener('click', () => pick('voice', v.name));
    ui.voices.append(card);
  }

  for (const m of data.models) {
    const b = el('button', { className: 'option', type: 'button', role: 'radio', dataset: { value: m.id } });
    b.append(el('b', { textContent: m.label }), el('span', { textContent: `${m.note} · ${m.id}` }));
    b.addEventListener('click', () => pick('model', m.id));
    ui.models.append(b);
  }

  for (const c of data.contextLimits) {
    const info = CONTEXT_INFO[c] ?? { label: `${c / 1000}k`, memory: '', hour: '' };
    const b = el('button', { className: 'segment', type: 'button', role: 'radio', dataset: { value: String(c) } });
    b.append(el('b', { textContent: info.label }), el('span', { textContent: info.memory }), el('span', { textContent: info.hour }));
    b.addEventListener('click', () => pick('contextLimit', c));
    ui.contexts.append(b);
  }

  ui.search.addEventListener('change', () => pick('googleSearch', ui.search.checked));
  render();
  ui.voices.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'center' });
}

function el(tag, props) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'role') e.setAttribute('role', v);
    else e[k] = v;
  }
  return e;
}

function pick(key, value) {
  draft[key] = value;
  render();
}

const dirtyKeys = () => Object.keys(draft).filter((k) => draft[k] !== saved[k]);

function render() {
  const mark = (box, value) => {
    for (const n of box.children) n.setAttribute('aria-checked', String(n.dataset.value === String(value)));
  };
  mark(ui.voices, draft.voice);
  mark(ui.models, draft.model);
  mark(ui.contexts, draft.contextLimit);
  ui.search.checked = draft.googleSearch;

  const dirty = dirtyKeys().length > 0;
  ui.save.disabled = !dirty;
  setStatus(dirty && connected ? 'Kaydedince konuşma yeni ayarla yeniden başlar.' : '');
}

function setStatus(text, err = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('err', err);
}

// ── Önizleme ─────────────────────────────────────────────

let ctx = null;
let playing = null; // { source, button }

function stopPreview() {
  if (!playing) return;
  playing.source.onended = null;
  try { playing.source.stop(); } catch { /* zaten bitti */ }
  playing.button.classList.remove('playing');
  playing = null;
}

async function togglePreview(voice, button) {
  const wasThis = playing?.button === button;
  stopPreview();
  if (wasThis) return;

  button.classList.add('loading');
  let pcm;
  try {
    pcm = await window.atlas.previewVoice(voice, draft.model);
  } catch (e) {
    setStatus(`Örnek alınamadı: ${String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, true);
    return;
  } finally {
    button.classList.remove('loading');
  }

  ctx ??= new AudioContext({ sampleRate: 24000 });
  const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const buf = ctx.createBuffer(1, i16.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 0x8000;
  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.connect(ctx.destination);
  source.onended = () => stopPreview();
  stopPreview(); // yüklenirken başka bir örnek başlamış olabilir
  source.start();
  playing = { source, button };
  button.classList.add('playing');
}

// ── Kaydet / kapat ───────────────────────────────────────

ui.save.addEventListener('click', async () => {
  const patch = Object.fromEntries(dirtyKeys().map((k) => [k, draft[k]]));
  ui.save.disabled = true;
  setStatus(connected ? 'Kaydediliyor, yeniden bağlanıyor…' : 'Kaydediliyor…');
  const r = await window.atlas.saveSettings(patch);
  if (!r.ok) {
    render();
    return setStatus(r.error, true);
  }
  saved = { ...draft };
  for (const n of ui.voices.querySelectorAll('.now')) n.remove();
  ui.voices.querySelector(`[data-value="${saved.voice}"] .name`)?.append(el('span', { className: 'now', textContent: 'şu an' }));
  render();
  setStatus(r.restarted ? 'Kaydedildi, yeni ayarla bağlandı.' : 'Kaydedildi.');
});

ui.close.addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
  // Ses kartında Enter/Boşluk seçer
  if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.classList.contains('voice')) {
    e.preventDefault();
    pick('voice', document.activeElement.dataset.value);
  }
});

init();
