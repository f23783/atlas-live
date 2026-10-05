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

/** LiveConnectConfig.tools için liste: yerel fonksiyonlar + Google Search grounding. */
export function toolConfig(tools = LOCAL_TOOLS) {
  return [{ functionDeclarations: tools.map((t) => t.declaration) }, { googleSearch: {} }];
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
