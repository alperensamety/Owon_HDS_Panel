'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('owonNative', {
  open: () => ipcRenderer.invoke('usb:open'),
  close: () => ipcRenderer.invoke('usb:close'),
  send: (cmd) => ipcRenderer.invoke('usb:send', cmd),
  query: (cmd, binary, timeout) => ipcRenderer.invoke('usb:query', cmd, binary, timeout),
  diagnose: () => ipcRenderer.invoke('drv:diagnose'),
  installDriver: () => ipcRenderer.invoke('drv:install'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onPresent: (cb) => ipcRenderer.on('native:present', (_e, r) => cb(r)),
  onLost: (cb) => ipcRenderer.on('native:lost', () => cb()),
  onLog: (cb) => ipcRenderer.on('native:log', (_e, m) => cb(m)),
});
