---
name: chatgpt-web
description: 用确定性命令操控网页版 ChatGPT（复用已登录会话）。适合需要外部第二意见、复杂决策、代码评审、预编程、Deep Research 或图片生成的场景：把文件 + 问题交给网页版 GPT，拿回技术指导、代码或产物。触发词：问问 ChatGPT、让 GPT 看看、把这份文件丢给 GPT、让 GPT Pro/Thinking 想想、让 GPT 出图、deep research、外部意见、第二意见、评审这个方案。
---

# chatgpt-web

让 **dsh / workbuddy / trae / codex** 等任意 agent 通过一组**固定命令**操控网页版 ChatGPT，
而不是每次都让 agent 重新"思考整个操作流程"。

设计前提：ChatGPT 网页是最稳定的部分，所以把稳定操作**固化**成命令，把不稳定的判断留给上层 agent。

## Load First

**多轮研讨 / 思路研究 / 决策类问题，先读 [`THINKING.md`](THINKING.md)** —— 沟通思维协议：

- 三个 Gate 最小闭环：**能不能开始 → 值不值得继续 → 能不能生效**
- R1-R4 轮次协议、可跳过的判据与三个已知漏洞
- **Decision Delta** 与 Counterfactual Delta Gate（防"假装深入"）
- 方法论 Router（F/V/E/P/A/M/X → NONE / M1 六维思考 / M2 萃取 / M3 提示词 / M4 追问）
- 可直接抄的追问句式、五种停止状态、State Promotion Gate、PRD 触发条件

**再做决策类调用时，读 [`COORDINATION.md`](COORDINATION.md)** —— 它规定了上层决策契约：

- 什么时候**该**调用 GPT（三维路由 Gate：Impact / Uncertainty / Gap）
- 何时建项目、何时新开会话、何时 handoff（一个连续推理状态 = 一个会话）
- token 预算与输出契约（prompt ≤6k 字符、read ≤4k 字符、按 mode 限输出）
- 协议 v1 的稳定字段与状态码

本文件的其余部分管"怎么可靠地送进去取回来"；协作边界看 COORDINATION.md。

## 0｜工作区硬规则（必须遵守）

本 Skill 只提供可复用能力，**不是任务工作区**。

- 先识别目标项目目录，并**在目标项目中新建任务文件夹**（如 `<目标项目>/chatgpt-consult-20260920/`）。
- 提问上下文、GPT 回答、截图、生成图片、日志一律写入该任务文件夹。
- 需要落盘时设 `CHATGPT_OUT_DIR=<任务目录>`，或先用 `read` 取回文本再自行写入。
- **任务产物绝不写入 Skill 目录**：`scripts/` 只放可复用能力，不承载任何运行数据。
- 所有脚本必须接收**显式输出路径**，任何情况下都不能默认写入 Skill 目录。
- 无法判断目标目录时先问用户。

## 1｜Task Contract

**Objective**：把"需要外部判断/生成"的任务稳定地委托给网页版 ChatGPT，并把结果**可验证地**取回。

**Inputs**（权威事实源 = 用户指定的文件本身）
- 待问的问题（必需）
- 需要一并上传的文件（可选，给绝对路径）
- 目标会话：新聊天 / 指定会话 URL / 指定项目上下文（可选）
- 期望产物：文本 / 代码 / 图片 / 深度研究报告（可选）
- 输出路径：由调用方以 `CHATGPT_OUT_DIR` 或 `--md` / `--save` 指定，脚本接收**显式输出路径**，不自行决定落盘位置

**Deliverables**
- GPT 的完整回答文本（截断时必须标注不完整）
- 会话 URL（`projectId` + `conversationId`）——后续追问的入口
- 落盘的产物（图片 / Markdown），如需

**Invariants**
- 不导出、不复制、不保存 cookie / token / localStorage / storage_state。
  `/api/auth/session` 的 `accessToken` 只在内存里用于 `/backend-api/*`（生图取图），**不打印、不落盘、不进返回值**。
