// Ses önizlemesini Electron olmadan dener:  node scripts/preview-voice.js Puck
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/main/config.js';
import { VoicePreview } from '../src/main/voice-preview.js';
const cfg = loadConfig();
const p = new VoicePreview({ dir: path.join(os.tmpdir(), 'atlas-voice-test'), apiKey: cfg.apiKey });
const t = performance.now();
const pcm = await p.sample(process.argv[2] || 'Puck', cfg.model);
console.log(`${pcm.length} bayt · ${(pcm.length / 48000).toFixed(1)} sn ses · ${Math.round(performance.now() - t)} ms`);
const t2 = performance.now();
await p.sample(process.argv[2] || 'Puck', cfg.model);
console.log(`önbellekten: ${Math.round(performance.now() - t2)} ms`);
