// jev_pre tel biçimi: activityStart/End, clientContent ipucu, VAD kapalı kurulum, döküm modeli kurulumu.
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { loadConfig, loadEnv, USER_DATA } from '../src/main/config.js';
import { LiveSession } from '../src/main/live-session.js';
import { Scribe } from '../src/main/scribe.js';
import { GoogleGenAI } from '@google/genai';
import { buildToolset, skillRegistry } from '../src/main/tools/index.js';
import { TimerManager } from '../src/main/tools/timer.js';
import { JevClient, JevLedger } from '../src/main/jev.js';
const redact = (s) => s.replace(/"data":"[A-Za-z0-9+/=]{40,}"/g, '"data":"<b64>"').replace(/"functionDeclarations":\[.*?\]\}\]/, '"functionDeclarations":[…]}]');
const origSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (d, ...r) { console.log('OUT ' + redact(String(d)).slice(0, 700)); return origSend.call(this, d, ...r); };
const base = loadConfig(loadEnv(), {});
const jev = new JevClient({ apiKey: base.typesafeKey, ledger: new JevLedger(path.join(USER_DATA, 'jev-usage.json'), base.jevBudgetUsd) });
const ai = new GoogleGenAI({ apiKey: base.apiKey });
const scribe = new Scribe({ ai });
const s = new LiveSession({ config: { ...base, toolMode: 'jev_pre', model: 'gemini-3.1-flash-live-preview' }, ai, scribe,
  toolset: buildToolset({ mode: 'jev_pre', skills: skillRegistry(new TimerManager()), jev, dryRun: true }) });
await s.start();
await new Promise((r) => (s.state === 'open' ? r() : s.once('state', r)));
s.sendAudio(Buffer.alloc(3200));
scribe.emit('interim', 'yarın yağmur');
scribe.emit('final', 'yarın yağmur var mı');
await new Promise((r) => setTimeout(r, 2500));
s.stop();
process.exit(0);