- 不代替用户登录、过 MFA/CAPTCHA、点 OAuth 同意、绕过付费墙与限额。
- 不静默降级模型：要 Pro 却拿不到，就如实报告可见选项，让用户决定。
- 不往 ChatGPT 发送凭证类内容（cookie / API key / 私钥 / 身份证号），即使用户原始请求里带。

**Authority**
- 用户拥有最终业务决策权与不可逆动作的批准权（A0）。
- 取回与读取是低风险重复动作，agent 可自主执行后汇报（A2）。
- Agent 不得替用户做"是否采纳 GPT 建议"的判断。

## 2｜Runtime Profile：R1 Structured

固定多步 + Gate + 局部修复，不引入额外状态机。

```
Connect → Context → Compose → Send → Wait(Gate) → Read(Gate) → Commit → AskUser
                                   └─ timeout/异常 → repair/询问/上报
```

原子动作 = CLI 子命令。**注意：并非全部幂等**，重跑前必须分清：

| 动作 | 命令 | 幂等? |
|---|---|---|
| Init（每台机器一次） | `init [--browser X --user-data-dir Y]` / `config` | ✅ 只读；`init` 不带参数只探测，带参数才写且已有绑定需 `--force` |
| Connect | `launch` | ✅ 已在运行则复用（并验证 profile 是否匹配） |
| Preflight | `status` / `doctor` | ✅ 只读 |
| Context | `goto <url>` / `project <名>` | ✅ 只读定位 |
| Context | `new` | ❌ 每次都开新会话 |
| Compose | `send --text-file ... [--file ...]` | ❌ **重跑 = 再发一条消息** |
| Wait | `wait [--timeout 秒]` | ✅ 只观察（会消费基线） |
| Read | `read [--md] [--save]` | ✅ 只读；`--save` 会再落一份文件 |
| Inspect | `tabs` / `model [名]` | ✅ 只读（`model` 带参会切换） |
| Image | `image start` | ❌ **重跑 = 再开一个会话再生一张**（要防重就用 `--request-id` 之外的 jobId 记账；先 `image list` 看清在途） |
| Image | `image list` / `wait` / `download` | ✅ 只读；`download` 会再落一份文件 |
| Route | `route --impact N --uncertainty N --gap N` | ✅ 纯计算，决定该不该调用 |

- `send` 只有在**明确确认上次未提交**（`submitted: false`）时才可安全重跑。
- `wait` 成功后不要重复 `send` 同一 prompt；需要追问请明确换内容。
- 会改动会话状态的命令（`new/project/goto/send/wait/read/ask`）持有全局互斥锁，
  被占用时返回 `status: busy`——**串行等待，不要并发硬闯**。

`send` 会写 `uploadedCount`，**必须等于你传入的附件数**；不等说明附件没挂上，不要继续。

## 3｜执行流程（agent 照此调用）

### Step 0｜机器级绑定（每台机器一次，不是每次调用）
```bash
node <skill>/scripts/chatgpt.mjs config    # 只读：现在会用哪个浏览器 / 哪个 profile，各自来自哪里
```
- 没绑定（`configExists: false`，或 `effective.userDataDir` 为空）→ 先 `init` 探测，再显式绑定：
  `init --browser "<chrome.exe>" --user-data-dir "<已登录 GPT 的 profile 目录>" [--profile-directory Default]`。
- **不要**为了省事让用户"再登录一次"：同一账号在多处重复登录容易触发风控；
  优先复用用户**已有**的登录 profile（写进 `~/.chatgpt-web/config.json`，机器专属、不进 git）。
- 绑定是显式的：已有绑定要改必须加 `--force`；skill 不会自动改，也不会偷偷换 profile。

