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

node scripts/chatgpt.mjs init     # ← 先做这一步：绑定"用哪个浏览器 + 哪个已登录 GPT 的 profile"
node scripts/chatgpt.mjs doctor   # 预检：能否用 / 缺什么 / 下一步做什么
```

### 机器级初始化（`init`）——每台机器一次

**这是本 skill 最容易搞错的一环，也是唯一需要用户参与决策的一环。**

每台机器要显式回答两个问题：**用哪个浏览器二进制**、**用哪个已经登录过 ChatGPT 的 Chrome profile**。
配好之前，skill 只能用默认 profile —— 那个 profile 没登录，于是要么报 `NOT_LOGGED_IN`，
要么让用户**在本机再登录一次 GPT**。而同一账号在多处重复登录容易触发风控，
所以正确做法是**复用用户日常那个已经登录的浏览器 profile**。

```bash
# 1) 只探测、不写任何东西：列出本机浏览器、正在运行的 profile、
#    以及"哪个 profile 里有 ChatGPT 使用痕迹"（只读扫描 cookie 库域名与 IndexedDB 目录名，不解密任何凭证）
node scripts/chatgpt.mjs init

# 2) 按建议显式绑定（写进 ~/.chatgpt-web/config.json —— 机器专属，不在仓库里，也不会被 git pull 覆盖）
node scripts/chatgpt.mjs init \
  --browser "C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --user-data-dir "D:\ChromeProfiles\GPT" \
  --profile-directory Default

node scripts/chatgpt.mjs config    # 只读确认：实际会用哪个浏览器/profile，各自来自哪里
node scripts/chatgpt.mjs doctor    # 期望 ready: true, profileVerified: true
```

硬约束与失败状态码（都有实测依据，见 `REVIEW.md`）：

| 约束 | 后果 | skill 的行为 |
|---|---|---|
| 运行中的 Chrome **无法事后**开启 CDP | 已开着的日常浏览器连不上 | `PROFILE_IN_USE_NO_CDP` + 给出确切手工启动命令，**不杀用户浏览器** |
| 同一 user-data-dir 只能有一个可调试实例 | 再启动只会把请求交给已有实例 | `PROFILE_IN_USE_OTHER_PORT`（并报出占用端口），不抢、不换 profile |
| 一个 profile 只能有一个调试实例 | 多宿主改实例名后会互相阻塞 | 共用同一 profile 时**不要**改 `CHATGPT_AGENT` |
| Chrome 136+ 禁止**默认** user-data-dir 开调试端口 | 绑默认目录永远连不上 | `init` 显式警告，建议绑非默认目录 |
| 猜错 profile = 让用户重复登录（有风控风险） | 比报错严重得多 | 默认值里**绝不含**浏览器与 profile 路径；连上的实例不匹配时报 `PROFILE_MISMATCH` |

`doctor` 会列出每个绑定项的实际值、来源（`env:` / `config` / `.env.agent` / `default`）与 `profileVerified`：

- `true`  —— CDP 端口后面那个实例用的确实是绑定的 profile（读的是进程启动参数）；
- `false` —— 连上的是**别的** profile（`launch` 直接拒止，不会静默用错）；
- `null`  —— 本平台拿不到进程信息，无法验证；doctor 明说"无法验证"，**不假装通过**。

> ⚠️ **登录态无法程序化迁移。** 实测：Chrome 127+ 的 cookie 使用 app-bound 加密，
> 把 48 个 chatgpt/openai cookie 解密并迁入新 profile 后**登录态依然不生效**；
> 复制整个 profile 同样失败。所以只有两条路：**绑定用户已有的登录 profile**（推荐），
> 或者让用户在专用 profile 里登录一次。
>
> ⚠️ **绑日常 profile 的取舍**：该 profile 同时只能被一个进程持有（带调试端口时，
> 日常双开会被委托到该实例）。要"开机即用"，建议把带调试端口的启动方式做成该 profile 的唯一入口
> （快捷方式 / 登录时计划任务，参数与 `chatgpt-web config` 的输出保持一致）。

`doctor` 逐项检查并给出**可操作的下一步**（不是抛错）：

| 检查项 | 失败时的含义 |
|---|---|
| `binding-config` | `~/.chatgpt-web/config.json` 缺失或 JSON 坏了 → 跑 `init` |
| `browser-binding` | 绑定的浏览器路径不存在 → `init --browser <绝对路径>` |
| `profile-binding` | 没有绑定 profile → 用默认 profile（需重新登录一次） |
| `cdp-instance` | 实例没起 → `chatgpt-web launch` |
| `profile-match` | 连上的实例不是绑定的 profile → 见上表状态码 |
| `login` | **需要用户登录一次**（正常结果） |
| `applescript-channel` | macOS 上是否能用"零登录备选通道" |

### 一键装到各 agent

```bash
node scripts/install.mjs --dry-run       # 先看要做什么，不改任何文件（跨平台，Windows 可用）
node scripts/install.mjs                 # 装到检测到的宿主（dsh/claude/codex/trae/...）
node scripts/install.mjs --only dsh --agent dsh
node scripts/install.mjs --root "<DSH_HOME>/skills"   # 显式指定 skill 根目录（最保险）

