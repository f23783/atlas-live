import path from 'node:path';
import { app, ipcMain } from 'electron';
import { LiveSession } from './live-session.js';
import { loadConfig, loadEnv } from './config.js';
import { costUsd, fetchUsdTry, UsageLedger, TRANSCRIBE_PRICES } from './pricing.js';
import { SettingsStore, VOICES, MODELS, CONTEXT_LIMITS } from './settings.js';
import { VoicePreview } from './voice-preview.js';
import { buildToolset, skillRegistry } from './tools/index.js';
import { TimerManager } from './tools/timer.js';
import { JevClient, JevLedger } from './jev.js';

// IPC sözleşmesi (preload.cjs ile birebir):
//   invoke  live:start → { ok, error? } · live:stop · live:text(text) · live:info → { model, voice, hasKey, googleSearch, contextLimit, cost }
//           settings:get → { settings, voices, models, contextLimits, connected } · settings:save(patch) → { ok, restarted?, error? }
//           settings:preview(voice, model) → Uint8Array PCM16 24 kHz · settings:open · live:dry-run(bool) · ui:lab(bool)
//   send    live:audio(ArrayBuffer PCM16 16 kHz) · live:audio-end
//   main→UI live:event { type, payload }   (type 'cost' → { session, today, month } TL + kur + jev; 'settings' → yeni info)
const FORWARDED = ['state', 'interrupted', 'turnComplete', 'transcript', 'tool', 'watchdog', 'userLive'];

export function registerIpc({ getWindow, openSettings, setLabOpen }) {
  let session = null;
  const emit = (type, payload) => getWindow()?.webContents.send('live:event', { type, payload });

  const userData = app.getPath('userData');
  const settings = new SettingsStore(path.join(userData, 'settings.json'));
  const config = () => loadConfig(loadEnv(), settings.get());
  let preview = null; // anahtar ilk önizlemede okunur (.env sonradan eklenmiş olabilir)

  // Maliyet: tahmini, ücretli katman fiyatıyla (ücretsiz katmanda gerçek fatura 0).
  const ledger = new UsageLedger(path.join(userData, 'usage.json'));
  let fx = { rate: config().usdTryFallback, source: 'yedek kur' };
  const fxReady = fetchUsdTry(fx.rate).then((r) => (fx = r));
  let sessionUsd = 0;
  const jevLedger = new JevLedger(path.join(userData, 'jev-usage.json'), config().jevBudgetUsd);
  const costSnapshot = () => ({
    session: sessionUsd * fx.rate,
    today: ledger.todayUsd * fx.rate,
    month: ledger.monthUsd * fx.rate,
    rate: fx.rate,
    rateSource: fx.source,
    jev: jevLedger.snapshot(),
  });

  // Zamanlayıcılar oturumdan bağımsız: ayar değişip oturum yeniden açılsa da çalar.
  const timers = new TimerManager();
  timers.onFire = (t) => {
    emit('timer', { label: t.label });
    session?.sendSystemNote(`"${t.label}" zamanlayıcısının süresi doldu. Kullanıcıya kısaca haber ver.`);
  };

  let dryRun = false; // test panelindeki "kuru" anahtarı; kalıcı değil
  function toolsetFor(c) {
    const jev = c.toolMode !== 'direct' ? new JevClient({ apiKey: c.typesafeKey, ledger: jevLedger }) : null;
    return buildToolset({ mode: c.toolMode, skills: skillRegistry(timers), jev, dryRun: () => dryRun, userText: () => session?.userText ?? '' });
  }
  const info = () => {
    const c = config();
    return { model: c.model, voice: c.voice, hasKey: Boolean(c.apiKey), googleSearch: c.googleSearch, contextLimit: c.contextLimit, toolMode: c.toolMode, hasJevKey: Boolean(c.typesafeKey), cost: costSnapshot() };
  };

  async function startSession() {
    // Eski oturumun 'closed' olayı UI'a gitmesin: UI onu kalıcı kopma sanıp mikrofonu kapatır.
    session?.removeAllListeners();
    session?.stop();
    session = null;
    const c = config();
    if (c.toolMode !== 'direct' && !c.typesafeKey) return { ok: false, error: 'Jev kipi seçili ama TYPESAFE_API_KEY yok (.env).' };
    session = new LiveSession({ config: c, toolset: toolsetFor(c) });
    for (const ev of FORWARDED) session.on(ev, (p) => emit(ev, p));
    // Ses base64 olarak gelir; UI'a ham bayt yolla (IPC'de Uint8Array olarak varır, çözme maliyeti yok).
    session.on('audio', (b64) => emit('audio', Buffer.from(b64, 'base64')));
    session.on('error', (e) => emit('error', e.message));
    // Jev harcaması araç sonucunda oluşur: sayaç anında güncellensin.
    session.on('tool', (t) => t.phase === 'result' && t.traces.some((x) => x.jev) && emit('cost', costSnapshot()));
    sessionUsd = 0;
    const charge = (usd) => {
      sessionUsd += usd;
      ledger.add(usd);
      emit('cost', costSnapshot());
    };
    session.on('usage', (u) => charge(costUsd(u)));
    session.on('scribeUsage', (u) => charge(costUsd(u, TRANSCRIBE_PRICES))); // paralel döküm (jev_pre sesli)
    try {
      await session.start();
      return { ok: true };
    } catch (e) {
      session = null;
      return { ok: false, error: e.message };
    }
  }

  ipcMain.handle('live:start', startSession);
  ipcMain.handle('live:stop', () => { session?.removeAllListeners(); session?.stop(); session = null; });
  ipcMain.handle('live:info', async () => { await fxReady; return info(); });
  ipcMain.handle('live:text', (_e, text) => session?.sendText(String(text)) ?? false);
  ipcMain.on('live:audio', (_e, pcm) => session?.sendAudio(pcm));
  ipcMain.on('live:audio-end', () => session?.endAudio());

  ipcMain.handle('live:dry-run', (_e, on) => { dryRun = Boolean(on); return dryRun; });
  ipcMain.handle('ui:lab', (_e, open) => setLabOpen(Boolean(open)));
  ipcMain.handle('settings:open', () => openSettings());
  ipcMain.handle('settings:get', () => {
    const c = config();
    return {
      settings: { voice: c.voice, model: c.model, contextLimit: c.contextLimit, googleSearch: c.googleSearch, toolMode: c.toolMode },
      hasJevKey: Boolean(c.typesafeKey),
      jev: jevLedger.snapshot(),
      voices: VOICES,
      models: MODELS,
      contextLimits: CONTEXT_LIMITS,
      connected: Boolean(session),
    };
  });
  ipcMain.handle('settings:save', async (_e, patch) => {
    try {
      settings.set(patch);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    emit('settings', info());
    // Ses/model bağlantı anında sabitlenir; bağlıysak yeni ayarla oturumu yeniden aç (konuşma bağlamı sıfırlanır).
    if (!session) return { ok: true, restarted: false };
    const r = await startSession();
    return { ...r, restarted: r.ok };
  });
  ipcMain.handle('settings:preview', async (_e, voice, model) => {
    preview ??= new VoicePreview({ dir: path.join(userData, 'voice-samples'), apiKey: config().apiKey });
    return preview.sample(voice, model);
  });

  return () => { timers.clear(); session?.stop(); };
}
