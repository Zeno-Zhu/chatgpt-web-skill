// chatgpt-web · 浏览器生命周期（V2）
//
// 设计原则（2026-10-16 因"误杀用户 Chrome"事故而定）：
//   1) 复用优先   CDP 可用且绑定身份匹配 → 直接连，不重复启动。
//   2) 验证优先   端口返回 HTTP 200、netstat 显示 LISTENING，都**不能**单独证明
//                 该浏览器属于绑定的 profile。
//   3) 用户窗口优先保护   发现普通 Chrome 占用绑定 profile → 立刻报明确错误，
//                 由用户决定关不关。**绝不**自动/按进程名批量杀。
//   4) 终止必须独立授权   ensureBrowser() 永不终止浏览器；killBoundInstanceIfAny()
//                 独立存在，且必须过 PID + 创建时间 + 命令行 + 页面 target 四重校验。
//
// ⚠️ 与上游 V1 的差异（本仓库适配，非原始版本）：
//   A) configOf() 走 config.mjs 的 resolveBinding()，读真实 config.json
//      （顶层扁平键 browserPath/userDataDir/profileDirectory + targets.<agent>.cdpPort）。
//      上游版本假设 {CHROME, PROFILE, ...} 大写键，与本机真实配置完全不符。
//   B) preparePage() 在 createPage=false 且没有 GPT 标签页时返回 null 而非抛错 ——
//      status / tabs 这类只读命令不该因为"窗口里没有 GPT 页"而失败。
//      同时保留 2026-09-26 实测的"等已有页面 URL 落定再 newPage"，否则会开出两个 GPT 窗口。
//   C) 所有进程扫描走 { cacheMs: 0 }，避免 2 秒缓存让启动竞态/终止前校验看到旧进程表。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

import {
  scanBrowserProcesses,
  getProcessByPid,
  samePath,
} from './procs.mjs';
import { resolveBinding, readConfig, CONFIG_FILE } from './config.mjs';

const DEFAULT_URL = 'https://chatgpt.com/';

const GPT_URL_RE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/i;

const pause = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const BASE = path.join(os.homedir(), '.chatgpt-web');

// 新鲜扫描：生命周期判定不能用缓存（默认带重试，抗 Get-CimInstance 偶发抖动）
function freshScan({ attempts = 3 } = {}) {
  return scanBrowserProcesses({ cacheMs: 0, attempts });
}

// 读取机器配置。
//
// 优先级：显式 options.* > 环境变量 > config.json > 默认值 —— 与 lib.mjs 完全一致，
// 因为实际解析统一委托给 config.mjs 的 resolveBinding()（单一事实源，永不漂移）。
//
// 真实 config.json 形状（见 ~/.chatgpt-web/BINDING.md）：
//   { "browserPath": "...chrome.exe", "userDataDir": "C:\\ChromeProfiles\\Google2",
//     "profileDirectory": "Default",
//     "targets": { "chatgpt": { ..., "cdpPort": 9444 }, "deepseek": {...} } }
// 注意：顶层**没有** cdpPort —— 端口只写在 targets.<agent> 里。
function configOf(options = {}) {
  const file = options.configFile || CONFIG_FILE;
  const cfg = readConfig(file);

  if (cfg.error) {
    throw new Error(`CONFIG_PARSE_FAILED: ${cfg.error}`);
  }

  const binding = resolveBinding({ file });
  const agent = binding.keys.agent || 'chatgpt';
  const target =
    (cfg.data && cfg.data.targets && cfg.data.targets[agent]) || {};

  const pick = (given, bound, inTarget, fallback) => {
    if (given !== undefined && given !== null && given !== '') return given;
    if (bound !== undefined && bound !== null && bound !== '') return bound;
    if (inTarget !== undefined && inTarget !== null && inTarget !== '') return inTarget;
    return fallback;
  };

  const chrome = pick(
    options.chrome,
    binding.keys.browserPath,
    target.browserPath,
    null
  );

  const profile = pick(
    options.profile,
    binding.keys.userDataDir,
    target.userDataDir,
    null
  );

  const profileDirectory = String(pick(
    options.profileDirectory,
    binding.keys.profileDirectory,
    target.profileDirectory,
    'Default'
  ));

  const port = Number(pick(
    options.cdpPort,
    binding.keys.cdpPort,
    target.cdpPort,
    9444
  ));

  const cdpUrl = options.cdpUrl || `http://127.0.0.1:${port}`;

  if (!chrome || !path.isAbsolute(chrome)) {
    throw new Error(
      'CONFIG_INVALID: 绑定里的浏览器不是绝对路径。先跑 `chatgpt-web init` 或修 config.json（browserPath）'
    );
  }

  if (!profile || !path.isAbsolute(profile)) {
    throw new Error(
      'CONFIG_INVALID: 绑定里的 user-data-dir 不是绝对路径。先跑 `chatgpt-web init` 或修 config.json（userDataDir）'
    );
  }

  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  ) {
    throw new Error(
      'CONFIG_INVALID: CDP 端口无效'
    );
  }

  if (!/^[\w .-]+$/.test(profileDirectory)) {
    throw new Error(
      'CONFIG_INVALID: profile-directory 含非法字符'
    );
  }

  let u;

  try {
    u = new URL(cdpUrl);
  } catch {
    throw new Error(
      'CONFIG_INVALID: CDP URL 无效'
    );
  }

  if (
    u.protocol !== 'http:' ||
    u.hostname !== '127.0.0.1' ||
    Number(u.port || 80) !== port ||
    u.pathname !== '/'
  ) {
    throw new Error(
      'CONFIG_INVALID: CDP URL 必须是 http://127.0.0.1:PORT'
    );
  }

  if (samePath(profile, path.dirname(profile))) {
    throw new Error(
      'CONFIG_INVALID: user-data-dir 指向了盘根，拒绝使用'
    );
  }

  return {
    chrome,
    profile,
    profileDirectory,
    port,
    cdpUrl: `http://127.0.0.1:${port}`,
    baseDir: options.baseDir || BASE
  };
}