bash scripts/install.sh --dry-run        # 等价能力的 bash 版（会跟随 DSH_HOME）
```

> Windows 上没有 bash 时用 `install.mjs`；`dsh` 的 skill 根目录默认跟随 `DSH_HOME`，
> 不再硬编码 `~/.dsh/skills`（`DSH_HOME` 指向别处时会装错位置）。

### 多 agent 并行（可选）

默认所有 agent 共用一个实例（全局串行，靠锁保证不串线）。
想让它们**真正并行**，给每个宿主不同的实例名，profile / 端口 / 锁会全部隔离：

```bash
export CHATGPT_AGENT=trae     # → profile-trae、独立端口、独立锁
node scripts/chatgpt.mjs doctor
```

> 注意：绑定了一个**已登录的固定 profile** 之后，多实例并行就不再适用 ——
> 同一个 profile 同时只能有一个可调试实例。要并行就得给每个实例各自的登录 profile。

## 结构

```text
chatgpt-web/
├── SKILL.md                  # 任务契约 / R1 运行时 / 原子命令 / Gate / 异常路由
├── scripts/
│   ├── chatgpt.mjs           # CLI：核心原子动作 + 路由 Gate + 协议 + init/config + image
│   ├── lib.mjs               # 跨平台浏览器解析 + 机器级绑定 + 实例隔离 + latch 完成判定
│   ├── compose.mjs           # 页面交互层：选择器 / 注入 / 提交（普通对话与生图共用一份）
│   ├── images.mjs            # 生图任务账本 + 会话 JSON 解析 + 图片下载（含凭证纪律）
│   ├── config.mjs            # 机器级绑定：~/.chatgpt-web/config.json + profile 探测（只读、不解密）
│   ├── procs.mjs             # 尽力读取浏览器进程启动参数（验证 profile / 发现占用）
│   ├── e2e-smoke.mjs         # 端到端冒烟测试（断言每一步契约）
│   ├── install.mjs           # 跨平台安装器（Windows 可用，跟随 DSH_HOME）
│   └── install.sh            # 等价的 bash 安装器（支持 --dry-run）
├── references/
│   └── chatgpt-dom.md        # 唯一允许写选择器的地方
├── THINKING.md               # 沟通思维协议（多轮研讨 / 方法论 Router）
├── COORDINATION.md           # 协作契约（何时调用 / 会话轮换 / token 预算）
├── REVIEW.md                 # 审核记录与经验沉淀（含 Windows 实机验证记录）
└── package.json              # 依赖 playwright-core
```

## 安装

```bash
# 作为 DSH skill（跨平台；dsh 根目录跟随 DSH_HOME）
node scripts/install.mjs --only dsh
# 或手工：把整个目录放到 <DSH_HOME>/skills/chatgpt-web，然后
cd <DSH_HOME>/skills/chatgpt-web && npm install    # 离线: npm install --offline

