#!/usr/bin/env node
// chatgpt-web CLI · 让任意 agent 用固定命令操控网页版 ChatGPT
// 用法见 SKILL.md 或 `node scripts/chatgpt.mjs help`
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  launchChrome, connect, getPage, isLoggedIn, waitForCompletion, acquireLock, releaseLock,
  SELECTORS, sleep, convIds, readTabs, writeTabs, cdpAlive, CDP_URL, PROFILE, AGENT, CDP_PORT, CHROME,
} from './lib.mjs';

const OUT_DIR = process.env.CHATGPT_OUT_DIR || path.join(process.cwd(), 'chatgpt-out');
const STATE_DIR = path.join(os.homedir(), '.chatgpt-web');
const REQ_DIR = path.join(STATE_DIR, 'requests');
const PROTOCOL_VERSION = 1;

// Token 预算（由与 GPT 的设计讨论确定：按字符，不按行；行数无意义）
const BUDGET = {
  promptSoft: 6000,    // prompt 正文软上限（字符）
  promptHard: 12000,   // 超过必须先压缩/slice/附件
  readDefault: 4000,   // read 默认返回上限（字符）——比 send 预算更值钱
  output: { decision: 1200, review: 2000, generation: null, evidence: 2000 },  // 中文字符
};

// 可重复出现的参数：--file a --file b 必须收集成数组，不能被当成彼此的值
const REPEATABLE = new Set(['file', 'model-name']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k.startsWith('no-')) { out[k.slice(3)] = false; continue; }
      const hasVal = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--');
      const val = hasVal ? argv[++i] : true;
      if (REPEATABLE.has(k)) {
        if (!Array.isArray(out[k])) out[k] = out[k] === undefined ? [] : [out[k]];
        out[k].push(val);
      } else out[k] = val;
    } else out._.push(a);
  }
  return out;
}

// 协议信封：让上层（含未来 IDE 聊天区）只依赖稳定字段，不解析人类文本。
// 形如 { protocol_version, ok, code, request_id, project_id, conversation_id, state, ...payload }
// 采用扁平合并而非嵌套 data，保持既有 `--json` 消费者的兼容性。
const STATES = {
  ok: 'SUCCESS', busy: 'FAILED', timeout: 'FAILED', conversation_drift: 'FAILED',
  auth_required: 'FAILED', rate_limit: 'FAILED', network_error: 'FAILED',
  ui_changed: 'FAILED', empty_response: 'FAILED', no_response_started: 'FAILED',
  NOT_LOGGED_IN: 'FAILED', NO_CDP: 'FAILED',
};

function envelope(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const code = obj.status || obj.error || (obj.ok === false ? 'failed' : 'success');
  return {
    protocol_version: PROTOCOL_VERSION,
    ok: obj.ok !== false,
    code: String(code),
    state: STATES[String(code)] || (obj.ok === false ? 'FAILED' : 'SUCCESS'),
    request_id: obj.requestId ?? null,
    project_id: obj.projectId ?? null,
    conversation_id: obj.conversationId ?? null,
    ...obj,
  };
}

function emit(obj, args) {
  const payload = args['no-envelope'] ? obj : envelope(obj);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else if (payload && payload.text !== undefined) console.log(payload.text);
  else console.log(JSON.stringify(payload, null, 2));
}

// ---------- DOM 操作 ----------
const js = {
  insertText: (text) => {
    const el = document.querySelector('#prompt-textarea')
      || document.querySelector("textarea[name='prompt-textarea']");
    if (!el) return { ok: false, error: 'composer-not-found' };
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { ok: true, len: (el.innerText || el.value || '').length };
  },
  composerText: () => {
    const el = document.querySelector('#prompt-textarea')
      || document.querySelector("textarea[name='prompt-textarea']");
    return el ? (el.innerText || el.value || '') : null;
  },
  sendInfo: () => ({
    send: !!document.querySelector("button[data-testid='send-button']"),
    stop: !!document.querySelector("button[data-testid='stop-button']"),
  }),
  lastAssistant: () => {
    const turns = [...document.querySelectorAll("[data-testid^='conversation-turn-']")];
    const last = turns[turns.length - 1];
    const asst = last?.querySelector("[data-message-author-role='assistant']");
    if (!asst) return null;
    const imgs = [...asst.querySelectorAll('img')]
      .map((i) => ({ src: i.currentSrc || i.src, alt: i.alt || '', w: i.naturalWidth, h: i.naturalHeight }))
      .filter((i) => i.src && !/avatar|profile|emoji|icon/i.test(i.src));
    const codes = [...asst.querySelectorAll('pre')].map((p) => {
      const code = p.querySelector('code');
      const lang = code?.className?.match(/language-([\w+-]+)/)?.[1] || '';
      return { lang, text: (code || p).innerText };
    });
    return { text: asst.innerText || '', imgs, codes, turnIndex: turns.length };
  },
};

