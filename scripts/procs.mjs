// chatgpt-web · 尽力而为地读取"正在运行的 Chromium 系浏览器"的启动参数
//
// 两个用途（都来自实测坑）：
//   1) 确认 CDP 端口后面的实例，用的确实是配置里绑定的那个 profile ——
//      否则会出现"连上了别的 Chrome、读到的是别人的会话"这种看起来成功的错误；
//   2) 发现"目标 profile 正被普通 Chrome 占用、但没开调试端口" ——
//      此时再启动一个 chrome.exe 只会把请求交给已有实例，永远等不到 CDP。
//
// 拿不到进程信息时返回 supported:false：**如实回答"无法验证"，绝不假装验证通过**。
//
// V2（2026-10-16）：在 read-only 的扫描之上补齐"可安全终止"所需的身份信息。
//   每条 entry 现在是完整指纹 = pid + startId(进程创建时间) + commandLine。
//   只靠 PID 判断会在 PID 复用后误杀别人的进程；三个字段一起比对才有意义。
//   同时 parseCmdline 新增「--flag value」空格分隔形式的解析（Chrome 的
//   --profile-directory "Profile 1" 就是这种写法，旧正则只认 `=`）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BROWSER_EXE_RE =
  /(?:^|[\\/])(chrome|chromium|msedge|brave)(?:\.exe)?(?=[\s"\x27]|$)/i;

const BROWSER_UNIX_RE =
  /(?:^|[\\/])(google-chrome(?:-stable)?|chromium(?:-browser)?|microsoft-edge|brave-browser|Google Chrome)(?=[\s"\x27]|$)/i;

const CHILD_RE = /(?:^|\s)--type(?:=|\s)/i;

function unquote(v) {
  return String(v ?? '')
    .trim()
    .replace(
      /^(?:"([\s\S]*)"|'([\s\S]*)')$/,
      (_, a, b) => a ?? b
    );
}

function flagValue(cmd, name) {
  // 支持 --flag=value、--flag="a b"、--flag "a b"
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const rx = new RegExp(
    `(?:^|\\s)--${escaped}(?:=(?:"([^"]*)"|'([^']*)'|([^\\s]+))|\\s+(?:"([^"]*)"|'([^']*)'|([^\\s]+)))`,
    'i'
  );

  const m = String(cmd).match(rx);

  return m
    ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? null)
    : null;
}

export function parseCmdline(
  commandLine,
  {
    pid = null,
    startId = null,
    executablePath = null
  } = {}
) {
  const rawPort = flagValue(
    commandLine,
    'remote-debugging-port'
  );

  const port =
    rawPort !== null && /^\d+$/.test(rawPort)
      ? Number(rawPort)
      : null;

  return {
    pid:
      Number.isSafeInteger(Number(pid)) && Number(pid) > 0
        ? Number(pid)
        : null,

    startId: startId ? String(startId) : null,

    executablePath: executablePath || null,

    commandLine: String(commandLine || ''),

    userDataDir: flagValue(
      commandLine,
      'user-data-dir'
    ),

    profileDirectory: flagValue(
      commandLine,
      'profile-directory'
    ),

    cdpPort: port && port <= 65535 ? port : null,

    child: CHILD_RE.test(commandLine)
  };
}

function isBrowser(cmd) {
  return (
    BROWSER_EXE_RE.test(cmd) ||
    BROWSER_UNIX_RE.test(cmd)
  );
}

function canonical(p) {
  if (!p || typeof p !== 'string') return null;

  const value = unquote(p);

  try {
    const resolved = fs.realpathSync.native(value);

    return process.platform === 'win32'
      ? path.win32
          .normalize(resolved)
          .replace(/[\\/]+$/, '')
          .toLowerCase()
      : path.posix
          .normalize(resolved)
          .replace(/\/+$/, '');

  } catch {
    if (
      process.platform === 'win32' ||
      /^[a-z]:[\\/]/i.test(value)
    ) {
      return path.win32
        .normalize(value)
        .replace(/[\\/]+$/, '')
        .toLowerCase();
    }

    return path.resolve(value).replace(/\/+$/, '');
  }
}

// 比较两个路径是否指向同一目录
export function samePath(a, b) {
  const x = canonical(a);
  const y = canonical(b);

  return !!x && !!y && x === y;
}

// Windows：CIM 优先，WMI 作为降级
function windowsScan() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$filter = "Name='chrome.exe' OR Name='chromium.exe' OR Name='msedge.exe' OR Name='brave.exe'"

try {
  $items = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)
  $provider = 'CIM'
} catch {
  try {
    $items = @(Get-WmiObject Win32_Process -Filter $filter -ErrorAction Stop)
    $provider = 'WMI'
  } catch {
    throw "CIM_AND_WMI_FAILED: $($_.Exception.Message)"
  }
}

$rows = @($items | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    commandLine = [string]$_.CommandLine
    executablePath = [string]$_.ExecutablePath
    startId = $(
      if ($_.CreationDate) {
        if ($_.CreationDate -is [string]) {
          [Management.ManagementDateTimeConverter]::ToDateTime(
            $_.CreationDate
          ).ToString('o')
        } else {
          ([datetime]$_.CreationDate).ToString('o')
        }
      } else {
        $null
      }
    )
  }
})