# 其它宿主（trae / workbuddy 等）用 --root 指定 skill 根目录
node scripts/install.mjs --root ~/.trae/skills
node <skill>/scripts/chatgpt.mjs init     # 然后做一次机器级绑定
```

## 日常使用

```bash
node scripts/chatgpt.mjs config                  # 确认绑定的浏览器/profile（只读）
node scripts/chatgpt.mjs launch                  # 启动/复用那个已登录的浏览器实例（幂等）
node scripts/chatgpt.mjs status                  # 必须 loggedIn: true 且 profileVerified: true
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
- 附件上传完成前发送按钮是 `aria-disabled`（`disabled` 属性仍为 false），**等它真正可用再点**，
  等不到就如实标 `attachmentReady: false` 并改走 Enter（实测 Enter 能提交且附件确实送达）。
- 输入文字后**回读 composer 校验**，React 没吃下 paste 事件就报 `composer-not-filled` 并中止。
- 长回答被截断、Deep Research 正文在 iframe 内取不到时，**如实标注**，不假装拿到。

### 7｜机器级显式绑定：用哪个浏览器 + 哪个已登录 profile
skill 不猜"这台机器的 GPT 登录在哪个 profile 里"——猜错的代价是**让用户重复登录（风控风险）**，
或者**打开的不是用户指定的浏览器**。所以：

- 绑定写在 `~/.chatgpt-web/config.json`（机器专属，**不在仓库里**，git pull / 重装都不会覆盖）；
  优先级 环境变量 > config.json > 宿主级 `.env.agent` > 默认值，且默认值里**绝不含**浏览器与 profile 路径。
- `init` 会只读探测本机浏览器与候选 profile，并判断"哪个 profile 有 ChatGPT 使用痕迹"：
  先看 cookie 库里的 `chatgpt.com` 域名；该文件被运行中的 Chrome 独占时，退回**无锁痕迹**
  （`IndexedDB\https_chatgpt.com_0.indexeddb.leveldb` 目录名、`Local Storage` 里的明文 origin）。
  读不到就返回 `null`，**不当成 false**。
- `launch` 会读**进程启动参数**确认 CDP 端口后面的实例用的就是绑定 profile；
  不匹配 → `PROFILE_MISMATCH`（拒止，不静默用别的 profile）；被别的实例占用 → 
  `PROFILE_IN_USE_NO_CDP` / `PROFILE_IN_USE_OTHER_PORT`（拒止，不杀用户浏览器、不换 profile）。
- 拿不到进程信息（平台不支持 / 权限不足）时 `profileVerified: null`，doctor 明说"无法验证"。

## 生图（一张图 = 一个 GPT 会话）

```bash
# 一个任务 = 一个**新会话**（不是新标签页）：发完提示词、等 URL 定型就返回，不等生成
node scripts/chatgpt.mjs image start --text "画一只戴墨镜的柴犬" --json
# → { jobId, conversationId, url, urlStable: true, inFlight: 1, max: 10 }

# 立刻可以再开下一个会话继续生（服务端并行；默认同时在途上限 10）
node scripts/chatgpt.mjs image start --text "再来一张同风格的猫" --json

node scripts/chatgpt.mjs image list                      # ready / generating / text_only / failed
node scripts/chatgpt.mjs image wait --job <id>           # 等某张出图
node scripts/chatgpt.mjs image download --job <id>       # 按会话 id 收图到本地文件夹（默认 --mode api）
node scripts/chatgpt.mjs image download --all            # 收全部已出图的
node scripts/chatgpt.mjs image download --all --mode dom --allow-ui   # 兜底：走前台 DOM（会抢焦点）
node scripts/chatgpt.mjs image run --text "画一张…"       # 单张一条龙
```

### 取图的三条路（实测对比）

| mode | 机制 | 实测 | 该不该做主线 |
|---|---|---|---|
| `api`（默认） | `/backend-api/conversation/<id>` → `image_asset_pointer` → `/files/<id>/download` → `download_url` | 723875 B，~2s，不碰页面 | ✅ 主线（无人值守） |
| `dom` | 前台渲染出的 `<img src=…estuary/content?id=file_…>` → 只用 cookie 取字节 | 723875 B，**50.4s**（等渲染 ~24s 起），**要前台** | ⛔ 兜底/对照 |
| `native` | 点原生"下载"按钮 + 接 `download` 事件 | 当前 UI **没有**该按钮 → `NATIVE_ACTION_UNAVAILABLE` | ⛔ 仅当 UI 加了按钮 |

