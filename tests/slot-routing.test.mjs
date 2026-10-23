import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const cli = fileURLToPath(new URL('../scripts/chatgpt.mjs', import.meta.url));
const base = path.dirname(cli);

function resolvedSlot(taskDir) {
  const output = execFileSync(process.execPath, [cli, 'slot', 'status', '--json'], {
    cwd: base,
    env: { ...process.env, CODEX_THREAD_ID: '', CHATGPT_SLOT: '', CHATGPT_OUT_DIR: taskDir },
    encoding: 'utf8',
  });
  return JSON.parse(output).slot;
}

test('non-Codex chats get stable, distinct windows from task directories', () => {
  const aDir = path.join(os.tmpdir(), 'chat-a');
  const bDir = path.join(os.tmpdir(), 'chat-b');
  const a = resolvedSlot(aDir);
  const b = resolvedSlot(bDir);
  assert.equal(a, resolvedSlot(aDir));
  assert.notEqual(a, b);
});
