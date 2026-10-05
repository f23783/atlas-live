import { clock } from './clock.js';
import { timerTool } from './timer.js';
import { mediaTool } from './media.js';
import { weatherTool } from './weather.js';
import { systemTool } from './system.js';

/** Yönlendirilen yetenekler (Jev kipinde Jev bunlar arasından seçer). Saat her kipte doğrudan durur: küçük ve sık. */
export function skillRegistry(timers) {
  return [timerTool(timers), mediaTool, weatherTool, systemTool];
}

const NONE = 'hicbiri';
const MIN_CONFIDENCE = 0.5; // altında Jev "emin değilim" der; tahmin yürütmez

/**
 * Oturumun araç seti.
 *   mode 'direct': Gemini tüm yeteneklerin tanımını görür ve doğrudan çağırır.
 *   mode 'jev'   : Gemini yalnız arac_bul + arac_calistir görür; hangi aracın gerektiğine Jev karar verir (iki tur).
 *   mode 'jev_pre': Jev kullanıcının cümlesine Gemini'den ÖNCE bakar; araç gerekiyorsa aynı mesaja öneri notu
 *                  (araç + şema) eklenir, Gemini yalnız arac_calistir görür (tek tur). preRoute() bunu yapar.
 * run() modelin göreceği cevabı ve UI/test için `trace`'i ayrı döner.
 * dryRun: boolean ya da () => boolean; açıkken değiştiren araçlar (medya, zamanlayıcı) yalnız ne yapacağını söyler.
 */
export function buildToolset({ mode = 'direct', skills, jev, dryRun = false, userText = () => '' }) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const base = [clock];
  const isDry = typeof dryRun === 'function' ? dryRun : () => dryRun; // test panelinden anlık açılıp kapanabilir

  const routed = mode === 'jev' || mode === 'jev_pre' ? jevRouter({ skills, byName, jev, userText }) : null;
  const routedDecl = mode === 'jev_pre' ? routed.declarations.filter((d) => d.name === 'arac_calistir') : routed?.declarations;
  const declarations = [...base.map((t) => t.declaration), ...(routed ? routedDecl : skills.map((s) => s.declaration))];

  /**
   * jev_pre: kullanıcının cümlesi için Jev'e sor; araç gerekiyorsa Gemini'ye gidecek öneri notunu döner.
   * @returns {{ note: string|null, trace }}
   */
  async function preRoute(text) {
    const trace = { name: 'on_secim', args: { cumle: text }, mode, dryRun: isDry() };
    try {
      const a = await pickTool({ jev, skills, said: text, summary: null });
      trace.jev = { ...a, userText: text };
      trace.ms = a.ms;
      if (a.choice === NONE || a.confidence < MIN_CONFIDENCE) return { note: null, trace };
      const s = byName.get(a.choice);
      trace.skill = s.name;
      const note =
        `[Araç önerisi — sistemden, kullanıcı yazmadı] Bu istek için "${s.name}" aracı uygun: ${s.declaration.description} ` +
        `arac_calistir ile çağır: ad="${s.name}", argumanlar_json bu şemaya uyan JSON: ${JSON.stringify(s.declaration.parameters ?? {})}. ` +
        'İstek açıkça başka bir şeyse öneriyi yok say.';
      return { note, trace };
    } catch (err) {
      trace.response = { hata: String(err?.message ?? err) }; // Jev yoksa öneri yok; konuşma sürer
      return { note: null, trace };
    }
  }

  async function run(fc) {
    const t0 = performance.now();
    const dryRun = isDry();
    const trace = { name: fc.name, args: fc.args ?? {}, mode, dryRun };
    let response;
    try {
      const direct = base.find((t) => t.name === fc.name) ?? (mode === 'direct' ? byName.get(fc.name) : null);
      if (direct) {
        trace.skill = direct.name;
        response = await direct.run(fc.args ?? {}, { dryRun });
      } else if (routed && routed.handles(fc.name)) {
        response = await routed.run(fc, { dryRun, trace });
      } else {
        response = { hata: `Bilinmeyen araç: ${fc.name}` };
      }
    } catch (err) {
      response = { hata: String(err?.message ?? err) };
    }
    trace.ms = Math.round(performance.now() - t0);
    trace.response = response;
    return { response, trace };
  }

  const systemNote = mode === 'jev_pre'
    ? 'Kullanıcının mesajında [Araç önerisi] notu varsa ve öneri isteğe uyuyorsa, tahmin yürütmeden hemen arac_calistir ile o aracı kullan. ' +
      'Not yoksa saat dışında araç kullanma; bu notu kullanıcıya okuma.'
    : null;

  return { mode, declarations, run, systemNote, preRoute: mode === 'jev_pre' ? preRoute : null };
}

