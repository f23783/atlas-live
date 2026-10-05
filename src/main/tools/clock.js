export const clock = {
  name: 'get_current_time',
  summary: 'Şu anki tarih ve saat.',
  declaration: {
    name: 'get_current_time',
    description: 'Şu anki tarih ve saati (Europe/Istanbul) döndürür.',
  },
  run: async () => ({
    now: new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'full', timeStyle: 'short' }),
  }),
};
