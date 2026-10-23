// 跨命令存活实验：本进程启动 Chrome 后立刻退出，看下一个命令还能不能连上。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser } from '../scripts/browser-lifecycle.mjs';

const PORT = Number(process.argv[2] || 9462);
const MARK = path.join(os.tmpdir(), `chatgpt-lifecycle-survive-${PORT}`);
if (!fs.existsSync(MARK)) fs.mkdirSync(MARK, { recursive: true });

const opts = {
  profile: path.join(MARK, 'profile'),
  profileDirectory: 'Default',
  cdpPort: PORT,
  cdpUrl: `http://127.0.0.1:${PORT}`,
  baseDir: path.join(MARK, 'meta'),
  headless: false,
  createPage: false,
  timeoutMs: 60000,
};

const r = await ensureBrowser(opts);
console.log(JSON.stringify({
  ok: r.ok, state: r.state, pid: r.pid, error: r.error, hint: r.hint,
  actionsTaken: r.actionsTaken, profile: opts.profile,
}, null, 2));

await r.browser?.close().catch(() => {});
console.log('>>> 本进程即将退出；下一个命令应仍能连上 port', PORT);
