#!/usr/bin/env node
// deepseek.mjs · DeepSeek 网页渠道（确定性执行层，不做业务判断）
//
// 与 chatgpt.mjs 并列的第二条渠道。共用同一套约定：
//   - CLI 子命令 + JSON 信封（protocol_version / ok / code / state / request_id / conversation_id）
//   - 机器级绑定放 ~/.chatgpt-web/（不在 skill 目录内，不会被重装/git pull 覆盖）
//   - 绑定键读 config.json 的 targets.deepseek，回退到顶层扁平键
//
// 本文件只负责"把动作做对"，不负责"决定问什么"。多模型圆桌的编排在上层。

// ---- 0. 环境净化：宿主会注入 HTTP_PROXY，会把 127.0.0.1:CDP 的请求也送去代理 → 502 ----
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { chromium } from 'playwright-core';

const PROTOCOL_VERSION = '1';
const CHAT_URL = 'https://chat.deepseek.com/';
const TARGET = 'deepseek';

// ---------- 绑定 ----------
const CONFIG_FILE = process.env.CHATGPT_CONFIG || path.join(os.homedir(), '.chatgpt-web', 'config.json');
const STATE_DIR = path.join(os.homedir(), '.chatgpt-web');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function resolveBinding() {
  const cfg = readJson(CONFIG_FILE) || {};
  const scoped = (cfg.targets && cfg.targets[TARGET]) || {};
  const pick = (k, envKey, dflt) => process.env[envKey] || scoped[k] || cfg[k] || dflt;
  return {
    browserPath: pick('browserPath', 'DEEPSEEK_BROWSER',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
    userDataDir: pick('userDataDir', 'DEEPSEEK_PROFILE', path.join(os.homedir(), '.chatgpt-web', 'edge-deepseek')),
    profileDirectory: pick('profileDirectory', 'DEEPSEEK_PROFILE_DIRECTORY', 'Default'),
    cdpPort: Number(pick('cdpPort', 'DEEPSEEK_CDP_PORT', 9445)),
    launcher: pick('launcher', 'DEEPSEEK_LAUNCHER', null),
    source: scoped.browserPath ? 'config:targets.deepseek' : (cfg.browserPath ? 'config:flat' : 'default'),
  };
}

const B = resolveBinding();
const CDP_URL = `http://127.0.0.1:${B.cdpPort}`;
const TABS_FILE = path.join(STATE_DIR, 'deepseek-tabs.json');

// 不关浏览器。
// 用户明确要求：一个项目对话过程中不要把网页关掉，后续可能还要用，由用户自己关。
// 实测 connectOverCDP 下的 browser.close() 只断开、不杀浏览器，但仍不主动调用——
// 一来语义正确（这里只想断开），二来挡住未来 Playwright 版本把行为改成真关的风险。
function dropBrowser(browser) { /* 故意什么都不做，靠 process.exit 断开 */ }
void dropBrowser;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 信封 ----------
const STATES = {
  OK: 'SUCCESS', LAUNCHED: 'SUCCESS', SENT: 'SUCCESS', READY: 'SUCCESS', DONE: 'SUCCESS',
  NEW_CHAT: 'SUCCESS', TOGGLES_SET: 'SUCCESS', NO_CHANGE: 'SUCCESS',
  CDP_DOWN: 'FAILED', NOT_LOGGED_IN: 'FAILED', NO_COMPOSER: 'FAILED', SEND_FAILED: 'FAILED',
  TIMEOUT: 'FAILED', BAD_ARGS: 'FAILED', BROWSER_MISSING: 'FAILED', INTERNAL: 'FAILED',
};

function envelope(code, extra = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    ok: STATES[code] === 'SUCCESS',
    code,
    state: STATES[code] || 'FAILED',
    target: TARGET,
    request_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...extra,
  };
}
function emit(code, extra = {}) {
  process.stdout.write(`${JSON.stringify(envelope(code, extra), null, 2)}\n`);
  process.exit(STATES[code] === 'SUCCESS' ? 0 : 1);
}

// ---------- CDP ----------
function pingOnce() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: B.cdpPort, path: '/json/version', timeout: 1500 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function waitCdp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await pingOnce(); if (v && v.Browser) return v; await sleep(500); }
  return null;
}

