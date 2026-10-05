// Modelin çağırabileceği yerel araçlar. Her araç: Gemini'ye giden `declaration` + Node'da çalışan `run`.
// Yeni araç eklemek = bu listeye bir nesne eklemek.

export const LOCAL_TOOLS = [
  {
    declaration: {
      name: 'get_current_time',
      description: 'Şu anki tarih ve saati (Europe/Istanbul) döndürür.',
    },
    run: async () => ({
      now: new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'full', timeStyle: 'short' }),
    }),
  },
];

/**
 * LiveConnectConfig.tools için liste: yerel fonksiyonlar (+ istenirse Google Search grounding).
 * Ücretsiz katmanda googleSearch açıkken Live bağlantısı anında 1011 "exceeded your current quota"
 * ile kapanıyor (2026-10-05'te ölçüldü) — bu yüzden varsayılan kapalı, billing sonrası açılır.
 */
export function toolConfig(tools = LOCAL_TOOLS, { googleSearch = false } = {}) {
  return [{ functionDeclarations: tools.map((t) => t.declaration) }, ...(googleSearch ? [{ googleSearch: {} }] : [])];
}

/** Gelen functionCalls'ı çalıştırır; hata olursa modele hata metni döner, oturumu düşürmez. */
export async function runToolCalls(functionCalls, tools = LOCAL_TOOLS) {
  return Promise.all(
    functionCalls.map(async (fc) => {
      const tool = tools.find((t) => t.declaration.name === fc.name);
      let response;
      try {
        response = tool ? await tool.run(fc.args ?? {}) : { error: `Bilinmeyen araç: ${fc.name}` };
      } catch (err) {
        response = { error: String(err?.message ?? err) };
      }
      return { id: fc.id, name: fc.name, response };
    }),
  );
}
