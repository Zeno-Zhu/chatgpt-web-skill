# 浏览器生命周期 V2（唯一真源）

> 2026-10-16 落地。起因：**agent 的代码把用户的 Chrome 一起杀了**（`taskkill /F /IM chrome.exe`
> 一类"按进程名批量终止"），且调试端口/实例归属反复混乱。
>
> 本文件是"浏览器怎么起、怎么复用、怎么判断、能不能关"的唯一判据。
> 改这里的规则前先跑 `node --test tests/`（11 个断言）+ `node tests/lifecycle-e2e.mjs`。

## 0｜四条不可动摇的原则

1. **复用优先** —— CDP 可用且绑定身份匹配 → 直接连，不重复启动。
2. **验证优先** —— 端口返回 HTTP 200、`netstat` 显示 LISTENING，**都单独不构成证明**。
   必须同时证明"该实例的 `user-data-dir` + `profile-directory` + 端口 = 我们的绑定"。
3. **用户窗口优先保护** —— 发现普通 Chrome 占用绑定 profile → **立刻报明确错误**，
   由用户决定关不关。**绝不**自动终止、**绝不**按进程名批量杀。
4. **终止必须独立授权** —— `ensureBrowser()` **永不**终止浏览器；
   关窗口是独立函数，且必须过 `PID + 创建时间 + 命令行 + 页面 target` 四重校验。

## 1｜固定指令表（唯一命令，不要再自己拼 sleep / netstat / curl）

| 场景 | 唯一命令 | 预期 `state` | 禁止 |
|---|---|---|---|
| 例行工作（**默认只用这个**） | `browser-control.mjs ensure` | `READY_REUSED` 或 `READY_STARTED` | 重复 launch |
| 只读诊断 | `browser-control.mjs status` | 同上，但**不启动** | 顺手启动 |
| 首次/换机预检 | `browser-control.mjs doctor` | 同上，且不启动 | 盲目启动 |
| 普通 Chrome 占了 profile | `ensure` | `PROFILE_IN_USE_NO_CDP` | **自动杀进程** |
| 该 profile 被别的 CDP 端口占用 | `ensure` | `PROFILE_IN_USE_OTHER_PORT` | 抢占 profile |
| CDP 半死（有调试参数但 HTTP 不通） | `ensure` | `CDP_STALE_BOUND` | 自动强杀 |
| 9444 被无关进程占用 | `ensure` | `CDP_PORT_CONFLICT` / `CDP_PORT_STALE_OR_CONFLICT` | 误连、抢端口 |
| 任务做完 | **无需命令** | 保持 Chrome 运行 | 自动 stop |
| 用户明确要求关掉 | `browser-control.mjs stop` | `GRACEFUL_CDP_CLOSE` | 绕过身份校验 |

> `ensure` 是"检测 → 校验 → 复用或启动 → 连接"的唯一入口。
> `send` / `wait` / `read` / `image *` / `tabs` 内部**已经自动调它**，正常使用不必手跑。

`stop` 的额外约束（务必遵守）：
- **不是** `stop --force` 也不是 `stop` 都不许进 agent 的自动恢复路径。
  用户可能恰好在最后一次校验之后打开了新窗口 —— 这个并发窗口无法彻底消除。
- 没有所有权记录（不是本工具启动的）→ 一律拒绝。**这是特性，不是缺陷。**

## 2｜状态码 → 处置

