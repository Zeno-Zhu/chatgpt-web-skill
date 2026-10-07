#!/usr/bin/env node
// channel-kit.mjs · 网页渠道通用引擎
//
// 背景：chatgpt.mjs / deepseek.mjs 各自是一份 600 行的完整脚本，再加渠道就是复制粘贴。
// 本文件把那 600 行里**与站点无关**的部分抽出来（CDP 连接、信封、启动、发送、等待、读取），
// 每个新渠道只剩一份「契约描述」（spec），通常 40 行以内。
//
// 用法：
//   import { runChannel } from './channel-kit.mjs';
//   import { spec } from './channels/qianwen.spec.mjs';
//   runChannel(spec);
//
// 设计纪律（三条，都是踩过坑换来的）：
//   1. **交互一律用 Playwright locator**（真实鼠标事件）。JS 的 element.click()
//      对 React/Radix 一类组件常常"返回成功但状态没变"。
//   2. **凡点按必回读**。changed:true 只代表我们点了，不代表界面变了。
//   3. **等回复完成只看助手容器**的文本 + **发送前基线**，绝不用整页 innerText，
//      也不要用"比上一次更长"（新回复可能比上一条更短）。

// ---- 0. 环境净化：宿主会注入 HTTP_PROXY，把 127.0.0.1:CDP 的请求也送去代理 → 502 ----
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
const CONFIG_FILE = process.env.CHATGPT_CONFIG || path.join(os.homedir(), '.chatgpt-web', 'config.json');
const STATE_DIR = path.join(os.homedir(), '.chatgpt-web');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ---------- 绑定：targets.<key> 优先，回退顶层扁平键，再回退默认值 ----------
function resolveBinding(spec) {
  const cfg = readJson(CONFIG_FILE) || {};
  const scoped = (cfg.targets && cfg.targets[spec.target]) || {};
  const env = spec.envPrefix;
  // ★ 顶层扁平键**只属于主渠道**（chatgpt），不能让新渠道吃掉它。
  //   踩过：新增 qianwen 时没写 targets.qianwen，扁平回退把 browserPath 指成了
  //   chatgpt 的 Chrome + C:\ChromeProfiles\Google2，doctor 还报"一切正常"——
  //   真去 launch 就会用别人的 profile 开一个新窗口。默认不吃扁平，需显式 opt-in。
  const flatOk = spec.flatFallback === true;
  const pick = (k, dflt) => process.env[`${env}_${k.toUpperCase()}`] || scoped[k]
    || (flatOk ? cfg[k] : undefined) || dflt;
  const b = {
    browserPath: pick('browserPath', spec.browserPath),
    userDataDir: pick('userDataDir', path.join(os.homedir(), '.chatgpt-web', spec.target)),
    profileDirectory: pick('profileDirectory', 'Default'),
    cdpPort: Number(pick('cdpPort', spec.cdpPort)),
    launcher: pick('launcher', spec.launcher || null),
    source: scoped.browserPath ? `config:targets.${spec.target}` : (flatOk && cfg.browserPath ? 'config:flat' : 'spec-default'),
  };
  return b;
}

// ---------- 信封 ----------
const SUCCESS = new Set([
  'OK', 'LAUNCHED', 'SENT', 'READY', 'DONE', 'NEW_CHAT', 'MODES_SET', 'NO_CHANGE', 'LOGGED_IN',
]);
const STATES = {
  OK: 'SUCCESS', LAUNCHED: 'SUCCESS', SENT: 'SUCCESS', READY: 'SUCCESS', DONE: 'SUCCESS',
  NEW_CHAT: 'SUCCESS', MODES_SET: 'SUCCESS', NO_CHANGE: 'SUCCESS', LOGGED_IN: 'SUCCESS',
  CDP_DOWN: 'FAILED', NOT_LOGGED_IN: 'FAILED', NO_COMPOSER: 'FAILED', SEND_FAILED: 'FAILED',
  MODE_NOT_FOUND: 'FAILED', TIMEOUT: 'FAILED', BAD_ARGS: 'FAILED', BROWSER_MISSING: 'FAILED',
  INTERNAL: 'FAILED',
};