async function withPage(fn, { create = true } = {}) {
  const browser = await connect();
  try {
    const page = await getPage(browser, { create });
    if (!page) return { ok: false, error: 'no-chatgpt-tab' };
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdLaunch(args) {
  const r = await launchChrome({ headless: args.headless === true });
  if (r.reason === 'already-running') return { ok: true, launched: false, cdp: CDP_URL };
  if (!r.ok && !CHROME) {
    return {
      ok: false, error: 'chrome-not-found', platform: process.platform,
      hint: '没找到 Chrome/Chromium。装一个浏览器，或用 CHATGPT_CHROME=<可执行文件绝对路径> 指定。',
    };
  }
  return { ok: r.ok, launched: true, cdp: CDP_URL, profile: PROFILE, agent: AGENT };
}

// ---------- 新机器预检 ----------
// 目标：在一台没配置过的电脑上，一条命令告诉 agent 现在能不能用、缺什么、下一步做什么。
// 关键前提：登录态**无法程序化迁移**（Chrome 127+ cookie 为 app-bound 加密，实测迁移后不生效），
// 所以"需要用户登录一次"是正常结果，必须给可操作指引，而不是抛错误。
async function cmdDoctor() {
  const steps = [];
  const add = (name, status, detail, action) => steps.push({ name, status, detail, action });

  // 1) 浏览器可执行文件
  add('browser-binary', CHROME ? 'ok' : 'fail',
    CHROME || `未找到（platform=${process.platform}）`,
    CHROME ? null : '安装 Chrome，或设置 CHATGPT_CHROME=/path/to/chrome');

  // 2) CDP 实例
  const alive = await cdpAlive();
  add('cdp-instance', alive ? 'ok' : 'fail', `${CDP_URL}（agent=${AGENT}, port=${CDP_PORT}）`,
    alive ? null : '运行: chatgpt-web launch');

  // 3) 自动化 profile
  const profileExists = fs.existsSync(PROFILE);
  add('profile', profileExists ? 'ok' : 'warn', PROFILE,
    profileExists ? null : '首次运行自动创建；随后需在打开的窗口登录一次 GPT');

  // 4) 登录态（核心判据）
  let loggedIn = false;
  let currentUrl = null;
  if (alive) {
    try {
      const r = await withPage(async (page) => ({ loggedIn: await isLoggedIn(page), url: page.url() }));
      loggedIn = !!r.loggedIn;
      currentUrl = r.url;
      add('logged-in', loggedIn ? 'ok' : 'needs-user', loggedIn ? `已登录（${r.url}）` : '未登录',
        loggedIn ? null : '让用户在该 Chrome 窗口登录 ChatGPT；登录一次后长期有效');
    } catch (e) {
      add('logged-in', 'unknown', `无法读取页面：${e.message}`, '先修 cdp-instance');
    }
  } else {
    add('logged-in', 'unknown', 'CDP 未启动，无法判断', '先运行 launch');
  }

  // 5) 日常浏览器与 AppleScript 备选通道（只探测，不擅自操控）
  if (process.platform === 'darwin') {
    const hasDaily = fs.existsSync(path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies'));
    add('user-chrome-profile', hasDaily ? 'ok' : 'unknown',
      hasDaily ? '检测到本机 Chrome 日常 profile' : '未检测到',
      '本 skill 用独立自动化 profile，不操控日常浏览器。日常 profile 的登录态无法程序化迁移（Chrome 127+ app-bound 加密，已实测失败），需单独登录一次');
    let ae = 'unreachable';
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('osascript', ['-e', 'tell application "Google Chrome" to get URL of active tab of front window'],
        { stdio: 'pipe', timeout: 4000 });
      ae = 'reachable';
    } catch { /* 未运行或未授权 */ }
    add('applescript-channel', ae === 'reachable' ? 'ok' : 'unknown',
      ae === 'reachable' ? '可读取日常 Chrome（零登录备选通道）' : '无法访问日常 Chrome（未运行或未授权）',
      '备选通道需在 Chrome 勾选「查看 → 开发者 → 允许 Apple 事件中的 JavaScript」；但附件上传不可靠，仅适合纯文本问答');
  }

  const blocking = steps.filter((s) => s.status === 'fail' || s.status === 'needs-user');
  const ready = loggedIn && !!CHROME;
  return {
    ok: true, ready, agent: AGENT, port: CDP_PORT, profile: PROFILE, currentUrl,
    verdict: ready
      ? 'READY：可以直接调用网页版 GPT'
      : (CHROME ? 'NEEDS-USER-ACTION：需要用户完成一次登录' : 'NOT-READY：先解决浏览器缺失'),
    nextAction: ready
      ? 'chatgpt-web ask --text-file <prompt> --json'
      : (!CHROME ? '安装 Chrome，或设置 CHATGPT_CHROME'
        : (!alive ? 'chatgpt-web launch' : '让用户在弹出的 Chrome 窗口登录 ChatGPT，然后重跑 doctor')),
    blocking, steps,
  };
}

async function cmdStatus() {
  const alive = await cdpAlive();
  if (!alive) return { ok: false, cdp: false, hint: 'node scripts/chatgpt.mjs launch' };
  return withPage(async (page) => {
    const loggedIn = await isLoggedIn(page);
    const url = page.url();
    const ids = convIds(url);
    const title = await page.title();
    return { ok: true, cdp: true, loggedIn, url, title, ...ids };
  });
}

async function cmdTabs({ json } = {}) {
  const browser = await connect();
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    const tabs = await Promise.all(pages.map(async (p, i) => ({ i, url: p.url(), title: await p.title() })));
    if (json) return { ok: true, tabs };
    return { ok: true, text: tabs.map((t) => `[${t.i}] ${t.title}  ${t.url}`).join('\n') };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdGoto(args) {
  const url = args._[0];
  if (!url) return { ok: false, error: 'usage: goto <url>' };
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    return { ok: true, url: page.url(), ...convIds(page.url()) };
  });
}

async function cmdNew(args) {
  return withPage(async (page) => {
    const t = readTabs();
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    if (!(await isLoggedIn(page))) return { ok: false, error: 'NOT_LOGGED_IN', url: page.url() };
    t.lastUrl = page.url();
    writeTabs(t);
    return { ok: true, url: page.url(), mode: 'new-chat' };
  });
}

// 进入项目上下文（点击"打开项目首页"，进入项目内新聊天）
async function cmdProject(args) {
  const name = args._[0] || args.name;
  if (!name) return { ok: false, error: 'usage: project <项目名>' };
  return withPage(async (page) => {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    const row = page.locator('div.__menu-item', { hasText: name }).first();
    if (!(await row.count())) return { ok: false, error: 'project-not-found', name };
    await row.hover();
    await sleep(600);
    const openBtn = page.locator('button[aria-label="打开项目首页"]').first();
    if (await openBtn.count()) { await openBtn.click({ force: true }); }
    else { await row.click(); }
    await sleep(3500);
    const ph = await page.locator('#prompt-textarea').getAttribute('aria-label').catch(() => null);
    return { ok: true, url: page.url(), placeholder: ph, ...convIds(page.url()) };
  });
}

async function cmdSend(args) {
  // prompt 可以内联传，也可以从文件读（长 prompt 走文件更安全，避免 shell 转义问题）
  let text = args.text ?? args._.join(' ');
  if (typeof args['text-file'] === 'string') {
    const p = path.resolve(args['text-file']);
    if (!fs.existsSync(p)) return { ok: false, error: 'text-file-not-found', file: p };
    text = fs.readFileSync(p, 'utf8');
  }
  const files = [].concat(args.file || []).filter((f) => typeof f === 'string');
  if (!text && !files.length) return { ok: false, error: 'usage: send --text <...> | --text-file <path> [--file <path> ...]' };

  // ---- Token 预算检查（按字符，不按行）----
  const promptChars = text.length;
  const attachBytes = files.reduce((n, f) => {
    try { return n + fs.statSync(path.resolve(f)).size; } catch { return n; }
  }, 0);
  const budget = {
    promptChars, promptCharsSoft: BUDGET.promptSoft, promptCharsHard: BUDGET.promptHard,
    attachmentBytes: attachBytes,
  };
  if (promptChars > BUDGET.promptHard) {
    return {
      ok: false, error: 'prompt-over-hard-budget', ...budget,
      hint: '超过硬上限：先压缩上下文、只截取相关段落，或改用 --file 走附件（附件解决传输，不减少信息量）',
    };
  }
  if (promptChars > BUDGET.promptSoft) {
    budget.warning = `prompt ${promptChars} 字符超过软上限 ${BUDGET.promptSoft}：考虑只保留必须事实`;
  }

  // ---- 幂等发送：同一个 request_id 绝不重复发送 ----
  const requestId = typeof args['request-id'] === 'string' ? args['request-id'] : null;
  if (requestId) {
    const prev = reqLoad(requestId);
    if (prev && prev.sent) {
      return {
        ok: true, idempotent: true, requestId, ...budget,
        submitted: prev.submitted, deduplicated: true,
        conversationId: prev.conversationId ?? null, baselineAssistant: prev.baselineAssistant,
        note: '该 request_id 已发送过，本次未重复发送（防止断线重试造成重复消息）',
      };
    }
  }

  return withPage(async (page) => {
    if (!(await isLoggedIn(page))) return { ok: false, error: 'NOT_LOGGED_IN', url: page.url() };
    const before = await page.locator(SELECTORS.assistant).count();   // assistant 消息数基线（无歧义）

    let uploaded = [];
    if (files.length) {
      const abs = files.map((f) => path.resolve(f));
      for (const f of abs) if (!fs.existsSync(f)) return { ok: false, error: 'file-not-found', file: f };
      const input = page.locator("input[type='file']").first();
      if (!(await input.count())) return { ok: false, error: 'file-input-not-found' };
      await input.setInputFiles(abs);
      uploaded = abs;
      // 等附件 chip 真正渲染完成再发送，否则会发出空附件消息。
      // 检测要宽：只看 form/body 的文本在 UI 忙时会超时（e2e 里实测），
      // 所以同时认"文件已被 input 接收"和"chip 文本出现"两类证据。
      const names = abs.map((f) => path.basename(f));
      let chipReady = false;
      let lastProbe = null;
      for (let i = 0; i < 60; i++) {            // 最长 30s
        lastProbe = await page.evaluate((ns) => {
          const form = document.querySelector('form');
          const formTxt = form ? (form.innerText || '') : '';
          const bodyTxt = document.body.innerText || '';
          const inputs = [...document.querySelectorAll("input[type='file']")]
            .map((el) => (el.files ? el.files.length : 0));
          return {
            inForm: ns.filter((n) => formTxt.includes(n)).length,
            inBody: ns.filter((n) => bodyTxt.includes(n)).length,
            inputFiles: inputs.reduce((a, b) => a + b, 0),
          };
        }, names);
        if (lastProbe.inForm >= names.length || lastProbe.inBody >= names.length) { chipReady = true; break; }
        await sleep(500);
      }
      if (!chipReady) {
        return {
          ok: false, error: 'attachment-not-confirmed', uploadedCount: 0,
          expected: names, probe: lastProbe,
          hint: '附件已提交给页面但未确认渲染（可能是上传过慢或 UI 改版）。本次未发送消息，避免发出空附件。',
        };
      }
      await sleep(800);
    }

    if (text) {
      const r = await page.evaluate(js.insertText, text);
      if (!r.ok) return { ok: false, error: r.error };
      // 确认文字真的进入 composer（受控组件可能没吃下 paste 事件）。
      // 必须轮询：ProseMirror 提交内容是异步的，立刻回读会读到空串
      // （2026-09-20 实测：5KB prompt 注入后 100ms 内才生效）。
      const want = Math.min(3, text.trim().length);
      let got = '';
      for (let i = 0; i < 20; i++) {
        got = await page.evaluate(js.composerText);
        if (got && got.trim().length >= want) break;
        await sleep(150);
      }
      if (!got || got.trim().length < want) {
        return { ok: false, error: 'composer-not-filled', composerText: got, wanted: want };
      }
    }
    await sleep(300);

    // 提交：先点发送按钮，未生效则连续两次回退 Enter。
    // 只尝试一次就报失败会漏掉"按钮点击被附件 chip/浮层吃掉"的常见情况。
    const confirm = async (tries = 30) => {
      for (let i = 0; i < tries; i++) {
        const info = await page.evaluate(js.sendInfo);
        const ct = await page.evaluate(js.composerText);
        const cleared = !ct || ct.trim() === '';
        if (info.stop || cleared) return { ok: true, stop: info.stop, cleared };
        await sleep(500);
      }
      return { ok: false };
    };

    const attempts = [];
    let submitted = false;
    const send = page.locator(SELECTORS.send).first();
    if (await send.count()) {
      await send.click({ force: true }).catch((e) => attempts.push('click-error:' + e.message));
      const r = await confirm(20);
      attempts.push({ via: 'button', ...r });
      submitted = r.ok;
    }
    if (!submitted) {
      await page.locator(SELECTORS.composer).first().click().catch(() => {});
      await sleep(200);
      await page.keyboard.press('Enter');
      const r = await confirm(20);
      attempts.push({ via: 'enter', ...r });
      submitted = r.ok;
    }
    if (!submitted) {
      await page.keyboard.press('Enter');   // 第二次 Enter（部分 UI 需要先聚焦后第二次才生效）
      const r = await confirm(20);
      attempts.push({ via: 'enter-retry', ...r });
      submitted = r.ok;
    }

    // 记录本次请求基线：wait 只认"基线之后新增的 assistant 消息"，避免读到历史回答。
    //
    // 注意 URL 会漂移：新聊天先给临时 /c/WEB:<uuid>，几百毫秒后替换为最终 /c/<uuid>。
    // 只记录稳定的最终 UUID；若仍是临时 id，短暂轮询等它定型（最多 4s）。
    let ids = convIds(page.url());
    if (ids.temporary) {
      for (let i = 0; i < 10 && ids.temporary; i++) {
        await sleep(400);
        ids = convIds(page.url());
      }
    }
    const url = page.url();
    const t = readTabs();
    t.lastUrl = url;
    t.baselineAssistant = before;
    if (ids.conversationId && !ids.temporary) t.conversationId = ids.conversationId;
    else delete t.conversationId;   // 拿不到稳定 id 就不要留一个会误报漂移的旧值
    t.sentAt = new Date().toISOString();
    writeTabs(t);
    const result = {
      ok: submitted, submitted, attempts,
      uploaded, uploadedCount: uploaded.length,
      baselineAssistant: before,
      pendingText: submitted ? '' : await page.evaluate(js.composerText),
      url, ...ids, turnsBefore: before,
      requestId, ...budget,
    };
    // 幂等记录：只有确认 submitted 才标记 sent，避免"没发出去"被当成已发送
    if (requestId && submitted) {
      reqSave(requestId, {
        requestId, sent: true, submitted: true, at: new Date().toISOString(),
        conversationId: ids.conversationId && !ids.temporary ? ids.conversationId : null,
        baselineAssistant: before, promptChars, attachmentBytes: attachBytes,
        attachments: uploaded,
      });
    }
    return result;
  });
}

async function cmdWait(args) {
  const timeoutMs = Number(args.timeout || 600) * 1000;
  const pollMs = Number(args.poll || 1000);
  const t = readTabs();
  // 基线优先取 send 记录的 turnsBefore（自动绑定"本次请求"），允许命令行覆盖
  const baselineAssistant = Number(args.baseline ?? t.baselineAssistant ?? 0);
  const expectConversationId = args.conversation || t.conversationId || null;
  return withPage(async (page) => {
    const r = await waitForCompletion(page, {
      timeoutMs, pollMs, baselineAssistant, expectConversationId,
      settleQuietMs: Number(args.quiet || 2000),
      settleStopMs: Number(args.stopQuiet || 1500),
    });
    const ids = convIds(page.url());
    // 消费掉基线：避免下一次 wait 复用过期基线导致漏判
    delete t.baselineAssistant;
    t.lastUrl = page.url();
    writeTabs(t);
    return {
      ok: r.done, done: r.done, status: r.status ?? (r.done ? 'success' : 'unknown'),
      elapsedMs: r.elapsedMs, baselineAssistant, sawStop: !!r.sawStop, sawTarget: !!r.sawTarget,
      text: r.text || '', ...ids,
    };
  });
}

async function cmdRead(args) {
  const saveImages = args.save === true;   // 落盘为显式动作，避免污染硬盘
  // 读取预算：默认只返回前 4k 字符，避免把长回答整篇灌进上层 agent 的上下文。
  // 这是整个设计里最值钱的一层隔离：GPT 可以写很多，dsh 不必全部消费。
  const maxChars = args['max-chars'] === undefined ? BUDGET.readDefault : Number(args['max-chars']);
  return withPage(async (page) => {
    const last = await page.evaluate(js.lastAssistant);
    if (!last) return { ok: false, error: 'no-assistant-message' };
    const full = last.text || '';
    const truncated = maxChars > 0 && full.length > maxChars;
    const text = truncated ? full.slice(0, maxChars) : full;
    const out = { ok: true, text, ...convIds(page.url()), turnIndex: last.turnIndex,
      images: last.imgs.map((i) => i.src), codeBlocks: last.codes.length,
      code: last.codes.map((c) => ({ lang: c.lang, bytes: c.text.length })),
      responseChars: full.length, readChars: text.length, truncated,
      readRatio: full.length ? +(text.length / full.length).toFixed(3) : 1 };
    if (truncated) {
      out.truncatedHint = `仅返回前 ${maxChars} 字符（原文 ${full.length}）。需要更多请用 --max-chars，或按段再读`;
    }
    if (saveImages && last.imgs.length) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const saved = [];
      for (const im of last.imgs) {
        if (!/^https?:/.test(im.src)) continue;
        try {
          const res = await page.request.get(im.src);
          if (!res.ok()) continue;
          const buf = await res.body();
          const ext = /png/.test(im.src) ? 'png' : 'jpg';
          const f = path.join(OUT_DIR, `image-${Date.now()}-${saved.length}.${ext}`);
          fs.writeFileSync(f, buf);
          saved.push(f);
        } catch { /* 忽略单张失败 */ }
      }
      out.savedImages = saved;
    }
    if (args.md) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const f = path.join(OUT_DIR, `answer-${Date.now()}.md`);
      fs.writeFileSync(f, last.text);   // 落盘始终写全文，预算只约束返回给 agent 的部分
      out.savedMarkdown = f;
    }
    // 记录读取指标：read_chars / response_chars 长期接近 1 说明选择性读取没起作用
    if (typeof args['request-id'] === 'string') {
      const prev = reqLoad(args['request-id']);
      if (prev) {
        reqSave(args['request-id'], {
          ...prev, readAt: new Date().toISOString(),
          responseChars: full.length, readChars: text.length,
          readRatio: out.readRatio, savedMarkdown: out.savedMarkdown ?? prev.savedMarkdown ?? null,
        });
      }
    }
    return out;
  });
}

