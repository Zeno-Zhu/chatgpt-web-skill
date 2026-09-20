#!/usr/bin/env node
// 端到端冒烟测试：按 SKILL.md 规定的顺序驱动 CLI，并断言每一步的契约。
// 用法: node scripts/e2e-smoke.mjs --prompt <文件> --file <附件>... --out <任务目录>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'chatgpt.mjs');

function parseArgs(argv) {
  const o = { files: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') o.files.push(argv[++i]);
    else if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

function run(cmd, args, env = {}) {
  const r = spawnSync('node', [CLI, cmd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 JSON 输出 */ }
  return { cmd, code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const checks = [];
function check(label, cond, detail) {
  checks.push({ label, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <-- ${JSON.stringify(detail)}`}`);
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out || 'chatgpt-out');
const promptFile = args.prompt;
fs.mkdirSync(outDir, { recursive: true });
const env = { CHATGPT_OUT_DIR: outDir };

console.log(`# chatgpt-web E2E · out=${outDir}\n`);

// 1) launch（幂等）
const launch = run('launch', ['--json'], env);
check('launch 成功', launch.json?.ok === true, launch.json ?? launch.stderr);

// 2) status
const status = run('status', ['--json'], env);
check('status 连通 CDP', status.json?.cdp === true, status.json);
check('status 已登录', status.json?.loggedIn === true, status.json);

if (!status.json?.loggedIn) {
  console.log('\n中止：未登录。请在自动化 Chrome 窗口登录后重跑。');
  process.exit(1);
}

// 3) new
const neu = run('new', ['--json'], env);
check('new 建立新会话', neu.json?.ok === true, neu.json);

// 4) send（带附件）
const sendArgs = ['--json'];
const prompt = promptFile ? fs.readFileSync(promptFile, 'utf8') : (args.text || '请只回复：PONG');
sendArgs.push('--text', prompt);
for (const f of args.files) sendArgs.push('--file', path.resolve(f));
const send = run('send', sendArgs, env);
check('send 提交成功', send.json?.submitted === true, send.json);
check('send 附件数吻合', !args.files.length || (send.json?.uploadedCount === args.files.length), { want: args.files.length, got: send.json?.uploadedCount });
check('send 记录了 assistant 基线', typeof send.json?.baselineAssistant === 'number', send.json?.baselineAssistant);

// 5) wait（Gate）
const wait = run('wait', ['--timeout', args.timeout || '600', '--json'], env);
check('wait 判定完成', wait.json?.done === true, { done: wait.json?.done, elapsedMs: wait.json?.elapsedMs });
check('wait status=success', wait.json?.status === 'success', { status: wait.json?.status });
check('wait 观察到 latch 信号', wait.json?.sawTarget === true, { sawTarget: wait.json?.sawTarget });

// 6) read（Gate）
const read = run('read', ['--json', '--md'], env);
check('read 取回非空回答', typeof read.json?.text === 'string' && read.json.text.trim().length > 0,
  { len: read.json?.text?.length });
check('read 解析出稳定会话 id', !!read.json?.conversationId && read.json?.temporary === false, { conversationId: read.json?.conversationId, temporary: read.json?.temporary });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const report = {
  at: new Date().toISOString(),
  url: read.json?.url, projectId: read.json?.projectId, conversationId: read.json?.conversationId,
  answerChars: read.json?.text?.length ?? 0, images: read.json?.images?.length ?? 0,
  codeBlocks: read.json?.codeBlocks ?? 0,
  savedMarkdown: read.json?.savedMarkdown,
  checks,
  passed: checks.every((c) => c.pass),
};
fs.writeFileSync(path.join(outDir, `e2e-report-${stamp}.json`), JSON.stringify(report, null, 2));
if (read.json?.text) fs.writeFileSync(path.join(outDir, `answer-${stamp}.md`), read.json.text);

console.log(`\n${report.passed ? 'ALL PASS' : 'HAS FAILURES'} · 回答 ${report.answerChars} 字 · 会话 ${report.conversationId ?? 'n/a'}`);
process.exit(report.passed ? 0 : 1);
