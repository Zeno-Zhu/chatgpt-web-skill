// 同一浏览器实例内，为每个调用方固定一个 ChatGPT 标签页。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = process.env.CHATGPT_STATE_DIR || path.join(os.homedir(), '.chatgpt-web');
const gptUrl = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/;

export function slotName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(String(value))) {
    throw new Error('INVALID_SLOT: --slot 只能使用 1–64 位字母、数字、下划线或连字符');
  }
  return String(value);
}

export function slotFile(slot, scope = '') {
  return path.join(stateDir, `tab${scope}-${slot}.json`);
}

export function claimedTargetIds(scope = '') {
  const ids = new Set();
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (!name.startsWith(`tab${scope}-`) || !name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        if (record.targetId) ids.add(record.targetId);
      } catch { /* 损坏的记录不参与选页 */ }
    }
  } catch { /* 状态目录尚不存在 */ }
  return ids;
}

export async function targetId(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const info = await session.send('Target.getTargetInfo');
    return info.targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

async function windowId(session, id) {
  const result = await session.send('Browser.getWindowForTarget', { targetId: id });
  return result.windowId;
}

async function createWindow(browser) {
  const ctx = browser.contexts()[0];
  const session = await browser.newBrowserCDPSession();
  let id = null;
  try {
    const existing = new Set();
    for (const page of ctx.pages()) {
      const pageId = await targetId(page).catch(() => null);
      if (pageId) existing.add(await windowId(session, pageId).catch(() => null));
    }
    ({ targetId: id } = await session.send('Target.createTarget', {
      url: 'https://chatgpt.com/', newWindow: true, focus: false,
    }));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      for (const page of ctx.pages()) {
        if (await targetId(page).catch(() => null) !== id) continue;
        const win = await windowId(session, id);
        if (existing.has(win)) throw new Error('WINDOW_NOT_SEPARATE: 浏览器没有创建独立窗口');
        return { page, targetId: id, windowId: win };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('WINDOW_TARGET_TIMEOUT: 新窗口已创建，但未能取得页面');
  } catch (e) {
    if (id) await session.send('Target.closeTarget', { targetId: id }).catch(() => {});
    throw e;
  } finally {
    await session.detach();
  }
}

export async function selectSlotPage(browser, slot, { create = true, scope = '' } = {}) {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('NO_BROWSER_CONTEXT');
  const file = slotFile(slot, scope);
  let record = null;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次使用 */ }
  if (record?.targetId) {
    for (const page of ctx.pages()) {
      if (!page.isClosed() && await targetId(page).catch(() => null) === record.targetId) {
        if (!record.windowId) throw new Error(`SLOT_LEGACY_TAB: ${slot} 仍是旧版标签页；运行 slot reset --slot ${slot} 后创建独立窗口`);
        const session = await browser.newBrowserCDPSession();
        try {
          const currentWindow = await windowId(session, record.targetId);
          if (currentWindow !== record.windowId) throw new Error(`SLOT_WINDOW_MOVED: ${slot} 的页面已移到另一个窗口`);
        } finally { await session.detach(); }
        return page;
      }
    }
    throw new Error(`SLOT_PAGE_CLOSED: ${slot} 的标签页已关闭；请显式运行 slot reset --slot ${slot} 后重建`);
  }
  if (!create) return null;
  const opened = await createWindow(browser);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ slot, targetId: opened.targetId, windowId: opened.windowId, url: opened.page.url(), createdAt: new Date().toISOString() }, null, 2));
  return opened.page;
}

export async function selectUnclaimedPage(browser, { create = true, scope = '' } = {}) {
  const ctx = browser.contexts()[0];
  const claimed = claimedTargetIds(scope);
  const find = async () => {
    for (const page of ctx.pages().slice().reverse()) {
      if (!gptUrl.test(page.url()) || page.isClosed()) continue;
      if (!claimed.has(await targetId(page).catch(() => null))) return page;
    }
    return null;
  };
  let found = await find();
  if (found) return found;
  if (!create) return null;
  // 启动后页面 URL 可能暂时为空；保留原来的等待窗口，避免重复开页。
  const deadline = Date.now() + (ctx.pages().some((p) => !p.url()) ? 20000 : 0);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    found = await find();
    if (found) return found;
  }
  const page = await ctx.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

export function resetSlot(slot, scope = '') {
  const file = slotFile(slot, scope);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}
