// Open-Meteo: anahtarsız, ücretsiz. Şehir adı → koordinat → tahmin.
const WMO = {
  0: 'açık', 1: 'çoğunlukla açık', 2: 'parçalı bulutlu', 3: 'kapalı', 45: 'sisli', 48: 'kırağılı sis',
  51: 'hafif çisenti', 53: 'çisenti', 55: 'yoğun çisenti', 56: 'donan çisenti', 57: 'yoğun donan çisenti',
  61: 'hafif yağmur', 63: 'yağmur', 65: 'şiddetli yağmur', 66: 'donan yağmur', 67: 'şiddetli donan yağmur',
  71: 'hafif kar', 73: 'kar', 75: 'yoğun kar', 77: 'kar taneleri', 80: 'hafif sağanak', 81: 'sağanak',
  82: 'şiddetli sağanak', 85: 'kar sağanağı', 86: 'yoğun kar sağanağı', 95: 'gök gürültülü fırtına',
  96: 'dolu ile fırtına', 99: 'şiddetli dolu ile fırtına',
};

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Hava durumu servisi ${res.status} döndü.`);
  return res.json();
}

export const weatherTool = {
  name: 'hava_durumu',
  summary: 'Bir şehrin şu anki ve önümüzdeki günlerin hava durumu: sıcaklık, yağmur/kar ihtimali, rüzgar. "Yarın şemsiye lazım mı?", "Hafta sonu hava nasıl?"',
  mutates: false,
  declaration: {
    name: 'hava_durumu',
    description: 'Şehir için güncel hava ve 7 güne kadar tahmin döndürür.',
    parameters: {
      type: 'OBJECT',
      properties: {
        sehir: { type: 'STRING', description: 'Şehir adı. Kullanıcı belirtmezse "Ankara".' },
        gun: { type: 'STRING', enum: ['bugun', 'yarin', 'hafta'], description: 'Hangi dönem. hafta: 7 günlük.' },
      },
      required: [],
    },
  },
  async run({ sehir = 'Ankara', gun = 'bugun' }) {
    const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=tr&name=${encodeURIComponent(sehir)}`);
    const place = geo.results?.[0];
    if (!place) return { hata: `"${sehir}" bulunamadı.` };
    const q = new URLSearchParams({
      latitude: place.latitude, longitude: place.longitude, timezone: 'Europe/Istanbul', forecast_days: '7',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
    });
    const w = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
    const d = w.daily;
    const day = (i) => ({
      tarih: d.time[i],
      durum: WMO[d.weather_code[i]] ?? `kod ${d.weather_code[i]}`,
      en_yuksek: Math.round(d.temperature_2m_max[i]),
      en_dusuk: Math.round(d.temperature_2m_min[i]),
      yagis_ihtimali_yuzde: d.precipitation_probability_max[i],
      yagis_mm: d.precipitation_sum[i],
    });
    const days = gun === 'hafta' ? d.time.map((_, i) => day(i)) : [day(gun === 'yarin' ? 1 : 0)];
    return {
      yer: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      simdi: gun === 'bugun' ? {
        sicaklik: Math.round(w.current.temperature_2m),
        hissedilen: Math.round(w.current.apparent_temperature),
        nem_yuzde: w.current.relative_humidity_2m,
        ruzgar_kmh: Math.round(w.current.wind_speed_10m),
        durum: WMO[w.current.weather_code] ?? `kod ${w.current.weather_code}`,
      } : undefined,
      gunler: days,
    };
  },
};