// 只读诊断：本机那个托管 Chrome 的计划任务在不在、跟当前绑定对不对得上。
// 用于 doctor —— **不启动任何东西**。
export function describeLaunchTask(options = {}) {
  let cfg;
  try {
    cfg = configOf(options);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const name =
    options.launchTask
    || process.env.CHATGPT_LAUNCH_TASK
    || `ChatGPT-CDP-${cfg.port}`;

  if (process.platform !== 'win32') {
    return { ok: true, supported: false, reason: 'NOT_WINDOWS', name };
  }

  const task = readScheduledTask(name);

  if (!task) {
    return {
      ok: true,
      supported: true,
      name,
      found: false,
      hint: options.launchTask || process.env.CHATGPT_LAUNCH_TASK
        ? '指定的计划任务不存在（检查名字）'
        : `没有名为 ${name} 的计划任务；启动将退回 direct spawn`
    };
  }

  const matches = taskMatchesBinding(task, cfg);

  return {
    ok: true,
    supported: true,
    name: task.name,
    found: true,
    state: task.state,
    matchesBinding: matches,
    execute: task.execute,
    arguments: task.arguments,
    hint: matches
      ? '可用：ensure 会经它启动（跨命令存活）'
      : '⚠️ 该任务的浏览器/profile/端口与绑定不符 → ensure 会拒绝使用它（不会盲跑别人的任务）'
  };
}

// 诊断用：把"实际会用什么"暴露出来（doctor / binding 展示）
export function resolveLifecycleConfig(options = {}) {
  const cfg = configOf(options);
  return {
    chrome: cfg.chrome,
    profile: cfg.profile,
    profileDirectory: cfg.profileDirectory,
    port: cfg.port,
    cdpUrl: cfg.cdpUrl,
    baseDir: cfg.baseDir
  };
}

// 确保 localhost 不经过 HTTP 代理。
// 2026-10-16 实测：机器上设了 HTTP_PROXY 时，连 127.0.0.1:9444 也会被劫持 →
// fetch failed / 502，看起来像"浏览器死了"，其实是代理。NO_PROXY 必须含这两个 host。
function ensureProxyBypass() {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const items = String(process.env[key] || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    for (const host of [
      '127.0.0.1',
      'localhost'
    ]) {
      if (!items.includes(host)) {
        items.push(host);
      }
    }

    process.env[key] = items.join(',');
  }
}

// HTTP 探测：必须得到真正的 CDP 版本信息（不只是"端口通了"）
async function probeHttp(cfg) {
  return new Promise(resolve => {
    const req = http.get(
      `${cfg.cdpUrl}/json/version`,
      {
        agent: false,
        timeout: 1500
      },
      res => {
        let body = '';

        res.setEncoding('utf8');

        res.on('data', chunk => {
          body += chunk;

          if (body.length > 131072) {
            req.destroy(
              new Error('too large')
            );
          }
        });

        res.on('end', () => {
          try {
            const v = JSON.parse(body);
            let ws;

            try {
              ws = new URL(
                v.webSocketDebuggerUrl
              );
            } catch {}

            resolve(
              res.statusCode === 200 &&
              ws?.protocol === 'ws:' &&
              [
                '127.0.0.1',
                'localhost'
              ].includes(ws.hostname) &&
              Number(ws.port) === cfg.port
                ? v
                : null
            );
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));

    req.on('timeout', () => {
      req.destroy(
        new Error('CDP ping timeout')
      );
    });
  });
}

// TCP 连接检测
async function tcpListening(port) {
  return new Promise(resolve => {
    const s = net.connect({
      host: '127.0.0.1',
      port
    });

    const end = result => {
      s.destroy();
      resolve(result);
    };

    s.setTimeout(1000);

    s.once('connect', () => end(true));
    s.once('error', () => end(false));
    s.once('timeout', () => end(false));
  });
}

// Windows 上补充 netstat 检测
function portListed(cfg) {
  if (process.platform !== 'win32') {
    return {
      known: false,
      listening: false
    };
  }

  try {
    const text = execFileSync(
      'netstat.exe',
      ['-ano', '-p', 'TCP'],
      {
        encoding: 'utf8',
        timeout: 12000,
        windowsHide: true
      }
    );

    const rows = text
      .split(/\r?\n/)
      .map(x => x.trim().split(/\s+/));

    const lines = rows.filter(
      x =>
        x[0]?.toUpperCase() === 'TCP' &&
        x[1]?.endsWith(`:${cfg.port}`) &&
        x[3]?.toUpperCase() === 'LISTENING'
    );

    return {
      known: true,
      listening: lines.length > 0,
      pids: lines
        .map(x => Number(x[4]))
        .filter(Number.isInteger)
    };

  } catch {
    return {
      known: false,
      listening: false
    };
  }
}

// 并发锁及所有权记录的路径
function lockPath(cfg) {
  return path.join(
    cfg.baseDir,
    `lifecycle-${cfg.port}.lock`
  );
}

function ownerPath(cfg) {
  return path.join(
    cfg.baseDir,
    `owner-${cfg.port}.json`
  );
}

// 防止多个 agent 同时执行启动/终止操作
function acquireLock(cfg) {
  fs.mkdirSync(
    cfg.baseDir,
    { recursive: true }
  );

  const pathname = lockPath(cfg);

  try {
    const fd = fs.openSync(
      pathname,
      'wx',
      0o600
    );

    fs.writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        time: Date.now()
      })
    );

    fs.closeSync(fd);

    return {
      ok: true,
      release: () => {
        try {
          fs.unlinkSync(pathname);
        } catch {}
      }
    };

  } catch (e) {
    if (e.code !== 'EEXIST') {
      return {
        ok: false,
        error: `LOCK_ERROR: ${e.message}`
      };
    }

    // 只清理超过 3 分钟且原进程已不存在的锁
    try {
      const item = JSON.parse(
        fs.readFileSync(
          pathname,
          'utf8'
        )
      );

      if (
        Date.now() - item.time > 180000 &&
        Number.isInteger(item.pid) &&
        item.pid > 0
      ) {
        let alive = true;

        try {
          process.kill(item.pid, 0);
        } catch (err) {
          if (err.code === 'ESRCH') {
            alive = false;
          }
        }

        if (!alive) {
          fs.unlinkSync(pathname);
          return acquireLock(cfg);
        }
      }
    } catch {}

    return {
      ok: false,
      error:
        'LOCK_BUSY: another lifecycle operation may be running'
    };
  }
}

// 读取所有权记录
function readOwner(cfg) {
  try {
    return JSON.parse(
      fs.readFileSync(
        ownerPath(cfg),
        'utf8'
      )
    );
  } catch {
    return null;
  }
}

// 记录本工具实际启动的浏览器（只有"我们启动的"才允许被我们关闭）
function writeOwner(
  cfg,
  holder,
  pageTargetIds
) {
  const state = {
    schema: 1,
    pid: holder.pid,
    startId: holder.startId,
    commandLine: holder.commandLine,
    chrome: cfg.chrome,
    profile: cfg.profile,
    profileDirectory: cfg.profileDirectory,
    port: cfg.port,
    pageTargetIds
  };

  const tmp =
    `${ownerPath(cfg)}.${process.pid}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(state, null, 2),
    { mode: 0o600 }
  );

  fs.renameSync(
    tmp,
    ownerPath(cfg)
  );
}

// 校验进程是否与本机配置完全匹配
function matchesBinding(entry, cfg) {
  return (
    !!entry &&
    !entry.child &&
    !!entry.pid &&
    !!entry.startId &&
    samePath(
      entry.userDataDir,
      cfg.profile
    ) &&
    entry.cdpPort === cfg.port &&
    String(
      entry.profileDirectory || 'Default'
    ).toLowerCase() ===
      cfg.profileDirectory.toLowerCase() &&
    (
      !entry.executablePath ||
      samePath(
        entry.executablePath,
        cfg.chrome
      )
    )
  );
}

// 列出 CDP page targets
async function pageTargets(browser) {
  const s =
    await browser.newBrowserCDPSession();

  try {
    const r = await s.send(
      'Target.getTargets'
    );

    return r.targetInfos
      .filter(t => t.type === 'page')
      .map(t => ({
        id: t.targetId,
        url: t.url
      }));

  } finally {
    await s.detach().catch(() => {});
  }
}

// 定位或创建 ChatGPT 页面。
// createPage === false 且没有已存在的 GPT 标签页时返回 null（只读命令允许"没有页"）。
async function preparePage(browser, options) {
  const ctx = browser.contexts()[0];

  if (!ctx) {
    throw new Error(
      'NO_DEFAULT_CONTEXT'
    );
  }

  const match = () =>
    ctx.pages().filter(p => GPT_URL_RE.test(p.url()));

  let pages = match();

  // 2026-09-26 实测（Windows / Chrome 153）：launch 返回时页面**刚开始导航，p.url() 还是空字符串**，
  // 上述过滤必然为空。若此刻立刻 newPage，就会在同一个 profile 里开出**第二个** chatgpt.com
  // 页面（用户可见："每次同时打开两个 GPT 窗口"）。之后选页漂移，两个同源页面互相干扰 ——
  // 实测表现为间歇 NOT_LOGGED_IN、以及提交成功但 conversationId 恒为 null。
  // 所以先等已有页面把 URL 落定，等不到才新建。
  if (!pages.length && options.createPage !== false) {
    const deadline = Date.now() + 20000;
    do {
      await pause(500);
      pages = match();
      if (pages.length) break;
    } while (Date.now() < deadline);
  }

  if (pages.length) {
    const page = pages[pages.length - 1];
    if (page.isClosed()) {
      throw new Error('PAGE_CLOSED');
    }
    return page;
  }

  if (options.createPage === false) {
    return null;
  }

  const page = await ctx.newPage();

  await page.goto(
    options.url || DEFAULT_URL,
    {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }
  );

  return page;
}

// 标准错误返回
function bad(
  state,
  error,
  hint,
  actionsTaken = []
) {
  return {
    ok: false,
    state,
    actionsTaken,
    error,
    hint
  };
}

// 汇总端口与 profile 归属
function ownershipOf(scan, cfg) {
  const portHolders = scan.entries.filter(
    e =>
      !e.child &&
      e.cdpPort === cfg.port
  );

  const profileHolders = scan.entries.filter(
    e =>
      !e.child &&
      samePath(
        e.userDataDir,
        cfg.profile
      )
  );

  return {
    portHolders,
    profileHolders,
    holder: portHolders[0] || null,
    profileHolder: profileHolders[0] || null
  };
}

// 只有验证通过才连接 Playwright
async function connectVerified(
  cfg,
  holder,
  options,
  state,
  actions
) {
  let browser;

  try {
    ensureProxyBypass();

    browser = await chromium.connectOverCDP(
      cfg.cdpUrl,
      { timeout: 20000 }
    );

    const page = await preparePage(
      browser,
      options
    );

    actions.push(
      'connected-cdp',
      'page-ready'
    );

    return {
      ok: true,
      state,
      browser,
      page,
      pid: holder.pid,
      actionsTaken: actions
    };

  } catch (e) {
    if (browser) {
      await browser.close().catch(() => {});
    }

    return bad(
      'CONNECT_FAILED',
      'CONNECT_FAILED',
      String(e.message),
      actions
    );
  }
}

// 构造 Chrome 启动参数（引号由调用方按各自规则处理）
function chromeArgs(cfg, options) {
  const args = [
    `--remote-debugging-port=${cfg.port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${cfg.profile}`,
    `--profile-directory=${cfg.profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI,CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    options.url || DEFAULT_URL
  ];

  if (options.headless === true) {
    args.unshift('--headless=new');
  }

  return args;
}

// 直接 spawn（非 Windows 的默认方式；Windows 上作为 WMI 不可用时的兜底）
function spawnDirect(cfg, args) {
  return new Promise(resolve => {
    const child = spawn(
      cfg.chrome,
      args,
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      }
    );

    const pid = child.pid || null;

    let completed = false;

    const finish = x => {
      if (completed) return;
      completed = true;
      resolve(x);
    };

    child.once('error', e => {
      finish({
        ok: false,
        pid,
        detail: e.message
      });
    });

    child.once('spawn', () => {
      child.unref();

      finish({
        ok: true,
        pid
      });
    });
  });
}

// Windows：用 WMI 的 Win32_Process.Create 启动。
//
// ★ 2026-10-16 实测（本机 WorkBuddy 环境）：
//   直接 spawn(detached:true)+unref() 启动的 Chrome **活不过本条命令** ——
//   宿主在命令结束时回收整棵进程树，端口只剩 TIME_WAIT，下一个命令连不上。
//   （实测 port 9462：命令 A 返回 READY_STARTED，命令 B 已经没有 LISTENING。）
//   改为 WMI 创建后，父进程是 WmiPrvSE.exe，不在我们的进程树里 →
//   **跨命令存活**（实测 port 9463：命令 B 仍能 LISTENING 且 /json/version 正常）。
//
// 命令行用 base64 传递，彻底绕开 PowerShell 的引号地狱 —— 路径带空格也不会被切断。
function spawnViaWmi(cfg, args) {
  const quote = a => (/\s/.test(a) ? `"${a}"` : a);
  const full = [cfg.chrome, ...args].map(quote).join(' ');
  const b64 = Buffer.from(full, 'utf8').toString('base64');

  const ps =
    `$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); `
    + '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$c}; '
    + '$r | ConvertTo-Json -Compress';

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    );

    const r = JSON.parse(String(out).trim());
    const pid = Number(r.ProcessId);

    if (r.ReturnValue === 0 && Number.isSafeInteger(pid) && pid > 0) {
      return { ok: true, pid, via: 'wmi' };
    }

    return { ok: false, pid: null, via: 'wmi', detail: `WMI_RETURN_${r.ReturnValue}` };
  } catch (e) {
    return { ok: false, pid: null, via: 'wmi', detail: e.message };
  }
}

