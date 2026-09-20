# 协作契约：上层 agent（dsh）与网页版 GPT

本文件回答一个问题：**上层 agent 什么时候、以什么方式调用 GPT，以及怎么协同最省成本。**
（`SKILL.md` 管"怎么可靠地送进去取回来"；本文件管"该不该送、送什么、什么时候换会话"。）

结论来自 2026-09-20 与 GPT 的协议设计讨论，原文见
`tasks/20260920-collab-design/answer-*.md`。

## 0｜总原则：四层分工，谁也别越界

| 层 | 决定什么 |
|---|---|
| **dsh** | "需不需要第二认知源" |
| **skill（本 CLI）** | "如何可靠地把一次请求送进去并取回来" |
| **GPT** | "在给定事实和约束下给出判断 / 审查 / 产出" |
| **state file** | "已经确定了什么" |
| **conversation** | 只负责"这一次连续推理过程" |

推论：**聊天历史不是状态数据库。** 长期状态必须落成结构化文件。

## 1｜路由 Gate：该不该调用 GPT

不要靠"我感觉有没有把握"。用三维评分（各 0/1/2）：

| 维度 | 0 | 1 | 2 |
|---|---|---|---|
| **Impact（影响）** | 单点、易撤销 | 多文件或影响后续步骤 | 架构 / 用户可见行为 / 外部副作用 / 难回滚 |
| **Uncertainty（不确定）** | 已有明确答案 | 有两个合理方案 | 证据冲突，不知道哪条路对 |
| **Gap（可验证性缺口）** | 测试 / 编译器可完整证明 | 只能部分证明 | 主要靠语义、产品、架构、审美判断 |

```bash
node <skill>/scripts/chatgpt.mjs route --impact 2 --uncertainty 1 --gap 2 --json
```

判定：

- `A + U + V >= 4` → **CONSULT**（调用）
- `<= 2` → **LOCAL**（本地做，调用属浪费）
- `= 3` → **LOCAL_FIRST**（先做一次廉价本地验证，再复算本 Gate）

### 为什么必须有 Gap 这一维（最容易搞错的地方）

"有测试/编译器能验证 → 不用问 GPT"**太粗**。大量严重的 agent 错误恰恰是：

- 代码能编译、测试能过、符合局部 spec，但**整体方向错了**；
- 改了 5 个文件解决问题，其实该改的是协议层；
- 实现了需求文字，却违反既有架构约束；
- 修掉当前 bug，却制造长期耦合。

客观验证器只能证明 "implementation satisfies machine-checkable assertions"，
**证明不了 "implementation satisfies human intent"**。这就是 **语义验收缺口**。

### 三种模式（不要都用"帮我看看"）

| mode | 含义 | 是否走评分 |
|---|---|---|
| `DECISION` | 判断分叉、方案取舍 | 是 |
| `SEMANTIC_REVIEW` | 语义验收（Gap>=2 时的 CONSULT） | 是 |
| `GENERATION` | 能力委托：写文案、整理、大量生成 | 否，`--mode generation` 直接委托 |
| `EXTERNAL_EVIDENCE` | 外部事实，dsh 无可靠来源 | 否，`--mode evidence` |

调用时**在 prompt 开头写明 mode**，不要用万能句式。

### 三种反模式（必须避免）

1. 把"我该怎么做"整体甩给 GPT（应该是带着方案去求证）；
2. 每个问题都双跑 GPT（双倍成本，不是节省）；
3. 把决策权交出去（GPT 给判断，**采纳与否仍是 dsh/用户的**）。

## 2｜项目 / 会话 / 新窗口

### 什么时候建项目

**只有当"重复消费稳定上下文"时才值得建项目：**

```
预计 >= 3 次 GPT 会话  AND  至少有一份稳定参考资产会被重复使用  →  建项目
```

不要因为"这个任务很复杂"就建项目——**复杂 ≠ 长期上下文复用**。

⚠️ **项目知识库不能当确定性依赖**：官方保证项目是上下文容器，
但不保证某个回答一定检索到某个文件的某一段。关键约束仍必须显式写进当前 prompt。

### 一个会话 = 一个连续推理状态

**不是**"一个交付目标 = 一个会话"。一个交付目标可能跨越需求判断 → 架构 → 实现 → review → 修复，
全塞一个会话会越来越污染上下文。

### 什么时候该新开会话

不要用"20 轮 / 30 轮"这种指标（轮数几乎是最差指标）。只看两条：

1. **上下文相关性**：下一步真正需要的历史信息占当前历史多少？
   `>50%` 继续当前会话；`20–50%` 看是否有强连续推理；`<20%` 新开会话。
2. **契约是否变化**：目标 / 交付物 / 验收标准 / 核心对象 / 角色 任一明显变化 → 新开会话。

例子：

