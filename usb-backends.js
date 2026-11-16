'use strict';
// OWON HDS USB arka uçları.
//  - Windows: libusbK.dll (paketle gelir) → Owon'un libusb0 sürücüsü, libusbK sürücüsü ve WinUSB ile çalışır.
//  - Diğer / yedek: node-usb (libusb-1.0).
// Her arka uç aynı arabirimi sunar: readChunk(len, ms) → Buffer, write(buf, ms), close(), info.

const path = require('path');
const VID = 0x5345, PID = 0x1234;

/* ------------------------------------------------------------------ */
/* libusbK                                                              */
/* ------------------------------------------------------------------ */
let K = null; // tembel yükleme
function loadLibusbK(dllPath) {
  if (K) return K;
  const koffi = require('koffi');
  const lib = koffi.load(dllPath);
  // BOOL = int (4 bayt)
  K = {
    koffi,
    LstK_Init: lib.func('int LstK_Init(_Out_ void** list, int flags)'),
    LstK_FindByVidPid: lib.func('int LstK_FindByVidPid(void* list, int vid, int pid, _Out_ void** info)'),
    LstK_Free: lib.func('int LstK_Free(void* list)'),
    LibK_LoadDriverAPI: lib.func('int LibK_LoadDriverAPI(_Out_ uint8_t* api, int driverId)'),
    PipeInfo: koffi.struct('OWON_WINUSB_PIPE_INFORMATION', { PipeType: 'int', PipeId: 'uint8', MaximumPacketSize: 'uint16', Interval: 'uint8' }),
  };
  K.P = {
    Init: koffi.proto('int OWON_KUSB_Init(_Out_ void** h, void* devInfo)'),
    Free: koffi.proto('int OWON_KUSB_Free(void* h)'),
    Claim: koffi.proto('int OWON_KUSB_ClaimInterface(void* h, uint8_t num, int isIndex)'),
    Release: koffi.proto('int OWON_KUSB_ReleaseInterface(void* h, uint8_t num, int isIndex)'),
    SetCfg: koffi.proto('int OWON_KUSB_SetConfiguration(void* h, uint8_t cfg)'),
    QueryPipe: koffi.proto('int OWON_KUSB_QueryPipe(void* h, uint8_t alt, uint8_t idx, _Out_ OWON_WINUSB_PIPE_INFORMATION* info)'),
    SetPolicy: koffi.proto('int OWON_KUSB_SetPipePolicy(void* h, uint8_t pipe, uint32_t type, uint32_t len, uint8_t* value)'),
    Read: koffi.proto('int OWON_KUSB_ReadPipe(void* h, uint8_t pipe, _Out_ uint8_t* buf, uint32_t len, _Out_ uint32_t* got, void* ovl)'),
    Write: koffi.proto('int OWON_KUSB_WritePipe(void* h, uint8_t pipe, uint8_t* buf, uint32_t len, _Out_ uint32_t* got, void* ovl)'),
    Reset: koffi.proto('int OWON_KUSB_ResetPipe(void* h, uint8_t pipe)'),
    Abort: koffi.proto('int OWON_KUSB_AbortPipe(void* h, uint8_t pipe)'),
  };
  return K;
}
// KUSB_DRIVER_API içindeki fonksiyon işaretçisi sırası (libusbk.h)
const FN = { Init: 0, Free: 1, Claim: 2, Release: 3, SetCfg: 10, QueryPipe: 21, SetPolicy: 22, Read: 24, Write: 25, Reset: 26, Abort: 27 };
const DRIVER_NAMES = ['libusbK', 'libusb0 (libusb-win32)', 'WinUSB', 'libusb0 filtre'];
const PIPE_TRANSFER_TIMEOUT = 3;
// KLST_DEVINFO alan ofsetleri (KLST_STRING_MAX_LEN = 256)
const OFF = { DriverID: 268, DeviceDesc: 1296, Service: 1552, Connected: 2324 };

function libusbKProbe(dllPath) {
  // Cihaz listede var mı (açmadan)? {found, driver}
  const k = loadLibusbK(dllPath);
  const list = [null];
  if (!k.LstK_Init(list, 0)) return { found: false };
  try {
    const info = [null];
    if (!k.LstK_FindByVidPid(list[0], VID, PID, info) || !info[0]) return { found: false };
    const drv = k.koffi.decode(info[0], OFF.DriverID, 'int');
    const connected = k.koffi.decode(info[0], OFF.Connected, 'int');
    return { found: true, connected: !!connected, driverId: drv, driver: DRIVER_NAMES[drv] || ('#' + drv) };
  } finally { k.LstK_Free(list[0]); }
}