// 启动：优先用 .cmd 启动器（走 explorer，脱离宿主进程树 —— 沙箱会在调用结束时回收
// 它自己 spawn 的 GUI 子进程，所以直接 spawn 的浏览器活不过一次工具调用）。
async function launchBrowser({ timeoutMs = 40000 } = {}) {
  if (!fs.existsSync(B.browserPath)) return { ok: false, reason: 'browser-missing', path: B.browserPath };
  const cmdPath = B.launcher || path.join(STATE_DIR, 'start-edge-deepseek.cmd');
  if (fs.existsSync(cmdPath)) {
    await new Promise((resolve) => {
      execFile('explorer.exe', [cmdPath], { windowsHide: true }, () => resolve());
      setTimeout(resolve, 1500);
    });
  } else {
    // 回退：直接 spawn。在同一次工具调用内可用，跨调用可能被回收。
    const child = spawn(B.browserPath, [
      `--remote-debugging-port=${B.cdpPort}`,
      `--user-data-dir=${B.userDataDir}`,
      `--profile-directory=${B.profileDirectory}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--start-maximized',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  const ver = await waitCdp(timeoutMs);
  return ver ? { ok: true, browser: ver.Browser } : { ok: false, reason: 'cdp-timeout' };
}

async function ensureBrowser() {
  if (await pingOnce()) return { launched: false };
  const r = await launchBrowser();
  if (!r.ok) emit(r.reason === 'browser-missing' ? 'BROWSER_MISSING' : 'CDP_DOWN', r);
  return { launched: true, browser: r.browser };
}

// ---------- 页面 ----------
async function getPage({ create = true } = {}) {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  let page = ctx.pages().find((p) => /chat\.deepseek\.com/.test(p.url()));
  if (!page && create) {
    page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || (await ctx.newPage());
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(4000);
  }
  return { browser, ctx, page };
}

// 登录判据：localStorage.userToken 有真值（深拷的 app-kit 信封：{"value": "..."}）
async function loginState(page) {
  return page.evaluate(() => {
    const raw = (() => { try { return localStorage.getItem('userToken'); } catch { return null; } })();
    let token = null;
    try { token = JSON.parse(raw)?.value; } catch { token = raw; }
    const ui = (() => { try { return JSON.parse(localStorage.getItem('__appKit_userInfo'))?.value; } catch { return null; } })();
    return {
      loggedIn: !!(token && String(token).length > 10),
      tokenLen: token ? String(token).length : 0,
      userId: ui && ui.id ? ui.id : null,
      onSignIn: /\/sign_in/.test(location.href),
    };
  });
}

// ---------- 开关 ----------
const TOGGLE_NAME = { thinking: '深度思考', search: '智能搜索' };

async function readToggles(page) {
  return page.evaluate(() => {
    const out = { thinking: null, search: null };
    for (const e of document.querySelectorAll('div[class*="ds-toggle-button"]')) {
      const t = (e.innerText || '').trim();
      const pressed = e.getAttribute('aria-pressed') === 'true'
        || /ds-toggle-button--selected/.test(String(e.className || ''));
      if (/深度思考/.test(t)) out.thinking = pressed;
      if (/智能搜索/.test(t)) out.search = pressed;
    }
    return out;
  });
}

async function setToggle(page, name, want) {
  return page.evaluate(({ name, want }) => {
    for (const e of document.querySelectorAll('div[class*="ds-toggle-button"]')) {
      if ((e.innerText || '').trim() !== name) continue;
      const cur = e.getAttribute('aria-pressed') === 'true'
        || /ds-toggle-button--selected/.test(String(e.className || ''));
      if (cur === want) return { name, changed: false, now: cur };
      e.click();
      return { name, changed: true, now: want };
    }
    return { name, changed: false, err: 'toggle-not-found' };
  }, { name, want });
}

// 把两个开关摆到目标状态；只点需要变的，点完回读校验
async function applyToggles(page, { thinking = true, search = true } = {}) {
  const before = await readToggles(page);
  const log = [];
  if (before.thinking !== thinking) { log.push(await setToggle(page, TOGGLE_NAME.thinking, thinking)); await sleep(500); }
  if (before.search !== search) { log.push(await setToggle(page, TOGGLE_NAME.search, search)); await sleep(500); }
  const after = await readToggles(page);
  return { before, after, log, satisfied: after.thinking === thinking && after.search === search };
}

// ---------- 新对话 ----------
// 坑：页面里 "开启新对话" 这个文本会命中 4 个元素（外层包装 div / 内层可点 div[tabindex=0] / span）。
// 2026-10-06 实测点 document 顺序里第一个（外层包装）**不生效**：返回 clicked=true 但 URL 没变、
// 会话没切换 —— 静默失败比报错更糟。所以这里逐个候选点，点完**回读校验**。
async function newChat(page) {
  const before = { url: page.url(), n: (await snapshot(page)).count };
  for (const preferTabindex of [true, false]) {
    const clicked = await page.evaluate(({ preferTabindex }) => {
      const els = [...document.querySelectorAll('div,span,a,button')]
        .filter((e) => /^(开启新对话|新建对话|New chat)$/.test((e.innerText || '').trim()));
      if (!els.length) return 0;
      // 优先点带 tabindex 的那个（真正绑了事件），否则退化为最内层（children 最少）
      let target = null;
      if (preferTabindex) target = els.find((e) => (e.closest('[tabindex="0"]') || e.getAttribute('tabindex') === '0')) || null;
      else target = [...els].sort((a, b) => a.children.length - b.children.length)[0] || null;
      if (!target) return 0;
      (target.closest('[tabindex="0"]') || target).click();
      return 1;
    }, { preferTabindex });
    if (!clicked) continue;
    await sleep(2200);
    const now = { url: page.url(), n: (await snapshot(page)).count };
    if (now.url !== before.url || now.n < before.n) return { ok: true, url: now.url, from: before, preferTabindex };
  }
  return { ok: false, url: page.url(), from: before };
}

// 是否开新对话：默认开；--no-new / --new off 表示延续当前会话（多轮研讨要用）
function wantNewChat(args) {
  if (args['no-new'] === true) return false;
  if (args.new === 'off' || args.new === false) return false;
  return true;
}

// ---------- 会话标识 ----------
// DeepSeek 的 URL 会变成 /a/chat/s/<uuid>；没有就退化为标题
async function conversationId(page) {
  const url = page.url();
  const m = /\/s\/([0-9a-f-]{16,})/i.exec(url);
  if (m) return m[1];
  return page.evaluate(() => document.title || null);
}

// ---------- 发送 ----------
async function sendText(page, text) {
  const ta = await page.waitForSelector('textarea[placeholder]', { timeout: 15000 }).catch(() => null);
  if (!ta) return { sent: false, reason: 'no-composer' };
  await ta.click();
  await ta.fill(text);
  await sleep(350);
  const pending = await ta.inputValue().catch(() => '');
  await ta.press('Enter');
  await sleep(1200);
  const cleared = await page.evaluate(() => {
    const t = document.querySelector('textarea[placeholder]');
    return t ? t.value.length : -1;
  });
  return { sent: cleared === 0 || cleared === -1, pendingLen: pending.length, composerLenAfter: cleared };
}

// ---------- 等待完成（盯"最后一条助手消息"，不盯整页）----------
// DeepSeek 前端 class 是 hash 的（_27c9245 之类），随构建变化；
// 但"助手回复文本停止增长"这个信号与前端实现无关，比找"停止按钮"稳。
// 关键一：必须**按容器**取文本。2026-10-06 实测用整页 innerText 永远不稳定
//        （侧栏/角标等区域有持续变化的文字），会把 wait 拖到超时。
// 关键二：判"已开始"必须拿**发送前**的基线比，不能拿上一次轮询比（见 snapshot 注释）。

// 发送前的基线快照：{count, text}
// 为什么需要它：2026-10-06 实测，新回复可能**比上一条更短**（"1\n2\n3\n4\n5" 9 字 vs 上一条 52 字），
// 用"比上一次更长"当作"已开始生成"会永远判不出来，于是 wait 一路拖到超时却其实早就答完了。
// 正确做法：拿**发送前**的状态当基线，块数增加 或 文本变化 都算"已开始"。
async function snapshot(page) {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const md = [...document.querySelectorAll('[class*="ds-markdown"]')].filter(vis);
    return {
      count: md.length,
      text: md.length ? (md[md.length - 1].innerText || '').trim() : '',
    };
  });
}

async function readAssistantText(page) {
  return (await snapshot(page)).text;
}

// 生成中指示器（尽力而为：找到就用来加速判定，找不到不影响主判据）
async function generating(page) {
  return page.evaluate(() => {
    for (const e of document.querySelectorAll('div[role="button"],button,[class*="ds-icon-button"]')) {
      const s = (e.getAttribute('aria-label') || '') + '|' + (e.innerText || '');
      if (/停止|Stop generating|Stop/i.test(s)) {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  });
}

async function waitForDone(page, { timeoutMs = 300000, stableMs = 4000, minMs = 1500, baseline = null } = {}) {
  const t0 = Date.now();
  const base = baseline || (await snapshot(page));
  let lastText = base.text;
  let started = false;
  let stableSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    const s = await snapshot(page);
    if (!started && (s.count > base.count || (s.text && s.text !== base.text))) {
      started = true;
      stableSince = Date.now();
    }
    if (s.text !== lastText) { lastText = s.text; stableSince = Date.now(); continue; }
    const elapsed = Date.now() - t0;
    if (started && lastText && !(await generating(page)) && elapsed >= minMs && Date.now() - stableSince >= stableMs) {
      return { done: true, elapsedMs: elapsed, chars: lastText.length, started };
    }
  }
  return { done: false, elapsedMs: Date.now() - t0, chars: lastText.length, started, reason: 'timeout' };
}

// ---------- 读回复 ----------
// 策略：先试 DeepSeek 的 markdown 容器；拿不到就退化为"最后一条用户消息之后的文本"
async function readLast(page, { userText = null } = {}) {
  const r = await page.evaluate(({ userText }) => {
    // 1) markdown 容器（assistant 正文）
    const md = [...document.querySelectorAll('[class*="ds-markdown"]')]
      .filter((e) => { const x = e.getBoundingClientRect(); return x.width > 0 && x.height > 0; });
    if (md.length) {
      const last = md[md.length - 1];
      return { via: 'ds-markdown', count: md.length, text: (last.innerText || '').trim() };
    }
    // 2) 退化：整页文本里，最后一条用户消息之后的部分
    const all = (document.body.innerText || '');
    if (userText && all.includes(userText)) {
      const i = all.lastIndexOf(userText);
      let tail = all.slice(i + userText.length);
      // 砍掉页脚/免责声明等噪音
      tail = tail.replace(/内容由\s*AI\s*生成[\s\S]*$/, '');
      tail = tail.split('\n').filter((l) => !/^(深度思考|智能搜索|复制|重新生成|分享)$/.test(l.trim())).join('\n');
      return { via: 'tail-slice', count: null, text: tail.trim() };
    }
    // 3) 兜底：整页
    return { via: 'whole-body', count: null, text: all.trim() };
  }, { userText });
  return r;
}

// ---------- 命令 ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { out[k] = true; }
      else { out[k] = v; i++; }
    } else out._.push(a);
  }
  return out;
}

async function cmdStatus(args) {
  const ver = await pingOnce();
  if (!ver) {
    return emit('CDP_DOWN', {
      cdpUrl: CDP_URL,
      binding: B,
      hint: `浏览器没在跑（或不是这个端口）。跑：node scripts/deepseek.mjs launch`,
    });
  }
  const { browser, page } = await getPage({ create: false });
  const st = page ? await loginState(page) : { loggedIn: false };
  const toggles = page ? await readToggles(page) : null;
  return emit('OK', {
    cdpUrl: CDP_URL, browser: ver.Browser, binding: B,
    pageUrl: page ? page.url() : null,
    ...st, toggles,
  });
}

async function cmdLaunch(args) {
  const ver = await pingOnce();
  if (ver) return emit('LAUNCHED', { reused: true, browser: ver.Browser, cdpUrl: CDP_URL });
  const r = await launchBrowser({ timeoutMs: Number(args.timeout || 40000) });
  if (!r.ok) return emit(r.reason === 'browser-missing' ? 'BROWSER_MISSING' : 'CDP_DOWN', r);
  return emit('LAUNCHED', { reused: false, browser: r.browser, cdpUrl: CDP_URL, binding: B });
}

async function cmdNew(args) {
  await ensureBrowser();
  const { browser, page } = await getPage();
  if (!page) { dropBrowser(browser); return emit('NO_COMPOSER'); }
  const res = await newChat(page);
  const cid = await conversationId(page);
  dropBrowser(browser);
  if (!res.ok) return emit('SEND_FAILED', { reason: 'new-chat-not-effective', ...res });
  return emit('NEW_CHAT', { conversation_id: cid, url: page.url(), ...res });
}

async function cmdToggles(args) {
  await ensureBrowser();
  const { browser, page } = await getPage();
  if (!page) { dropBrowser(browser); return emit('NO_COMPOSER'); }
  // 只读
  if (args.thinking === undefined && args.search === undefined && !args.set) {
    const t = await readToggles(page);
    dropBrowser(browser);
    return emit('OK', { toggles: t });
  }
  const want = {
    thinking: args.thinking === undefined ? (await readToggles(page)).thinking : args.thinking !== 'off',
    search: args.search === undefined ? (await readToggles(page)).search : args.search !== 'off',
  };
  const r = await applyToggles(page, want);
  dropBrowser(browser);
  return emit(r.satisfied ? 'TOGGLES_SET' : 'NO_CHANGE', { want, ...r });
}

async function cmdSend(args) {
  const text = typeof args.text === 'string' ? args.text : (args._ [1] || '');
  if (!text) return emit('BAD_ARGS', { hint: '需要 --text "..."' });
  await ensureBrowser();
  const { browser, page } = await getPage();
  if (!page) { dropBrowser(browser); return emit('NO_COMPOSER'); }

  const ls = await loginState(page);
  if (!ls.loggedIn) { dropBrowser(browser); return emit('NOT_LOGGED_IN', ls); }

  let nc = null;
  if (wantNewChat(args)) nc = await newChat(page);

  const want = {
    thinking: args.thinking === undefined ? true : args.thinking !== 'off',
    search: args.search === undefined ? true : args.search !== 'off',
  };
  const tg = await applyToggles(page, want);

  const base = await snapshot(page);            // 发送前基线，供 wait 判"已开始"
  const s = await sendText(page, text);
  const cid = await conversationId(page);
  dropBrowser(browser);
  if (!s.sent) return emit('SEND_FAILED', { ...s, toggles: tg.after });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(TABS_FILE, JSON.stringify({ conversation_id: cid, url: page.url(), lastPrompt: text, baseline: base, ts: new Date().toISOString() }, null, 2));
  return emit('SENT', {
    conversation_id: cid, url: page.url(),
    submitted: true, pendingText: s.pendingLen, toggles: tg.after, toggleLog: tg.log, baseline: base,
    newChat: nc,
  });
}

async function cmdWait(args) {
  await ensureBrowser();
  const { browser, page } = await getPage({ create: false });
  if (!page) { dropBrowser(browser); return emit('NO_COMPOSER'); }
  const meta = readJson(TABS_FILE) || {};
  const r = await waitForDone(page, {
    timeoutMs: Number(args.timeout || 300000),
    stableMs: Number(args.stable || 4000),
    baseline: meta.baseline || null,
  });
  dropBrowser(browser);
  return emit(r.done ? 'DONE' : 'TIMEOUT', { conversation_id: await conversationId(page), ...r });
}

async function cmdRead(args) {
  await ensureBrowser();
  const { browser, page } = await getPage({ create: false });
  if (!page) { dropBrowser(browser); return emit('NO_COMPOSER'); }
  const meta = readJson(TABS_FILE) || {};
  const r = await readLast(page, { userText: typeof args.after === 'string' ? args.after : meta.lastPrompt });
  const cid = await conversationId(page);
  dropBrowser(browser);
  if (args.md) {
    const out = String(args.md);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${r.text}\n`);
    return emit('OK', { conversation_id: cid, via: r.via, chars: r.text.length, savedMarkdown: out });
  }
  return emit('OK', { conversation_id: cid, via: r.via, mdBlocks: r.count, chars: r.text.length, text: r.text });
}

// 复合命令：一次调用跑完全链路（沙箱下最稳）
async function cmdAsk(args) {
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text) return emit('BAD_ARGS', { hint: '需要 --text "..."' });
  await ensureBrowser();
  const { browser, page } = await getPage();
  if (!page) { dropBrowser(browser); return emit('NO_COMPOSER'); }

  const ls = await loginState(page);
  if (!ls.loggedIn) { dropBrowser(browser); return emit('NOT_LOGGED_IN', ls); }

  let nc = null;
  if (wantNewChat(args)) nc = await newChat(page);

  const want = {
    thinking: args.thinking === undefined ? true : args.thinking !== 'off',
    search: args.search === undefined ? true : args.search !== 'off',
  };
  const tg = await applyToggles(page, want);

  const base = await snapshot(page);            // 发送前基线
  const s = await sendText(page, text);
  if (!s.sent) { dropBrowser(browser); return emit('SEND_FAILED', { ...s, toggles: tg.after }); }

  const w = await waitForDone(page, { timeoutMs: Number(args.timeout || 300000), stableMs: Number(args.stable || 4000), baseline: base });
  const r = await readLast(page, { userText: text });
  const cid = await conversationId(page);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(TABS_FILE, JSON.stringify({ conversation_id: cid, url: page.url(), lastPrompt: text, baseline: base, ts: new Date().toISOString() }, null, 2));

  let savedMarkdown = null;
  if (args.md) {
    savedMarkdown = String(args.md);
    fs.mkdirSync(path.dirname(savedMarkdown), { recursive: true });
    fs.writeFileSync(savedMarkdown, `${r.text}\n`);
  }
  dropBrowser(browser);
  return emit(w.done ? 'OK' : 'TIMEOUT', {
    conversation_id: cid, url: page.url(),
    toggles: tg.after, toggleLog: tg.log, newChat: nc,
    submitted: s.sent, replyVia: r.via, chars: r.text.length,
    elapsedMs: w.elapsedMs, done: w.done,
    savedMarkdown, text: r.text,
  });
}

