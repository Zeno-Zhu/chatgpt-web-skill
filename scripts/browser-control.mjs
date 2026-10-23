#!/usr/bin/env node
// chatgpt-web · 浏览器生命周期统一 CLI
//
//   node scripts/browser-control.mjs doctor          只检查，不启动
//   node scripts/browser-control.mjs ensure          复用或按需启动（日常工作只用这个）
//   node scripts/browser-control.mjs status          只读状态，不启动
//   node scripts/browser-control.mjs stop [--force]  仅当本工具启动过该实例时才关
//
// 退出码：0 成功 / 2 ensure|status|doctor 未就绪 / 3 stop 被拒 / 64 用法错误 / 1 异常
import {
  ensureBrowser,
  killBoundInstanceIfAny,
  resolveLifecycleConfig,
  describeLaunchTask,
} from './browser-lifecycle.mjs';
import { resolveBinding, CONFIG_FILE } from './config.mjs';

const cmd = process.argv[2] || 'ensure';

const hasForce = process.argv
  .slice(3)
  .includes('--force');

function bindingInfo() {
  try {
    const b = resolveBinding({});
    let effective = null;
    try {
      effective = resolveLifecycleConfig({});
    } catch (e) {
      effective = { error: e.message };
    }
    let launchTask = null;
    try {
      launchTask = describeLaunchTask({});
    } catch (e) {
      launchTask = { ok: false, error: e.message };
    }
    return {
      configFile: b.file,
      configFileExists: b.fileExists,
      // 扁平键原值（chatgpt 主渠道用；可能为 null）
      flatKeys: {
        browserPath: b.keys.browserPath ?? null,
        userDataDir: b.keys.userDataDir ?? null,
        profileDirectory: b.keys.profileDirectory ?? null,
        cdpPort: b.keys.cdpPort ?? null,
        agent: b.keys.agent ?? null,
      },
      // 实际生效值（已合并 env / 扁平键 / targets.<agent>）
      effective,
      // 本机托管 Chrome 的计划任务（只读探测，不启动）
      launchTask,
      spawnMode: process.env.CHATGPT_SPAWN_MODE || 'auto',
    };
  } catch (e) {
    return { configFile: CONFIG_FILE, error: e.message };
  }
}

async function main() {
  if (
    cmd === 'ensure' ||
    cmd === 'status' ||
    cmd === 'doctor'
  ) {
    const wantsLaunch = cmd === 'ensure';

    const r = await ensureBrowser({
      launchIfMissing: wantsLaunch,
      createPage: wantsLaunch
    });

    if (r.browser) {
      await r.browser.close().catch(() => {});
    }

    const {
      browser,
      page,
      ...safe
    } = r;

    const out = {
      command: cmd,
      ...safe,
      binding: bindingInfo()
    };

    process.stdout.write(
      `${JSON.stringify(out, null, 2)}\n`
    );

    return r.ok ? 0 : 2;
  }

  if (cmd === 'stop') {
    const r = await killBoundInstanceIfAny({
      force: hasForce
    });

    process.stdout.write(
      `${JSON.stringify(r, null, 2)}\n`
    );

    return (
      r.killed ||
      r.reason === 'NOT_RUNNING'
    )
      ? 0
      : 3;
  }

  process.stderr.write(
    'Usage: node scripts/browser-control.mjs ensure|status|doctor|stop [--force]\n'
  );

  return 64;
}

process.exitCode = await main().catch(e => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: e.message
    })}\n`
  );

  return 1;
});
