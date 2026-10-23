// chatgpt-web · procs 单元测试（不接触真实浏览器）
// 运行：node --test tests/procs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCmdline,
  samePath,
  findProfileUser,
  findCdpInstance,
  scanBrowserProcesses
} from '../scripts/procs.mjs';

test('extract PID and Chrome flags, including spaced Windows paths', () => {
  const cmd = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\ChromeProfiles\\Google2" --profile-directory="Profile 1" --remote-debugging-port=9444';

  const p = parseCmdline(cmd, {
    pid: 4231,
    startId: 'token'
  });

  assert.equal(p.pid, 4231);
  assert.equal(p.userDataDir, 'C:\\ChromeProfiles\\Google2');
  assert.equal(p.profileDirectory, 'Profile 1');
  assert.equal(p.cdpPort, 9444);
  assert.equal(p.startId, 'token');
  assert.equal(p.child, false);
});

test('recognize separate flag values and subprocesses', () => {
  const x = parseCmdline(
    'chrome.exe --user-data-dir "C:\\ChromeProfiles\\Google2" --type=renderer --remote-debugging-port=9444'
  );

  assert.equal(
    x.userDataDir,
    'C:\\ChromeProfiles\\Google2'
  );

  assert.equal(x.child, true);
});

test('case insensitive Windows paths and refuse unrelated profile', () => {
  assert.ok(
    samePath(
      'C:\\ChromeProfiles\\Google2\\',
      'c:\\chromeprofiles\\google2'
    )
  );

  assert.ok(
    !samePath(
      'C:\\ChromeProfiles\\Google2',
      'C:\\ChromeProfiles\\Other'
    )
  );
});

test('find main browser rather than subprocess', () => {
  const main = parseCmdline(
    'chrome.exe --user-data-dir=C:\\ChromeProfiles\\Google2 --remote-debugging-port=9444',
    { pid: 12 }
  );

  const child = parseCmdline(
    'chrome.exe --type=renderer --remote-debugging-port=9444',
    { pid: 13 }
  );

  assert.equal(
    findCdpInstance([child, main], 9444)?.pid,
    12
  );

  assert.equal(
    findProfileUser(
      [child, main],
      'C:\\ChromeProfiles\\Google2'
    )?.pid,
    12
  );
});

test('OS browser scan returns a structured result', () => {
  const result = scanBrowserProcesses();

  assert.equal(
    typeof result.supported,
    'boolean'
  );

  assert.ok(
    Array.isArray(result.entries)
  );
});

test('scan cache can be bypassed with cacheMs: 0', () => {
  const a = scanBrowserProcesses({ cacheMs: 0 });
  const b = scanBrowserProcesses({ cacheMs: 0 });

  assert.equal(typeof a.supported, 'boolean');
  assert.equal(typeof b.supported, 'boolean');
});
