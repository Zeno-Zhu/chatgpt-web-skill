# 多渠道 + 圆桌讨论：设计与落地计划

> 状态：**设计已定，代码待落地**（DeepSeek 渠道需要用户先在一个专用 profile 里登录一次）。
> 本文件放在 `references/` 下，`install.mjs` 会随 skill 一起复制，换机器也在。

## 1｜目标与约束

把现在只对 ChatGPT 的确定性工作流，扩成**多渠道**（ChatGPT / DeepSeek / 以后还可能加），并让两个渠道能互相质询：

- 保持现有 `chatgpt.mjs` **零回归**（它是日用主链路）；
- 每个渠道可以有**不同的浏览器**（本机：ChatGPT=Chrome，DeepSeek=Edge）；
- 机器级配置**一次配好、永久有效、不被 skill 更新覆盖**；
- 正常开工时**不读初始化文档**（省 token）。

## 2｜绑定：单绑定 → 多 target

### 2.1 现状

`~/.chatgpt-web/config.json` 是**扁平单绑定**：

```json
{ "browserPath": "...\\chrome.exe", "userDataDir": "C:\\ChromeProfiles\\Google2", "profileDirectory": "Default" }
```

问题：一个文件只能表达"一个渠道的一个浏览器"。

### 2.2 目标形态（v2，向后兼容）

```json
{
  "version": 2,
  "targets": {
    "chatgpt":  { "browserPath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                  "userDataDir": "C:\\ChromeProfiles\\Google2", "profileDirectory": "Default", "cdpPort": 9444 },
    "deepseek": { "browserPath": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                  "userDataDir": "C:\\EdgeProfiles\\DeepSeek", "profileDirectory": "Default", "cdpPort": 9445 }
  }
}
```

规则：

- 读到**扁平 v1** 时按 `targets.chatgpt` 解释（老机器不用改文件就能继续用）。
- **端口必须按 target 分开**：同一台机器上 Chrome 与 Edge 各占一个调试端口，不能共用。
- 绑定写入只动目标 target，不覆盖其它 target。

### 2.3 机器状态（新增，替代重复探测）

`~/.chatgpt-web/STATE.json`：记录每个 target 是否已验证、用什么浏览器、什么时候验的。

```json
{ "version": 1, "targets": { "chatgpt": { "verified": true, "browser": "chrome.exe", "profile": "C:\\ChromeProfiles\\Google2", "verifiedAt": "2026-10-06T16:20:00+08:00" } } }
```

**agent 开工只看这个文件**（很小）→ 决定是否需要走 `INIT.md`。

## 3｜代码结构

```
scripts/
  chatgpt.mjs        # 统一入口（保持既有命令面），新增 --target/--provider 选渠道
  lib.mjs            # 共用：CDP 连接 / 锁 / sleep / 路径 / 绑定解析（改为按 target 取）
  config.mjs         # 读写 config.json（v2 多 target + v1 兼容）
  envelope.mjs       # （抽出）协议信封 + emit：两个渠道共用同一套状态码
  providers/
    chatgpt.mjs      # 适配现有 compose.mjs（不动既有实现，只包一层）
    deepseek.mjs     # 新增
  compose.mjs        # ChatGPT 页面层（保持）
  install.mjs        # 登记 INIT.md / HANDOVER.md
```

渠道接口（每个 provider 必须实现）：

| 能力 | 说明 |
|---|---|
| `isLoggedIn(page, {waitMs})` | 判据必须是"输入框可用"，不能只看 URL |
| `ensureNewChat(page)` | 回到/开一个干净会话 |
| `send(page, {text, files})` | 注入 + 提交，返回 `{submitted, uploadedCount, pendingText}` |
| `waitForReply(page, baseline, {timeoutMs})` | 只认**基线之后**新增的回复；返回 `{status, text}` |
| `readLast(page, {maxChars})` | 取最后一条回复 + 会话 id |
| `convIds(url)` | 从 URL 解析会话 id |

**共用**：CDP/浏览器/锁/信封/状态码/路径规范化 —— 一份实现。
**渠道专属**：选择器、注入方式、完成判定、会话 id 规则。

## 4｜渠道差异（实测）

| 项 | ChatGPT | DeepSeek |
|---|---|---|
| 网址 | `chatgpt.com` | `chat.deepseek.com` |
| 本机浏览器 | Chrome（专用 profile `Google2`） | **Edge**（用户日常登录在 `User Data/Profile5`） |
| 建议绑定 | 沿用现绑定，端口 9444 | 专用 `C:\EdgeProfiles\DeepSeek`，端口 **9445** |
| CDP 可行性 | 已验证 | **已验证**：`Edg/154` + 9445 可连（2026-10-06） |
| 输入框/发送 | `div.ProseMirror[role=textbox]` + `button[aria-label="Send"]` | 待实测锚点 |
| 新对话 | `new` 走 `chatgpt.com/` | 点「开启新对话」（文字匹配） |
| 开关 | 模型选择器 | **深度思考 / 智能搜索 两个开关，默认期望「开」** |