async function openLibusbK(dllPath) {
  const k = loadLibusbK(dllPath), koffi = k.koffi;
  const list = [null];
  if (!k.LstK_Init(list, 0)) throw new Error('libusbK cihaz listesi alınamadı');
  const info = [null];
  if (!k.LstK_FindByVidPid(list[0], VID, PID, info) || !info[0]) { k.LstK_Free(list[0]); return null; }
  const driverId = koffi.decode(info[0], OFF.DriverID, 'int');
  const api = Buffer.alloc(512);
  if (!k.LibK_LoadDriverAPI(api, driverId)) { k.LstK_Free(list[0]); throw new Error('Sürücü API yüklenemedi (DriverID ' + driverId + ')'); }
  const fn = {};
  for (const [name, idx] of Object.entries(FN)) {
    const p = koffi.decode(api, 8 + 8 * idx, 'void*');
    fn[name] = p ? koffi.decode(p, k.P[name]) : null;
  }
  const h = [null];
  if (!fn.Init(h, info[0]) || !h[0]) {
    k.LstK_Free(list[0]);
    throw new Error('Cihaz açılamadı. Owon\'un kendi programı açıksa kapatıp tekrar deneyin.');
  }
  const H = h[0];
  try { fn.SetCfg && fn.SetCfg(H, 1); } catch {}
  try { fn.Claim && fn.Claim(H, 0, 0); } catch {}
  // uç noktaları bul
  let pipeIn = 0x81, pipeOut = 0x01, pkt = 64;
  try {
    for (let i = 0; i < 8; i++) {
      const pi = {};
      if (!fn.QueryPipe(H, 0, i, pi)) break;
      if (pi.PipeType === 2) { // bulk
        if (pi.PipeId & 0x80) { pipeIn = pi.PipeId; pkt = pi.MaximumPacketSize || 64; } else pipeOut = pi.PipeId;
      }
    }
  } catch {}
  let curTimeout = { in: -1, out: -1 };
  const setTimeoutFor = (pipe, key, ms) => {
    if (curTimeout[key] === ms) return;
    const v = Buffer.alloc(4); v.writeUInt32LE(ms);
    try { fn.SetPolicy(H, pipe, PIPE_TRANSFER_TIMEOUT, 4, v); } catch {}
    curTimeout[key] = ms;
  };
  const call = (f, ...args) => new Promise((res, rej) => f.async(...args, (e, r) => e ? rej(e) : res(r)));
  let closed = false;
  return {
    kind: 'libusbK',
    info: { backend: 'libusbK', driver: DRIVER_NAMES[driverId] || ('#' + driverId), pipeIn, pipeOut, packetSize: pkt },
    packetSize: pkt,
    async write(buf, ms = 1000) {
      if (closed) throw new Error('kapalı');
      setTimeoutFor(pipeOut, 'out', ms);
      const got = [0];
      const ok = await call(fn.Write, H, pipeOut, buf, buf.length, got, null);
      if (!ok) { try { fn.Reset(H, pipeOut); } catch {} throw new Error('USB yazma başarısız'); }
    },
    async readChunk(len, ms) {
      if (closed) throw new Error('kapalı');
      setTimeoutFor(pipeIn, 'in', ms);
      const buf = Buffer.alloc(len), got = [0];
      const ok = await call(fn.Read, H, pipeIn, buf, len, got, null);
      if (!ok && !got[0]) { const e = new Error('Zaman aşımı (yanıt gelmedi)'); e.timeout = true; throw e; }
      return buf.subarray(0, got[0]);
    },
    close() {
      if (closed) return; closed = true;
      try { fn.Abort && fn.Abort(H, pipeIn); } catch {}
      try { fn.Release && fn.Release(H, 0, 0); } catch {}
      try { fn.Free(H); } catch {}
      try { k.LstK_Free(list[0]); } catch {}
    },
  };
}

