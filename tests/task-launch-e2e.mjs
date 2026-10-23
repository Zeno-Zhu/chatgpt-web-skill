#!/usr/bin/env node
// 验证「经计划任务启动」这条路（spawnMode: task）。
//
// 为什么要单独测：Windows 上由 agent 直接 spawn 的 Chrome 活不过本条命令
// （宿主回收进程树），而本机 2026-10-15 起用**计划任务**托管 Chrome 来跨命令存活。
// 这条路现在是 `ensure` 的默认启动方式，必须证明它真能用。
//
// 全程用**临时端口 + 临时 profile + 临时计划任务**，跑完在 finally 里注销该任务，
// 不触碰用户已有的 ChatGPT-CDP-9444。
//
// 用法：node tests/task-launch-e2e.mjs [--port 9478]
// 退出码：0 全通过 / 1 有失败
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  ensureBrowser,
  killBoundInstanceIfAny,
  resolveLifecycleConfig,
} from '../scripts/browser-lifecycle.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const PORT = Number(arg('port', 9478));
const TASK = `ChatGPT-CDP-SELFTEST-${PORT}`;

const base = resolveLifecycleConfig({});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-task-e2e-'));
const profile = path.join(root, 'profile');

const opts = {
  chrome: base.chrome,
  profile,
  profileDirectory: 'Default',
  cdpPort: PORT,
  cdpUrl: `http://127.0.0.1:${PORT}`,
  baseDir: path.join(root, 'meta'),
  createPage: true,
  timeoutMs: 60000,
  spawnMode: 'task',
  launchTask: TASK,
};

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <-- ${JSON.stringify(detail)}`}`);
}

function ps(cmd) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  }).trim();
}

function registerTask() {
  const args =
    `--remote-debugging-port=${PORT} --remote-debugging-address=127.0.0.1 `
    + `--user-data-dir="${profile}" --profile-directory=Default `
    // 与真实任务一致：直接开 chatgpt.com（这样恰好 1 个 GPT 标签页 → 才会写所有权记录）
    + '--no-first-run --no-default-browser-check https://chatgpt.com/';
  const cmd =
    `Register-ScheduledTask -TaskName '${TASK}' -Force `
    + `-Action (New-ScheduledTaskAction -Execute '${base.chrome}' -Argument '${args}') `
    + `-Principal (New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Limited) `
    + `| Out-Null; 'REGISTERED'`;
  return ps(cmd).includes('REGISTERED');
}

function unregisterTask() {
  try {
    ps(`Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false; 'REMOVED'`);
    return true;
  } catch {
    return false;
  }
}

console.log(`# task-launch e2e · port=${PORT} · task=${TASK}`);
console.log(`# profile=${profile}\n`);

let registered = false;

try {
  registered = registerTask();
  check('临时计划任务注册成功', registered);

  if (!registered) {
    console.log('\n注册失败，无法继续。');
  } else {
    // 1) 经计划任务启动
    const a = await ensureBrowser(opts);
    check('经计划任务启动 → READY_STARTED', a.ok && a.state === 'READY_STARTED',
      { ok: a.ok, state: a.state, error: a.error, hint: a.hint, actions: a.actionsTaken });
    check('actions 标明了 spawn-via:task', (a.actionsTaken || []).some((x) => x === 'spawn-via:task'), a.actionsTaken);
    await a.browser?.close().catch(() => {});

    if (a.ok) {
      // 2) 复用
      const b = await ensureBrowser(opts);
      check('第二次 ensure → READY_REUSED', b.ok && b.state === 'READY_REUSED', { state: b.state, error: b.error });
      await b.browser?.close().catch(() => {});

      // 3) 精确关闭（所有权记录应已建立）
      const c = await killBoundInstanceIfAny({ ...opts, force: false });
      check('stop 精确关闭成功', c.killed === true && c.reason === 'GRACEFUL_CDP_CLOSE', c);

      // 4) 关闭后 NOT_RUNNING
      const d = await ensureBrowser({ ...opts, launchIfMissing: false });
      check('关闭后为 NOT_RUNNING', d.ok === false && d.state === 'NOT_RUNNING', { state: d.state });
    }
  }
} finally {
  if (registered) {
    check('临时计划任务已注销', unregisterTask());
  }
}

const passed = results.every((r) => r.pass);
console.log(`\n${passed ? 'ALL PASS' : 'HAS FAILURES'}`);
console.log(`# 临时目录（可删）: ${root}`);
process.exit(passed ? 0 : 1);