### Step 1｜Preflight
```bash
node <skill>/scripts/chatgpt.mjs launch
node <skill>/scripts/chatgpt.mjs status      # 必须看到 loggedIn: true
```
`loggedIn: false` → **停下**，让用户在那个被打开的 Chrome 窗口里登录，然后重试。不要自己想办法登录。
`profileVerified: false` → 连上的是**别的** profile（`launch` 会拒止）；`null` → 本平台无法验证，
可继续，但必须如实转述"没能证明用的是绑定 profile"。

### Step 1.5｜先算路由 Gate（不要凭感觉决定要不要问）
```bash
node <skill>/scripts/chatgpt.mjs route --impact 2 --uncertainty 1 --gap 2 --json
```
- `mode: LOCAL` → **不要调用**，本地解决。
- `mode: LOCAL_FIRST` → 先做廉价本地验证，再复算。
- `mode: CONSULT` → 继续，按返回的 `consultType` 写 prompt 并声明 mode。
- 能力委托 / 外部事实 → 用 `--mode generation` / `--mode evidence` 走 bypass。

判据与反模式见 [`COORDINATION.md`](COORDINATION.md) 第 1 节。**评分拿不准时不要跳过本步骤。**

如果决定要问，且这是**探讨/研究/决策类**问题（而不是一次性事实查询），
再算一次方法论 Router，决定用哪套思维与怎么追问：
```bash
node <skill>/scripts/chatgpt.mjs method --v 2 --e 0 --p 0 --a 0 --m 0 --f 0 --x 0 --json
```
- `primary: NONE` 是**默认**——不要为了"显得深入"套方法论。
- `blocked: true`（F=2）→ **先补事实**再开始想（防"垃圾进 M2 / 过早进 M1"）。
- `operator: M4`（A=2）→ Authority 类未知**不得用假设替代**，必须问用户。
- `action: decompose` → 多个方法论同时主导，拆阶段，**一条 Atomic Action 只允许一个 Primary Method**。

多轮研讨默认按 2-4 轮推进，但**轮次不是深度**：每轮必须产生 Decision Delta，
否则按 THINKING.md 的停止状态如实收口（含 `Plateau` 必须显式标记，不得伪装成收敛）。

### Step 2｜选上下文
- 默认：`new`（普通新聊天）。
- 用户说"在 X 项目里问"：`project X`，并确认 placeholder 变成 `"X中的新聊天"`；否则说明没进项目。
- 接着旧会话：`goto <url>`。

### Step 3｜组织上下文（关键质量点）
- 大文件不要整篇贴进 prompt：用 `send --file <绝对路径>` 上传，让 GPT 自己读。
- prompt 里明确四件事：**角色/目标、判断标准、输出格式、不确定时怎么办**。
- 一次只问一件事。需要多方比较时，分开提问而不是堆在一段里。

⚠️ **`ask` / `send` 都接在"当前活跃会话"里。** 每次委托前先明确 Step 2 的上下文
（`new` 开新会话 / `goto` 指定会话 / `project` 指定项目），否则问题会混进上一个话题。

### Step 4｜发送并等待
```bash
# 长 prompt 用 --text-file，避免 shell 转义问题；附件可重复 --file
node <skill>/scripts/chatgpt.mjs send --request-id req-20260920-1 \
  --text-file /abs/prompt.md --file /abs/a.md --file /abs/b.pdf --json
node <skill>/scripts/chatgpt.mjs wait --timeout 600 --json
```
- `send` 必须在 JSON 里看到 `submitted: true`，且 `uploadedCount` 等于你传的附件数；
  数量不符或 `pendingText` 非空 → 说明没提交成功，**不要**进入 wait。
- `send` 会自动记录本次请求基线（`baselineTurns`），`wait` 读它并只认**基线之后新增的轮次**；
  因此**不要手工传 baseline**，也不要跳过 `send` 直接 `wait`。
- `wait` 返回 `status: "success"` 才算完成。`status` 是稳定状态码，见下表，
  **不要**把非 success 的文本当成 GPT 的正常回答。
