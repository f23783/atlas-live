const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atlas', {
  start: () => ipcRenderer.invoke('live:start'),
  stop: () => ipcRenderer.invoke('live:stop'),
  sendText: (text) => ipcRenderer.invoke('live:text', text),
  sendAudio: (pcm16) => ipcRenderer.send('live:audio', pcm16),
  endAudio: () => ipcRenderer.send('live:audio-end'),
  onEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('live:event', h);
    return () => ipcRenderer.removeListener('live:event', h);
  },
});
