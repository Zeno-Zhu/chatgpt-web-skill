# chatgpt-web

让 **dsh / workbuddy / trae / codex** 等任意 coding agent，用一组**固定命令**操控网页版 ChatGPT
（复用已登录会话），把需要外部判断、代码评审、复杂推理或预编程的任务委托给 GPT，并把结果稳定取回。

核心思路来自三个参考实现 + 本项目已有的页面调研资产：

- [Wangnov/chatgpt-skill](https://github.com/Wangnov/chatgpt-skill)（Claude 版 / Codex 版）
- [browser-use](https://github.com/browser-use/browser-use)
- `~/Documents/gpt交互流水线/gpt通用操作元素说明.md`（真实 ChatGPT DOM 调研）

## 为什么要自己做一层

两个参考实现之所以优雅，是因为它们**寄生在 Codex / Claude 自带的浏览器桥**上
（Codex Chrome Extension / claude-in-chrome MCP）。**DSH 没有这个桥**，
所以对 dsh/workbuddy/trae 通用的唯一办法是：**自己提供一层确定性 CLI 当桥**。

由此确定的切分：

| 层 | 负责 | 不负责 |
|---|---|---|
| **Skill（本仓库）** | 固定操作：找 composer、输入、发送、等完成、读回答 | 不决定"该问什么" |
| **上层 agent** | 判断任务该不该外发、怎么组织上下文、要不要采纳建议 | 不重新探索页面流程 |

> 关键收益：Codex 调用时内部变成 `chatgpt_send() → chatgpt_wait() → chatgpt_read()`，
> 而不是让 browser agent 每次重新思考整个操作流程。

## 快速开始（新机器 / 新 agent）

```bash
git clone <repo> chatgpt-web && cd chatgpt-web
npm install                       # 或 npm install --offline

node scripts/chatgpt.mjs doctor    # ← 先跑这个：能否用 / 缺什么 / 下一步做什么
```

`doctor` 会逐项检查并给出**可操作的下一步**（不是抛错）：

| 检查项 | 失败时的含义 |
|---|---|
| `browser-binary` | 没找到 Chrome/Chromium → 装一个，或设 `CHATGPT_CHROME=/path/to/chrome` |
| `cdp-instance` | 自动化实例没起 → `chatgpt-web launch` |
| `login` | **需要用户登录一次**（正常结果，见下） |
| `applescript-channel` | macOS 上是否能用"零登录备选通道" |

> ⚠️ **登录态无法程序化迁移。** 实测：Chrome 127+ 的 cookie 使用 app-bound 加密，
> 把 48 个 chatgpt/openai cookie 解密并迁入新 profile 后**登录态依然不生效**；
> 复制整个 profile 同样失败。所以每台新机器需要**用户登录一次**，
> 之后长期有效（所有 agent 复用同一实例，不必重复登录）。

### 一键装到各 agent

```bash
bash scripts/install.sh --dry-run        # 先看要做什么，不改任何文件
bash scripts/install.sh                  # 装到检测到的宿主（dsh/claude/codex/trae/...）
bash scripts/install.sh --only dsh --agent dsh
```

### 多 agent 并行（可选）

默认所有 agent 共用一个实例（全局串行，靠锁保证不串线）。
想让它们**真正并行**，给每个宿主不同的实例名，profile / 端口 / 锁会全部隔离：

```bash
export CHATGPT_AGENT=trae     # → profile-trae、独立端口、独立锁
node scripts/chatgpt.mjs doctor
```

## 结构

```text
chatgpt-web/
├── SKILL.md                  # 任务契约 / R1 运行时 / 原子命令 / Gate / 异常路由
├── scripts/
│   ├── chatgpt.mjs           # CLI：核心原子动作 + 路由 Gate + 协议
│   ├── lib.mjs               # 跨平台浏览器解析 + 实例隔离 + latch 完成判定
│   ├── e2e-smoke.mjs         # 端到端冒烟测试（断言每一步契约）
│   └── install.sh            # 一键装到各 agent skill 目录（支持 --dry-run）
├── references/
│   └── chatgpt-dom.md        # 唯一允许写选择器的地方
├── THINKING.md               # 沟通思维协议（多轮研讨 / 方法论 Router）
├── COORDINATION.md           # 协作契约（何时调用 / 会话轮换 / token 预算）
├── REVIEW.md                 # 审核记录与经验沉淀
└── package.json              # 依赖 playwright-core
```

## 安装

```bash
# 作为 DSH skill
cp -R <repo> ~/.dsh/skills/chatgpt-web
cd ~/.dsh/skills/chatgpt-web && npm install        # 离线: npm install --offline

# 其它宿主（trae / workbuddy 等）把 <skill> 换成该技能的落盘路径即可
node <skill>/scripts/chatgpt.mjs status
```

## 快速开始

```bash
node scripts/chatgpt.mjs launch                  # 启动/复用自动化 Chrome（幂等）
node scripts/chatgpt.mjs status                  # 必须 loggedIn: true
node scripts/chatgpt.mjs new
node scripts/chatgpt.mjs ask --text "问题" --file /abs/path.md --json
```

## 写入 agent 的"思考核心"

各 agent 的 skill 目录只管**能被发现**；要让它成为**日常习惯**，还需把下面这段写进宿主的
instructions（`AGENTS.md` / `CLAUDE.md` / 系统提示词 / memory）。按需裁剪：

```markdown
## 外部第二意见（chatgpt-web）

遇到以下情况时，先把上下文整理好，再用 `chatgpt-web` 询问网页版 GPT，而不是自己硬猜：

1. 需要判断分叉：A+U+V 三维评分 >= 4（影响 / 不确定 / 可验证性缺口，各 0-2）
   → `chatgpt-web route --impact N --uncertainty N --gap N --json`
2. 客观验证器证明不了"方向对不对"（测试全绿但可能违背真实意图）→ 语义验收
3. 能力委托（写文案、大量生成、资料整理）→ `--mode generation`
4. 结论依赖我没有可靠来源的外部事实 → `--mode evidence`

调用前先 `doctor` 确认 ready；调用时固定用 `--request-id` 防重复发送；
读取时默认只读前 4000 字符（`readRatio` 长期接近 1 说明选择性读取失效）。

探讨/研究类问题默认按 2-4 轮推进，但**轮次不等于深度**：
每轮必须产生 Decision Delta，否则按 THINKING.md 的停止状态如实收口。
```

完整判据见 [`COORDINATION.md`](COORDINATION.md) 与 [`THINKING.md`](THINKING.md)。

## 关键设计决策（都有实测依据）

### 1｜浏览器接入：独立 profile + CDP，而不是直接操控日常 Chrome

实测确认的三条硬约束：

1. **运行中的 Chrome 无法事后开启 CDP**（`--remote-debugging-port` 只在启动时生效）。
2. **Chrome 136+ 禁止默认 user-data-dir 开调试端口**。
3. **Chrome 127+ cookie 使用 app-bound 加密**：实测把 48 个 chatgpt/openai cookie
   从日常 profile 解密并迁入新 profile 后，**登录态并不生效**；复制整个 profile 同样无效。

因此采用：**自动化专用 Chrome 实例**（`~/.chatgpt-web/profile`，CDP `9444`），
用户登录一次，之后所有 agent 复用同一实例。
这也顺带隔离了"多个 debugger 控制方抢占 ChatGPT 标签页"这个参考实现里反复踩到的坑。

> 备选通道（本文档记录但不作为默认）：AppleScript `execute javascript` 可操控**已登录的日常 Chrome**，
> 零登录成本，但需用户手动开启"查看 → 开发者 → 允许 Apple 事件中的 JavaScript"，
> 且**无法可靠上传附件**。适合只问文本、且坚持不额外登录的场景。

### 2｜完成判定用多信号与，而不是单信号

简单回复可能产生多个"回复操作"元素，长回复在思考间隙会短暂没有 stop 按钮——
任何**单一**信号都会误判。协议是状态机：

```text
SENT → RESPONSE_STARTED(latch) → GENERATING → SETTLING → SUCCESS / 状态码
```

**硬约束**：未观察到"本次新增的 assistant 消息"，绝不判完成——
否则页面原本静止时会把**上一条历史回答**当成本次结果返回（最危险的竞态）。

latch 之后四项同时成立才算完成，且**全部绑定目标 assistant 消息**：

1. 目标文本持续 `settleQuietMs`（默认 2s）不变；
2. `stop-button` **连续** `settleStopMs`（默认 1.5s）不存在（持续时间，不是瞬时布尔）；
3. 目标内无 `.result-streaming`；
4. composer/进度区无进行时字样。

满足后再**间隔 500ms 双采样**，两次一致才落地。

> 实测坑（2026-09-20）：曾用"扫全页正文找'正在搜索'"当工作态信号，
> 而**回答正文本身就在讨论"正在搜索"**，导致 wait 永久卡死。
> 工作态只能看 composer/进度区这类受控区域。

失败不返回一坨文本，而是稳定状态码：`success` / `no_response_started` / `timeout` /
`conversation_drift` / `auth_required` / `rate_limit` / `network_error` / `ui_changed` / `empty_response`。

### 3｜不写死模型名，不静默降级

模型可见项随账户/灰度变化。`model` 只**读**当前可见项；指定了却拿不到时如实报错，
让用户决定，绝不偷偷换成别的模型。

### 4｜不碰凭证

不导出、不保存 cookie / token / storage_state / localStorage。
不代替用户登录、过 MFA/CAPTCHA、点 OAuth 同意。

### 5｜并发隔离

多 agent 共享同一页面会串线，且**"看起来成功、只是答案属于别人"**。
`new/project/goto/send/wait/read/ask` 持有单 profile 全局互斥锁
（`~/.chatgpt-web/lock.json`），被占用返回 `status: busy`；崩溃残留锁 15 分钟后可抢占。
`read` 也在锁内，避免 `wait` 成功后页面被另一个任务切走。

### 6｜防"假装成功"

- 上传附件后**轮询等 chip 真正渲染**，拿不到就报 `uploaded: []`，不睡固定时长就发。
- 输入文字后**回读 composer 校验**，React 没吃下 paste 事件就报 `composer-not-filled` 并中止。
- 长回答被截断、Deep Research 正文在 iframe 内取不到时，**如实标注**，不假装拿到。

## 验证

```bash
node scripts/e2e-smoke.mjs --prompt <提问.md> --file <附件> --out <任务目录>
```

按 SKILL.md 规定顺序驱动 CLI，并断言：`launch` 幂等、`loggedIn: true`、
`submitted: true`、`uploaded` 数量吻合、`done: true`、未走兜底、回答非空、会话 id 可解析。

## 工作区规则

本 skill **只是能力，不是任务工作区**：所有输入引用、回答、产物、日志写入目标项目下的任务目录
（用 `CHATGPT_OUT_DIR` 指定），`scripts/` 与 `references/` 绝不承载运行数据。