// Windows：用**已存在的计划任务**启动（本机 2026-10-15 既定机制）。
//
// 为什么是它：宿主会在命令结束时回收整棵进程树（见 spawnViaWmi 的实测），
// 由 `schtasks.exe` 注册的计划任务不受影响 —— 但 `schtasks.exe` 在本机被程序黑名单封杀，
// 必须用 **PowerShell 的 `Register-ScheduledTask` / `Start-ScheduledTask`**（2026-10-15 实测可用）。
// 本机现有任务：`ChatGPT-CDP-9444`（Ready，按需触发）。
//
// ★ 安全前置：**先读任务、核对它启动的确实是我们绑定的浏览器 + profile + 端口**，对不上就拒绝。
//   否则"跑一个未知的计划任务"等于开了个后门（这正是一切"验证优先"的由来）。
function readScheduledTask(name) {
  const safe = String(name).replace(/'/g, "''");
  const ps =
    `$ErrorActionPreference='Stop'; `
    + `$t = Get-ScheduledTask -TaskName '${safe}' -ErrorAction Stop; `
    + `$a = $t.Actions | Where-Object { $_.Execute } | Select-Object -First 1; `
    + `[pscustomobject]@{ name=$t.TaskName; state=[string]$t.State; execute=[string]$a.Execute; arguments=[string]$a.Arguments } | ConvertTo-Json -Compress`;

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    return JSON.parse(String(out).trim());
  } catch {
    return null;
  }
}