[pscustomobject]@{
  provider = $provider
  entries = $rows
} | ConvertTo-Json -Depth 5 -Compress
`;

  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      }
    );

    const result = JSON.parse(output.trim());

    const raw = Array.isArray(result.entries)
      ? result.entries
      : result.entries
        ? [result.entries]
        : [];

    const missing = raw.filter(
      r => !r.commandLine || !r.startId
    );

    if (missing.length) {
      return {
        supported: false,
        entries: [],
        reason: 'PROCESS_METADATA_INCOMPLETE',
        provider: result.provider,
        // 便于诊断：到底漏了几条、为什么（不泄露路径/命令行）
        missingCount: missing.length,
        totalCount: raw.length
      };
    }

    return {
      supported: true,
      provider: result.provider,
      entries: raw
        .map(r => parseCmdline(r.commandLine, r))
        .filter(e => isBrowser(e.commandLine))
    };

  } catch (e) {
    return {
      supported: false,
      entries: [],
      reason: 'PROCESS_SCAN_UNAVAILABLE',
      detail: e.message
    };
  }
}

// Linux：读取进程启动时间，防止只靠 PID 判断
function linuxStartId(pid) {
  const stat = fs.readFileSync(
    `/proc/${pid}/stat`,
    'utf8'
  );

  const close = stat.lastIndexOf(')');

  if (close === -1) {
    throw new Error('malformed proc stat');
  }

  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);

  // /proc/<pid>/stat 第 22 字段：starttime
  return fields[19] || null;
}

function linuxScan() {
  const entries = [];

  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;

      let comm;

      try {
        comm = fs
          .readFileSync(`/proc/${name}/comm`, 'utf8')
          .trim();
      } catch (e) {
        if (
          e.code === 'ENOENT' ||
          e.code === 'ESRCH'
        ) continue;

        return {
          supported: false,
          entries: [],
          reason: 'PROCESS_SCAN_UNAVAILABLE'
        };
      }

      if (
        !/^(chrome|chromium|msedge|brave|google-chrome|microsoft-edge|brave-browser)$/.test(comm)
      ) continue;

      try {
        const raw = fs.readFileSync(
          `/proc/${name}/cmdline`,
          'utf8'
        );

        if (!raw) continue;

        const argv = raw.split('\0').filter(Boolean);

        const commandLine = argv
          .map(a => /\s/.test(a) ? JSON.stringify(a) : a)
          .join(' ');

        const startId = linuxStartId(name);

        if (!startId) {
          return {
            supported: false,
            entries: [],
            reason: 'PROCESS_METADATA_INCOMPLETE'
          };
        }

        entries.push(
          parseCmdline(commandLine, {
            pid: Number(name),
            startId,
            executablePath: argv[0]
          })
        );

      } catch (e) {
        if (
          e.code === 'ENOENT' ||
          e.code === 'ESRCH'
        ) continue;

        return {
          supported: false,
          entries: [],
          reason: 'PROCESS_METADATA_INCOMPLETE',
          detail: e.message
        };
      }
    }

    return {
      supported: true,
      provider: 'procfs',
      entries
    };

  } catch (e) {
    return {
      supported: false,
      entries: [],
      reason: 'PROCESS_SCAN_UNAVAILABLE',
      detail: e.message
    };
  }
}

// macOS：通过 ps 读取 PID、启动时间及命令行
function darwinScan() {
  try {
    const out = execFileSync(
      'ps',
      ['-ww', '-axo', 'pid=,lstart=,command='],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024
      }
    );

    const entries = [];

    for (const line of out.split(/\r?\n/)) {
      const match = line.match(
        /^\s*(\d+)\s+(.{24})\s+(.+)$/
      );

      if (!match || !isBrowser(match[3])) continue;

      entries.push(
        parseCmdline(match[3], {
          pid: Number(match[1]),
          startId: match[2].trim()
        })
      );
    }

    return {
      supported: true,
      provider: 'ps',
      entries
    };

  } catch (e) {
    return {
      supported: false,
      entries: [],
      reason: 'PROCESS_SCAN_UNAVAILABLE',
      detail: e.message
    };
  }
}

function rawScan() {
  if (process.platform === 'win32') {
    return windowsScan();
  }

  if (process.platform === 'linux') {
    return linuxScan();
  }

  if (process.platform === 'darwin') {
    return darwinScan();
  }

  return {
    supported: false,
    entries: [],
    reason: 'UNSUPPORTED_PLATFORM'
  };
}

// 同步小睡（不引入异步，扫描接口保持同步签名）
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* 极少数环境不支持就退化成忙等极小量 */ }
}

// 扫描缓存（沿用旧实现的经验值 2000ms）：
// 单条命令里 checkCdpProfile / launchChrome / doctor 会连着问好几次，
// PowerShell 冷启一次 1-3s，不缓存的话每次都白等。
//
// ⚠️ 生命周期判定（启动竞态、终止前二次校验）**必须绕过缓存**：
// 那些地方传 { cacheMs: 0 }，否则会看到 2 秒前的旧进程表而误判。
//
// ★ 2026-10-16 实测：`Get-CimInstance` 会**间歇性**失败（本机在密集轮询、
//   多浏览器实例并存时抓到过）。原实现把"一次抖动"直接升级成 supported:false，
//   于是 ensure / status / stop 会随机报 PROCESS_SCAN_UNAVAILABLE —— 表现是
//   "同一条命令一会儿能过一会儿不能过"，极难排查。
//   ⇒ 这里改为**重试**（最多 attempts 次，短退避）。保持 fail-closed 语义不变
//   （重试都失败仍然如实返回不可用），只是不再被单次抖动打倒。
let cache = null;
let cacheAt = 0;

export function scanBrowserProcesses({ cacheMs = 2000, attempts = 3 } = {}) {
  if (cache && cacheMs > 0 && Date.now() - cacheAt < cacheMs) {
    return cache;
  }

  let result = rawScan();

  for (let i = 1; i < Math.max(1, attempts) && !result.supported; i++) {
    sleepSync(120 * i);
    result = rawScan();
  }

  cache = result;
  cacheAt = Date.now();

  return result;
}

// 根据端口找到对应的主浏览器进程
export function findCdpInstance(entries, port) {
  return (
    entries.find(
      e => !e.child && e.cdpPort === Number(port)
    ) || null
  );
}

// 根据 user-data-dir 找到使用该目录的浏览器
export function findProfileUser(
  entries,
  userDataDir,
  { profileDirectory = null } = {}
) {
  const hits = entries.filter(
    e =>
      !e.child &&
      samePath(e.userDataDir, userDataDir)
  );

  if (!hits.length) return null;

  if (profileDirectory) {
    const exact = hits.find(
      e =>
        (
          e.profileDirectory || 'Default'
        ).toLowerCase() ===
        String(profileDirectory).toLowerCase()
    );

    if (exact) return exact;
  }

  return hits[0];
}

// 精确按 PID 查询，供终止操作二次校验
export function getProcessByPid(pid) {
  const scan = scanBrowserProcesses({ cacheMs: 0 });

  if (!scan.supported) {
    return {
      supported: false,
      entry: null,
      reason: scan.reason
    };
  }

  return {
    supported: true,
    entry:
      scan.entries.find(
        e => e.pid === Number(pid) && !e.child
      ) || null
  };
}
