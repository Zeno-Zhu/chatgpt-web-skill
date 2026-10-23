# 多窗口并行（唯一真源）

> 2026-10-23 落地并实测通过。起因：agent 一次只能盯一个窗口，而实际经常同时在跑多个聊天。
> 早先只有全局锁 + 全局等待基线（`tabs.json`），两个任务并行时**必然串线**——
> A 的 `wait` 会把 B 刚发出的回答当成自己的，或者读错会话。
>
> 本文件是"多窗口怎么分身份、状态存在哪、什么能并行、出问题怎么处置"的唯一判据。
> 改这里之前先跑 `node --test tests/slot-page.test.mjs tests/slot-routing.test.mjs tests/lifecycle.test.mjs`。

## 0｜一个 slot = 一个窗口 + 一套独立状态

同一浏览器、同一份登录 profile 下，可以同时开多个**独立顶层窗口**。每个 slot 对应：

| 隔离维度 | 落盘文件 | 不带 slot（全局） | 带 slot |
|---|---|---|---|
| 窗口绑定 | `~/.chatgpt-web/tab-<slot>.json` | 无记录，按当前页面/URL 推断 | `targetId` + `windowId`，按 ID 找回 |
| 等待基线 | `~/.chatgpt-web/tabs-<slot>.json` | `tabs.json` | 各自一份，互不覆盖 |
| 互斥锁 | 锁文件 | 全局一把 | 按 slot 分锁 |
| 请求记录 | `~/.chatgpt-web/requests/` | 全局 | 按 slot 分开 |

★ 窗口是**真·独立窗口**（`Target.createTarget` 带 `newWindow: true`），不是同窗口的新标签页。
建完后会校验 `windowId` 与既有页面不同，否则报 `WINDOW_NOT_SEPARATE` —— 这条防止"以为开了新窗口，
其实还在旧窗口里"，那样最小化/关闭会互相牵连。

## 1｜身份从哪来（优先级从高到低）

1. 命令行 `--slot <名>`
2. 环境变量 `CHATGPT_SLOT`
3. `CHATGPT_OUT_DIR`（任务目录 → 目录路径 hash 成 `task-<hex>`，自动，不用起名）
4. `CODEX_THREAD_ID`（Codex 宿主兜底）

slot 名只允许 `1–64` 位字母、数字、下划线、连字符，且必须以字母或数字开头（`INVALID_SLOT`）。

**推荐用 `CHATGPT_OUT_DIR`**：每个任务本来就有自己的目录，天然一一对应，不会出现"两个任务忘了改名撞车"。
没有任务目录时再显式 `--slot`。

## 1.5｜先确认身份：`windows`（高频动作，已固化为命令）

判断"现在到底是哪个窗口"不该靠 `tabs` 数页面或看窗口标题——那是人眼逻辑，agent 用会错。
用固定命令：

```bash
node <skill>/scripts/chatgpt.mjs windows        # 人读版
node <skill>/scripts/chatgpt.mjs windows --json # 机读版
```

输出（2026-10-23 实测样例）：

```
共 2 个窗口 / 2 个页面

窗口 1  windowId=1123407268  slot=task-609879f59ce90cb09052
  · 重写短剧画面  [slot=task-609879f59ce90cb09052  ⚠️ 同一会话在多个窗口]
    https://chatgpt.com/c/6adb4c8c-83e4-83ea-8d0c-031b086c6784

窗口 2  windowId=1123407224  （无 slot）
  · 重写短剧画面  [未分配  ← 无 slot 命令默认落这里  ⚠️ 同一会话在多个窗口]

⛔ 1 个会话被多个窗口同时打开（6adb4c8c）：
   在两个窗口里并行 send/wait 会串线（读到对方的回答）。
```

它一次回答四个问题：

| 问题 | 看哪个字段 |
|---|---|
| 现在有几个窗口、每页是什么 | `windows[].targets[]`（`windowId` / `targetId` / `url` / `title`） |
| 这页归哪个 slot | `targets[].slot`（从 `tab-*.json` 反查，不是猜） |
| 不带 slot 的命令会操作哪页 | `targets[].isDefault === true` / `defaultTargetId` |
| 有没有会话被两个窗口同时打开 | `targets[].sharedConversation` / `duplicates[]` |

★ **`windows` 只读且不加互斥锁**：全局锁被占（`status` 返回 `busy`）时照样能跑 ——
这正是它最有用的时候，因为窗口冲突往往发生在"另一个任务正在跑"的时候。

⛔ 见到 `sharedConversation: true` 不要继续并行发消息。处置顺序：
① 关掉多余的那个窗口（或让它 `new` 一个独立会话）→ ② 再 `windows` 复查 → ③ 才继续。

## 2｜实测记录（2026-10-23 20:03–20:07 · Windows · Chrome 9444 · Google2）

在**全局锁正被占用**的最坏条件下做的验证，不是空跑：

| 时刻 | 动作 | 结果 |
|---|---|---|
| 20:03 | 另一个会话的 `wait`（pid 33452）启动，占全局锁 | — |
| 20:04 | 无 slot 的 `status` | `busy`（被 33452 挡住，符合预期） |
| 20:05 | `CHATGPT_SLOT=verify-b … new` | **成功**，未被全局锁影响 |
| 20:05 | `… send --text "只回复两个字：收到"` | `submitted: true`（via button 一次过），新会话 `6adb4d89` |
| 20:05 | `… wait` | **3.6s** 拿到「收到」 |
| 20:06 | 无 slot 的 `status` / `read` | 仍指向原会话 `6adb4c8c`「重写短剧画面」 |
| 20:06 | 检查全局基线 `tabs.json` | `conversationId=6adb4c8c`、`baselineAssistant=1`、`sentAt=20:03:22` —— **零字节改动** |