function startScheduledTask(name) {
  const safe = String(name).replace(/'/g, "''");
  const ps = `$ErrorActionPreference='Stop'; Start-ScheduledTask -TaskName '${safe}'; 'STARTED'`;

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    return String(out).includes('STARTED');
  } catch {
    return false;
  }
}

// 任务动作是否**就是**我们的绑定？三样都必须对得上，缺一不可。
function taskMatchesBinding(task, cfg) {
  if (!task || !task.execute) return false;
  if (!samePath(task.execute, cfg.chrome)) return false;

  const args = String(task.arguments || '');
  if (!new RegExp(`--remote-debugging-port=${cfg.port}(\\s|$)`).test(args)) return false;

  const m = args.match(/--user-data-dir=(?:"([^"]*)"|'([^']*)'|(\S+))/i);
  const dir = m ? (m[1] ?? m[2] ?? m[3]) : null;
  if (!dir || !samePath(dir, cfg.profile)) return false;

  const pd = args.match(/--profile-directory=(?:"([^"]*)"|'([^']*)'|(\S+))/i);
  const pdVal = pd ? (pd[1] ?? pd[2] ?? pd[3]) : 'Default';
  if (String(pdVal).toLowerCase() !== cfg.profileDirectory.toLowerCase()) return false;

  return true;
}

