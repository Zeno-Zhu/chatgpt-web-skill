// chatgpt-web · 浏览器与页面基础层（确定性，不含业务判断）
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { resolveBinding } from './config.mjs';
import { scanBrowserProcesses, findCdpInstance, findProfileUser, samePath } from './procs.mjs';
import { SELECTORS } from './compose.mjs';

export { SELECTORS };

// ---------- 环境解析（跨平台）----------
// 实例作用域：不同 agent 想互不干扰时，各自设 CHATGPT_AGENT=trae 等，
// 于是 profile / 端口 / 锁文件 / 状态目录全部隔离，可并行；不设则共用同一实例（串行）。
// 稳定的端口偏移，避免同一台机器上多 agent 抢同一端口
function hashPort(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 500;
  return h;
}

// 机器级绑定：用哪个浏览器 + 哪个**已登录**的 profile。
// 优先级：环境变量 > ~/.chatgpt-web/config.json > <skill>/.env.agent（宿主级实例名）> 默认值。
// 默认值刻意只给端口与 profile 目录名，不给浏览器/profile 路径 ——
// 猜错 profile 的代价是让用户重复登录（甚至触发风控），比直接报错严重得多。
export const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BINDING = resolveBinding({ skillDir: SKILL_DIR });

export const AGENT = BINDING.keys.agent || 'default';
const SCOPE = AGENT === 'default' ? '' : `-${AGENT}`;

export const CDP_PORT = Number(BINDING.keys.cdpPort || (9444 + hashPort(SCOPE)));
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
export const PROFILE_DIRECTORY = BINDING.keys.profileDirectory || null;export const PROFILE = BINDING.keys.userDataDir
  || path.join(os.homedir(), '.chatgpt-web', `profile${SCOPE}`);
export const STATE_DIR = path.join(os.homedir(), '.chatgpt-web');
export const TABS_FILE = path.join(STATE_DIR, `tabs${SCOPE}.json`);

// ---------- 用户传入路径的规范化（跨 shell 安全）----------
// 2026-09-22 实测：在 Git Bash 里把 `/c/Users/x` 交给 Windows 版 node，它会被当成"当前盘符的相对路径"，
// `path.resolve` 得到 `C:\c\Users\x` —— 产物**静默**写到错误位置，调用方毫无察觉
// （`read --md` 返回的 savedMarkdown 也是那个坏路径）。
// 只转换 `/单字母/` 这种确定是 MSYS 盘符的形式，不碰 `/usr/share` 这类真正的根路径。
export function normalizeUserPath(p) {
  if (typeof p !== 'string' || !p) return p;
  if (process.platform !== 'win32') return p;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// Windows 上输出目录必须是**盘符绝对路径**。不是就明确报错，而不是让它被解析到
// `<当前盘符>\...` 之后静默写错地方（这正是上面那个坑里"静默"的那一半）。
// 抛出的错误由 chatgpt.mjs 的 main() 兜住，转成 `{ ok:false, error }` 信封。
export function requireDriveAbsolute(p, what = '路径') {
  if (process.platform !== 'win32') return p;
  const s = String(p == null ? '' : p);
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s;
  throw new Error(
    `PATH_NOT_DRIVE_ABSOLUTE: ${what} "${s}" 在 Windows 上必须是盘符绝对路径（如 C:/Users/me/out）。`
    + ' Git Bash 的 /c/... 会被自动纠正；"\\\\" 开头或 /tmp/... 这类会被解析成 <当前盘符>:\\tmp\\...，故直接拒绝。',
  );
}

// 在基础层统一纠正 CHATGPT_OUT_DIR：它必须在任何消费方（chatgpt.mjs / images.mjs）读取之前生效，
// 所以放在这里而不是各命令内部 —— 否则 images.mjs 在 import 期就算好了旧值。
{
  const rawOut = process.env.CHATGPT_OUT_DIR;
  if (rawOut) {
    const fixedOut = normalizeUserPath(rawOut);
    if (fixedOut !== rawOut) {
      process.env.CHATGPT_OUT_DIR = fixedOut;
      process.stderr.write(`[chatgpt-web] CHATGPT_OUT_DIR: ${rawOut} → ${fixedOut}（Git Bash 盘符形式已纠正）\n`);
    }
  }
}

// 跨平台定位 Chrome：先看显式环境变量，再按平台探测常见安装位置。
// 返回 null 表示没找到——由上层给出可操作提示，而不是抛一个看不懂的错误。
function winCandidates() {
  // 注意：Windows 上 Edge 常常只装在 %ProgramFiles(x86)%，Chrome 也可能只装在 %LOCALAPPDATA%。
  // 2026-09-20 实测：本机 Edge 只存在于 Program Files (x86)，旧版候选表因此漏判。
  const bases = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean);
  const rels = [
    'Google/Chrome/Application/chrome.exe',
    'Google/Chrome Beta/Application/chrome.exe',
    'Google/Chrome Dev/Application/chrome.exe',
    'Google/Chrome SxS/Application/chrome.exe',   // Canary
    'Chromium/Application/chrome.exe',
    'Microsoft/Edge/Application/msedge.exe',
    'BraveSoftware/Brave-Browser/Application/brave.exe',
  ];
  const out = [];
  for (const b of bases) for (const r of rels) out.push(path.join(b, r));
  return out;
}