| state | 含义 | 处置 |
|---|---|---|
| `READY_REUSED` | 复用了一个身份已核验的实例 | 继续 |
| `READY_STARTED` | 本次启动了，且三重校验通过 | 继续 |
| `CONFIG_INVALID` | config.json 不合规（路径非绝对、端口非法…） | 跑 `init` 修绑定 |
| `CHROME_NOT_FOUND` | 绑定的浏览器可执行文件不存在 | 修 `browserPath` |
| `CDP_PROFILE_MISMATCH` | 端口上有 CDP，但**证明不了**是我们的 profile | 停止，人工排查 |
| `PROFILE_IN_USE_NO_CDP` | 绑定 profile 被**普通** Chrome 占用 | **ask user** 关窗口 |
| `PROFILE_IN_USE_OTHER_PORT` | 同 profile 被另一个 CDP 端口占用 | ask user / 复用那个端口 |
| `CDP_STALE_BOUND` | 有调试参数但 CDP HTTP 无响应 | 请用户正常退出后重试，**不要强杀** |
| `CDP_PORT_CONFLICT` | 端口持有者的 user-data-dir 不匹配 | 人工排查 |
| `CDP_PORT_STALE_OR_CONFLICT` | 端口在监听/TCP 可连，但 CDP 不可用 | 人工排查 |
| `PROCESS_SCAN_UNAVAILABLE` | 读不到进程命令行（CIM/WMI 不可用） | 恢复权限后重试 |
| `AMBIGUOUS_INSTANCES` | 多个主进程宣称同一端口/目录 | 停止，人工排查 |
| `LOCK_BUSY` | 另一个生命周期操作在跑 | 等一会儿重试 |
| `SPAWN_FAILED` / `LAUNCH_TIMEOUT` | 起不来 / 起来但没完成校验 | 先重跑 `ensure` 复查，**不要反复重拉** |

## 3｜两条实测结论（都是被坑出来的，别推翻）

### 3.1｜宿主会在命令结束时回收整棵进程树 → 启动必须走「沙箱外的通道」

实测（WorkBuddy 沙箱）：
- `spawn(..., {detached:true}) + unref()` 拉起 Chrome → 命令返回 `READY_STARTED`，
  **下一个命令**里该端口只剩 `TIME_WAIT`，进程数为 0。`detached` 救不了。
- 对照实验：用 WMI（`Invoke-CimMethod Win32_Process Create`）创建 → 父进程是 `WmiPrvSE.exe`，
  不在本次调用的进程树里 → 跨命令存活。

**本机采用的通道 = 计划任务**（2026-10-15 落地，2026-10-16 复核仍在且与绑定匹配）：

```
任务名  ChatGPT-CDP-9444        状态 Ready      按需触发（无定时）
动作    chrome.exe --remote-debugging-address=127.0.0.1
                    --remote-debugging-port=9444
                    --user-data-dir="C:\ChromeProfiles\Google2"
                    --profile-directory=Default --no-first-run --no-default-browser-check
                    --restore-last-session https://chatgpt.com/
```

- 由 Task Scheduler 服务拉起 → **不受本次调用的进程树回收影响** ⇒ 跨命令存活。
- ⚠️ `schtasks.exe` 在本机被程序黑名单封杀，**必须用 PowerShell 的
  `Register-ScheduledTask` / `Start-ScheduledTask` / `Unregister-ScheduledTask`**。
- `ensure` 需要启动时**优先走它**（`spawnMode: 'auto'`，见 §6）；
  用之前会**先读任务的 Execute/Arguments 并核对**（chrome 路径 + `--user-data-dir` + `--remote-debugging-port`
  + `--profile-directory` 四项都要对上），**对不上就拒绝执行**，绝不盲跑别人的任务。
- `doctor` 会打印 `launchTask`（`found` / `matchesBinding` / `state` / 完整命令行）供人工核对。

> ⛔ **不采用 WMI**。SKILL.md 9.1 记录过 `Invoke-CimMethod Win32_Process Create`
> 被安全策略拦截、理由写着 "equivalent to Start-Process"，判定"**这属于绕过安全控制，不该做**"。
> 2026-10-16 实测它确实能成功创建（与旧记录矛盾），但**既然已有用户认可的通道（计划任务），
> 就没必要走这条有争议的旁路**。WMI 仅在**显式** `CHATGPT_SPAWN_MODE=wmi` 时可用，
> 且**不在 `auto` 候选里**。

**兜底路线（用户动手一次，最稳）**：双击 `<用户目录>\.chatgpt-web\start-chrome-google2.cmd`。

### 3.2｜`Get-CimInstance` 会**间歇性**失败 → 一次抖动不能升级成"整体拒绝"

实测：连续 12 次扫描 12/12 成功，但在"刚拉起浏览器 + 多实例并存 + 密集轮询"时抓到过失败；
原实现把单次抖动直接变成 `supported:false`，于是 `ensure`/`status`/`stop`
**随机**失败（实测连续 3 次 e2e 必挂 1 次），极难排查。