function spawnViaTask(cfg, options) {
  const name =
    options.launchTask
    || process.env.CHATGPT_LAUNCH_TASK
    || `ChatGPT-CDP-${cfg.port}`;

  const task = readScheduledTask(name);

  if (!task) {
    return { ok: false, pid: null, via: 'task', detail: `TASK_NOT_FOUND(${name})` };
  }

  if (!taskMatchesBinding(task, cfg)) {
    return {
      ok: false,
      pid: null,
      via: 'task',
      detail:
        `TASK_BINDING_MISMATCH(${name}): 该计划任务启动的不是绑定的浏览器/profile/端口，已拒绝执行。`
    };
  }

  if (!startScheduledTask(name)) {
    return { ok: false, pid: null, via: 'task', detail: `TASK_START_FAILED(${name})` };
  }

  // 计划任务拉起的进程 PID 事先未知 → pid 留空，由 waitForOwnedCdp 用"启动前快照"排除法核对
  return { ok: true, pid: null, via: 'task', taskName: task.name };
}

// 启动绑定的 Chrome 实例。
// spawnMode: 'auto'(默认) | 'task' | 'direct' | 'wmi'；也可用 CHATGPT_SPAWN_MODE 覆盖。
//
// 'auto' = Windows 上优先「已核验的计划任务」→ 退回 direct。
//   ⛔ 刻意**不把 WMI 放进 auto**：SKILL.md 9.1 记录过它被安全策略拦截、判定"不该做"；
//      2026-10-16 实测它确实能用（见 spawnViaWmi 注释），但要用户明确同意后才作为候选。
async function spawnChrome(cfg, options) {
  const mode = String(
    options.spawnMode || process.env.CHATGPT_SPAWN_MODE || 'auto'
  ).toLowerCase();

  const args = chromeArgs(cfg, options);

  if (process.platform === 'win32' && (mode === 'auto' || mode === 'task')) {
    const task = spawnViaTask(cfg, options);
    if (task.ok) return task;
    if (mode === 'task') return task;
    // auto：没有可用计划任务 → 退回 direct（并在 actions 里说明原因）
    return { ...(await spawnDirect(cfg, args)), via: 'direct', taskSkipped: task.detail };
  }

  if (mode === 'wmi' && process.platform === 'win32') {
    return spawnViaWmi(cfg, args);
  }

  const direct = await spawnDirect(cfg, args);
  return { ...direct, via: 'direct' };
}

// 等待且验证"刚被启动"的 Chrome。
//   ownPid 有值（direct / wmi）：端口持有者必须**正是**我们启的那个 PID。
//   ownPid 为 null（计划任务）：PID 事先未知，改为要求"恰好一个、且与绑定完全匹配"的持有者。
//     —— 能走到启动分支，前提就是启动前该 profile/端口**没有任何持有者**（上面已判），
//        所以此刻出现的那一个必然是我们刚拉起来的。
async function waitForOwnedCdp(
  cfg,
  timeoutMs,
  ownPid = null
) {
  const deadline =
    Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await probeHttp(cfg)) {
      // 这里在轮询（每 500ms 一次），瞬时失败下一轮就自愈 →
      // 不要用重试版（否则一次抖动要拖 3 次 PowerShell，把 60s 预算吃掉）
      const scan = scanBrowserProcesses({ cacheMs: 0, attempts: 1 });

      // ★ 2026-10-16 实测修正：进程表暂时读不到**不是终态**。
      //   原来这里直接 return PROCESS_SCAN_UNAVAILABLE，把一次瞬时抖动
      //   升级成"启动失败"（实测 3 次 e2e 里必挂 1 次）。既然已经在轮询，
      //   就该在下一轮重试，只在超时后才放弃。
      if (!scan.supported) {
        await pause(500);
        continue;
      }

      const { portHolders } =
        ownershipOf(scan, cfg);

      if (
        portHolders.length === 1 &&
        matchesBinding(
          portHolders[0],
          cfg
        ) &&
        (ownPid === null || portHolders[0].pid === ownPid)
      ) {
        return {
          ok: true,
          holder: portHolders[0]
        };
      }

      return {
        ok: false,
        reason: 'CDP_OWNERSHIP_CHANGED'
      };
    }

    await pause(500);
  }

  return {
    ok: false,
    reason: 'LAUNCH_TIMEOUT',
    hint:
      'Chrome 起来了但 60s 内没能完成"端口 + profile + 进程身份"三重校验。'
      + '常见原因：系统繁忙导致进程表读不到，或该 user-data-dir 被别的实例接管。'
      + '先重跑一次 ensure 复查，不要重复 launch。'
  };
}

/**
 * ensureBrowser：统一确定性入口
 *
 * options:
 * {
 *   chrome, profile, profileDirectory, cdpPort, cdpUrl,
 *   configFile, baseDir,
 *   createPage: true,       // false = 允许"没有 GPT 标签页"（status/tabs 用）
 *   launchIfMissing: true,  // false = 只读，不启动
 *   headless: false,
 *   url,
 *   timeoutMs: 60000
 * }
 *
 * 成功：{ ok:true, state:'READY_REUSED'|'READY_STARTED', browser, page, pid, actionsTaken }
 * 失败：{ ok:false, state, actionsTaken, error, hint }
 *
 * ⚠️ 本函数任何时候都不终止浏览器。
 */
