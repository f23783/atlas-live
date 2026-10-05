const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atlas', {
  start: () => ipcRenderer.invoke('live:start'),
  stop: () => ipcRenderer.invoke('live:stop'),
  info: () => ipcRenderer.invoke('live:info'),
  sendText: (text) => ipcRenderer.invoke('live:text', text),
  sendAudio: (pcm16) => ipcRenderer.send('live:audio', pcm16),
  endAudio: () => ipcRenderer.send('live:audio-end'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  setDryRun: (on) => ipcRenderer.invoke('live:dry-run', on),
  setLabOpen: (open) => ipcRenderer.invoke('ui:lab', open),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  previewVoice: (voice, model) => ipcRenderer.invoke('settings:preview', voice, model),
  onEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('live:event', h);
    return () => ipcRenderer.removeListener('live:event', h);
  },
});
