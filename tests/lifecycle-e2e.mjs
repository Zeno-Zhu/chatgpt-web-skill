#!/usr/bin/env node
// chatgpt-web · 生命周期真实端到端验收（手动、可选）
//
// 在**独立临时 profile + 独立端口 + headless** 上跑完整链路：
//   READY_STARTED → READY_REUSED → 所有权记录 → 精确关闭 → NOT_RUNNING
//
// 刻意不碰用户日常的 C:\ChromeProfiles\Google2 —— 不会影响用户已经打开的窗口。
//
// 用法：node tests/lifecycle-e2e.mjs [--port 9461]
// 退出码：0 全通过 / 1 有失败
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  ensureBrowser,
  killBoundInstanceIfAny,
} from '../scripts/browser-lifecycle.mjs';
import { resolveLifecycleConfig } from '../scripts/browser-lifecycle.mjs';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = Number(arg('port', 9461));

const base = resolveLifecycleConfig({});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-lifecycle-e2e-'));

const opts = {
  chrome: base.chrome,
  profile: path.join(root, 'profile'),
  profileDirectory: 'Default',
  cdpPort: PORT,
  cdpUrl: `http://127.0.0.1:${PORT}`,
  baseDir: path.join(root, 'meta'),
  headless: true,
  createPage: true,
  timeoutMs: 60000,
};

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <-- ${JSON.stringify(detail)}`}`);
}

console.log(`# lifecycle e2e · port=${PORT}\n# profile=${opts.profile}\n# chrome=${base.chrome}\n`);

// 1) 启动（headless，独立 profile）
const a = await ensureBrowser(opts);
check('ensure 启动成功 READY_STARTED', a.ok && a.state === 'READY_STARTED',
  { ok: a.ok, state: a.state, error: a.error, hint: a.hint });
check('ensure 记录了 ownership-recorded', (a.actionsTaken || []).includes('ownership-recorded'), a.actionsTaken);
await a.browser?.close().catch(() => {});

if (!a.ok) {
  console.log('\n启动失败，后续步骤跳过。');
  console.log(`\n${results.every(r => r.pass) ? 'ALL PASS' : 'HAS FAILURES'}`);
  process.exit(1);
}

// 2) 复用（不重复启动）
const b = await ensureBrowser(opts);
check('ensure 第二次复用 READY_REUSED', b.ok && b.state === 'READY_REUSED',
  { ok: b.ok, state: b.state, error: b.error });
check('复用命中同一个 PID', b.pid === a.pid, { first: a.pid, second: b.pid });
await b.browser?.close().catch(() => {});

// 3) 版本信息证明是同一个 CDP
try {
  const raw = execFileSync('node', ['-e', `
    const http=require('http');
    http.get('http://127.0.0.1:${PORT}/json/version',{timeout:1500},r=>{
      let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log(d);process.exit(0)});
    }).on('error',()=>{console.log('{}');process.exit(0)});
  `], { encoding: 'utf8', timeout: 8000 }).trim();
  const v = JSON.parse(raw);
  check('CDP /json/version 可达', typeof v.Browser === 'string', raw.slice(0, 200));
} catch (e) {
  check('CDP /json/version 可达', false, e.message);
}

// 4) 精确关闭（只关我们自己启动的那个）
const c = await killBoundInstanceIfAny({ ...opts, force: false });
check('stop 关闭成功', c.killed === true, c);
check('stop 走优雅关闭', c.reason === 'GRACEFUL_CDP_CLOSE', c.reason);

// 5) 关闭后应为 NOT_RUNNING
const d = await ensureBrowser({ ...opts, launchIfMissing: false, createPage: false });
check('关闭后状态为 NOT_RUNNING', d.ok === false && d.state === 'NOT_RUNNING',
  { ok: d.ok, state: d.state, error: d.error });

const passed = results.every(r => r.pass);
console.log(`\n${passed ? 'ALL PASS' : 'HAS FAILURES'}`);
console.log(`# 临时目录（可手动删除）: ${root}`);
process.exit(passed ? 0 : 1);