export async function ensureBrowser(options = {}) {
  let cfg;

  try {
    cfg = configOf(options);
  } catch (e) {
    return bad(
      'CONFIG_INVALID',
      'CONFIG_INVALID',
      e.message
    );
  }

  const lock = acquireLock(cfg);

  if (!lock.ok) {
    return bad(
      'LOCK_BUSY',
      'LOCK_BUSY',
      lock.error
    );
  }

  const actions = [];

  try {
    const scan = freshScan();

    if (!scan.supported) {
      return bad(
        'PROCESS_SCAN_UNAVAILABLE',
        scan.reason,
        '无法可靠读取进程命令行（已重试仍失败）。请恢复 CIM/WMI 权限后重试，不得盲目启动或结束 Chrome。'
          + (scan.detail ? ` (${scan.detail})` : '')
          + (scan.missingCount ? ` 缺失 ${scan.missingCount}/${scan.totalCount} 条浏览器进程元数据。` : ''),
        actions
      );
    }

    const {
      portHolders,
      profileHolders,
      holder,
      profileHolder
    } = ownershipOf(scan, cfg);

    if (
      portHolders.length > 1 ||
      profileHolders.length > 1
    ) {
      return bad(
        'AMBIGUOUS_INSTANCES',
        'AMBIGUOUS_INSTANCES',
        '发现多个浏览器主进程声明了同一调试端口或 user-data-dir，已停止。',
        actions
      );
    }

    const live = await probeHttp(cfg);

    // CDP 已经正常工作
    if (live) {
      if (
        !holder ||
        !matchesBinding(holder, cfg)
      ) {
        return bad(
          'CDP_PROFILE_MISMATCH',
          'CDP_PROFILE_MISMATCH',
          `${cfg.port} 上有 CDP，但无法证明属于绑定的 PROFILE；禁止连接。`,
          actions
        );
      }

      return await connectVerified(
        cfg,
        holder,
        options,
        'READY_REUSED',
        actions
      );
    }

    // 绑定 profile 正被某个 Chrome 占用
    if (profileHolder) {
      if (
        profileHolder.cdpPort === cfg.port
      ) {
        return bad(
          'CDP_STALE_BOUND',
          'CDP_STALE_BOUND',
          `检测到绑定实例 PID=${profileHolder.pid} 带调试参数运行，但 CDP HTTP 无响应。不要强杀；请用户保存此窗口内容并正常退出，然后执行 ensure。`,
          actions
        );
      }

      const state = profileHolder.cdpPort
        ? 'PROFILE_IN_USE_OTHER_PORT'
        : 'PROFILE_IN_USE_NO_CDP';

      const launcher = path.join(BASE, 'start-chrome-google2.cmd');

      return bad(
        state,
        state,
        `PROFILE 正由 PID=${profileHolder.pid} 使用${profileHolder.cdpPort ? `（调试端口 ${profileHolder.cdpPort}）` : '（普通 Chrome，没有调试端口）'}。`
          + '**不要杀进程**：请用户自己关掉那个窗口。'
          + '⚠️ 因为"运行中的 Chrome 无法事后开启调试端口"，以后请改用 '
          + `"${launcher}" 启动这个 profile，而不是双击 Chrome。`,
        actions
      );
    }

    // CDP 端口被其他 Chrome 使用
    if (holder) {
      return bad(
        'CDP_PORT_CONFLICT',
        'CDP_PORT_CONFLICT',
        `端口 ${cfg.port} 所属 Chrome 的 user-data-dir 不匹配。请检查该程序，禁止连接或覆盖。`,
        actions
      );
    }

    // HTTP 不通，但 TCP 或 netstat 仍显示占用
    const listed = portListed(cfg);

    if (
      listed.listening ||
      await tcpListening(cfg.port)
    ) {
      return bad(
        'CDP_PORT_STALE_OR_CONFLICT',
        'CDP_PORT_STALE_OR_CONFLICT',
        `${cfg.port} 端口存在监听或 TCP 连接，但 CDP HTTP 不可用，且没有可验证的绑定 Chrome。${listed.pids?.length ? `监听 PID: ${listed.pids.join(', ')}。` : ''}需人工排除端口占用；禁止按进程名终止。`,
        actions
      );
    }

    if (
      process.platform === 'win32' &&
      !listed.known
    ) {
      return bad(
        'PORT_SCAN_UNAVAILABLE',
        'PORT_SCAN_UNAVAILABLE',
        '无法核实 netstat 监听状态，保守停止启动。',
        actions
      );
    }

    // 只读状态检查，不执行启动
    if (options.launchIfMissing === false) {
      return bad(
        'NOT_RUNNING',
        'NOT_RUNNING',
        'Chrome 未运行；执行 ensure（默认会自动启动）。',
        actions
      );
    }

    if (!fs.existsSync(cfg.chrome)) {
      return bad(
        'CHROME_NOT_FOUND',
        'CHROME_NOT_FOUND',
        cfg.chrome,
        actions
      );
    }

    fs.mkdirSync(
      cfg.profile,
      { recursive: true }
    );

    // 真正启动浏览器
    const spawned = await spawnChrome(
      cfg,
      options
    );

    if (!spawned.ok) {
      return bad(
        'SPAWN_FAILED',
        'SPAWN_FAILED',
        spawned.detail,
        actions
      );
    }

    actions.push(
      `spawned-pid:${spawned.pid ?? 'unknown'}`,
      `spawn-via:${spawned.via || 'unknown'}`
    );

    if (spawned.taskName) actions.push(`task:${spawned.taskName}`);
    if (spawned.taskSkipped) actions.push(`task-skipped:${spawned.taskSkipped}`);

    const ready = await waitForOwnedCdp(
      cfg,
      options.timeoutMs ?? 60000,
      spawned.pid
    );

    if (!ready.ok) {
      return bad(
        ready.reason,
        ready.reason,
        ready.hint
          || 'Chrome 可能仍在启动或已经复用其他进程；不要重复 launch。先重新运行 ensure 观察状态。',
        actions
      );
    }

    const result = await connectVerified(
      cfg,
      ready.holder,
      options,
      'READY_STARTED',
      actions
    );

    if (!result.ok) {
      return result;
    }

    // 记录本工具启动实例的所有权（只有 1 个 GPT 标签页时才记，避免关掉用户后面开的东西）
    try {
      const targets = await pageTargets(
        result.browser
      );

      const safeTargets =
        targets.length === 1 &&
        targets.every(t =>
          GPT_URL_RE.test(t.url)
        );

      if (safeTargets) {
        writeOwner(
          cfg,
          ready.holder,
          targets.map(t => t.id)
        );

        actions.push(
          'ownership-recorded'
        );
      } else {
        actions.push(
          'ownership-not-recorded-extra-or-unexpected-pages'
        );
      }

    } catch {
      actions.push(
        'ownership-not-recorded-target-check-failed'
      );
    }

    return result;

  } finally {
    lock.release();
  }
}