// 选模型：只在明确指定时切换，找不到就如实报告，不静默降级
async function cmdModel(args) {
  const want = args._[0] || args.name;
  return withPage(async (page) => {
    const triggers = [
      "button[aria-label='切换模型']",
      "button[data-testid='model-switcher-dropdown-button']",
      "button[aria-label*='模型']",
    ];
    let opened = false;
    for (const sel of triggers) {
      const t = page.locator(sel).last();
      if (await t.count()) { await t.click({ force: true }).catch(() => {}); opened = true; break; }
    }
    if (!opened) return { ok: false, error: 'model-trigger-not-found' };
    await sleep(1200);
    const items = await page.locator("[role='menuitem'], [role='menuitemradio'], [role='option']").allInnerTexts();
    const clean = items.map((s) => s.trim()).filter(Boolean);
    if (!want) return { ok: true, options: clean };
    const target = page.locator("[role='menuitem'], [role='menuitemradio'], [role='option']", { hasText: want }).first();
    if (!(await target.count())) { await page.keyboard.press('Escape'); return { ok: false, error: 'model-not-available', want, options: clean }; }
    await target.click({ force: true });
    await sleep(1200);
    return { ok: true, selected: want, options: clean };
  });
}

// ---------- 路由 Gate ----------
// 目的：把"该不该调用 GPT"从主观感觉变成可复算的判据，并同时给出输出预算。
// 设计依据：与 GPT 的协作协议讨论（2026-09-20）。核心修正是——
// "有测试/编译器能验证"不等于"整体方向正确"，所以必须单列 VerifiabilityGap，
// 且语义验收（测试通过但可能违背真实意图）是独立触发类型。
function routeDecision({ impact, uncertainty, gap, mode = 'auto' }) {
  const dims = { impact, uncertainty, gap };
  // 两种 bypass 先判：它们不是"要不要听 GPT 的判断"，而是直接委托，不需要评分维度。
  // （维度校验必须放在 bypass 之后，否则 `route --mode generation` 会被误判为非法。）
  if (mode === 'generation') {
    return {
      ok: true, mode: 'GENERATION', action: 'delegate', score: null, dimensions: dims,
      outputBudget: BUDGET.output.generation,
      reason: '能力委托：产出量或领域非所长，不需要评分',
    };
  }
  if (mode === 'evidence') {
    return {
      ok: true, mode: 'EXTERNAL_EVIDENCE', action: 'delegate', score: null, dimensions: dims,
      outputBudget: BUDGET.output.evidence,
      reason: '外部事实：结论依赖 dsh 没有可靠来源的当前事实',
    };
  }
  for (const [k, v] of Object.entries(dims)) {
    if (!Number.isInteger(v) || v < 0 || v > 2) {
      return { ok: false, error: `dimension-out-of-range: ${k}=${v}（必须是 0/1/2；委托类请用 --mode generation|evidence）` };
    }
  }
  const score = impact + uncertainty + gap;
  if (score >= 4) {
    return {
      ok: true, mode: 'CONSULT', action: 'consult', score, dimensions: dims,
      outputBudget: BUDGET.output[gap >= 2 ? 'review' : 'decision'],
      consultType: gap >= 2 ? 'SEMANTIC_REVIEW' : 'DECISION',
      reason: `A+U+V=${score} >= 4：影响大或不确定性高或缺少客观验证器`,
    };
  }
  if (score <= 2) {
    return {
      ok: true, mode: 'LOCAL', action: 'proceed', score, dimensions: dims,
      outputBudget: 0,
      reason: `A+U+V=${score} <= 2：本地可判定，调用 GPT 属浪费`,
    };
  }
  return {
    ok: true, mode: 'LOCAL_FIRST', action: 'verify_then_decide', score, dimensions: dims,
    outputBudget: 0,
    reason: `A+U+V=${score} = 3：先做一次廉价本地验证（跑测试/查文档/grep），再复算本 Gate`,
  };
}