function jevRouter({ skills, byName, jev, userText }) {
  const declarations = [
    {
      name: 'arac_bul',
      description:
        'Kullanıcının isteği bir eylem veya canlı veri gerektiriyorsa (zamanlayıcı, müzik/ses kontrolü, hava durumu, ' +
        'bilgisayarın donanım durumu gibi) ÖNCE bunu çağır. Sana uygun aracı ve parametrelerini söyler. ' +
        'Sohbet ve genel bilgi için çağırma.',
      parameters: {
        type: 'OBJECT',
        properties: { ihtiyac: { type: 'STRING', description: 'Kullanıcının ne istediği, kısa ve somut (ör. "müziğin sesini kısmak").' } },
        required: ['ihtiyac'],
      },
    },
    {
      name: 'arac_calistir',
      description: 'Önerilen aracı (arac_bul cevabından ya da mesajdaki [Araç önerisi] notundan) çalıştırır. Parametreleri verilen şemaya göre JSON nesnesi olarak yaz.',
      parameters: {
        type: 'OBJECT',
        properties: {
          ad: { type: 'STRING', description: 'Aracın adı (arac_bul\'dan).' },
          argumanlar_json: { type: 'STRING', description: 'Parametreler, JSON nesnesi olarak (ör. {"islem":"ses_azalt","deger":10}).' },
        },
        required: ['ad', 'argumanlar_json'],
      },
    },
  ];

  async function find({ ihtiyac }, { trace }) {
    const said = userText();
    const a = await pickTool({ jev, skills, said, summary: ihtiyac });
    trace.jev = { ...a, userText: said };
    if (a.choice === NONE) return { arac: null, mesaj: 'Bu istek için uygun bir araç yok. Kullanıcıya bunu yapamadığını kısaca söyle.' };
    if (a.confidence < MIN_CONFIDENCE) {
      const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k);
      return { arac: null, mesaj: `Emin olamadım (${top.join(' / ')}). Kullanıcıya ne istediğini kısaca sor.` };
    }
    const s = byName.get(a.choice);
    trace.skill = s.name;
    return { arac: s.name, aciklama: s.declaration.description, parametre_semasi: s.declaration.parameters ?? { type: 'OBJECT', properties: {} }, sonraki_adim: 'arac_calistir ile çağır.' };
  }

  async function exec({ ad, argumanlar_json }, { dryRun, trace }) {
    const s = byName.get(ad);
    if (!s) return { hata: `Bilinmeyen araç: ${ad}. Önce arac_bul çağır.` };
    let args;
    try { args = argumanlar_json ? JSON.parse(argumanlar_json) : {}; } catch { return { hata: 'argumanlar_json geçerli JSON değil.' }; }
    const invalid = validateArgs(s.declaration.parameters, args);
    if (invalid) return { hata: invalid };
    trace.skill = s.name;
    trace.args = args;
    return s.run(args, { dryRun });
  }

  return {
    declarations,
    handles: (name) => name === 'arac_bul' || name === 'arac_calistir',
    run: (fc, ctx) => (fc.name === 'arac_bul' ? find(fc.args ?? {}, ctx) : exec(fc.args ?? {}, ctx)),
  };
}

/**
 * Jev'e "hangi araç?" sorusu. Uygulama ve değerlendirme betiği aynı soruyu sorsun diye tek yerde.
 * @returns {{ choice, confidence, probabilities, ms, tokens, usd }}
 */
export async function pickTool({ jev, skills, said, summary }) {
  // Jev'in "ilk seçeneğe eğilimi" var (jev-1.13 jaggedness): sırayı her çağrıda karıştır.
  const options = shuffle([...skills.map((s) => [s.name, s.summary]), [NONE, 'Hiçbir araç uymuyor: sohbet, genel bilgi ya da bu araçların yapamadığı bir iş.']]);
  const r = await jev.ask(
    { kullanicinin_sozu: said || null, asistanin_ozeti: summary || null },
    {
      arac: {
        type: 'choice',
        instructions: 'Kullanıcının isteğini yerine getirmek için aşağıdaki araçlardan hangisi gerekiyor? Hiçbiri uymuyorsa "hicbiri".',
        criteria: Object.fromEntries(options),
      },
    },
  );
  const a = r.answers.arac;
  return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, ms: r.ms, tokens: r.inputTokens, usd: r.usd };
}

/** Gemini şemasına (OBJECT/STRING/INTEGER + enum + required) göre basit doğrulama. Hata metni modele gider. */
export function validateArgs(schema, args) {
  if (!schema) return null;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'Parametreler bir JSON nesnesi olmalı.';
  for (const r of schema.required ?? []) if (args[r] === undefined) return `Eksik parametre: ${r}`;
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p) return `Bilinmeyen parametre: ${k}`;
    if (p.enum && !p.enum.includes(v)) return `${k} şunlardan biri olmalı: ${p.enum.join(', ')}`;
    if ((p.type === 'INTEGER' || p.type === 'NUMBER') && Number.isNaN(Number(v))) return `${k} sayı olmalı.`;
  }
  return null;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