// 校验所有权记录
function checkOwner(cfg, owner, holder) {
  if (
    !owner ||
    owner.schema !== 1
  ) {
    return 'OWNERSHIP_RECORD_MISSING';
  }

  if (!matchesBinding(holder, cfg)) {
    return 'PROCESS_BINDING_MISMATCH';
  }

  if (
    owner.pid !== holder.pid ||
    owner.startId !== holder.startId ||
    owner.commandLine !== holder.commandLine ||
    owner.port !== cfg.port ||
    !samePath(owner.profile, cfg.profile) ||
    !samePath(owner.chrome, cfg.chrome) ||
    String(
      owner.profileDirectory
    ).toLowerCase() !==
      cfg.profileDirectory.toLowerCase()
  ) {
    return 'OWNERSHIP_FINGERPRINT_MISMATCH';
  }

  if (
    !Array.isArray(owner.pageTargetIds) ||
    owner.pageTargetIds.length !== 1
  ) {
    return 'OWNERSHIP_TARGETS_INVALID';
  }

  return null;
}

// 检查是否有用户后来添加的页面
async function enumerateExtraTargets(
  cfg,
  owner
) {
  if (!(await probeHttp(cfg))) {
    return {
      ok: false,
      reason:
        'CDP_UNRESPONSIVE_CANNOT_CHECK_WINDOWS'
    };
  }

  let browser;
  let retain = false;

  try {
    browser = await chromium.connectOverCDP(
      cfg.cdpUrl,
      { timeout: 10000 }
    );

    const targets = await pageTargets(
      browser
    );

    const expected = new Set(
      owner.pageTargetIds
    );

    const unexpected = targets.filter(
      t =>
        !expected.has(t.id) ||
        !GPT_URL_RE.test(t.url)
    );

    if (
      targets.length !== expected.size ||
      unexpected.length
    ) {
      return {
        ok: false,
        reason: 'FOREIGN_OR_CHANGED_WINDOW',
        detail: unexpected
      };
    }

    retain = true;

    return {
      ok: true,
      browser
    };

  } catch (e) {
    return {
      ok: false,
      reason:
        `WINDOW_CHECK_FAILED: ${e.message}`
    };

  } finally {
    if (browser && !retain) {
      await browser.close().catch(() => {});
    }
  }
}

// Windows：按句柄终止，降低 PID 复用风险
function forceTerminateWindows(holder) {
  const expected = Buffer.from(
    JSON.stringify({
      pid: holder.pid,
      startId: holder.startId,
      commandLine: holder.commandLine
    }),
    'utf8'
  ).toString('base64');

  const script = String.raw`
$ErrorActionPreference = 'Stop'

$e = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String('REPLACE_DATA')
) | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class BoundedTerminator {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(
    uint desiredAccess,
    bool inheritHandle,
    int processId
  );

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool TerminateProcess(
    IntPtr processHandle,
    uint exitCode
  );

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(
    IntPtr processHandle
  );
}
'@

$handle = [BoundedTerminator]::OpenProcess(
  0x1001,
  $false,
  [int]$e.pid
)

if ($handle -eq [IntPtr]::Zero) {
  throw 'OPEN_PROCESS_FAILED'
}

try {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($e.pid)" -ErrorAction Stop
  } catch {
    $p = Get-WmiObject Win32_Process -Filter "ProcessId=$($e.pid)" -ErrorAction Stop
  }

  if (!$p) {
    throw 'PROCESS_DISAPPEARED'
  }

  if ([string]$p.CommandLine -cne [string]$e.commandLine) {
    throw 'COMMAND_LINE_CHANGED'
  }

  if ($p.CreationDate -is [string]) {
    $created = [Management.ManagementDateTimeConverter]::ToDateTime(
      $p.CreationDate
    ).ToString('o')
  } else {
    $created = ([datetime]$p.CreationDate).ToString('o')
  }

  if ($created -cne [string]$e.startId) {
    throw 'CREATION_TIME_CHANGED'
  }

  if (
    -not [BoundedTerminator]::TerminateProcess(
      $handle,
      1
    )
  ) {
    throw 'TERMINATE_PROCESS_FAILED'
  }

  Write-Output 'TERMINATED_EXACT_HANDLE'

} finally {
  [void][BoundedTerminator]::CloseHandle($handle)
}
`.replace('REPLACE_DATA', expected);

  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script
      ],
      {
        encoding: 'utf8',
        timeout: 18000,
        windowsHide: true
      }
    );

    return out.includes(
      'TERMINATED_EXACT_HANDLE'
    )
      ? { ok: true }
      : {
          ok: false,
          error: 'TERMINATION_UNCONFIRMED'
        };

  } catch (e) {
    return {
      ok: false,
      error:
        `FORCE_TERMINATION_REFUSED: ${e.message}`
    };
  }
}

// 终止前校验：把"哪一项对不上"细分出来。
// 只报一个笼统的 PID_REUSE_OR_BINDING_CHANGED 会让人无从下手 ——
// 2026-10-16 实测就踩到这个：拒绝理由正确，但看不出到底哪一栏不一致。
function lifecycleMismatch(latest, holder, cfg) {
  if (!latest.supported) return 'SCAN_UNAVAILABLE';
  if (!latest.entry) return 'PROCESS_DISAPPEARED';
  if (latest.entry.startId !== holder.startId) return 'START_ID_CHANGED';
  if (latest.entry.commandLine !== holder.commandLine) return 'COMMAND_LINE_CHANGED';

  if (!matchesBinding(latest.entry, cfg)) {
    if (!samePath(latest.entry.userDataDir, cfg.profile)) return 'USER_DATA_DIR_CHANGED';
    if (latest.entry.cdpPort !== cfg.port) return `CDP_PORT_CHANGED(${latest.entry.cdpPort}!=${cfg.port})`;
    if (String(latest.entry.profileDirectory || 'Default').toLowerCase() !== cfg.profileDirectory.toLowerCase()) {
      return `PROFILE_DIR_CHANGED(${latest.entry.profileDirectory})`;
    }
    if (latest.entry.executablePath && !samePath(latest.entry.executablePath, cfg.chrome)) {
      return 'EXECUTABLE_CHANGED';
    }
    return 'BINDING_UNKNOWN';
  }

  return null;
}