当时浏览器里三个窗口身份并存，互不干扰：

| 身份 | windowId | 会话 |
|---|---|---|
| 默认（无 slot） | 1123407224 | `6adb4c8c`「重写短剧画面」 |
| `task-609879f5…`（另一 agent 的任务目录） | 1123407268 | 该任务自己的会话 |
| `verify-b` | 1123407266 | `6adb4d89`「确认收到」 |

**结论**：slot 锁独立于全局锁；slot 的 `send/wait` 与全局的 `wait` 可以真正同时跑；
带 slot 的操作不会改写全局基线，所以老任务的完成判定不会被打乱。

## 3｜正确姿势

```bash
S=<skill>/scripts/chatgpt.mjs

# 窗口 A：一个任务目录从头用到尾
CHATGPT_OUT_DIR=/abs/task-a node $S new   --json
CHATGPT_OUT_DIR=/abs/task-a node $S send  --text-file /abs/prompt-a.md --json
CHATGPT_OUT_DIR=/abs/task-a node $S wait  --json
CHATGPT_OUT_DIR=/abs/task-a node $S read  --json

# 窗口 B：同时进行，互不等待
CHATGPT_OUT_DIR=/abs/task-b node $S new   --json
CHATGPT_OUT_DIR=/abs/task-b node $S send  --text-file /abs/prompt-b.md --json
```

规则：

1. **同一聊天的 `new/send/wait/read` 必须始终用同一个 slot 值。** 中途换值 = 换了个窗口，会读不到刚才那轮。
2. 不同 slot 之间**可以并行**（各自 wait、各自 send）；同一 slot 内仍然**串行**，撞锁返回 `busy`。
3. 不带 slot 的旧命令仍可用，而且**不会**选中已分配给 slot 的窗口 —— 老用法不会被新窗口劫持。
4. 收尾：用户手动关窗口 → `slot reset --slot <名>`（或同一个 `CHATGPT_OUT_DIR` 跑 `slot reset`）→ 下次 `new` 重建。

## 4｜踩过的坑

| 现象 | 原因 | 处置 |
|---|---|---|
| `SLOT_PAGE_CLOSED` | 用户关掉了那个窗口 | 确认要重建才 `slot reset` → `new`；⛔ 不要换个 slot 名硬顶，会话就接不上了 |
| `WINDOW_NOT_SEPARATE` | 浏览器没给出独立顶层窗口（窗口管理器/被合并） | 报错停下查环境，⛔ 别当成功继续发，后面会关错窗口 |
| `IMAGE_SLOT_UNSUPPORTED` | 生图共用全局任务账本，暂不支持 slot | `image` 命令一律不带 slot；多窗口并发生图仍会串，已知限制 |
| `INVALID_SLOT` | slot 名含中文/空格/非法字符 | 只用字母数字下划线连字符 |
| `busy` | 同一 slot 上一个命令还没跑完 | 等它结束；⛔ 不要 `--no-lock` 硬闯，会串线 |
| slot 窗口里的会话用无 slot 命令读不到 | 设计如此：无 slot 不选 slot 窗口 | 要读它就必须带上原来那个 slot |

## 5｜关闭单个窗口（skill 没有这个命令）

`stop` 会关**整个浏览器实例**，不能用来关一个 slot 窗口 —— 那会连带关掉用户正在用的窗口。
SKILL 的规矩是"agent 不主动关标签页"，所以正常情况下：**让用户手动关**，然后 `slot reset`。

确需程序化关闭（例如清理自己开的验证窗口）时，只能用 CDP 精确关 target，且必须双重校验：

```js
// 只关指定 windowId 下、且 URL 命中预期会话的 target
const native = await browser.newBrowserCDPSession();
const win = await native.send('Browser.getWindowForTarget', { targetId });
if (win.windowId === EXPECT_WINDOW && url.includes(EXPECT_CONVERSATION)) {
  await native.send('Target.closeTarget', { targetId });
}
```

⛔ 绝不按 `windowId` 之外的模糊条件批量关，绝不用 `stop` 代替。

## 6｜自测清单（改完 slot 相关代码跑这个）

```bash
# 1) 单测
node --test tests/slot-page.test.mjs tests/slot-routing.test.mjs tests/lifecycle.test.mjs

# 2) 先盘点：确认现在有几个窗口、谁是谁、有没有同会话多窗口
node scripts/chatgpt.mjs windows
#    期望：窗口数与实际相符；duplicates 为空；isDefault 指向你要操作的那页

# 3) 起一个 slot 窗口
CHATGPT_SLOT=selftest node scripts/chatgpt.mjs new --json
#    期望 ok:true, mode:new-chat

# 3) 查绑定与窗口
CHATGPT_SLOT=selftest node scripts/chatgpt.mjs slot status --slot selftest --json
CHATGPT_SLOT=selftest node scripts/chatgpt.mjs windows
#    期望：tab-selftest.json 里有 targetId + windowId；windows 里多出一个窗口，
#          该页标着 slot=selftest，且与既有窗口的 windowId 不同

# 4) 发一条最短消息并等待
CHATGPT_SLOT=selftest node scripts/chatgpt.mjs send --text "只回复两个字：收到" --json
CHATGPT_SLOT=selftest node scripts/chatgpt.mjs wait --json
#    期望 submitted:true、text:"收到"

# 5) 确认全局没被污染
node scripts/chatgpt.mjs status --json
cat ~/.chatgpt-web/tabs.json        # conversationId 应仍是原来那个
node scripts/chatgpt.mjs windows    # 期望 isDefault 仍指向原来那页；新 slot 页不算默认

# 6) 收尾
#    手动关掉窗口 → node scripts/chatgpt.mjs windows 确认该 slot 变成 deadSlots
#    → slot reset --slot selftest
```