- `wait` 内部有"回复已开始"的 latch：页面原本静止时**不会**误把上一条历史回答返回给你。

### Step 5｜取回结果
```bash
node <skill>/scripts/chatgpt.mjs read --request-id req-20260920-1 --json   # 默认只回前 4k 字符
node <skill>/scripts/chatgpt.mjs read --max-chars 20000 --json             # 明确需要更多时
node <skill>/scripts/chatgpt.mjs read --md              # 文本落盘为 Markdown
node <skill>/scripts/chatgpt.mjs read --save            # 额外下载图片
```
- 默认只读前 4000 字符：**GPT 可以写很多，你不必全部消费**。返回里的
  `truncated` / `responseChars` / `readChars` / `readRatio` 就是给你控制上下文的。
  `readRatio` 长期接近 1.0 说明选择性读取没起作用。
- 需要全文时先落盘（`--md` 始终写全文），再按需分段读，而不是一次性灌进上下文。
- 长回答可能被 GPT 侧截断（出现"继续生成"）。此时**必须**标注"可能不完整"，并可 `send --text "继续"` 续写。
- 深度研究报告正文在 iframe 内，`read` 取不到时如实说明，不要假装拿到了。

### Step 5.5｜生图任务（一张图 = 一个 GPT 会话）

```bash
# 一个任务 = 一个新会话（"窗口"）：发完提示词、等 URL 定型就返回，**不等生成**
node <skill>/scripts/chatgpt.mjs image start --text "画一张…" --json
# → { jobId, conversationId, url, urlStable: true, inFlight, max }

node <skill>/scripts/chatgpt.mjs image list --json          # 每个任务：ready / generating / text_only / failed
node <skill>/scripts/chatgpt.mjs image wait --job <id>      # 等某张出图
node <skill>/scripts/chatgpt.mjs image download --job <id> [--out <目录>]
node <skill>/scripts/chatgpt.mjs image download --all       # 收所有已出图的
node <skill>/scripts/chatgpt.mjs image run --text "画一张…"  # 单张：start → wait → download
```

规则（照此执行，不要自己发明流程）：

- **可以连续开**：`start` 返回后立刻可以 `start` 下一个新会话，生成在服务端并行；
  默认**同时在途上限 10**（`--max` / `CHATGPT_IMAGE_MAX` / config `imageMaxInFlight` 可调），
  超了返回 `IMAGE_LIMIT_REACHED`。**"在途"= 还没被观测到完成的任务**：跑一次
  `image list` / `wait` / `download` 观测到出图后名额**立即**释放（不必等下载完）——
  所以只 start 不收图会把名额占满。
- `urlStable: false`（极少数情况下 30s 内仍是临时 `WEB:` id）→ 如实转述，别把它当稳定入口。
- 收图**不需要**点回那个会话：`image download` 按会话 id 读会话 JSON 并下载。
  这是**故意**不用 DOM 的：实测会话被切走后页面里根本没有图片元素（只有空的
  `image-gen-overlay-*` 壳），抓 DOM 会得到 0 张图。
- 落盘：`<CHATGPT_OUT_DIR>/<jobId>/<序号>-<服务端文件名>.<ext>` + `images.json` 元数据
  （fileId / 字节数 / 宽高 / 校验结果）。**一张图一个文件**，多张自动编号。
- 状态语义：`ready`=有图可下；`generating`=还在生成；`text_only`=模型只回了文字（没出图，
  把 `lastText` 原样给用户看）；`failed`=报错/会话不可访问。
- 凭证：`/backend-api/*` 需要应用内 access token（`/api/auth/session`）。
  **只在内存里用于本次请求，绝不打印、绝不落盘、绝不返回值里带上**——这是 Protected Rule。

### Step 6｜异常路由（只走已定义出口）

`wait` 的 `status` 与出口一一对应：

