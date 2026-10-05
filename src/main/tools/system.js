import os from 'node:os';
import fs from 'node:fs';
import { run } from './exec.js';

const gb = (b) => +(b / 1024 ** 3).toFixed(1);

async function cpu() {
  const [l1, l5] = os.loadavg();
  let temp = null;
  try {
    const s = JSON.parse(await run('sensors', ['-j']));
    const k = Object.entries(s).find(([n]) => n.startsWith('k10temp') || n.startsWith('coretemp'))?.[1];
    const t = k && (k.Tctl ?? k['Package id 0'] ?? Object.values(k).find((v) => typeof v === 'object'));
    temp = t ? Math.round(Object.entries(t).find(([n]) => n.endsWith('_input'))?.[1]) : null;
  } catch { /* sensors yok */ }
  return { model: os.cpus()[0]?.model.trim(), cekirdek: os.cpus().length, yuk_1dk: +l1.toFixed(2), yuk_5dk: +l5.toFixed(2), sicaklik_c: temp };
}

async function gpu() {
  try {
    const out = await run('nvidia-smi', ['--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw', '--format=csv,noheader,nounits']);
    const [name, temp, util, used, total, power] = out.split(',').map((s) => s.trim());
    return { model: name, sicaklik_c: +temp, kullanim_yuzde: +util, vram_mb: `${used}/${total}`, guc_w: Number.isNaN(+power) ? null : +power };
  } catch {
    return { hata: 'NVIDIA GPU bilgisi alınamadı.' };
  }
}

function memory() {
  const info = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').map((l) => l.split(/:\s+/)).filter((p) => p[1]).map(([k, v]) => [k, parseInt(v, 10) * 1024]));
  const used = info.MemTotal - info.MemAvailable;
  return { toplam_gb: gb(info.MemTotal), kullanilan_gb: gb(used), kullanim_yuzde: Math.round((used / info.MemTotal) * 100), swap_kullanilan_gb: gb(info.SwapTotal - info.SwapFree) };
}

async function disk() {
  const out = await run('df', ['-B1', '--output=target,size,used,avail', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'efivarfs', '-x', 'overlay']);
  const seen = new Set();
  return out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter(([mnt, size]) => {
    // btrfs alt birimleri aynı diski tekrar gösterir; boyuta göre tekilleştir, yalnız anlamlı bağlama noktaları
    if (!['/', '/home'].includes(mnt) && !mnt.startsWith('/mnt') && !mnt.startsWith('/run/media')) return false;
    if (seen.has(size)) return false;
    seen.add(size);
    return true;
  }).map(([mnt, size, used, avail]) => ({ yer: mnt, toplam_gb: gb(+size), bos_gb: gb(+avail), doluluk_yuzde: Math.round((+used / +size) * 100) }));
}

function battery() {
  const base = '/sys/class/power_supply/BAT1';
  if (!fs.existsSync(base)) return { hata: 'Pil yok.' };
  const read = (f) => fs.readFileSync(`${base}/${f}`, 'utf8').trim();
  return { yuzde: +read('capacity'), durum: { Charging: 'şarj oluyor', Discharging: 'pilden çalışıyor', Full: 'dolu', 'Not charging': 'şarj olmuyor' }[read('status')] ?? read('status') };
}

export const systemTool = {
  name: 'sistem_durumu',
  summary: 'Bu bilgisayarın donanım durumu: işlemci yükü ve sıcaklığı, ekran kartı (GPU) sıcaklığı/kullanımı, RAM, disk doluluğu, pil. "Bilgisayar ısındı mı?", "Disk dolu mu?"',
  mutates: false,
  declaration: {
    name: 'sistem_durumu',
    description: 'Bilgisayarın CPU, GPU, bellek, disk ve pil durumunu döndürür.',
    parameters: {
      type: 'OBJECT',
      properties: { bilesen: { type: 'STRING', enum: ['ozet', 'cpu', 'gpu', 'bellek', 'disk', 'pil'], description: 'ozet: hepsi kısaca.' } },
      required: [],
    },
  },
  async run({ bilesen = 'ozet' }) {
    const parts = { cpu, gpu, bellek: memory, disk, pil: battery };
    if (bilesen !== 'ozet') return parts[bilesen] ? { [bilesen]: await parts[bilesen]() } : { hata: `Bilinmeyen bileşen: ${bilesen}` };
    const entries = await Promise.all(Object.entries(parts).map(async ([k, f]) => [k, await f()]));
    return { ...Object.fromEntries(entries), calisma_suresi_saat: +(os.uptime() / 3600).toFixed(1) };
  },
};