function makeEmitter(spec, binding, cdpUrl) {
  return function emit(code, extra = {}) {
    const env = {
      protocol_version: PROTOCOL_VERSION,
      ok: (STATES[code] || (SUCCESS.has(code) ? 'SUCCESS' : 'FAILED')) === 'SUCCESS',
      code,
      state: STATES[code] || (SUCCESS.has(code) ? 'SUCCESS' : 'FAILED'),
      target: spec.target,
      cdp_url: cdpUrl,
      request_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      ...extra,
    };
    process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
    process.exit(env.ok ? 0 : 1);
  };
}

// ---------- CDP ----------
function makeCdp(binding) {
  const cdpUrl = `http://127.0.0.1:${binding.cdpPort}`;
  function pingOnce() {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: binding.cdpPort, path: '/json/version', timeout: 1500 }, (res) => {
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
  return { cdpUrl, pingOnce, waitCdp };
}

// 启动浏览器并保持存活。
//
// ★ 关键环境事实（2026-10-07 实测）：在受限宿主里，**前台工具调用结束时它自己拉起的 GUI 子进程会被回收**，
//   所以"起浏览器 → 隔一次调用再操作"会失败。目前只有两条出路：
//     (a) 由用户自己双击启动器（进程挂在资源管理器下，与宿主无关）；
//     (b) **把浏览器连同调用一起放进"后台任务"**——后台任务的进程树在任务结束前一直活着，
//         于是浏览器跨调用存活。本函数默认走 (b) 的配合模式：只负责拉起，
//         让调用方（或 run-*.sh）用长驻命令把它包住。
//   已不再依赖 explorer.exe：实测该通道在当前沙箱里静默失效（返回 0 但不执行）。
async function launch(binding, spec, { timeoutMs = 40000 } = {}) {
  if (!fs.existsSync(binding.browserPath)) return { ok: false, reason: 'browser-missing', path: binding.browserPath };
  const cmdPath = binding.launcher || path.join(STATE_DIR, `start-${spec.target}.cmd`);
  if (fs.existsSync(cmdPath)) {
    await new Promise((resolve) => { execFile('explorer.exe', [cmdPath], { windowsHide: true }, () => resolve()); setTimeout(resolve, 1200); });
  }
  // 兜底：直接 spawn（在同一次调用内可用；跨调用能否存活取决于是否被后台任务包住、或由用户双击）
  const args = [
    `--remote-debugging-port=${binding.cdpPort}`,
    `--user-data-dir=${binding.userDataDir}`,
    `--profile-directory=${binding.profileDirectory}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--start-maximized',
  ];
  if (spec.url) args.push(spec.url);
  const child = spawn(binding.browserPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const ver = await waitCdp(timeoutMs);
  return ver ? { ok: true, browser: ver.Browser } : { ok: false, reason: 'cdp-timeout' };
}

// 干净退出：把 cookie / localStorage 落盘。
// 为什么必须显式关：被宿主强杀的进程不会 flush，登录态可能丢掉。
// 注意 Playwright 的 browser.close() 在 connectOverCDP 下只断开，所以走原始 CDP 命令。
async function closeBrowserCleanly(browser) {
  try {
    const s = await browser.newBrowserCDPSession();
    await s.send('Browser.close').catch(() => {});
  } catch { /* ignore */ }
}

// ---------- 页面 ----------
async function getPage(ctx, spec, { create = true, reuseHost = true } = {}) {
  const host = (() => { try { return new URL(spec.url).host; } catch { return null; } })();
  let page = ctx.pages().find((p) => !/^devtools:/.test(p.url()) && !p.url().startsWith('chrome-extension://')
    && (!reuseHost || !host || p.url().includes(host)));
  if (!page && create) {
    page = ctx.pages().find((p) => !/^devtools:/.test(p.url()) && !p.url().startsWith('chrome-extension://'))
      || (await ctx.newPage());
    await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(spec.settleMs || 5000);
  }
  return page;
}

// ---------- 登录判据 ----------
async function loginState(page, spec) {
  if (spec.login?.probe) {
    const r = await page.evaluate(new Function('spec', spec.login.probe), null).catch(() => null);
    if (r) return r;
  }
  // 通用兜底：页面上还有「登录」按钮 ⇒ 未登录。
  // ★ 光看按钮**不够**：实测混元未登录时会跳到 `aistudio.tencent.com/scan`（扫码登录页），
  //   那个页面上**没有**"登录"按钮，于是被误判成已登录。URL 落在 auth 路径是更强的信号。
  //   但这也只是兜底——每个渠道仍应在 spec.login.probe 给出自己的判据（见 §12.10）。
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e.innerText || '').replace(/\s+/g, ' ').trim();
    const signIn = [...document.querySelectorAll('button,a,[role="button"],div')].filter(vis)
      .some((e) => /^(登录|登入|Sign in|Log in)$/.test(txt(e)));
    const onAuthPage = /\/(scan|login|signin|sign-in|auth|passport|sso)\b/i.test(location.pathname);
    return {
      loggedIn: !signIn && !onAuthPage, via: 'signin-absence+url',
      signInButtonVisible: signIn, onAuthPage, url: location.href,
    };
  });
}

// ---------- 模式（两种形态：toggle 按钮组 / dropdown 下拉） ----------
// spec.modes[i] 形态：
//   { key, label, type:'dropdown', triggerSel, onText, offText, menuSel, itemSel, stateAttr }
//   { key, label, type:'toggle',  sel, onText, offText }   // 用 aria-pressed 或选中类名
// 触发器**不能盲取 first()**：同一个选择器常同时命中"真正带状态的那个"和一个空壳包装层。
// 取法：优先文字等于 onText/offText 的那个；否则退化为第一个有文字可见者。
async function modeTrigger(page, m) {
  const all = page.locator(m.triggerSel);
  const n = await all.count().catch(() => 0);
  const texts = [];
  for (let i = 0; i < n; i++) {
    texts.push((await all.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim());
  }
  for (let i = 0; i < n; i++) if (texts[i] === m.onText || texts[i] === m.offText) return { loc: all.nth(i), text: texts[i], index: i, texts };
  for (let i = 0; i < n; i++) if (texts[i]) return { loc: all.nth(i), text: texts[i], index: i, texts };
  return { loc: all.first(), text: '', index: 0, texts };
}

async function readModes(page, spec) {
  const out = {};
  for (const m of spec.modes || []) {
    if (m.type === 'dropdown') {
      const t = (await modeTrigger(page, m)).text;
      out[m.key] = t === m.onText ? true : (t === m.offText ? false : (t || null));
    } else {
      const h = page.locator(m.sel).filter({ hasText: m.onText }).first();
      const aria = await h.getAttribute('aria-pressed').catch(() => null);
      const cls = (await h.getAttribute('class').catch(() => '')) || '';
      out[m.key] = aria === 'true' ? true
        : (aria === 'false' ? false
          : (m.onClass ? new RegExp(m.onClass).test(cls) : null));
    }
  }
  return out;
}

async function setMode(page, m, want) {
  if (m.type === 'dropdown') {
    const picked = await modeTrigger(page, m);
    const trig = picked.loc;
    const before = picked.text;
    if (before === (want ? m.onText : m.offText)) return { key: m.key, changed: false, now: before };
    // ★ 触发器压根不在页面上 ⇒ 立刻如实报告，别去点一个不存在的东西白等 8s。
    //   实测（2026-10-07 混元）：档位控件**只存在于落地页**，进了会话视图就整个没有
    //   （querySelectorAll('.paint-button') === 0）。此时"设档位"是物理上做不到的事，
    //   我们要的是一个诚实的 err，而不是一次超时 + 一句含糊的 changed:false。
    if (!picked.texts.length) {
      return { key: m.key, changed: false, err: 'trigger-absent', before, hint: '该模式下触发器不在当前页面（例如档位只在落地页可选）' };
    }
    // ★ 点之前先归零。触发器常见是**开合型（toggle）**：若上一轮把菜单开在那儿没关，
    //   这一下点下去是把菜单**关掉**，然后找选项会白等到 click 超时。
    //   实测（2026-10-07 混元）：菜单浮层关着时仍常驻 DOM（0×0），所以"点开没点开"
    //   不能靠元素存在与否判断，只能先保证起点是关的。Escape 顺带还能关掉落地弹窗。
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
    await trig.click({ timeout: 8000 }).catch(() => {});
    await sleep(m.menuWaitMs || 900);
    const menuSel = m.menuSel || '[role="menu"]';
    const itemSel = m.itemSel || '[role="menuitemcheckbox"]';
    const item = page.locator(`${menuSel} ${itemSel}`)
      .filter({ hasText: want ? m.onText : m.offText }).first();
    let n = await item.count().catch(() => 0);
    if (!n) {
      // 开菜单是异步的，再等一轮
      await sleep(900);
      n = await item.count().catch(() => 0);
    }
    if (!n) {
      // ★ 失败要能自证：分清"菜单根本没开" / "开了但选项文案变了"
      const diag = await page.evaluate(({ menuSel, itemSel }) => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const txt = (e) => (e.innerText || '').replace(/\s+/g, ' ').trim();
        const menus = [...document.querySelectorAll(menuSel)].filter(vis).map((e) => ({
          cls: String(e.className || '').slice(0, 60),
          items: [...e.querySelectorAll(itemSel)].filter(vis).map((x) => txt(x).slice(0, 40)).slice(0, 10),
        }));
        return { menuCount: menus.length, menus };
      }, { menuSel, itemSel }).catch((e) => ({ err: e.message }));
      return { key: m.key, changed: false, err: 'menu-item-not-found', before, diag };
    }
    await item.click({ timeout: 8000 }).catch(() => {});
    await sleep(m.settleMs || 700);
    // ★ 回读：先看 stateAttr，再退回触发器文字
    const st = m.stateAttr ? await item.getAttribute(m.stateAttr).catch(() => null) : null;
    const after = (await trig.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const ok = st ? (st === 'checked') === !!want : (after === (want ? m.onText : m.offText));
    return { key: m.key, changed: true, before, after, attr: st, ok };
  }
  // toggle
  const el = page.locator(m.sel).filter({ hasText: m.onText }).first();
  const aria = await el.getAttribute('aria-pressed').catch(() => null);
  if (aria === String(!!want)) return { key: m.key, changed: false, now: !!want };
  await el.click({ timeout: 8000 }).catch(() => {});
  await sleep(m.settleMs || 600);
  const aria2 = await el.getAttribute('aria-pressed').catch(() => null);
  return { key: m.key, changed: true, attr: aria2, ok: aria2 === String(!!want) };
}

async function applyModes(page, spec, wants) {
  const before = await readModes(page, spec);
  const log = [];
  for (const m of spec.modes || []) {
    const want = wants[m.key];
    if (want === undefined || want === null) continue;
    if (before[m.key] === want) continue;
    log.push(await setMode(page, m, want));
    await sleep(400);
  }
  const after = await readModes(page, spec);
  const satisfied = Object.entries(wants).every(([k, v]) => v === undefined || v === null || after[k] === v);
  return { before, after, log, satisfied };
}

// ---------- 新对话 ----------
async function newChat(page, spec) {
  const texts = spec.newChat?.texts || ['新对话', '新建对话', '开启新对话', 'New chat'];
  const before = { url: page.url(), ...(await snapshot(page, spec)) };
  // ★ 已经是"空会话"（页面上一条助手消息都没有）就**没必要点**。
  //   踩过（2026-10-07 混元）：ask 在刚落地的首页上跑 newChat，点什么都不会变，
  //   旧逻辑于是报 ok:false —— 但真相是"无需动作"，不是"没生效"。
  //   这个假阴性会让 ask 的信封看起来可疑，还会让 new 命令误报失败。
  //   注意 via 会写进信封：若某渠道的 assistant 选择器配错了（永远 count=0），
  //   你会看到它一直走 already-fresh，这就是线索。
  if (before.count === 0) return { ok: true, via: 'already-fresh', url: before.url, before, after: before };
  for (const t of texts) {
    const loc = page.getByText(t, { exact: true });
    const n = await loc.count().catch(() => 0);
    if (!n) continue;
    // 逐个候选点，点完回读校验（同一文案常命中多个包装层，点外层会静默失败）
    for (let i = 0; i < Math.min(n, 3); i++) {
      await loc.nth(i).click({ timeout: 6000 }).catch(() => {});
      await sleep(spec.newChat?.settleMs || 2200);
      const now = { url: page.url(), ...(await snapshot(page, spec)) };
      if (now.url !== before.url || now.count < before.count) {
        return { ok: true, via: t, index: i, url: now.url, before, after: now };
      }
    }
  }
  return { ok: false, url: page.url(), before };
}

function wantNewChat(args) {
  if (args['no-new'] === true) return false;
  if (args.new === 'off' || args.new === false) return false;
  return true;
}

// ---------- 发送 ----------
// 两种提交方式：Enter（多数站点）或**点发送按钮**（千问这类，回车不提交）。
// 判"已提交"不能看输入框是否为空：富文本编辑器的 placeholder 是真实节点，
// 空白时 innerText 会是「向千问提问」，永远不为空。用"内容不再等于我们输入的那串"作判据。
async function composerText(loc) {
  const t = await loc.innerText().catch(() => null);
  if (t !== null && t !== '') return t.replace(/\s+/g, ' ').trim();
  const v = await loc.inputValue().catch(() => '');
  return String(v || '').replace(/\s+/g, ' ').trim();
}

async function sendText(page, spec, text, { baseline = null } = {}) {
  const c = spec.composer;
  const loc = page.locator(c.sel).first();
  const n = await loc.count().catch(() => 0);
  if (!n) return { sent: false, reason: 'no-composer', sel: c.sel };
  await loc.click({ timeout: 10000 }).catch(() => {});
  await sleep(250);
  if (c.kind === 'contenteditable') {
    // ProseMirror 一类编辑器用 fill() 不生效（它监听 beforeinput/输入事件），insertText 才模拟真实输入
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.insertText(text);
  } else {
    await loc.fill(text);
  }
  await sleep(500);
  const pending = await composerText(loc);

  let how = 'enter';
  if (c.sendButton) {
    how = 'button';
    const btn = page.locator(c.sendButton).last();
    // 输入后按钮往往要等一拍才 enable，硬点会点到一个 disabled 的按钮（静默失败）
    for (let i = 0; i < 12; i++) {
      if (!(await btn.isDisabled().catch(() => false))) break;
      await sleep(300);
    }
    await btn.click({ timeout: 8000 }).catch(() => {});
  } else {
    await loc.press(c.sendKey || 'Enter');
  }
  await sleep(1600);

  const after = await composerText(loc);
  const btnDisabled = c.sendButton ? await page.locator(c.sendButton).last().isDisabled().catch(() => null) : null;
  let sent = after !== pending || btnDisabled === true;

  // ★ 交叉验证：输入框状态**不足以**判定"没发出去"。
  //   实测（2026-10-07 千问）：回车其实已提交，但输入框没清空 ⇒ 单看输入框会误报 SEND_FAILED，
  //   而答案其实正在生成。正向信号是"助手容器变多了"。
  let viaBaseline = false;
  if (!sent && baseline) {
    for (let i = 0; i < 8; i++) {
      const s = await snapshot(page, spec);
      if (s.count > baseline.count) { sent = true; viaBaseline = true; break; }
      await sleep(500);
    }
  }
  return { sent, how, viaBaseline, pendingLen: pending.length, composerLenAfter: after.length, composerAfter: after.slice(0, 40) };
}

// ---------- 快照 / 等待完成 ----------
// 只看**助手回复容器**：整页 innerText 会被侧栏动态文字拖到超时。
//
// assistant 支持两级选择器：
//   { sel }                    —— 容器即正文
//   { sel, textSel }           —— 容器负责"定位这一条消息"，textSel 负责"只取正文"
// 为什么需要第二级：千问的答题卡片 [class*="chat-answers-card-wrap"] 里除了正文，
// 还塞了"好的，交给工作助理模式继续完成"这类推荐按钮文案，直接取容器文本会把噪声带进答案。
async function snapshot(page, spec) {
  return page.evaluate(({ sel, textSel }) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = (s) => (s || '').replace(/\u200b/g, '').trim();
    const list = [...document.querySelectorAll(sel)].filter(vis);
    let text = '';
    if (list.length) {
      const last = list[list.length - 1];
      if (textSel) {
        const parts = [...last.querySelectorAll(textSel)].filter(vis).map((e) => clean(e.innerText));
        text = parts.filter(Boolean).join('\n\n');
      }
      if (!text) text = clean(last.innerText);
    }
    return { count: list.length, text };
  }, { sel: spec.assistant.sel, textSel: spec.assistant.textSel || null })
    .then((s) => ({ ...s, text: dropNoiseLines(s.text, spec.assistant.dropLines) }));
}

// 行级噪声过滤：容器里除了正文，常混有 UI 推荐按钮的文案（不是模型输出）。
// 用 dropLines 精确点名，别写宽泛正则——宽正则会连正文一起吃掉。
function dropNoiseLines(text, patterns) {
  if (!text || !patterns || !patterns.length) return text;
  const res = patterns.map((p) => new RegExp(p));
  return text.split('\n').filter((line) => !res.some((r) => r.test(line.trim()))).join('\n').trim();
}

async function generating(page, spec) {
  if (!spec.busy?.sel) return false;
  return page.locator(spec.busy.sel).filter({ visible: true }).count().then((n) => n > 0).catch(() => false);
}

// 三版判据的最终版：
//   v1 整页 innerText        → 永不收敛（侧栏有动态文字）
//   v2 "比上一次更长"         → 新回复比上一条短时永远判不出来
//   v3 容器级文本 + 发送前基线 → 正确
async function waitForDone(page, spec, { timeoutMs = 300000, stableMs = 4000, minMs = 1500, baseline = null } = {}) {
  const t0 = Date.now();
  const base = baseline || (await snapshot(page, spec));
  let lastText = base.text;
  let started = false;
  let stableSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    const s = await snapshot(page, spec);
    if (!started && (s.count > base.count || (s.text && s.text !== base.text))) { started = true; stableSince = Date.now(); }
    if (s.text !== lastText) { lastText = s.text; stableSince = Date.now(); continue; }
    const elapsed = Date.now() - t0;
    if (started && lastText && !(await generating(page, spec)) && elapsed >= minMs && Date.now() - stableSince >= stableMs) {
      return { done: true, elapsedMs: elapsed, chars: lastText.length, started };
    }
  }
  return { done: false, elapsedMs: Date.now() - t0, chars: lastText.length, started, reason: 'timeout' };
}

async function readLast(page, spec, { userText = null } = {}) {
  const s = await snapshot(page, spec);
  if (s.text) return { via: spec.assistant.sel, count: s.count, text: s.text };
  const all = await page.evaluate(() => document.body.innerText || '');
  if (userText && all.includes(userText)) {
    const i = all.lastIndexOf(userText);
    return { via: 'tail-slice', count: null, text: all.slice(i + userText.length).trim() };
  }
  return { via: 'whole-body', count: null, text: all.trim() };
}

async function conversationId(page, spec) {
  if (spec.conversationId?.urlPattern) {
    const m = new RegExp(spec.conversationId.urlPattern).exec(page.url());
    if (m) return m[1];
  }
  return page.title() || null;
}

// ---------- 信封外的会话元数据 ----------
const metaFile = (spec) => path.join(STATE_DIR, `${spec.target}-tabs.json`);
const readMeta = (spec) => readJson(metaFile(spec)) || {};
const writeMeta = (spec, obj) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(metaFile(spec), JSON.stringify({ ...obj, ts: new Date().toISOString() }, null, 2));
};

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) out[k] = true;
      else { out[k] = v; i++; }
    } else out._.push(a);
  }
  return out;
}

function modesFromArgs(args, spec) {
  const wants = {};
  for (const m of spec.modes || []) {
    const v = args[m.key];
    if (v === undefined) { wants[m.key] = spec.defaults?.[m.key] ?? null; continue; }
    wants[m.key] = !(v === 'off' || v === false || v === 'false');
  }
  return wants;
}

export function runChannel(spec) {
  const binding = resolveBinding(spec);
  const { cdpUrl, pingOnce, waitCdp } = makeCdp(binding);
  const emit = makeEmitter(spec, binding, cdpUrl);

  async function withPage({ create = true, reuseHost = true } = {}) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await getPage(ctx, spec, { create, reuseHost });
    return { browser, ctx, page };
  }

  async function ensureBrowser() {
    if (await pingOnce()) return { launched: false };
    const r = await launch(binding, spec);
    if (!r.ok) emit(r.reason === 'browser-missing' ? 'BROWSER_MISSING' : 'CDP_DOWN', {
      ...r,
      hint: '浏览器没起来。两条路：(a) 用户双击启动器；(b) 用后台任务把启动命令包住（见 channel-kit 注释）。',
    });
    return { launched: true, browser: r.browser };
  }

  const CMDS = {
    async doctor() {
      const ver = await pingOnce();
      const cfg = readJson(CONFIG_FILE);
      emit('OK', {
        binding, configFile: CONFIG_FILE, configExists: !!cfg, hasTargets: !!(cfg && cfg.targets),
        browserExists: fs.existsSync(binding.browserPath),
        profileExists: fs.existsSync(binding.userDataDir),
        cdpPortListens: !!ver, browser: ver ? ver.Browser : null,
        url: spec.url, modes: (spec.modes || []).map((m) => ({ key: m.key, label: m.label, type: m.type })),
        composerSel: spec.composer.sel, assistantSel: spec.assistant.sel,
      });
    },

    async status() {
      const ver = await pingOnce();
      if (!ver) return emit('CDP_DOWN', { hint: `跑：node scripts/${spec.target}.mjs launch`, binding });
      const { browser, page } = await withPage({ create: false });
      const st = page ? await loginState(page, spec) : { loggedIn: false, via: 'no-page' };
      const modes = page ? await readModes(page, spec) : null;
      await browser.close().catch(() => {});
      emit('OK', { browser: ver.Browser, binding, pageUrl: page ? page.url() : null, ...st, modes });
    },

    async launch(args) {
      if (await pingOnce()) return emit('LAUNCHED', { reused: true, cdp_url: cdpUrl });
      const r = await launch(binding, spec, { timeoutMs: Number(args.timeout || 40000) });
      if (!r.ok) return emit(r.reason === 'browser-missing' ? 'BROWSER_MISSING' : 'CDP_DOWN', r);
      emit('LAUNCHED', { reused: false, browser: r.browser, binding });
    },

    async modes(args) {
      await ensureBrowser();
      const { browser, page } = await withPage();
      if (!page) { await browser.close().catch(() => {}); return emit('NO_COMPOSER'); }
      if (spec.modes.every((m) => args[m.key] === undefined) && !args.set) {
        const m = await readModes(page, spec);
        await browser.close().catch(() => {});
        return emit('OK', { modes: m });
      }
      const r = await applyModes(page, spec, modesFromArgs(args, spec));
      await browser.close().catch(() => {});
      emit(r.satisfied ? 'MODES_SET' : 'NO_CHANGE', r);
    },

    async new(args) {
      await ensureBrowser();
      const { browser, page } = await withPage();
      if (!page) { await browser.close().catch(() => {}); return emit('NO_COMPOSER'); }
      const r = await newChat(page, spec);
      const cid = await conversationId(page, spec);
      await browser.close().catch(() => {});
      if (!r.ok) return emit('SEND_FAILED', { reason: 'new-chat-not-effective', ...r });
      emit('NEW_CHAT', { conversation_id: cid, ...r });
    },

    async send(args) {
      const text = typeof args.text === 'string' ? args.text : (args._[1] || '');
      if (!text) return emit('BAD_ARGS', { hint: '需要 --text "..."' });
      await ensureBrowser();
      const { browser, page } = await withPage();
      if (!page) { await browser.close().catch(() => {}); return emit('NO_COMPOSER'); }
      const ls = await loginState(page, spec);
      if (ls.loggedIn === false && spec.requireLogin !== false) { await browser.close().catch(() => {}); return emit('NOT_LOGGED_IN', ls); }
      const nc = wantNewChat(args) ? await newChat(page, spec) : null;
      const md = await applyModes(page, spec, modesFromArgs(args, spec));
      const base = await snapshot(page, spec);
      const s = await sendText(page, spec, text, { baseline: base });
      const cid = await conversationId(page, spec);
      await browser.close().catch(() => {});
      if (!s.sent) return emit('SEND_FAILED', { ...s, modes: md.after });
      writeMeta(spec, { conversation_id: cid, url: page.url(), lastPrompt: text, baseline: base });
      emit('SENT', { conversation_id: cid, url: page.url(), submitted: true, modes: md.after, modeLog: md.log, baseline: base, newChat: nc });
    },

    async wait(args) {
      await ensureBrowser();
      const { browser, page } = await withPage({ create: false });
      if (!page) { await browser.close().catch(() => {}); return emit('NO_COMPOSER'); }
      const meta = readMeta(spec);
      const r = await waitForDone(page, spec, {
        timeoutMs: Number(args.timeout || 300000),
        stableMs: Number(args.stable || 4000),
        baseline: meta.baseline || null,
      });
      await browser.close().catch(() => {});
      emit(r.done ? 'DONE' : 'TIMEOUT', { conversation_id: await conversationId(page, spec), ...r });
    },

    async read(args) {
      await ensureBrowser();
      const { browser, page } = await withPage({ create: false });
      if (!page) { await browser.close().catch(() => {}); return emit('NO_COMPOSER'); }
      const meta = readMeta(spec);
      const r = await readLast(page, spec, { userText: typeof args.after === 'string' ? args.after : meta.lastPrompt });
      const cid = await conversationId(page, spec);
      await browser.close().catch(() => {});
      if (args.md) {
        fs.mkdirSync(path.dirname(String(args.md)), { recursive: true });
        fs.writeFileSync(String(args.md), `${r.text}\n`);
        return emit('OK', { conversation_id: cid, via: r.via, chars: r.text.length, savedMarkdown: String(args.md) });
      }
      emit('OK', { conversation_id: cid, via: r.via, blocks: r.count, chars: r.text.length, text: r.text });
    },

    // 复合命令：一次调用跑完全链路（受限宿主下最稳）
    async ask(args) {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) return emit('BAD_ARGS', { hint: '需要 --text "..."' });
      await ensureBrowser();
      const { browser, page } = await withPage();
      if (!page) { await browser.close().catch(() => {}); return emit('NO_COMPOSER'); }
      const ls = await loginState(page, spec);
      if (ls.loggedIn === false && spec.requireLogin !== false) { await browser.close().catch(() => {}); return emit('NOT_LOGGED_IN', ls); }
      const nc = wantNewChat(args) ? await newChat(page, spec) : null;
      const md = await applyModes(page, spec, modesFromArgs(args, spec));
      const base = await snapshot(page, spec);
      const s = await sendText(page, spec, text, { baseline: base });
      if (!s.sent) { await browser.close().catch(() => {}); return emit('SEND_FAILED', { ...s, modes: md.after }); }
      const w = await waitForDone(page, spec, { timeoutMs: Number(args.timeout || 300000), stableMs: Number(args.stable || 4000), baseline: base });
      const r = await readLast(page, spec, { userText: text });
      const cid = await conversationId(page, spec);
      writeMeta(spec, { conversation_id: cid, url: page.url(), lastPrompt: text, baseline: base });
      let savedMarkdown = null;
      if (args.md) {
        savedMarkdown = String(args.md);
        fs.mkdirSync(path.dirname(savedMarkdown), { recursive: true });
        fs.writeFileSync(savedMarkdown, `${r.text}\n`);
      }
      if (args.close) await closeBrowserCleanly(browser);
      await browser.close().catch(() => {});
      emit(w.done ? 'OK' : 'TIMEOUT', {
        conversation_id: cid, url: page.url(), modes: md.after, modeLog: md.log, newChat: nc,
        submitted: s.sent, replyVia: r.via, chars: r.text.length, elapsedMs: w.elapsedMs, done: w.done,
        savedMarkdown, text: r.text,
      });
    },

    // 关掉浏览器但先把 cookie/localStorage 落盘（登录后必须走这条）
    async quit() {
      const { browser } = await withPage({ create: false });
      await closeBrowserCleanly(browser);
      await sleep(2500);
      emit('OK', { closed: true, note: '已发送 Browser.close，凭证已落盘' });
    },

    async dump() {
      await ensureBrowser();
      const { browser, page } = await withPage({ create: false });
      if (!page) { await browser.close().catch(() => {}); return emit('NO_COMPOSER'); }
      const d = await page.evaluate(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const txt = (e) => (e.innerText || '').replace(/\s+/g, ' ').trim();
        const rows = [];
        for (const e of document.querySelectorAll('button,[role="button"],[aria-haspopup],div,span')) {
          if (!vis(e) || e.children.length > 4) continue;
          const t = txt(e);
          if (!t || t.length > 30) continue;
          rows.push({ tag: e.tagName.toLowerCase(), cls: String(e.className || '').slice(0, 80), pop: e.getAttribute('aria-haspopup') || '', exp: e.getAttribute('aria-expanded') || '', t });
        }
        return rows.slice(0, 70);
      });
      await browser.close().catch(() => {});
      emit('OK', { url: page.url(), rows: d });
    },
  };

  async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    if (!cmd || cmd === 'help' || !CMDS[cmd]) {
      return emit('BAD_ARGS', { target: spec.target, cmds: Object.keys(CMDS), usage: `node scripts/${spec.target}.mjs <cmd> [--flags]` });
    }
    try {
      await CMDS[cmd](parseArgs(argv.slice(1)));
    } catch (e) {
      return emit('INTERNAL', { error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4) });
    }
  }
  main();
}

export { launch, closeBrowserCleanly };