async function cmdRoute(args) {
  const pick = (v) => (v === undefined ? undefined : Number(v));
  const r = routeDecision({
    impact: pick(args.impact), uncertainty: pick(args.uncertainty), gap: pick(args.gap),
    mode: args.mode || 'auto',
  });
  if (!r.ok) return r;
  return {
    ...r,
    rubric: {
      impact: '0=单点易撤销 / 1=多文件或影响后续步骤 / 2=架构、用户可见行为、外部副作用、难回滚',
      uncertainty: '0=已有明确答案 / 1=有两个合理方案 / 2=证据冲突或不知哪条路对',
      gap: '0=测试或编译器可完整证明 / 1=只能部分证明 / 2=主要靠语义、产品、架构、审美判断',
    },
    budgets: {
      promptCharsSoft: BUDGET.promptSoft, promptCharsHard: BUDGET.promptHard,
      readCharsDefault: BUDGET.readDefault, outputChars: r.outputBudget,
    },
  };
}

// ---------- request 记录（幂等发送的基础） ----------
function reqPath(id) { return path.join(REQ_DIR, `${id}.json`); }
function reqLoad(id) { try { return JSON.parse(fs.readFileSync(reqPath(id), 'utf8')); } catch { return null; } }
function reqSave(id, obj) {
  fs.mkdirSync(REQ_DIR, { recursive: true });
  fs.writeFileSync(reqPath(id), JSON.stringify(obj, null, 2));
}