| status / 现象 | 出口 | 动作 |
|---|---|---|
| `success` | commit | 进入 Step 7 |
| `IMAGE_LIMIT_REACHED` | wait | 在途已达上限 → 先 `image download` 收掉已出图的（空位自动释放），再 start |
| `IMAGE_JOB_NOT_FOUND` | repair | `image list` 确认 jobId / conversationId |
| 生图 `text_only` | report | 模型没出图只回了文字 → 原文给用户，别假装有图 |
| `attachment-not-confirmed` | repair | 附件 chip 没确认渲染 → 本次未发送（**不要**当成功）；看 `probe`/`attachInput` |
| `NO_CDP` | repair | 跑 `launch`，失败则报告 |
| `CHROME_NOT_FOUND` | repair | 绑定的浏览器路径不存在或本机没有浏览器 → `init --browser <绝对路径>` |
| `SPAWN_FAILED` / `CDP_TIMEOUT` | repair | 浏览器没起来 / 起来了但没开调试端口；先手工执行 hint 里的命令看报错 |
| `PROFILE_MISMATCH` | **stop** | CDP 端口上跑的不是绑定 profile → **不要**把它的会话当结果；按 hint 修（换实例/改绑定） |
| `PROFILE_IN_USE_NO_CDP` | ask user | 绑定的 profile 正被没有调试端口的浏览器占用；请用户用 hint 里的参数重启，**不许杀用户浏览器、不许换 profile** |
| `PROFILE_IN_USE_OTHER_PORT` | ask user | 同一 profile 已被另一个可调试实例占用（hint 里有端口）；要么复用它，要么先关掉 |
| `CONFIG_ERROR` | ask user | `~/.chatgpt-web/config.json` 坏了或要改绑定 → 修好或加 `--force`，不要绕过 |
| `NOT_LOGGED_IN` / `auth_required` | ask user | 让用户登录，**不代劳** |
| `no_response_started` | repair | 本次请求根本没开始生成；重新 `send` |
| `timeout` | continue/ask | 已开始但没写完；再 `wait` 一轮，累计别超用户可接受上限 |
| `conversation_drift` | **stop** | 页面跑到别的会话了，**绝不能**把当前文本当结果；重新定位会话 |
| `rate_limit` | ask user | 报告限额，不重试硬闯 |
| `network_error` / `ui_changed` | repair | 原样转述页面文字；疑似改版时只改 `references/chatgpt-dom.md` |
| `empty_response` | repair | 重试一次，仍空则报告 |
| `busy` | wait | 另一任务正占用浏览器，串行等待，不要并发硬闯 |
| 模型不可用 | ask user | 报告可见选项，不静默替换 |
| OAuth / CAPTCHA / 澄清弹窗 | ask user | 停下，原样转述页面文字 |
| 选择器失效 | repair | 只改 `references/chatgpt-dom.md` + `scripts/`，业务提示词不动 |

### Step 7｜Commit
- 会话 URL（`projectId`/`conversationId`）+ 回答 + 验证结果，写入任务目录。
- 明确区分**GPT 的原始输出**与**你的加工**，不得把中间产物当既定事实。
- 长期状态写进**结构化 state file**（`objective` / `locked_decisions` / `constraints` /
  `completed` / `open_questions` / `next_action`），**不要把聊天历史当状态数据库**。

### Step 8｜会话轮换（何时新开会话）
- 下一阶段依赖**"之前怎么讨论的"** → 保持当前会话（省 token）。
- 下一阶段只依赖**"之前决定了什么"** → 新会话 + state file。
- 契约变化（目标/交付物/验收标准/核心对象/角色）或相关性 <20% → 新会话。
- 保险丝：当前会话可见文本累计 >30k–50k 字符 → 总结 + handoff + 新会话。

判据见 [`COORDINATION.md`](COORDINATION.md) 第 2 节。**不要用"聊了多少轮"当判据。**

## 4｜Validation

