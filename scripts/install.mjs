#!/usr/bin/env node
// chatgpt-web · 跨平台安装器（Windows / macOS / Linux 都能用）
//
// 为什么需要 Node 版：install.sh 是 bash 脚本，在 Windows 上没有 bash 就跑不了；
// 而且它硬编码 `$HOME/.dsh/skills`，在 DSH_HOME 指向别处时会装错位置。
//
// 用法：
//   node scripts/install.mjs                     # 装到检测到的所有宿主
//   node scripts/install.mjs --dry-run           # 只打印要做什么，不动任何文件
//   node scripts/install.mjs --only dsh          # 只装 dsh
//   node scripts/install.mjs --root D:\skills    # 显式指定 skill 根目录（最保险）
//   node scripts/install.mjs --agent trae        # 顺手写宿主级实例名（.env.agent，会被真正读取）
//
// 原则：只复制能力文件（SKILL/参考/脚本），绝不复制运行数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else o._.push(a);
  }
  return o;
}

const argv = parseArgs(process.argv.slice(2));
if (argv.help) {
  console.log('用法: node scripts/install.mjs [--dry-run] [--only dsh] [--root <skill 根目录>] [--agent <实例名>]');
  process.exit(0);
}

const home = os.homedir();
const joinSkill = (base) => path.join(base, 'chatgpt-web');

// 各宿主的 skill 根目录。dsh 优先看 DSH_HOME（未设时才是 ~/.dsh）。
function hostRoots() {
  const dshBase = process.env.DSH_HOME
    || (process.platform === 'win32' && process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, '.dsh')
      : path.join(home, '.dsh'));
  return [
    { name: 'dsh', root: path.join(dshBase, 'skills'), note: process.env.DSH_HOME ? 'DSH_HOME' : '~/.dsh' },
    { name: 'claude', root: path.join(home, '.claude', 'skills') },
    { name: 'codex', root: path.join(home, '.codex', 'skills') },
    { name: 'trae', root: path.join(home, '.trae', 'skills') },
    { name: 'trae-cn', root: path.join(home, '.trae-cn', 'skills') },
    { name: 'cursor', root: path.join(home, '.cursor', 'skills') },
    { name: 'workbuddy', root: path.join(home, '.workbuddy', 'skills') },
  ];
}

const FILES = ['SKILL.md', 'COORDINATION.md', 'THINKING.md', 'README.md', 'REVIEW.md', 'package.json', 'package-lock.json'];
const DIRS = ['scripts', 'references'];

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function copyInto(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of FILES) {
    const s = path.join(SRC, f);
    if (!fs.existsSync(s)) continue;
    fs.copyFileSync(s, path.join(dest, f));
  }
  for (const d of DIRS) {
    const s = path.join(SRC, d);
    if (!fs.existsSync(s)) continue;
    fs.cpSync(s, path.join(dest, d), { recursive: true, force: true });
  }
}

function installDeps(dest, dryRun) {
  const srcModules = path.join(SRC, 'node_modules');
  const destModules = path.join(dest, 'node_modules');
  if (fs.existsSync(srcModules)) {
    if (dryRun) return '复制源目录 node_modules（离线可用）';
    fs.cpSync(srcModules, destModules, { recursive: true, force: true });
    return '已复制 node_modules';
  }
  if (dryRun) return '运行 npm install（源目录没有 node_modules）';
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dest, stdio: 'inherit', shell: true });
  return r.status === 0 ? 'npm install 完成' : `npm install 退出码 ${r.status}（请手工在 ${dest} 跑一次）`;
}

let roots = hostRoots();
if (argv.root) roots = [{ name: 'custom', root: argv.root }];
if (argv.only) roots = roots.filter((h) => h.name === argv.only);
if (argv.only && !roots.length) {
  console.error(`未知宿主: ${argv.only}（可选: dsh / claude / codex / trae / trae-cn / cursor / workbuddy，或用 --root 指定根目录）`);
  process.exit(2);
}

const installed = [];
for (const h of roots) {
  const exists = fs.existsSync(path.dirname(h.root)) || fs.existsSync(h.root);
  if (!exists && !argv.only && !argv.root) continue;
  const dest = joinSkill(h.root);
  if (samePath(dest, SRC)) {
    console.log(`跳过 ${h.name}：${dest} 就是当前仓库本身（已经在这里了）`);
    installed.push({ host: h.name, dest, skipped: 'same-as-source' });
    continue;
  }
  console.log(`安装到 ${h.name} → ${dest}${h.note ? `（根目录来自 ${h.note}）` : ''}`);
  if (argv.dryRun) {
    console.log(`  [dry-run] 复制 ${FILES.length} 个文件 + ${DIRS.join('/')}`);
    console.log(`  [dry-run] 依赖：${installDeps(dest, true)}`);
  } else {
    copyInto(dest);
    const dep = installDeps(dest, false);
    if (argv.agent) {
      fs.writeFileSync(path.join(dest, '.env.agent'), `CHATGPT_AGENT=${argv.agent}\n`);
      console.log(`  已写入宿主级实例名: ${argv.agent}（${path.join(dest, '.env.agent')}）`);
    }
    console.log(`  依赖：${dep}`);
  }
  installed.push({ host: h.name, dest, dryRun: !!argv.dryRun });
}

if (!installed.length) {
  console.log('没有检测到可安装的宿主。可指定根目录：node scripts/install.mjs --root <skills 目录>');
  process.exit(1);
}

console.log('\n下一步（每台机器一次，配置不进 git）：');
console.log('  1) node <skill>/scripts/chatgpt.mjs init        # 探测本机浏览器与"已登录 GPT 的 profile"，给出绑定命令');
console.log('  2) node <skill>/scripts/chatgpt.mjs init --browser "<chrome.exe>" --user-data-dir "<已登录 GPT 的 profile 目录>"');
console.log('  3) node <skill>/scripts/chatgpt.mjs doctor      # 期望 ready: true, profileVerified: true');
console.log('  4) node <skill>/scripts/chatgpt.mjs launch      # 首次会打开（或复用）那个已登录的浏览器实例');
console.log('\n多宿主并行：给不同宿主不同实例名（--agent trae）→ profile 目录名/端口/锁隔离；');
console.log('但同一个已登录 profile 同时只能有一个可调试实例，多宿主共用同一 profile 时不要改实例名。');