// 等待精确 PID 对应的原进程退出
async function waitPidGone(
  holder,
  ms = 7000
) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    const now = getProcessByPid(
      holder.pid
    );

    if (!now.supported) {
      return false;
    }

    if (
      !now.entry ||
      now.entry.startId !== holder.startId
    ) {
      return true;
    }

    await pause(300);
  }

  return false;
}

/**
 * killBoundInstanceIfAny()
 *
 * 只有本工具启动、且有完整所有权记录的实例，才允许执行关闭。
 *
 * force=false：优先尝试 CDP Browser.close（优雅）
 * force=true ：优雅失败后，Windows 上再用精确进程句柄终止
 *
 * ⚠️ 任何模式都必须先核对绑定信息；且**不要**把 stop/stop --force 放进 agent 的
 * 自动恢复路径 —— 用户可能恰好在最后一次校验之后打开了新窗口（并发窗口无法彻底消除）。
 */
export async function killBoundInstanceIfAny(
  options = {}
) {
  let cfg;

  try {
    cfg = configOf(options);
  } catch (e) {
    return {
      killed: false,
      pid: null,
      refused: [e.message],
      reason: 'CONFIG_INVALID'
    };
  }

  const lock = acquireLock(cfg);

  if (!lock.ok) {
    return {
      killed: false,
      pid: null,
      refused: [lock.error],
      reason: 'LOCK_BUSY'
    };
  }

  let browser = null;

  try {
    const scan = freshScan();

    if (!scan.supported) {
      return {
        killed: false,
        pid: null,
        refused: [scan.reason],
        reason: 'PROCESS_SCAN_UNAVAILABLE'
      };
    }

    const { profileHolders } =
      ownershipOf(scan, cfg);

    if (!profileHolders.length) {
      return {
        killed: false,
        pid: null,
        refused: [],
        reason: 'NOT_RUNNING'
      };
    }

    if (profileHolders.length !== 1) {
      return {
        killed: false,
        pid: null,
        refused: [
          'Multiple main processes use this profile'
        ],
        reason: 'AMBIGUOUS_INSTANCES'
      };
    }

    const holder = profileHolders[0];

    const refuse = (
      reason,
      detail = reason
    ) => ({
      killed: false,
      pid: holder.pid,
      refused: [detail],
      reason
    });

    const owner = readOwner(cfg);

    const check = checkOwner(
      cfg,
      owner,
      holder
    );

    if (check) {
      return refuse(check);
    }

    // 假如 CDP 已经半死，这里直接拒绝
    const windows = await enumerateExtraTargets(
      cfg,
      owner
    );

    if (!windows.ok) {
      return refuse(
        windows.reason,
        windows.detail || windows.reason
      );
    }

    browser = windows.browser;

    // 关闭前再次检查 PID + 启动时间 + 命令行
    const latest = getProcessByPid(
      holder.pid
    );

    const m1 = lifecycleMismatch(latest, holder, cfg);

    if (m1) {
      return refuse(
        'PID_REUSE_OR_BINDING_CHANGED',
        m1
      );
    }

    // 优雅关闭浏览器
    try {
      const s =
        await browser.newBrowserCDPSession();

      await s.send(
        'Browser.close'
      ).catch(() => {});
    } catch {}

    if (await waitPidGone(holder)) {
      try {
        fs.unlinkSync(
          ownerPath(cfg)
        );
      } catch {}

      return {
        killed: true,
        pid: holder.pid,
        refused: [],
        reason: 'GRACEFUL_CDP_CLOSE'
      };
    }

    // 没有明确 force 授权，不执行强制关闭
    if (options.force !== true) {
      return refuse(
        'GRACEFUL_CLOSE_FAILED',
        'Browser.close 没有完成关闭；没有执行强制终止。'
      );
    }

    // 强制终止前必须重新验证页面
    const freshWindows =
      await enumerateExtraTargets(
        cfg,
        owner
      );

    if (!freshWindows.ok) {
      return refuse(
        'FOREIGN_WINDOWS_NOT_EXCLUDED',
        freshWindows.reason
      );
    }

    await freshWindows.browser
      .close()
      .catch(() => {});

    if (process.platform !== 'win32') {
      return refuse(
        'ATOMIC_FORCE_UNSUPPORTED',
        '当前平台无基于进程句柄的安全终止实现。'
      );
    }

    // 终止前最后一次进程检查
    const again = getProcessByPid(
      holder.pid
    );

    const m2 = lifecycleMismatch(again, holder, cfg);

    if (m2) {
      return refuse(
        'PID_REUSE_OR_BINDING_CHANGED',
        m2
      );
    }

    const terminated =
      forceTerminateWindows(holder);

    if (!terminated.ok) {
      return refuse(
        'FORCE_TERMINATION_REFUSED',
        terminated.error
      );
    }

    if (
      !(await waitPidGone(
        holder,
        4000
      ))
    ) {
      return refuse(
        'FORCE_TERMINATION_UNCONFIRMED'
      );
    }

    try {
      fs.unlinkSync(
        ownerPath(cfg)
      );
    } catch {}

    return {
      killed: true,
      pid: holder.pid,
      refused: [],
      reason: 'EXACT_HANDLE_TERMINATED'
    };

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }

    lock.release();
  }
}
