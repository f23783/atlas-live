import { execFile } from 'node:child_process';

/** Komutu kabuksuz çalıştırır (argümanlar enjeksiyona kapalı), stdout döner. */
export function run(cmd, args, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout.trim());
    });
  });
}
