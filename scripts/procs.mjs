// chatgpt-web · 尽力而为地读取"正在运行的 Chromium 系浏览器"的启动参数
//
// 两个用途（都来自实测坑）：
//   1) 确认 CDP 端口后面的实例，用的确实是配置里绑定的那个 profile ——
//      否则会出现"连上了别的 Chrome、读到的是别人的会话"这种看起来成功的错误；
//   2) 发现"目标 profile 正被普通 Chrome 占用、但没开调试端口" ——
//      此时再启动一个 chrome.exe 只会把请求交给已有实例，永远等不到 CDP。
//
// 拿不到进程信息时返回 supported:false：**如实回答"无法验证"，绝不假装验证通过**。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BROWSER_RE = /(chrome|chromium|msedge|brave)\.exe\b|(google-chrome|chromium|microsoft-edge|brave-browser)\b/i;

function flagValue(cmd, name) {
  const re = new RegExp(`--${name}=(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'i');
  const m = cmd.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

export function parseCmdline(cmd) {
  return {
    commandLine: cmd,
    userDataDir: flagValue(cmd, 'user-data-dir'),
    profileDirectory: flagValue(cmd, 'profile-directory'),
    cdpPort: Number(flagValue(cmd, 'remote-debugging-port')) || null,
    child: /--type=/.test(cmd),
  };
}

function commandLines() {
  try {
    if (process.platform === 'linux') {
      return fs.readdirSync('/proc')
        .filter((d) => /^\d+$/.test(d))
        .map((pid) => {
          try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { return ''; }
        })
        .filter(Boolean);
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-Ao', 'command='], { encoding: 'utf8', timeout: 8000 })
        .split('\n').map((s) => s.trim()).filter(Boolean);
    }
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='chromium.exe' or Name='msedge.exe' or Name='brave.exe'\" | ForEach-Object { $_.CommandLine }";
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 15000 })
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  } catch { /* 拿不到 → 交给调用方按"无法验证"处理 */ }
  return null;
}

let cache = null;
let cacheAt = 0;
export function scanBrowserProcesses({ cacheMs = 2000 } = {}) {
  if (cache && Date.now() - cacheAt < cacheMs) return cache;
  const lines = commandLines();
  if (!lines) {
    cache = { supported: false, entries: [] };
    cacheAt = Date.now();
    return cache;
  }
  cache = { supported: true, entries: lines.filter((c) => BROWSER_RE.test(c)).map(parseCmdline) };
  cacheAt = Date.now();
  return cache;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p).replace(/^"|"$/g, '')).replace(/[\\/]+$/, '');
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// 谁在监听这个 CDP 端口：优先信主进程（子进程也会带 --user-data-dir，但参数不完整）
export function findCdpInstance(entries, port) {
  const hits = entries.filter((e) => e.cdpPort === Number(port));
  return hits.find((e) => !e.child) || hits[0] || null;
}

// 谁占用了这个 user-data-dir（可选按 profile-directory 精确匹配）
export function findProfileUser(entries, userDataDir, { profileDirectory = null } = {}) {
  const hits = entries.filter((e) => samePath(e.userDataDir, userDataDir));
  if (!hits.length) return null;
  if (profileDirectory) {
    const want = String(profileDirectory).toLowerCase();
    const exact = hits.find((e) => (e.profileDirectory || 'Default').toLowerCase() === want);
    if (exact) return exact;
  }
  return hits.find((e) => !e.child) || hits[0];
}