// ---------- 方法论 Router（与"该不该问"无关，是"用哪套思维"） ----------
// 默认 NONE。离散信号 + 布尔规则，禁止加权总分（业务阈值需证据，控制流判据不需要）。
// 依据：THINKING.md 第 2 节；F 是前置阻断信号。
function methodRoute(sig) {
  const g = (k) => (sig[k] === undefined ? 0 : Number(sig[k]));
  const keys = ['f', 'v', 'e', 'p', 'a', 'm', 'x'];
  for (const k of keys) {
    const v = Number(sig[k] ?? 0);
    if (!Number.isInteger(v) || v < 0 || v > 2) {
      return { ok: false, error: `signal-out-of-range: ${k}=${sig[k]}（必须是 0/1/2）` };
    }
  }
  const F = g('f'), V = g('v'), E = g('e'), P = g('p'), A = g('a'), M = g('m');
  const domains = [];
  if (V === 2) domains.push('M1');
  if (E === 2) domains.push('M2');
  if (M === 2 && E >= 1) domains.push('M2');
  if (P === 2) domains.push('M3');

  // 1) 前置阻断：事实不足时，先别开始想
  if (F === 2) {
    return {
      ok: true, primary: 'NONE', blocked: true, action: 'verify_first',
      reason: 'F=2：结论高度依赖未验证事实。先 verify/research/experiment，更新事实后重新 Router。',
      guards: [
        '防"垃圾进 M2"：从幸存者样本萃取出漂亮方法论',
        '防"过早进 M1"：事实没搞清，却被解释成价值冲突',
      ],
      signals: sig,
    };
  }
  // 2) Authority 缺口优先于选方法论：补齐信息才能继续
  if (A === 2) {
    return {
      ok: true, primary: 'NONE', operator: 'M4', action: 'ask_user_then_reroute',
      reason: 'A=2：关键答案只能由用户提供，模型无权替代。用 M4 追问技法补齐 Authority 后重新 Router。',
      note: 'Authority-bound 未知不得用假设替代（不得"先假设增长优先继续"）',
      signals: sig,
    };
  }
  // 3) Prompt 杠杆需先过可解性闸门
  if (P === 2 && !domains.length) {
    return {
      ok: true, primary: 'GATE', gate: 'prompt-solvability', action: 'classify_then_route',
      reason: 'P=2：先判断是否真属于提示词/上下文/调用结构问题。资料、工具、模型能力、流程问题 → NONE / 返回流程修复',
      signals: sig,
    };
  }
  const uniq = [...new Set(domains)];
  if (!uniq.length) {
    return {
      ok: true, primary: 'NONE', action: 'proceed',
      reason: '无信号达到主导（或方法论不会改变后续行动）——不用方法论是默认',
      signals: sig,
    };
  }
  if (uniq.length > 1) {
    return {
      ok: true, primary: null, conflict: uniq, action: 'decompose',
      reason: '多个方法论同时达主导：禁止揉成一个"大方法论"，按依赖顺序拆阶段、逐阶段路由；一条 Atomic Action 只允许一个 Primary Method',
      forbidden: uniq.includes('M1') && uniq.includes('M3')
        ? 'M1+M3 同步：一个允许"清晰但无解"，一个面向任务求解，Acceptance 天然冲突' : null,
      signals: sig,
    };
  }
  const primary = uniq[0];
  const reasons = { M1: 'V=2 价值/目标冲突', M2: 'E/M=2 需提炼可迁移机制', M3: 'P=2 提示词或调用结构杠杆' };
  return {
    ok: true, primary, action: 'apply',
    operator: primary === 'M1' ? 'M4' : null,
    reason: reasons[primary], signals: sig,
    acceptance: primary === 'M1'
      ? '核心矛盾已明确 + 关键价值与假设已显性化 + 知道哪些部分无法靠推理消除 + 得到 Decision Boundary 或 end: unresolved-but-clarified'
      : null,
    orderNote: primary === 'M1' ? null : '事实/机制未清时先 M2 → M1；只要可迁移规则则 M2 完成后结束，不为了"深度"追加 M1',
  };
}