- "继续修这个 timeout bug" → 原会话
- "timeout 已解决，现在重新设计并发协议" → 新会话

保险丝（context hygiene，不是 GPT 的 context limit）：**当前会话可见文本累计 > 30k–50k 字符**时，
做一次总结 → handoff → 新会话。

### 长任务：阶段会话 + handoff

默认模式。切换原则：

- 下一阶段依赖**"之前怎么讨论的"** → 保持原会话
- 下一阶段只依赖**"之前决定了什么"** → 新会话 + 结构化状态文件

```json
{
  "objective": "...",
  "locked_decisions": [],
  "constraints": [],
  "completed": [],
  "open_questions": [],
  "next_action": "..."
}
```

## 3｜省 token：按真实收益排序

**收益从大到小**：调用次数 > read 回来的内容 > prompt 背景 > GPT 输出长度 > 重复上下文
>>>>>> prompt 格式本身。

### 真正有效的

1. **少调用**（靠上面的路由 Gate）；
2. **read 选择性读取**——这是最值钱的一层隔离：GPT 可以写很多，dsh 不必全部消费；
3. **控制 prompt 背景**；
4. **会话复用 + 跨会话结论文件**。

### 预算（按字符，不按行——行数没有意义）

| 项 | 默认 |
|---|---|
| prompt 正文软上限 | 6000 字符 |
| prompt 正文硬上限 | 12000 字符（超过先压缩 / 截取 / 转附件） |
| `read` 返回上限 | 4000 字符（`--max-chars`） |
| decision 输出 | ≤1200 中文字 |
| review 输出 | ≤2000 中文字 |

CLI 已内置：`send` 超软上限给 `warning`，超硬上限直接拒绝（`prompt-over-hard-budget`）；
`read` 默认截断并返回 `responseChars` / `readChars` / `readRatio`。

### 两个容易形成的错觉

- **"大文件走附件就省 token"** —— 错。附件解决 **transport**，不解决 **information volume**；
  GPT 完整读附件照样消耗上下文。它省的是 dsh 自己的上下文和 prompt 噪声。
  正确做法是在 prompt 里**指定范围**："只检查 `src/foo.ts` 的 `FooManager`"、"只看 config.md 的并发部分"。
- **"换模型能省 token"** —— 模型选择主要影响质量、延迟、配额，不是 context token 的大头。

### 最该盯的指标

`readChars / responseChars`。**长期接近 1.0 就说明选择性读取根本没起作用。**

## 4｜输出契约

要求 GPT 按固定骨架回答，dsh 只读结论段：

```
结论 / 理由 / 风险 / 可执行改动 / 不确定项
```

**必须带长度预算**，否则骨架不产生任何 token 保证（GPT 可以在"理由"里写 2000 字）。

## 5｜协议 v1（为后续 IDE 聊天区冻结）

现在只冻结这些，**不要**提前做 streaming：

- 稳定 ID：`request_id` / `project_id` / `conversation_id`
- 机器返回信封：`protocol_version` / `ok` / `code` / `state`
- 状态机：`SENT → RESPONSE_STARTED → GENERATING → SETTLING → SUCCESS / FAILED / CANCELLED`
- 错误码：`timeout` / `conversation_drift` / `auth_required` / `rate_limit` /
  `network_error` / `ui_changed` / `empty_response` / `no_response_started` / `busy`
- **幂等发送**：`send --request-id X` 重复调用**绝不重发**（防断线重试造成重复消息）
- 读取预算：`read --max-chars N`
- 取消语义（待实现）：`cancel <request_id>`——best effort 停止生成、释放锁、
  状态置 `CANCELLED`，**不撤回已发送的用户消息，不删除已生成的部分回答**

`stdout` = 协议 JSON，`stderr` = 诊断日志。上层不解析人类文本。

### 验收方式

写一个**完全不了解 Playwright / CDP / DOM** 的 mock client，只依赖协议 v1，
就能完成：创建/恢复会话 → 发送 → 观察状态 → 读取结果 → 处理错误。
如果它还必须知道按钮、aria-label、页面结构，说明浏览器实现泄漏到了协议层。

## 6｜尚未实现 / 未验证（诚实清单）

- `cancel` 命令、`message_id` 级增量游标（`read --after`）尚未实现；
- "进入项目"的**可靠身份校验**尚未用真实项目做端到端验证（当前用 URL 的
  `projectId` 作为权威判据，`aria-label` 只作辅助）；
- 会话轮换的 `<20% 相关性` 判据目前只能靠 agent 主观估计，尚无自动测量；
- 路由 Gate 的阈值（4 / 2）来自设计推理，**尚未用真实任务回放校准**。
  校准方法：记录"是否调用 / GPT 是否改变了最终行动 / 未调用是否返工"，
  目标是低价值调用率下降、漏问返工率下降，而不是调用率低。