三条路拿到的字节 **SHA-256 完全相同**（`26d831a6638d3f9f…`），所以 dom 是可信的对照路径；
但它会抢用户焦点/滚动/切会话，必须显式 `--allow-ui`，且会占用全局锁。

> 为什么不做成"点图片 → 点下载"？因为**实测当前网页版 UI 里根本没有图片下载按钮**：
> 图片 overlay 只有 `编辑图片` / `分享此图片`，会话"更多操作"里只有
> `查看聊天中的文件 / 分享 / 置顶聊天 / 归档 / 删除 / 移至项目`。
> 唯一含"下载"的是无关的 `下载应用`——宽匹配会命中它并错报超时（已修）。
> 结论与 GPT 给的建议一致：**API 做主链路，UI 路径只做诊断/兜底**。

### 测试策略（复用已生成会话，不烧额度）

```bash
# 同一 conversation + fileId 反复下载，判据分层：①HTTP/事件成功 ②魔数+尺寸+字节数
# ③api 重复下载 SHA 稳定 ④api vs dom 的 SHA 相同（强证据，但不硬性要求字节一致）
node scripts/chatgpt.mjs image download --job <id> --json                      # 记下 sha256
node scripts/chatgpt.mjs image download --job <id> --mode dom --allow-ui --json  # 比对 sha256
```

落盘结构（**一张图一个文件**，多图自动编号）：

```text
<CHATGPT_OUT_DIR>/<jobId>/
├── 1-绿色圆盘中的数字9.png      # 文件名取自服务端 fn=（GPT 给图片起的名字）
├── 2-….png
└── images.json                  # fileId / 字节数 / 宽高 / 每个文件的校验结果
```

关键设计（都有实机取证，见 REVIEW.md 第六节）：

| 决定 | 原因 |
|---|---|
| `start` 只记录会话、不等生成 | 生成在服务端并行；这样才可能"每个会话发完就开下一个"，上限 10 个在途 |
| 收图走**会话 JSON**（`/backend-api/conversation/<id>`），不抓 DOM | 实测被切走的会话里 DOM **一张图都没有**（只有空的 `image-gen-overlay-*` 壳）；抓 DOM 会得 0 张 |
| 下载链路 `/files/<id>/download` → `download_url` | 实测返回真 PNG（791638 B，PNG 魔数 + 1254×1254 像素采样核对） |
| `accessToken` 只在内存用 | `/backend-api/*` 需要应用内 token；**不打印、不落盘、不进返回值**（Protected Rule） |
| 字节/魔数/尺寸三重校验 | 防止把 JSON 错误页或 0 字节文件当图片落盘 |
| 空位在"完成被观测到"时释放 | 在途 = 还没被观测到完成的任务；`image list/wait/download` 看到出图即释放名额（不必等下载完）。只 start 不收图会占满名额 |

### 8｜生图：凭证与"不要抓 DOM"

生图相关命令见上文。两条硬规则：

- `/backend-api/*`（会话 JSON、图片下载）需要 `/api/auth/session` 里的 `accessToken`。
  它**只在内存里用于本次请求**：不打印、不落盘、不作为返回值字段——与"不碰凭证"是同一条规则。
- 图片**不从 DOM 取**。实测：生图完成后被切走的会话里，DOM 里没有 `<img>`/`<canvas>`/背景图，
  只有空的 `image-gen-overlay-*` 壳节点；而会话 JSON 里图片带着 `size_bytes`/`width`/`height`，
  是可直接校验的权威来源。抓 DOM 会"看起来成功但拿到 0 张图"。

## 验证

```bash
node scripts/e2e-smoke.mjs --prompt <提问.md> --file <附件> --out <任务目录>
```

按 SKILL.md 规定顺序驱动 CLI，并断言：`launch` 幂等、`loggedIn: true`、
`submitted: true`、`uploaded` 数量吻合、`done: true`、未走兜底、回答非空、会话 id 可解析。

## 工作区规则

本 skill **只是能力，不是任务工作区**：所有输入引用、回答、产物、日志写入目标项目下的任务目录
（用 `CHATGPT_OUT_DIR` 指定），`scripts/` 与 `references/` 绝不承载运行数据。