async function cmdMethod(args) {
  const r = methodRoute(args);
  if (!r.ok) return r;
  return {
    ...r,
    rubric: {
      f: '0=事实充足 / 1=部分依赖未验证 / 2=结论高度依赖未验证的外部事实或证据质量',
      v: '0=无冲突 / 1=存在但非主导 / 2=价值或目标冲突主导，补事实无法消除',
      e: '0=无需萃取 / 1=部分 / 2=输入主要是案例/经验/流程/失败记录',
      p: '0=无关 / 1=部分 / 2=问题可能靠改提示词或调用结构显著改善',
      a: '0=可自决 / 1=部分 / 2=关键答案只能由用户提供，模型无权替代',
      m: '0=机制清楚 / 1=部分 / 2=知道现象但不知道为什么',
      x: '0=一次性 / 1=可能复用 / 2=结果要跨执行者/跨轮/跨版本继续使用',
    },
    gates: ['G1 Problem Validity（能不能开始）', 'G2 Decision Delta（值不值得继续）', 'G3 Commit（能不能生效）'],
  };
}

// 高层便利命令：send → wait → read 一条龙（等价于顺序调用三个原子命令）
async function cmdAsk(args) {
  const send = await cmdSend(args);
  if (!send.ok) return { ok: false, stage: 'send', ...send };
  const wait = await cmdWait(args);
  if (!wait.ok) return { ok: false, stage: 'wait', send, ...wait };
  const read = await cmdRead({ save: args.save, md: args.md, json: args.json });
  return {
    ok: true,
    url: send.url, projectId: send.projectId, conversationId: send.conversationId,
    uploaded: send.uploaded, elapsedMs: wait.elapsedMs, viaFallback: wait.viaFallback,
    text: read.text, images: read.images, codeBlocks: read.codeBlocks,
    savedImages: read.savedImages, savedMarkdown: read.savedMarkdown,
  };
}

