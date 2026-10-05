import { run } from './exec.js';

const pct = (v) => Math.round(v * 100);

async function volume() {
  const out = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']); // "Volume: 0.45 [MUTED]"
  const m = out.match(/Volume:\s*([\d.]+)/);
  return { ses_yuzde: m ? pct(Number(m[1])) : null, sessiz: /MUTED/.test(out) };
}

async function nowPlaying() {
  try {
    const status = await run('playerctl', ['status']);
    const meta = await run('playerctl', ['metadata', '--format', '{{artist}} — {{title}} ({{playerName}})']).catch(() => '');
    return { durum: { Playing: 'çalıyor', Paused: 'duraklatıldı', Stopped: 'durdu' }[status] ?? status, parca: meta || null };
  } catch {
    return { durum: 'oynatıcı yok', parca: null };
  }
}

export const mediaTool = {
  name: 'medya',
  summary: 'Müzik/video oynatma kontrolü (çal, duraklat, sonraki, önceki, ne çalıyor) ve bilgisayarın ses seviyesi (aç, kıs, yüzde ayarla, sessize al).',
  mutates: true,
  declaration: {
    name: 'medya',
    description: 'Oynatıcıyı (Spotify, tarayıcı vb.) ve sistem ses seviyesini kontrol eder.',
    parameters: {
      type: 'OBJECT',
      properties: {
        islem: {
          type: 'STRING',
          enum: ['oynat', 'duraklat', 'oynat_duraklat', 'sonraki', 'onceki', 'durum', 'ses_ayarla', 'ses_artir', 'ses_azalt', 'sessiz_ac_kapa'],
          description: 'durum: ne çalıyor ve ses seviyesi kaç.',
        },
        deger: { type: 'INTEGER', description: 'ses_ayarla için hedef yüzde (0-100); ses_artir/ses_azalt için adım yüzdesi (varsayılan 10).' },
      },
      required: ['islem'],
    },
  },
  async run({ islem, deger }, { dryRun }) {
    const player = { oynat: 'play', duraklat: 'pause', oynat_duraklat: 'play-pause', sonraki: 'next', onceki: 'previous' }[islem];
    if (islem === 'durum') return { ...(await nowPlaying()), ...(await volume()) };
    if (dryRun) return { kuru: true, islem, deger: deger ?? null };
    if (player) {
      try { await run('playerctl', [player]); } catch { return { hata: 'Açık bir oynatıcı bulunamadı.' }; }
      await new Promise((r) => setTimeout(r, 300)); // durumun güncellenmesi için
      return await nowPlaying();
    }
    const sink = '@DEFAULT_AUDIO_SINK@';
    if (islem === 'ses_ayarla') {
      const v = Math.max(0, Math.min(100, Math.round(Number(deger))));
      if (Number.isNaN(v)) return { hata: 'ses_ayarla için deger (0-100) gerekli.' };
      await run('wpctl', ['set-volume', sink, `${v}%`]);
    } else if (islem === 'ses_artir' || islem === 'ses_azalt') {
      const step = Math.max(1, Math.min(50, Math.round(Number(deger) || 10)));
      // -l 1.0: %100'ün üstüne çıkma (hoparlörü zorlamasın)
      await run('wpctl', ['set-volume', '-l', '1.0', sink, `${step}%${islem === 'ses_artir' ? '+' : '-'}`]);
    } else if (islem === 'sessiz_ac_kapa') {
      await run('wpctl', ['set-mute', sink, 'toggle']);
    } else {
      return { hata: `Bilinmeyen işlem: ${islem}` };
    }
    return await volume();
  },
};
