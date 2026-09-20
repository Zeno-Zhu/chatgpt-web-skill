// chatgpt-web · 页面交互层（选择器与注入逻辑的唯一实现处之一，与 references/chatgpt-dom.md 对应）
//
// 为什么单独一个文件：`chatgpt.mjs`（普通对话）与生图任务都要"往 composer 里注入文本并提交"，
// 选择器与注入方式必须只有一份实现，否则改版时必然出现改一处漏一处。
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
  // 文档附件输入框。页面上还有图片/视频专用输入（upload-photos / upload-media / upload-camera /
  // upload-media-files），它们**不渲染文档 chip**。2026-09-20 实测：用 `input[type='file']` 的
  // `.first()` 会随 DOM 顺序命中"照片"输入框 → 文件被接收但 chip 不出现 → 报 attachment-not-confirmed。
  fileInput: '#upload-files',
  fileInputFallback: "input[type='file']:not([accept])",
  // 生图结果里的图片元素（只有**前台**标签页才会渲染，见 references/chatgpt-dom.md §7）
  generatedImage: "img[src*='estuary/content'], img[src*='/backend-api/']",
  // 图片的原生下载入口。2026-09-20 实测：当前 UI **没有**这个按钮
  // （图片 overlay 只有 编辑图片 / 分享此图片；会话"更多操作"里也没有下载），
  // 所以走 native 模式会如实返回 NATIVE_ACTION_UNAVAILABLE —— 留着它是因为 UI 一旦加上就能用。
  // 注意必须排除无关的"下载应用"（Download app）按钮：宽匹配 */下载/ 会命中它，
  // 于是点了它、等 download 事件超时，错报成 DOWNLOAD_EVENT_TIMEOUT（实测踩到过）。
  imageDownloadButton: [
    "button[data-testid*='download' i]",
    "button[aria-label='下载']",
    "button[aria-label='Download']",
    "button[aria-label*='下载图片']",
    "button[aria-label*='Download image']",
    "[data-testid^='image-gen-overlay'] button[aria-label*='下载']",
    "[data-testid^='image-gen-overlay'] button[aria-label*='Download']",
  ].join(', '),
};

// 附件 chip 检测。
// 2026-09-20 实测坑：ChatGPT 会对**同名附件**去重重命名（attach.md → attach(2).md），
// 而草稿里的附件会跨"新聊天"导航保留。用精确文件名匹配就会 inForm=0 → 误报 attachment-not-confirmed。
// 所以匹配必须容忍 `(n)` 后缀，并把"被重命名"当作"草稿里本来就有一个同名附件"的证据上报。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function attachmentNameRe(name) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  return new RegExp(`${escapeRe(stem)}(?:\\(\\d+\\))?${escapeRe(ext)}`, 'i');
}

export async function probeAttachments(page, names) {
  const res = await page.evaluate(() => {
    const form = document.querySelector('form');
    const inputs = [...document.querySelectorAll("input[type='file']")].map((el) => (el.files ? el.files.length : 0));
    return { formTxt: form ? (form.innerText || '') : '', bodyTxt: document.body.innerText || '', inputFiles: inputs.reduce((a, b) => a + b, 0) };
  });
  const inForm = names.filter((n) => attachmentNameRe(n).test(res.formTxt)).length;
  const inBody = names.filter((n) => attachmentNameRe(n).test(res.bodyTxt)).length;
  const renamed = names.some((n) => attachmentNameRe(n).test(res.formTxt) && !res.formTxt.includes(n));
  return { inForm, inBody, inputFiles: res.inputFiles, renamed };
}

// 把附件交给**文档**输入框（而不是图片/视频输入框）。返回实际用的通道，便于诊断。
export async function setDocumentFiles(page, absPaths) {
  const doc = page.locator(SELECTORS.fileInput).first();
  if (await doc.count()) { await doc.setInputFiles(absPaths); return { input: SELECTORS.fileInput }; }
  const noAccept = page.locator(SELECTORS.fileInputFallback).first();
  if (await noAccept.count()) { await noAccept.setInputFiles(absPaths); return { input: SELECTORS.fileInputFallback }; }
  const any = page.locator("input[type='file']").first();
  if (await any.count()) {
    await any.setInputFiles(absPaths);
    return { input: 'first-file-input', warning: 'media-input-only', hint: '只找到图片/视频输入框，文档 chip 可能不渲染' };
  }
  return { error: 'file-input-not-found' };
}