const CMDS = { launch: cmdLaunch, status: cmdStatus, tabs: cmdTabs, goto: cmdGoto,
  new: cmdNew, project: cmdProject, send: cmdSend, wait: cmdWait, read: cmdRead,
  model: cmdModel, ask: cmdAsk, route: cmdRoute, method: cmdMethod, doctor: cmdDoctor };

const HELP = `chatgpt-web · 确定性操控网页版 ChatGPT

  doctor                       新机器预检：能否用 / 缺什么 / 下一步做什么（先跑这个）
  launch                       启动/复用自动化 Chrome（CDP ${CDP_URL}）
  status                       连接状态 + 登录态 + 当前会话 id
  tabs                         列出标签页
  goto <url>                   打开指定会话/项目 URL
  new                          新聊天
  project <项目名>             进入项目上下文（项目内新聊天）
  send --text <内容> [--file f] 发送消息（可带附件）
  wait [--timeout 600]         等待回复完成
  read [--md] [--save]         读取最后一条回答（含图片/代码块）
  ask --text-file f [--file f] 一条龙：send → wait → read
                               ⚠️ 接在**当前活跃会话**里。要开新会话先跑 new，
                                  要指定上下文先跑 goto <url> 或 project <名字>；
                                  否则问题会混进上一个话题（上线前务必确认）
                               注意：返回的 text 受 --max-chars（默认 4000）限制；
                               加 --md 会同时把**全文**落盘到 CHATGPT_OUT_DIR
  model [名称]                 查看或切换模型
  route --impact N --uncertainty N --gap N
                               路由 Gate：算出该不该调用 GPT（0/1/2 三维评分）
                               --mode generation|evidence 走委托 bypass
  method --v N --e N --p N --a N --m N --f N --x N
                               方法论 Router：该用哪套思维（默认 NONE）
                               信号见 THINKING.md 第 2 节

全局：
  --json          输出协议 JSON（含 protocol_version / code / state / request_id）
  --no-envelope   关闭协议信封，只回原始字段
  --request-id X  幂等键：同一 id 重复 send 不会重复发送
  --max-chars N   read 返回上限（默认 4000，原文更长时截断并给出 readRatio）
  --save          落盘图片（写到 CHATGPT_OUT_DIR）
环境：
  CHATGPT_AGENT     实例名（如 trae）→ profile/端口/锁全部隔离，多 agent 可并行
  CHATGPT_CHROME    指定浏览器可执行文件（默认按平台自动探测）
  CHATGPT_CDP_PORT  覆盖端口
  CHATGPT_PROFILE   覆盖 profile 目录
  CHATGPT_OUT_DIR   产物落盘目录`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (!cmd || cmd === 'help' || args.help) { console.log(HELP); return; }
  const fn = CMDS[cmd];
  if (!fn) { console.error(`未知命令: ${cmd}\n\n${HELP}`); process.exit(2); }

  // 会改动会话状态的命令需要互斥，避免多 agent 串线（读到别人的回答）
  const NEEDS_LOCK = new Set(['new', 'project', 'goto', 'send', 'wait', 'read', 'ask']);
  let locked = false;
  try {
    if (NEEDS_LOCK.has(cmd) && args.lock !== false) {
      const l = acquireLock(`${cmd} pid=${process.pid}`);
      if (!l.ok) {
        emit({
          ok: false, status: 'busy',
          error: `另一个任务正占用浏览器：${l.holder.job} (pid ${l.holder.pid}, since ${l.holder.at})`,
          hint: '等待其完成，或用 --no-lock 跳过（并发时可能串线）',
        }, args);
        process.exit(1);
      }
      locked = true;
    }
    const r = await fn(args);
    emit(r, args);
    if (r && r.ok === false) process.exitCode = 1;
  } catch (e) {
    emit({ ok: false, error: e.message }, args);
    process.exitCode = 1;
  } finally {
    if (locked) releaseLock();
  }
}
main();
