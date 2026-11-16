'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { openAny, probeAny } = require('./usb-backends');
const winDriver = require('./win-driver');

// Paketli uygulamada yerel dosyalar resources/native altında
const RES = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, 'native');

let win = null;
let session = null;
let watchTimer = null;
let lastPresent = null;

function log(...a) { try { win?.webContents.send('native:log', a.join(' ')); } catch {} }

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1000, minHeight: 640,
    backgroundColor: '#0c1016',
    title: 'OWON HDS Panel',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F5') win.webContents.reload();
  });
  win.on('closed', () => { win = null; });
  startWatch();
}

// Bağlı değilken cihaz takıldı mı diye yokla
function startWatch() {
  clearInterval(watchTimer);
  watchTimer = setInterval(() => {
    if (session || !win) return;
    let r = { found: false };
    try { r = probeAny(RES); } catch {}
    const key = JSON.stringify(r);
    if (key !== lastPresent) { lastPresent = key; win.webContents.send('native:present', r); }
  }, 1500);
}

ipcMain.handle('usb:open', async () => {
  if (session) { try { session.close(); } catch {} session = null; }
  try {
    session = await openAny(RES, log);
    lastPresent = null;
    return { ok: true, info: session.dev.info };
  } catch (e) {
    session = null;
    let diag = null;
    try { diag = await winDriver.diagnose(); } catch {}
    return { ok: false, error: e.message, notFound: !!e.notFound, diag };
  }
});
ipcMain.handle('usb:close', async () => { if (session) { session.close(); session = null; } lastPresent = null; return true; });
ipcMain.handle('usb:send', async (_e, cmd) => {
  if (!session) throw new Error('Bağlı değil');
  try { await session.send(cmd); session.fail = 0; }
  catch (e) { onIoError(e); throw e; }
});
ipcMain.handle('usb:query', async (_e, cmd, binary, timeout) => {
  if (!session) throw new Error('Bağlı değil');
  try { const r = await session.query(cmd, !!binary, timeout || 1500); session.fail = 0; return r; }
  catch (e) { onIoError(e); throw e; }
});
function onIoError(e) {
  if (!session) return;
  session.fail = (session.fail || 0) + 1;
  // art arda çok hata ve cihaz artık listede yoksa: çıkarılmış say
  if (session.fail >= 4) {
    let r = { found: true };
    try { r = probeAny(RES); } catch {}
    if (!r.found) { session.close(); session = null; lastPresent = null; win?.webContents.send('native:lost'); }
  }
}
ipcMain.handle('drv:diagnose', async () => winDriver.diagnose());
ipcMain.handle('drv:install', async () => {
  if (session) { session.close(); session = null; }
  return winDriver.installWinUsb(RES);
});
ipcMain.handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (session) session.close(); app.quit(); });
