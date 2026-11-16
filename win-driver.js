'use strict';
// Windows sürücü teşhisi ve (gerekirse) otomatik WinUSB kurulumu.
// Kurulum, Zadig/libwdi'nin yaptığının aynısıdır: Windows'un kendi winusb.sys sürücüsü için bir INF,
// dpscat.exe ile kendinden imzalı katalog, ardından pnputil ile kurulum. Tek bir yönetici (UAC) onayı ister.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ps(script, timeout = 20000) {
  return new Promise((res) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => res({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// Takılı OWON cihazlarını ve sürücü durumlarını döndürür.
async function diagnose() {
  if (process.platform !== 'win32') return { platform: process.platform, devices: [] };
  const script = `
$ErrorActionPreference='SilentlyContinue'
$list = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB\\VID_5345&PID_1234*' })
$out = foreach ($d in $list) { [pscustomobject]@{ Id=$d.PNPDeviceID; Name=$d.Name; Status=$d.Status; Error=$d.ConfigManagerErrorCode; Service=$d.Service; Class=$d.PNPClass; Present=$d.Present } }
if ($out) { ConvertTo-Json -Compress -InputObject @($out) } else { '[]' }`;
  const r = await ps(script);
  let devices = [];
  try { devices = JSON.parse(r.stdout.trim() || '[]'); if (!Array.isArray(devices)) devices = [devices]; } catch { }
  return { platform: 'win32', devices, raw: r.stderr.slice(0, 400) };
}

const INF = `; OWON HDS - WinUSB surucu paketi (OWON HDS Panel tarafindan olusturuldu)
[Version]
Signature   = "$Windows NT$"
Class       = USBDevice
ClassGUID   = {88BAE032-5A81-49f0-BC3D-A4FF138216D6}
Provider    = %ProviderName%
CatalogFile = owon_hds_winusb.cat
DriverVer   = 11/16/2026,1.0.0.0

[Manufacturer]
%ProviderName% = OwonDevices,NTamd64,NTarm64,NTx86

[OwonDevices.NTamd64]
%DeviceName% = USB_Install, USB\\VID_5345&PID_1234

[OwonDevices.NTarm64]
%DeviceName% = USB_Install, USB\\VID_5345&PID_1234

[OwonDevices.NTx86]
%DeviceName% = USB_Install, USB\\VID_5345&PID_1234

[USB_Install]
Include = winusb.inf
Needs   = WINUSB.NT

[USB_Install.Services]
Include = winusb.inf
Needs   = WINUSB.NT.Services

[USB_Install.HW]
AddReg = Dev_AddReg

[Dev_AddReg]
HKR,,DeviceInterfaceGUIDs,0x10000,"{6B9B4A70-3C35-4E1C-9A3F-5B0D2C6E8A11}"

[Strings]
ProviderName = "OWON HDS Panel"
DeviceName   = "OWON HDS Oscilloscope (WinUSB)"
`;

// Sürücüyü kurar. Yönetici onayı penceresi açılır. {ok, code, log}
async function installWinUsb(resBase) {
  if (process.platform !== 'win32') return { ok: false, log: 'Yalnızca Windows' };
  const dir = path.join(os.tmpdir(), 'owon-hds-driver-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owon_hds_winusb.inf'), INF.replace(/\n/g, '\r\n'), 'ascii');
  fs.copyFileSync(path.join(resBase, 'win-x64', 'dpscat.exe'), path.join(dir, 'dpscat.exe'));
  const ps1 = path.join(dir, 'install.ps1');
  fs.writeFileSync(ps1, [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`,
    `& .\\dpscat.exe /PATH . *> dpscat.log`,
    `"DPSCAT=$LASTEXITCODE" | Out-File result.txt -Encoding ascii`,
    `$o = & pnputil.exe /add-driver owon_hds_winusb.inf /install 2>&1`,
    `$o | Out-File pnputil.log -Encoding utf8`,
    `"PNPUTIL=$LASTEXITCODE" | Out-File result.txt -Append -Encoding ascii`,
    `& pnputil.exe /scan-devices 2>&1 | Out-Null`,
  ].join('\r\n'), 'utf8');
  const launch = `try { Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${ps1.replace(/'/g, "''")}"'); 'STARTED' } catch { 'CANCELLED: ' + $_.Exception.Message }`;
  const r = await ps(launch, 180000);
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''); } catch { return ''; } };
  const result = read('result.txt');
  const log = [r.stdout.trim(), result.trim(), read('dpscat.log').trim().slice(-1500), read('pnputil.log').trim().slice(-1500)].filter(Boolean).join('\n---\n');
  if (/CANCELLED/.test(r.stdout)) return { ok: false, cancelled: true, log };
  const m = result.match(/PNPUTIL=(-?\d+)/);
  const code = m ? +m[1] : null;
  // 0: başarılı, 3010: yeniden başlatma gerekebilir, 259: paket eklendi ama cihaz güncellenmedi
  return { ok: code === 0 || code === 3010, code, reboot: code === 3010, log, dir };
}

module.exports = { diagnose, installWinUsb };
