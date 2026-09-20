// chatgpt-web · 浏览器与页面基础层（确定性，不含业务判断）
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';

// ---------- 环境解析（跨平台）----------
// 实例作用域：不同 agent 想互不干扰时，各自设 CHATGPT_AGENT=trae 等，
// 于是 profile / 端口 / 锁文件 / 状态目录全部隔离，可并行；不设则共用同一实例（串行）。
// 稳定的端口偏移，避免同一台机器上多 agent 抢同一端口
function hashPort(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 500;
  return h;
}

export const AGENT = process.env.CHATGPT_AGENT || 'default';
const SCOPE = AGENT === 'default' ? '' : `-${AGENT}`;

export const CDP_PORT = Number(process.env.CHATGPT_CDP_PORT || (9444 + hashPort(SCOPE)));
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
export const PROFILE = process.env.CHATGPT_PROFILE
  || path.join(os.homedir(), '.chatgpt-web', `profile${SCOPE}`);
export const STATE_DIR = path.join(os.homedir(), '.chatgpt-web');
export const TABS_FILE = path.join(STATE_DIR, `tabs${SCOPE}.json`);

// 跨平台定位 Chrome：先看显式环境变量，再按平台探测常见安装位置。
// 返回 null 表示没找到——由上层给出可操作提示，而不是抛一个看不懂的错误。
export function resolveChrome() {
  const explicit = process.env.CHATGPT_CHROME;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
    ],
    linux: [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/snap/bin/chromium', '/usr/bin/microsoft-edge',
    ],
  }[process.platform] || [];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

export const CHROME = resolveChrome() || '';

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

async function waitCdp(ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cdpAlive()) return true;
    await sleep(400);
  }
  return false;
}

export async function launchChrome({ headless = false } = {}) {
  if (await cdpAlive()) return { launched: false, reason: 'already-running' };
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    'https://chatgpt.com/',
  ];
  if (headless) args.unshift('--headless=new');
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const ok = await waitCdp();
  return { launched: true, ok };
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

// 找到（或创建）ChatGPT 标签页
export async function getPage(browser, { create = true } = {}) {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages().filter((p) => /chatgpt\.com/.test(p.url()));
  if (pages.length) return pages[pages.length - 1];
  if (!create) return null;
  const page = await ctx.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

export const SELECTORS = {
  composer: '#prompt-textarea',
  composerFallback: "textarea[name='prompt-textarea']",
  send: "button[data-testid='send-button']",
  stop: "button[data-testid='stop-button']",
  voice: "button[aria-label='启动语音功能'], button[aria-label='Start voice mode']",
  turn: "[data-testid^='conversation-turn-']",
  user: "[data-message-author-role='user']",
  assistant: "[data-message-author-role='assistant']",
  copyBtn: "button[data-testid='copy-turn-action-button']",
  login: "button[data-testid='login-button'], a[href*='auth/login']",
  newChat: "a[data-testid='create-new-chat-button']",
};

export async function isLoggedIn(page) {
  if (await page.locator(SELECTORS.composer).count()) return true;
  const url = page.url();
  if (/auth\.openai\.com|\/auth\/login/.test(url)) return false;
  return false;
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

  while (Date.now() < deadline) {
    const s = await page.evaluate(PROBE, base);
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
      // 双采样确认：间隔 500ms 两次内容一致才落地，避免瞬时静止误判
      await sleep(500);
      const s2 = await page.evaluate(PROBE, base);
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
