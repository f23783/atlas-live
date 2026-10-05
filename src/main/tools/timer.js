import { run } from './exec.js';

const SOUND = '/usr/share/sounds/freedesktop/stereo/complete.oga';

/**
 * Zamanlayıcılar oturumdan bağımsız yaşar (ayar değişince oturum yeniden açılsa da çalar).
 * Bitince: masaüstü bildirimi + ses + onFire (açık oturum varsa model sesli haber verir).
 */
export class TimerManager {
  #timers = new Map();
  #seq = 0;
  onFire = null;

  add(seconds, label) {
    const id = ++this.#seq;
    const due = Date.now() + seconds * 1000;
    const handle = setTimeout(() => this.#fire(id), seconds * 1000);
    this.#timers.set(id, { id, label, due, handle });
    return { id, label, due };
  }

  list() {
    return [...this.#timers.values()].map(({ id, label, due }) => ({ id, label, kalan_saniye: Math.max(0, Math.round((due - Date.now()) / 1000)) }));
  }

  cancel(id) {
    const t = id == null ? [...this.#timers.values()].at(-1) : this.#timers.get(Number(id));
    if (!t) return null;
    clearTimeout(t.handle);
    this.#timers.delete(t.id);
    return { id: t.id, label: t.label };
  }

  clear() {
    for (const t of this.#timers.values()) clearTimeout(t.handle);
    this.#timers.clear();
  }

  async #fire(id) {
    const t = this.#timers.get(id);
    if (!t) return;
    this.#timers.delete(id);
    run('notify-send', ['-a', 'Atlas', '-u', 'critical', '⏰ Zamanlayıcı', t.label]).catch(() => {});
    run('pw-play', [SOUND]).catch(() => {});
    this.onFire?.(t);
  }
}

const fmt = (s) => {
  const m = Math.floor(s / 60), r = s % 60;
  return [m && `${m} dakika`, r && `${r} saniye`].filter(Boolean).join(' ') || '0 saniye';
};

export function timerTool(manager) {
  return {
    name: 'zamanlayici',
    summary: 'Geri sayım ve hatırlatıcı: kur, listele, iptal et. "10 dakika sonra hatırlat", "çay demlenince haber ver", "kaç dakika kaldı?"',
    mutates: true,
    declaration: {
      name: 'zamanlayici',
      description: 'Geri sayım zamanlayıcısı kurar, listeler veya iptal eder. Süre dolunca masaüstü bildirimi ve sesli uyarı verilir.',
      parameters: {
        type: 'OBJECT',
        properties: {
          islem: { type: 'STRING', enum: ['kur', 'listele', 'iptal'], description: 'Yapılacak işlem.' },
          sure_saniye: { type: 'INTEGER', description: 'kur için: toplam süre saniye cinsinden (ör. 10 dakika = 600).' },
          etiket: { type: 'STRING', description: 'kur için: ne için kurulduğu, kısa (ör. "çay").' },
          id: { type: 'INTEGER', description: 'iptal için: zamanlayıcı numarası. Verilmezse en son kurulan iptal edilir.' },
        },
        required: ['islem'],
      },
    },
    async run({ islem, sure_saniye, etiket, id }, { dryRun }) {
      if (islem === 'listele') return { zamanlayicilar: manager.list() };
      if (islem === 'iptal') {
        if (dryRun) return { kuru: true, iptal_edilecek: id ?? 'son' };
        const t = manager.cancel(id);
        return t ? { iptal_edildi: t } : { hata: 'İptal edilecek zamanlayıcı yok.' };
      }
      if (islem === 'kur') {
        const s = Math.round(Number(sure_saniye));
        if (!(s >= 1 && s <= 24 * 3600)) return { hata: 'sure_saniye 1 ile 86400 arasında olmalı.' };
        const label = (etiket || 'Zamanlayıcı').slice(0, 80);
        if (dryRun) return { kuru: true, kurulacak: { label, sure: fmt(s) } };
        const t = manager.add(s, label);
        return { kuruldu: { id: t.id, etiket: label, sure: fmt(s) } };
      }
      return { hata: `Bilinmeyen işlem: ${islem}` };
    },
  };
}