function browserCandidates() {
  return {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: winCandidates(),
    linux: [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/snap/bin/chromium', '/usr/bin/microsoft-edge',
    ],
  }[process.platform] || [];
}

export function resolveChrome() {
  const explicit = process.env.CHATGPT_CHROME;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const c of browserCandidates()) if (c && fs.existsSync(c)) return c;
  return null;
}

// 本机已安装的浏览器（去重、保持优先级顺序）——给 `init` 探测用
export function listInstalledBrowsers() {
  const seen = new Set();
  const out = [];
  for (const c of browserCandidates()) {
    if (!c) continue;
    const k = c.toLowerCase();
    if (seen.has(k) || !fs.existsSync(c)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// 显式绑定的浏览器路径优先；它不存在时**不**偷偷换一个浏览器（那正是"打开的不是我指定的浏览器"的根因），
// 而是交给上层报 CHROME_NOT_FOUND 并给出配置修正指引。
export const CHROME = BINDING.keys.browserPath || resolveChrome() || '';
export const CHROME_SOURCE = BINDING.keys.browserPath
  ? BINDING.sources.browserPath
  : (CHROME ? 'detected' : 'default');
export const CHROME_MISSING = !!(BINDING.keys.browserPath && !fs.existsSync(String(BINDING.keys.browserPath)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, { timeout: 1500 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

export async function cdpAlive() { return (await ping()) !== null; }

async function waitCdp(ms = 25000, shouldStop = () => false) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (shouldStop()) return false;
    if (await cdpAlive()) return true;
    await sleep(400);
  }
  return false;
}

// 谁在监听我们这个 CDP 端口？它的 profile 是否就是配置里绑定的那个？
// matched: true / false / null（null = 本平台拿不到进程信息，无法验证，如实返回）
export function checkCdpProfile(port = CDP_PORT, profile = PROFILE) {
  const scan = scanBrowserProcesses();
  if (!scan.supported) return { supported: false, liveProfile: null, matched: null };
  const holder = findCdpInstance(scan.entries, port);
  if (!holder) return { supported: true, liveProfile: null, matched: null };
  return {
    supported: true,
    liveProfile: holder.userDataDir,
    liveProfileDirectory: holder.profileDirectory,
    pid: holder.pid ?? null,
    matched: profile ? samePath(holder.userDataDir, profile) : null,
  };
}

export async function launchChrome({ headless = false } = {}) {
  if (await cdpAlive()) {
    // 已经有一个可调试实例：先确认它用的就是我们绑定的 profile，
    // 否则会"连上别的 Chrome、读到别人的会话"——看起来成功，实际是错的。
    const check = checkCdpProfile();
    if (check.matched === false) {
      return {
        launched: false, ok: false, reason: 'profile-mismatch',
        liveProfile: check.liveProfile, liveProfileDirectory: check.liveProfileDirectory,
        configured: PROFILE, configuredProfileDirectory: PROFILE_DIRECTORY,
      };
    }
    return { launched: false, reason: 'already-running', profileVerified: check.matched };
  }

  // 顺序很重要：浏览器缺失必须在 spawn 之前判断，
  // 否则 spawn('') 会抛 ENOENT，把"没装浏览器"伪装成一个看不懂的系统错误。
  if (!CHROME || CHROME_MISSING) {
    return { launched: false, ok: false, reason: 'chrome-not-found', configured: BINDING.keys.browserPath ?? null };
  }

  // 目标 profile 正被别的 Chrome 占用、但那个实例的调试端口不是我们要的：
  // 再启动一个 chrome.exe 只会把请求交给已有实例，永远等不到我们自己的 CDP。
  // 此时既不杀用户浏览器，也不偷偷换 profile，如实上报让用户决定。
  const scan = scanBrowserProcesses();
  if (scan.supported) {
    const holder = findProfileUser(scan.entries, PROFILE, { profileDirectory: PROFILE_DIRECTORY });
    if (holder && holder.cdpPort !== CDP_PORT) {
      return { launched: false, ok: false, reason: 'profile-in-use', holder };
    }
  }

  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    ...(PROFILE_DIRECTORY ? [`--profile-directory=${PROFILE_DIRECTORY}`] : []),
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    'https://chatgpt.com/',
  ];
  if (headless) args.unshift('--headless=new');
  let spawnError = null;
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => { spawnError = e; });
  child.unref();

  const ok = await waitCdp(25000, () => !!spawnError);
  if (spawnError) return { launched: true, ok: false, reason: 'spawn-failed', detail: spawnError.message };
  if (!ok) return { launched: true, ok: false, reason: 'cdp-timeout' };
  return { launched: true, ok: true, reason: 'started', profileVerified: true };
}

export async function connect() {
  if (!(await cdpAlive())) {
    throw new Error(`NO_CDP: 未检测到可调试的 Chrome (${CDP_URL})。请先运行: node scripts/chatgpt.mjs launch`);
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 20000 });
  return browser;
}

export function readTabs() {
  try { return JSON.parse(fs.readFileSync(TABS_FILE, 'utf8')); } catch { return {}; }
}
export function writeTabs(obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(TABS_FILE, JSON.stringify(obj, null, 2));
}

// 找到（或创建）ChatGPT 标签页。生图任务与普通对话**共用**同一个标签页：
// "一个窗口"指的是 GPT 里的一个新会话（新聊天），不是浏览器标签页；
// 每个会话的 URL 会被记账，之后按会话 id 直接取图（见 scripts/images.mjs）。
export async function getPage(browser, { create = true } = {}) {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages().filter((p) => /chatgpt\.com/.test(p.url()));
  if (pages.length) return pages[pages.length - 1];
  if (!create) return null;
  const page = await ctx.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

// 在同一个标签页里开一个**新的 GPT 会话**（新聊天），并等 composer 真正可用。
// 新标签页/新会话在 domcontentloaded 时 composer 还没渲染，此时判定登录态会误报 NOT_LOGGED_IN（实测）。
export async function openNewChat(page) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    if (await page.locator(SELECTORS.composer).count().catch(() => 0)) break;
    await sleep(500);
  }
  return page;
}