/* ------------------------------------------------------------------ */
/* node-usb (libusb-1.0)                                                */
/* ------------------------------------------------------------------ */
async function openNodeUsb() {
  let usbmod;
  try { usbmod = require('usb'); } catch (e) { throw new Error('node-usb yüklenemedi: ' + e.message); }
  const dev = usbmod.findByIds(VID, PID);
  if (!dev) return null;
  dev.open();
  const iface = dev.interface(0);
  try { if (process.platform === 'linux' && iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch {}
  iface.claim();
  const BULK = usbmod.usb.LIBUSB_TRANSFER_TYPE_BULK;
  const epIn = iface.endpoints.find(e => e.direction === 'in' && e.transferType === BULK);
  const epOut = iface.endpoints.find(e => e.direction === 'out' && e.transferType === BULK);
  if (!epIn || !epOut) { try { iface.release(true, () => dev.close()); } catch {} throw new Error('Bulk uç noktası bulunamadı'); }
  const pkt = epIn.descriptor.wMaxPacketSize || 64;
  let closed = false;
  return {
    kind: 'node-usb',
    info: { backend: 'libusb-1.0 (node-usb)', driver: process.platform === 'win32' ? 'WinUSB' : 'sistem', pipeIn: epIn.address, pipeOut: epOut.address, packetSize: pkt },
    packetSize: pkt,
    write(buf, ms = 1000) {
      return new Promise((res, rej) => { epOut.timeout = ms; epOut.transfer(buf, e => e ? rej(new Error('USB yazma: ' + e.message)) : res()); });
    },
    readChunk(len, ms) {
      return new Promise((res, rej) => {
        epIn.timeout = ms;
        epIn.transfer(len, (e, data) => {
          if (e) { const er = new Error(e.errno === usbmod.usb.LIBUSB_ERROR_TIMEOUT ? 'Zaman aşımı (yanıt gelmedi)' : 'USB okuma: ' + e.message); er.timeout = e.errno === usbmod.usb.LIBUSB_ERROR_TIMEOUT; rej(er); }
          else res(Buffer.from(data));
        });
      });
    },
    close() {
      if (closed) return; closed = true;
      try { iface.release(true, () => { try { dev.close(); } catch {} }); } catch { try { dev.close(); } catch {} }
    },
  };
}
function nodeUsbProbe() {
  try { const usbmod = require('usb'); return { found: !!usbmod.findByIds(VID, PID) }; } catch { return { found: false }; }
}

/* ------------------------------------------------------------------ */
/* Oturum: SCPI sorgu/yanıt mantığı (tek sıra, paket boyutunda okuma)    */
/* ------------------------------------------------------------------ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Session {
  constructor(dev) { this.dev = dev; this.q = Promise.resolve(); this.lastWrite = 0; this.dirty = false; this.fail = 0; }
  lock(fn) { const p = this.q.then(fn, fn); this.q = p.catch(() => {}); return p; }
  async _drain() {
    if (!this.dirty) return;
    // önceki zaman aşımından kalan geç yanıtları at
    for (let i = 0; i < 20; i++) {
      try { const b = await this.dev.readChunk(this.dev.packetSize * 64, 15); if (!b.length) break; } catch { break; }
    }
    this.dirty = false;
  }
  async _write(cmd) {
    const gap = 10 - (Date.now() - this.lastWrite);
    if (gap > 0) await sleep(gap);
    await this.dev.write(Buffer.from(cmd, 'latin1'));
    this.lastWrite = Date.now();
  }
  async _read(len, ms) {
    try { return await this.dev.readChunk(len, ms); }
    catch (e) { if (e.timeout) this.dirty = true; throw e; }
  }
  send(cmd) { return this.lock(async () => { await this._drain(); await this._write(cmd); }); }
  query(cmd, binary, timeout = 1500) {
    return this.lock(async () => {
      await this._drain();
      await this._write(cmd);
      const P = this.dev.packetSize;
      let buf = await this._read(P, timeout);
      let done = false;
      if (binary && buf.length >= 4) {
        const L = buf.readUInt32LE(0);
        if (L > 0 && L < 2e6) {
          while (buf.length < 4 + L) {
            const rem = 4 + L - buf.length;
            buf = Buffer.concat([buf, await this._read(Math.ceil(rem / P) * P, timeout)]);
          }
          done = true;
        }
      }
      while (!done && buf.length > 0 && buf.length % P === 0) {
        let more;
        try { more = await this.dev.readChunk(P, 60); } catch { break; }
        buf = Buffer.concat([buf, more]);
        if (more.length < P) break;
      }
      return binary ? new Uint8Array(buf) : buf.toString('latin1').replace(/\0/g, '').trim();
    });
  }
  close() { try { this.dev.close(); } catch {} }
}

/* ------------------------------------------------------------------ */
/* Dışa açılan yardımcılar                                              */
/* ------------------------------------------------------------------ */
function libusbKPath(resBase) { return path.join(resBase, 'win-x64', 'libusbK.dll'); }

async function openAny(resBase, log = () => {}) {
  const errors = [];
  if (process.platform === 'win32') {
    try {
      const d = await openLibusbK(libusbKPath(resBase));
      if (d) return new Session(d);
      errors.push('libusbK: cihaz sürücülü olarak bulunamadı');
    } catch (e) { errors.push('libusbK: ' + e.message); log('libusbK hata: ' + e.message); }
  }
  try {
    const d = await openNodeUsb();
    if (d) return new Session(d);
    errors.push('libusb-1.0: cihaz bulunamadı');
  } catch (e) { errors.push('libusb-1.0: ' + e.message); }
  const err = new Error(errors.join(' | '));
  err.notFound = true;
  throw err;
}
function probeAny(resBase) {
  if (process.platform === 'win32') {
    try { return libusbKProbe(libusbKPath(resBase)); } catch {}
  }
  return nodeUsbProbe();
}

module.exports = { openAny, probeAny, VID, PID };