**L1（机械，必须过）**：`status` 的 `loggedIn` 为 true；`send` 返回 `submitted: true`；`wait` 返回 `done: true`；`read` 返回非空文本。
**L2（语义）**：回答是否真的回应了问题？有无遗漏关键输入？是否只是"看似完成"（如只回了"好的"）？
**L3（质量）**：这份外部意见是否真的改变了下一步行动？若无价值，记录原因而不是硬凑。

## 5｜Autonomy 与边界

- 发送消息、等待、读取：A2（自主执行后汇报）。
- 上传用户文件：A1（默认执行；文件含敏感信息时先确认）。
- 触发**分享/公开链接**、删除会话/项目、清空 Memory：A0，必须先取得明确同意。
- **绝不杀用户的浏览器进程**、绝不静默换 profile、绝不复制/迁移 cookie：
  profile 被占用时如实报 `PROFILE_IN_USE_*` 并请用户决定（复用还是重启）。
- 绑定的 profile 往往是用户的日常浏览器：动它之前先说清"会在那个窗口里开会话/切标签页"。

## 6｜复盘与迭代

1. 在任务目录保存：请求、关键输入与输出、验证结果、用户修正、成功或失败原因。**不要**默认收集整段原始会话。
2. 一次只改一个目标文件。同类证据积累足够后，新建 evolution 任务目录，先跑 `dry-run` 无改动预检，再产出候选与对照验证；候选只能暂存，必须经过独立**审阅**报告后才允许**采用**，定时任务不得自动采用。
3. 只把**重复出现且已定位**的问题变成规则；重复的人工动作才脚本化。
4. 进化必须能 Add / Modify / **Remove**。用户契约、权限边界与平台硬限制属 Protected Rules，不因近期样本无退步而删除。
5. 质量候选需在 key 指标上无不可接受退步，并保留 **held-out / 留出集** 门禁防止过拟合。
6. 没有可检查的质量信号时，保持休眠，先定义未来能收集的证据。**不要伪造分数，不要自建自动自改循环。**

## 7｜环境与接入

| 项 | 值 |
|---|---|
| 脚本位置 | `<skill>/scripts/chatgpt.mjs`（安装到 `$DSH_HOME/skills/chatgpt-web/`，`DSH_HOME` 未设时为 `~/.dsh/skills/`） |
| 依赖 | Node ≥ 20 + `playwright-core`（在 skill 目录 `npm install`，离线可用） |
| **机器级绑定** | `~/.chatgpt-web/config.json`：`browserPath` / `userDataDir` / `profileDirectory` / `cdpPort` / `agent`（机器专属，**不进 git**） |
| 绑定优先级 | 环境变量 > `config.json` > `<skill>/.env.agent`（宿主级实例名）> 默认值 |
| 安装 | `node scripts/install.mjs [--dry-run] [--only dsh] [--root <skills 目录>]`（Windows 可用）；bash 版 `scripts/install.sh`（跟随 `DSH_HOME`） |
| 浏览器 | 用 `init` 绑定的那个（Windows 上会探测 Chrome/Beta/Dev/Canary/Chromium/Edge/Brave） |
| CDP | 默认 `http://127.0.0.1:9444`（`cdpPort` / `CHATGPT_CDP_PORT` 可改） |
| 为什么必须显式绑定 | 运行中的 Chrome 无法事后开启 CDP；同一 user-data-dir 同时只能有一个可调试实例；Chrome 136+ 禁止默认 user-data-dir 开调试端口；重复登录有风控风险 |

首次使用只需登录一次，之后所有 agent 复用同一实例。

## 8｜Avoid

- 不要让 agent 每次重新探索 ChatGPT 页面（这正是本 Skill 要消除的开销）。
- 不要把选择器写进业务提示词或聊天上下文；只改 `references/chatgpt-dom.md`。
- 不要并发在同一会话里发多条消息（会串线）；并发请用不同会话。
- 不要用固定 `sleep` 代替 `wait` 的完成判定。
- 不要为了"看起来完成"而截断或改写 GPT 的回答。
