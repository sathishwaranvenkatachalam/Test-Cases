import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function checkCdpReachable(cdpUrl: string): Promise<boolean> {
  try {
    const url = new URL('/json/version', cdpUrl).toString();
    await new Promise<void>((resolve, reject) => {
      const req = (url.startsWith('https') ? https : http).get(url, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    return true;
  } catch {
    return false;
  }
}

function findChromeExe(): string | null {
  if (process.platform !== 'win32') {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(mac)) return mac;
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData ? `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` : '',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function launchChromeWithDebugging(port: number): { ok: true } | { ok: false; error: string } {
  const exe = findChromeExe();
  if (!exe) {
    return { ok: false, error: 'Chrome executable not found. Install Google Chrome or set the path manually.' };
  }
  try {
    // Use a dedicated user-data-dir so a new instance opens even if Chrome is already running.
    const userDataDir = path.join(os.tmpdir(), 'chrome-debug-profile');
    const child = spawn(exe, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