// 登录判定 = composer 是否可用。
//
// 2026-09-22 实测：新标签页 / 刚导航完时 composer 还没渲染，**立刻**判定会误报 NOT_LOGGED_IN，
// 而用户其实是登录着的。所以允许调用方给一个就绪等待窗口（waitMs），窗口内轮询而非一锤定音。
// 反向证据优先：URL 已经落到登录页时立刻下结论，不必把窗口等满。
// 默认 waitMs = 0 —— 保持既有调用点的延迟不变；只有诊断类命令（status / doctor）显式传窗口。
export async function isLoggedIn(page, { waitMs = 0, stepMs = 500 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    if (await page.locator(SELECTORS.composer).count().catch(() => 0)) return true;
    if (/auth\.openai\.com|\/auth\/login/.test(page.url())) return false;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

// 单次采样：所有判定都绑定在"本次新增的 assistant 消息"上，不做全页面查询。
//
// 为什么用 assistant 消息数而不是 conversation-turn 容器数做基线：
// 实测一个"user+assistant"对话会产出 2 个 conversation-turn 容器，
// 且 user 容器先出现——用容器数当基线容易被 user 轮次触发，
// 语义上也不清晰（容器口径可能随前端漂移）。assistant 消息数是无歧义指标。
const PROBE = (baselineAssistant) => {
  const assts = [...document.querySelectorAll("[data-message-author-role='assistant']")];
  const stop = document.querySelector("button[data-testid='stop-button']");
  const base = baselineAssistant || 0;
  const isNew = assts.length > base;
  const target = isNew ? assts[assts.length - 1] : null;
  const body = document.body.innerText || '';
  // 工作态只看 composer / 进度区这类受控区域。
  // 绝不能扫全页正文或侧边栏：回答内容本身可能就在讨论"正在搜索"，
  // 侧边栏历史标题也可能含这些字样——那会让 wait 永久卡死（2026-09-20 实测踩到）。
  const liveRegions = [
    document.querySelector("[data-testid='composer']"),
    document.querySelector('form'),
    document.querySelector("[class*='progress']"),
  ].filter(Boolean);
  const liveText = liveRegions.map((e) => e.innerText || '').join('\n');
  return {
    assistantCount: assts.length,
    stop: !!stop,
    targetSeen: !!target,
    text: target ? (target.innerText || '') : '',
    streaming: !!(target && target.querySelector('.result-streaming')),
    hasAction: !!(target && target.querySelector("button[data-testid='copy-turn-action-button']")),
    working: /正在思考|正在搜索|正在分析|正在生成|正在浏览|正在调用/.test(liveText),
    errorText: (() => {
      const m = body.match(/(Something went wrong[^\n]*|出现了一些问题[^\n]*|网络错误[^\n]*|NetworkError[^\n]*|发送消息时出错[^\n]*)/);
      return m ? m[1].slice(0, 200) : null;
    })(),
    authWall: /Log in|Sign up|免费注册/.test(body) && !document.querySelector('#prompt-textarea'),
    rateLimit: /(达到上限|使用上限|rate limit|too many requests|You've reached|稍后再试)/i.test(body),
  };
};

// 把终态翻译成稳定状态码，供上层 agent 分支，而不是给一坨网页文本
function classify(s, { sawStop, sawTarget, text, errorText }) {
  if (s.authWall) return 'auth_required';
  if (s.rateLimit) return 'rate_limit';
  if (errorText) return 'network_error';
  if (!sawTarget && !sawStop) return 'ui_changed';
  if (!text) return 'empty_response';
  return null;
}

/**
 * 等待回复完成。协议（不确定的是内容，确定的是协议）：
 *   SENT → RESPONSE_STARTED(latch) → GENERATING → SETTLING → SUCCESS / 状态码
 * 硬约束：未观察到"本次新增的 assistant 消息"，绝不允许判定为完成——
 *         否则页面原本静止时会把上一条历史回答当成本次结果返回。
 * 注意：stop 按钮出现只说明"有东西在生成"，不能证明"这条新回复已开始"，
 *       所以它只作为辅助信号，不作为 latch 条件。
 */
export async function waitForCompletion(page, {
  timeoutMs = 600000, pollMs = 1000, settleQuietMs = 2000, settleStopMs = 1500,
  baselineAssistant = 0, expectConversationId = null,
} = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  const base = baselineAssistant || 0;
  let generatedStarted = false;   // latch
  let sawStop = false;
  let sawTarget = false;
  let lastText = '';
  let textStableSince = 0;
  let stopGoneSince = 0;
  let lastError = null;
  let drift = false;
  let evalErrors = 0;

  while (Date.now() < deadline) {
    let s;
    try {
      s = await page.evaluate(PROBE, base);
    } catch (e) {
      // 生成中途页面会导航（生图会先说临时 URL、随后换成正式 UUID，甚至整页重载），
      // 执行上下文被销毁会让 evaluate 抛错。这**不是**失败信号：继续等，别把整次 wait 判死。
      // 2026-09-20 实测：修之前带生图的会话直接返回 "Execution context was destroyed"。
      evalErrors++;
      if (evalErrors > 120) {
        return { done: false, status: 'ui_changed', text: lastText, elapsedMs: Date.now() - start, detail: e.message.slice(0, 160) };
      }
      await sleep(pollMs);
      continue;
    }
    lastError = s.errorText;

    // 会话漂移检测：绝不能把另一个会话的回答当成本次结果
    if (expectConversationId) {
      const cur = convIds(page.url());
      // 双方都必须是稳定 UUID 才比较：
      // 临时 id（新聊天过渡态）参与比较必然误报漂移（2026-09-20 实测踩到）。
      const expectTmp = String(expectConversationId).startsWith('WEB:');
      if (!expectTmp && cur.conversationId && !cur.temporary && cur.conversationId !== expectConversationId) {
        drift = true; break;
      }
    }

    // latch 只认"新增的 assistant 消息"
    if (s.assistantCount > base) generatedStarted = true;
    if (s.stop) { sawStop = true; stopGoneSince = 0; } else if (generatedStarted && !stopGoneSince) stopGoneSince = Date.now();
    if (s.targetSeen) sawTarget = true;

    if (s.text && s.text === lastText) {
      if (!textStableSince) textStableSince = Date.now();
    } else {
      textStableSince = 0;
      lastText = s.text;
    }

    // 未 latch：只能等"开始"，不能判完成
    if (!generatedStarted) { await sleep(pollMs); continue; }

    const textQuiet = lastText && textStableSince && (Date.now() - textStableSince >= settleQuietMs);
    const stopQuiet = !s.stop && stopGoneSince && (Date.now() - stopGoneSince >= settleStopMs);
    const idle = !s.streaming && !s.working;

    if (textQuiet && stopQuiet && idle) {
      // 双采样确认：间隔 500ms 两次内容一致才落地，避免瞬时静止误判。
      // 这里同样要容忍导航（生图/长回复都可能触发重载）。
      await sleep(500);
      let s2;
      try { s2 = await page.evaluate(PROBE, base); } catch { await sleep(pollMs); continue; }
      if (s2.text === lastText && !s2.stop) {
        const status = classify(s2, { sawStop, sawTarget, text: lastText, errorText: lastError });
        if (status) return { done: false, status, text: lastText, elapsedMs: Date.now() - start, assistantCount: s2.assistantCount };
        return {
          done: true, status: 'success', text: lastText,
          elapsedMs: Date.now() - start, assistantCount: s2.assistantCount,
          sawStop, sawTarget, hasAction: s2.hasAction,
        };
      }
    }
    await sleep(pollMs);
  }

  if (drift) return { done: false, status: 'conversation_drift', text: lastText, elapsedMs: Date.now() - start };
  const status = generatedStarted ? 'timeout' : 'no_response_started';
  return { done: false, status, timeout: true, text: lastText, elapsedMs: Date.now() - start };
}

// 会话 id 解析。实测有两种 URL 形态（新聊天会先给临时 id，随后替换为最终 UUID）：
//   临时:   /c/WEB:3785019b-b736-43ea-a7b6-6538be70c20d
//   最终:   /c/6aaf5c42-fff8-83e8-b6b8-2e4058b9ccb1
// 项目内: /g/g-p-xxxx/c/<id>
// 只认 UUID 作为稳定主键；临时 id 单独返回，且不当作漂移依据。
const RE_TMP = /\/c\/(WEB:[0-9a-f-]+)/;
const RE_UUID = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export function convIds(url) {
  const m = url.match(/\/g\/(g-p-[0-9a-f]+)\/c\/([0-9a-f-]+)/);
  if (m) return { projectId: m[1], conversationId: m[2], temporary: false };
  const u = url.match(RE_UUID);
  if (u) return { projectId: null, conversationId: u[1], temporary: false };
  const t = url.match(RE_TMP);
  return { projectId: null, conversationId: t ? t[1] : null, temporary: !!t };
}

// ---------- 并发隔离 ----------
// 多个 agent（dsh / trae / workbuddy）共享同一个 ChatGPT 页面时，
// 并发任务会互相串线——而且会"看起来成功、只是答案属于别人"。
// 最低成本方案：单 profile 全局互斥锁。
export const LOCK_FILE = path.join(STATE_DIR, `lock${SCOPE}.json`);   // 按实例隔离：不同 agent 可并行
const STALE_MS = 15 * 60 * 1000;   // 超过 15 分钟视为崩溃残留

export function acquireLock(job = 'unknown') {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const age = Date.now() - new Date(cur.at).getTime();
      const alive = cur.pid && (() => { try { process.kill(cur.pid, 0); return true; } catch { return false; } })();
      if (alive && age < STALE_MS) return { ok: false, holder: cur };
      // 残留锁：抢占并记录
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, job, at: new Date().toISOString(), stoleFrom: cur }));
      return { ok: true, stole: true, from: cur };
    } catch { /* 锁文件损坏，下面覆盖 */ }
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, job, at: new Date().toISOString() }));
  return { ok: true };
}

export function releaseLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (cur.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch { /* 忽略 */ }
}
