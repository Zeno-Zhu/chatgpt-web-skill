// chatgpt-web · 生命周期适配层
//
// 把 browser-lifecycle 的统一入口接到原有业务命令上，使 send / wait / read / 生图
// 都走同一个"检测 → 校验 → 复用或启动 → 连接"的确定性流程。
//
// 三个出口：
//   withEnsuredPage(fn,{create})    → fn(page)；没有可用页时返回 no-chatgpt-tab 信封
//   withEnsuredBrowser(fn,{create}) → fn(browser,page)；page 可能为 null（只读命令用）
//   commandEnsure({headless,url})   → launch / ensure 命令的返回值
//
// ⚠️ 关闭语义：这里对 browser.close() 只是**断开 Playwright 的 CDP 连接**，
//    不会关闭用户真实的 Chrome（Playwright 官方语义；2026-10-16 本机实测复核）。
import { ensureBrowser } from './browser-lifecycle.mjs';

function failEnvelope(r) {
  return {
    ok: false,
    error: r.error,
    // 用 lifecycleState 而不是 state：chatgpt.mjs 的 envelope() 会用协议状态覆盖 state
    lifecycleState: r.state,
    hint: r.hint,
    actionsTaken: r.actionsTaken
  };
}

// 统一页面入口（原 withPage 的替代）。要求有页；没有则明确报 no-chatgpt-tab。
export async function withEnsuredPage(
  fn,
  {
    create = true,
    ...options
  } = {}
) {
  const r = await ensureBrowser({
    ...options,
    createPage: create
  });

  if (!r.ok) {
    return failEnvelope(r);
  }

  try {
    if (!r.page) {
      return { ok: false, error: 'no-chatgpt-tab', lifecycleState: r.state, actionsTaken: r.actionsTaken };
    }
    return await fn(r.page, r);
  } finally {
    // 只断开 Playwright 的 CDP 连接，不关闭真实 Chrome
    await r.browser.close().catch(() => {});
  }
}

// 需要自行操作 browser（列标签页 / 生图任务）时用它；page 允许为 null。
export async function withEnsuredBrowser(
  fn,
  {
    create = false,
    ...options
  } = {}
) {
  const r = await ensureBrowser({
    ...options,
    createPage: create
  });

  if (!r.ok) {
    return failEnvelope(r);
  }

  try {
    return await fn(r.browser, r.page, r);
  } finally {
    await r.browser.close().catch(() => {});
  }
}

// launch / ensure 命令入口
export async function commandEnsure({
  headless = false,
  url = null,
  ...options
} = {}) {
  const r = await ensureBrowser({
    ...options,
    headless,
    url: url || undefined
  });

  if (r.browser) {
    await r.browser.close().catch(() => {});
  }

  return {
    ok: r.ok,
    state: r.state,
    actionsTaken: r.actionsTaken,
    ...(r.ok
      ? {
          pid: r.pid
        }
      : {
          error: r.error,
          hint: r.hint
        })
  };
}

// 给直接调用 connect() 的老命令用：拿到一个已经 ensure 过的 Playwright Browser。
// 返回的 browser 用完必须 close()（= 断开 CDP，不关 Chrome）。
export async function connectEnsured(options = {}) {
  const r = await ensureBrowser({
    ...options,
    createPage: false
  });

  if (!r.ok) {
    const e = new Error(r.error || 'ENSURE_FAILED');
    e.state = r.state;
    e.hint = r.hint;
    e.actionsTaken = r.actionsTaken;
    throw e;
  }

  return r.browser;
}
