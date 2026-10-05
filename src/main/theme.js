import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Renkler elle yazılmaz: matugen (~/.config/matugen/templates/atlas-live.css) duvar kâğıdından üretir.
// Dosya değişince (yeni duvar kâğıdı) pencereye canlı uygulanır. Yoksa styles.css'teki yedek palet kalır.
export const THEME_FILE = path.join(os.homedir(), '.config/matugen/generated/atlas-live.css');

export function attachTheme(win) {
  let key = null;
  const apply = async () => {
    if (win.isDestroyed()) return;
    let css;
    try { css = fs.readFileSync(THEME_FILE, 'utf8'); } catch { return; }
    const old = key;
    key = await win.webContents.insertCSS(css);
    if (old) await win.webContents.removeInsertedCSS(old);
  };
  win.webContents.on('did-finish-load', apply);
  try {
    let t;
    const watcher = fs.watch(path.dirname(THEME_FILE), (_ev, file) => {
      if (file !== path.basename(THEME_FILE)) return;
      clearTimeout(t);
      t = setTimeout(apply, 150); // matugen dosyayı birkaç adımda yazabilir
    });
    win.on('closed', () => watcher.close());
  } catch { /* matugen yok: yedek palet */ }
}
