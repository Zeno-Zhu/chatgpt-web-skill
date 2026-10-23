// chatgpt-web · 生命周期测试
// 运行：node --test tests/lifecycle.test.mjs
//
// 这些用例都**不启动、不终止**任何真实浏览器：用不存在的 chrome 路径、
// 空闲高端口、以及一个伪造的 CDP HTTP 端点来验证"拒绝逻辑"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  ensureBrowser,
  killBoundInstanceIfAny
} from '../scripts/browser-lifecycle.mjs';

const root = fs.mkdtempSync(
  path.join(
    os.tmpdir(),
    'chatgpt-lifecycle-test-'
  )
);

const basic = port => ({
  chrome: path.join(root, 'missing-chrome-binary'),
  profile: path.join(
    root,
    `profile-${port}`
  ),
  profileDirectory: 'Default',
  cdpPort: port,
  cdpUrl: `http://127.0.0.1:${port}`,
  baseDir: path.join(
    root,
    `meta-${port}`
  )
});

test('missing Chrome cannot be silently launched', async () => {
  const r = await ensureBrowser(
    basic(58317)
  );

  assert.equal(r.ok, false);
  assert.equal(r.state, 'CHROME_NOT_FOUND');
});

test('status is a no-launch operation', async () => {
  const r = await ensureBrowser({
    ...basic(58319),
    launchIfMissing: false
  });

  assert.equal(r.ok, false);
  assert.equal(r.state, 'NOT_RUNNING');
});

test('stop without matching process leaves all other browsers alone', async () => {
  const r = await killBoundInstanceIfAny(
    basic(58321)
  );

  assert.equal(r.killed, false);
  assert.equal(r.reason, 'NOT_RUNNING');
});

test('fake CDP endpoint never establishes browser ownership', async () => {
  let server;

  server = http.createServer(
    (req, res) => {
      res.setHeader(
        'Content-Type',
        'application/json'
      );

      res.end(
        JSON.stringify({
          Browser: 'Chrome/155',
          webSocketDebuggerUrl:
            `ws://127.0.0.1:${server.address().port}/devtools/browser/not-ours`
        })
      );
    }
  );

  await new Promise(resolve =>
    server.listen(
      0,
      '127.0.0.1',
      resolve
    )
  );

  try {
    const port = server.address().port;

    const r = await ensureBrowser(
      basic(port)
    );

    assert.equal(r.ok, false);
    assert.equal(
      r.state,
      'CDP_PROFILE_MISMATCH'
    );

  } finally {
    server.closeAllConnections();
    await new Promise(resolve =>
      server.close(resolve)
    );
  }
});

// 关键回归：configOf() 必须能解析**本机真实** ~/.chatgpt-web/config.json
// （顶层扁平键 + targets.<agent>.cdpPort）。只读，不启动。
test('real config.json is understood (not CONFIG_INVALID)', async () => {
  const r = await ensureBrowser({
    launchIfMissing: false,
    createPage: false
  });

  assert.notEqual(
    r.state,
    'CONFIG_INVALID',
    `configOf 解析真实配置失败：${r.hint}`
  );
  if (r.browser) await r.browser.close();
});