// 页面内函数（序列化后送进浏览器执行）
const JS = {
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
  // 发送按钮是否被 UI 判为不可用：附件上传未完成时 `disabled` 属性是 false，但 `aria-disabled="true"`，
  // 此时坐标点击会被忽略（2026-09-20 Windows 实测）。判定必须同时看两者。
  sendBlocked: () => {
    const btn = document.querySelector("button[data-testid='send-button']");
    if (!btn) return null;
    return {
      disabledAttr: !!btn.disabled,
      ariaDisabled: btn.getAttribute('aria-disabled') === 'true',
      disabled: !!(btn.disabled || btn.getAttribute('aria-disabled') === 'true'),
    };
  },
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

export const insertText = (page, text) => page.evaluate(JS.insertText, text);
export const composerText = (page) => page.evaluate(JS.composerText);
export const sendInfo = (page) => page.evaluate(JS.sendInfo);
export const sendBlocked = (page) => page.evaluate(JS.sendBlocked);
export const lastAssistant = (page) => page.evaluate(JS.lastAssistant);

// 注入文本并回读校验（ProseMirror 是异步受控组件，读一次就断言不算）
export async function fillComposer(page, text, { pollMs = 150, tries = 20 } = {}) {
  const r = await insertText(page, text);
  if (!r.ok) return { ok: false, error: r.error };
  const want = Math.min(3, text.trim().length);
  let got = '';
  for (let i = 0; i < tries; i++) {
    got = await composerText(page);
    if (got && got.trim().length >= want) break;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  if (!got || got.trim().length < want) return { ok: false, error: 'composer-not-filled', composerText: got, wanted: want };
  return { ok: true };
}

// 等发送按钮真正可用（附件上传完成）。返回是否等到。
export async function waitSendReady(page, { tries = 40, pollMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const b = await sendBlocked(page);
    if (!b || !b.disabled) return true;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return false;
}

// 提交消息：按钮优先，不可用或没生效时回退 Enter（Enter 走编辑器自身提交路径，实测更可靠）。
// 返回 { submitted, attempts }，attempts 保留每一步证据，便于上层判断。
export async function submitComposer(page, { buttonTries = 12, enterTries = 20, attachmentReady = null, pollMs = 500 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const confirm = async (tries) => {
    for (let i = 0; i < tries; i++) {
      const info = await sendInfo(page);
      const ct = await composerText(page);
      const cleared = !ct || ct.trim() === '';
      if (info.stop || cleared) return { ok: true, stop: info.stop, cleared };
      await sleep(pollMs);
    }
    return { ok: false };
  };

  const attempts = [];
  let submitted = false;
  const btnState = await sendBlocked(page);
  if (btnState && btnState.disabled) {
    attempts.push({ via: 'button', skipped: 'aria-disabled', attachmentReady });
  } else if (await page.locator(SELECTORS.send).first().count()) {
    await page.locator(SELECTORS.send).first().click({ force: true }).catch((e) => attempts.push('click-error:' + e.message));
    const r = await confirm(buttonTries);
    attempts.push({ via: 'button', ...r });
    submitted = r.ok;
  }
  if (!submitted) {
    await page.locator(SELECTORS.composer).first().click().catch(() => {});
    await sleep(200);
    await page.keyboard.press('Enter');
    const r = await confirm(enterTries);
    attempts.push({ via: 'enter', ...r });
    submitted = r.ok;
  }
  if (!submitted) {
    await page.keyboard.press('Enter');
    const r = await confirm(enterTries);
    attempts.push({ via: 'enter-retry', ...r });
    submitted = r.ok;
  }
  return { submitted, attempts };
}