### DeepSeek 开关的定位策略（用户已给 DOM 线索）

用户给的片段显示：开关是 `div[tabindex="0"][aria-pressed]`，class 里含**语义化的**
`ds-toggle-button` 与 `ds-toggle-button--selected`（这部分不是 hash，可用），
内部 `<span>` 的文字是「智能搜索」。因此：

- 定位：`[class*="ds-toggle-button"]` 里按**文字**（深度思考 / 智能搜索）认，**不要**用 hash class；
- 状态：优先 `aria-pressed="true"`，回退 `class` 含 `ds-toggle-button--selected`；
- 语义：默认**要求两个都开**；`--no-thinking` / `--no-search` 才关；实际状态要**读回来核实**，
  调不成时如实报（不静默降级）。

### 待用户做的一步（阻塞）

Edge 的 DeepSeek 登录在**默认 User Data 的 Profile5**，而 Chromium 136+ 禁止在默认 user-data-dir 上开调试端口，
cookie 又是 app-bound 加密（无法程序化迁移）。所以：

1. agent 用 `--user-data-dir="C:\EdgeProfiles\DeepSeek" --remote-debugging-port=9445` 起 Edge；
2. **用户在这个窗口里登录一次 DeepSeek**；
3. `doctor --target deepseek` 到 `ready: true` → 写 `STATE.json` → 以后不再管。

## 5｜圆桌讨论标准（Round-Table Consultation）

目的不是"问两家再取平均"，而是**用分歧定位不确定性**。取平均会把正确和错误搅在一起。

### 5.1 角色

- **A** = 发起 agent（掌握本地事实、派发、比对、最终裁决建议）
- **G** = GPT 渠道，**D** = DeepSeek 渠道

### 5.2 轮次

| 轮 | 动作 | 规则 |
|---|---|---|
| **R0** | 立场收集 | 同一份事实包 + 同一个问题，**并行**发给 G 和 D。**互相不可见**（避免锚定） |
| **R1** | 分歧提取 | A 比对两份答案，产出三张清单：**共识** / **分歧** / **缺口** |
| **R2** | 交叉质询 | 把**对方的关键论据**喂给另一边，要求「要么给反例反驳，要么承认」。**信息增益最大的一轮** |
| **R3** | 补缺 | 对缺口各问一次："你没提到 X，是无知还是认为不重要？" |
| **R4** | 收敛判定 | 按下面判据收口 |

**默认只做 R0 + R2**（两轮）。R3/R4 仅当分歧属**事实类**且结论会改变下一步行动时才做。

### 5.3 收敛判据（硬门）

- **强收敛**：R2 后分歧点有明确胜出方（有可验证的反例/事实）→ 采纳，并记录失败方论点为何不成立。
- **弱收敛**：分歧属**价值取舍**而非事实 → 不当成错误，列为"需用户选"的选项。
- **不收敛**：连续两轮无 Decision Delta → 停止，如实上报「二分/未决」+ 两边最强论据，
  **不得编造一个折中答案**（假收敛比未决更糟）。

### 5.4 反模式（明令禁止）

1. 把两边答案"综合/平均"成一段——会把对错混在一起；
2. 只问一边，把另一边当"确认"——那是确认偏差，不是验证；
3. 让两边**先看到**对方答案再问（锚定）——只有 R2 的交叉质询是刻意的例外；
4. 用轮数冒充深度——每轮必须有 Decision Delta；
5. 把"两个模型都这么说"当成事实（**共同训练数据会一起错**）——共识提高的置信度有限，
   真正能提高置信度的是**可验证的反例与外部证据**。

### 5.5 成本门

- 只在 `route` 判 `CONSULT` **且** Impact=2 或 Uncertainty=2 时才开圆桌；其余走单渠道。
- 每次调用带 `--request-id`（幂等），产物落任务目录，长期状态写 state file
  （`objective` / `locked_decisions` / `open_questions` / `next_action`），**不要把聊天记录当状态库**。

## 6｜落地计划

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | config v2 + v1 兼容 + `state` 命令 | 老机器不用改文件；`config --json` 仍返回原绑定 |
| 2 | 抽 `envelope.mjs`，两个 CLI 共用 | 既有命令的 `--json` 输出**逐字段不变** |
| 3 | `providers/deepseek.mjs` + `--target deepseek` | 用户登录后 `doctor --target deepseek` → `ready: true` |
| 4 | DeepSeek 的 new/send/wait/read | 端到端跑通，产物落盘正确 |
| 5 | 开关（深度思考/智能搜索）默认开、可关、读回核实 | 三种组合实测 |
| 6 | 圆桌编排（可选命令或文档化流程） | 一次真实双渠道质询，产出三张清单 |