async function cmdDump(args) {
  await ensureBrowser();
  const { browser, page } = await getPage({ create: false });
  if (!page) { dropBrowser(browser); return emit('NO_COMPOSER'); }
  const d = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const rows = [];
    for (const e of document.querySelectorAll('div,main,section,article,p')) {
      if (!vis(e) || e.children.length > 8) continue;
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 300) continue;
      rows.push({ cls: String(e.className || '').slice(0, 90), len: t.length, head: t.slice(0, 60) });
    }
    return rows.slice(0, 80);
  });
  dropBrowser(browser);
  return emit('OK', { url: page.url(), rows: d });
}

async function cmdDoctor(args) {
  const ver = await pingOnce();
  const cfg = readJson(CONFIG_FILE);
  return emit('OK', {
    configFile: CONFIG_FILE,
    configExists: !!cfg,
    hasTargets: !!(cfg && cfg.targets),
    binding: B,
    browserExists: fs.existsSync(B.browserPath),
    profileExists: fs.existsSync(B.userDataDir),
    cdpAlive: !!ver,
    browser: ver ? ver.Browser : null,
    launcherExists: fs.existsSync(B.launcher || path.join(STATE_DIR, 'start-edge-deepseek.cmd')),
  });
}

const CMDS = {
  status: cmdStatus, launch: cmdLaunch, new: cmdNew, toggles: cmdToggles,
  send: cmdSend, wait: cmdWait, read: cmdRead, ask: cmdAsk, dump: cmdDump, doctor: cmdDoctor,
};

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || !CMDS[cmd]) {
    return emit('BAD_ARGS', { cmds: Object.keys(CMDS), usage: 'node scripts/deepseek.mjs <cmd> [--flags]' });
  }
  try {
    await CMDS[cmd](parseArgs(argv.slice(1)));
  } catch (e) {
    return emit('INTERNAL', { error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4) });
  }
}
main();