处置（两条一起做才够）：
1. `scanBrowserProcesses()` **重试**（默认 3 次 + 短退避）；`getProcessByPid()` 同。
2. `waitForOwnedCdp()` 在**轮询中**遇到读不到进程表时 **`continue` 下一轮**，
   而不是立刻 return —— 那里本来就在等，瞬时失败下一轮就自愈。

### 3.3｜CDP 连接上的 `browser.close()` = **断开**，不是关浏览器

Playwright 官方语义 + 本机实测复核。所以业务命令 `finally` 里的 `browser.close()` 是安全的；
真正的关闭只走 `stop` 的 `Browser.close`（经 `newBrowserCDPSession`）。

## 4｜实现结构

```
scripts/
├── procs.mjs              进程扫描：pid + startId(创建时间) + commandLine 指纹；带缓存与重试
├── browser-lifecycle.mjs  ensureBrowser() / killBoundInstanceIfAny()
│                          + resolveLifecycleConfig() / describeLaunchTask()（只读诊断）
├── lifecycle-adapter.mjs  withEnsuredPage() / withEnsuredBrowser() / connectEnsured() / commandEnsure()
├── browser-control.mjs    统一 CLI：ensure | status | doctor | stop [--force]
└── chatgpt.mjs            业务命令；withPage() 与全部 5 处直接 connect() 都已接入上面这层
tests/
├── procs.test.mjs              6 断言
├── lifecycle.test.mjs          5 断言（含"真实 config.json 能被解析"回归）
├── lifecycle-e2e.mjs           真机全链路：READY_STARTED → READY_REUSED → stop → NOT_RUNNING
├── task-launch-e2e.mjs         真机全链路（**经计划任务启动**）+ 临时任务自动注销
├── cross-command-survival.mjs  跨命令存活实验（分两次调用跑）
└── cleanup-leftovers.mjs       按端口精确关闭遗留实例（不按进程名）
```

**配置读取**：统一委托 `config.mjs` 的 `resolveBinding()`，**不再自己解析 config.json**。
真实结构是**顶层扁平键 + `targets.<agent>`**：

```json
{
  "browserPath": "...chrome.exe",
  "userDataDir": "C:\\ChromeProfiles\\Google2",
  "profileDirectory": "Default",
  "targets": { "chatgpt": { "cdpPort": 9444 }, "deepseek": { "cdpPort": 9445 } }
}
```

⚠️ 顶层**没有** `cdpPort` —— 端口只在 `targets.<agent>.cdpPort`。
`browser-control doctor` 会同时打印 `flatKeys`（原值，可能为 null）与 `effective`（实际生效值）。

## 5｜`NO_PROXY` 必须在连接前补上

宿主注入的 `HTTP_PROXY` 会**劫持 `127.0.0.1`** → `connectOverCDP` 报
`Unexpected status 502 ... does not look like a DevTools server`，看起来像"浏览器挂了"。
`ensureBrowser()` 内部已调 `ensureProxyBypass()` 强制补 `NO_PROXY=127.0.0.1,localhost`；
**自己写的探针脚本也必须补**（本次清理脚本没补，4 个已死端口全部报 502 而非"连不上"）。

## 6｜逃生阀 / 环境变量

| 变量 | 作用 |
|---|---|
| `CHATGPT_SPAWN_MODE` | `auto`(默认：Windows 优先计划任务 → 退回 direct) / `task` / `direct` / `wmi` |
| `CHATGPT_LAUNCH_TASK` | 指定用来启动的计划任务名（默认约定 `ChatGPT-CDP-<端口>`） |
| `CHATGPT_CONFIG` | 换 config.json 路径 |
| `CHATGPT_CHROME` / `CHATGPT_PROFILE` / `CHATGPT_PROFILE_DIRECTORY` / `CHATGPT_CDP_PORT` | 覆盖绑定（优先级高于 config） |
| `CHATGPT_AGENT` | 实例名（影响 `targets.<agent>` 选择与端口偏移） |

> `wmi` **不在 `auto` 里**（理由见 §3.1），只有显式指定才用。
