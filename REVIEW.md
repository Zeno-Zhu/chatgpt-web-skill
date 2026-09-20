# 审核记录与经验沉淀

本文件记录**审核发现的缺陷**、**怎么发现的**、以及**可迁移的经验**。
它的价值不在"清单好看"，而在下次做同类 skill 时能直接复用这些教训。

## 一、审核结论（2026-09-20）

| 维度 | 结论 |
|---|---|
| 秘密泄漏 | ✅ 干净：无凭据、无 cookie、无 token 落盘；文档明确"不导出不保存" |
| 硬编码本机路径 | ✅ 干净：`scripts/` 与 `references/` 中 0 处 `/Users/laozhu` |
| 跨平台 | ⚠️ 已修：原来 Chrome 路径写死 macOS（P0，见下） |
| 规则自洽 | ✅ `validate-skill.py` PASS（工作区规则、显式输出路径、进化规则、held-out 均齐） |
| 端到端可跑 | ✅ `e2e-smoke` 12/12 ALL PASS（多次） |

## 二、本轮修掉的缺陷

### P0｜Chrome 路径写死 macOS → 其他电脑直接不可用

**问题**：`const CHROME = '/Applications/Google Chrome.app/...'`。
在 Windows/Linux 上 `launch` 必然失败，而这正是"别人拉取后要能用"的前提。

**修复**：`resolveChrome()` 按平台探测常见安装位置（macOS 含 Canary/Chromium，
Windows 含 Program Files / LocalAppData / Edge，Linux 含 chrome/chromium/edge/snap），
并支持 `CHATGPT_CHROME` 显式覆盖；找不到时**不抛异常**，而是返回
`chrome-not-found` + 可操作提示。

### P0｜新机器没有预检，失败信息不可操作

**问题**：新电脑首次使用只能撞到 `NO_CDP` 或 `NOT_LOGGED_IN`，agent 不知道该干什么。

**修复**：新增 `doctor` 命令，输出 `ready` / `verdict` / `nextAction` / `blocking` 与逐项 `steps`。
关键是把"需要用户登录"定义为**正常结果**而不是错误——因为登录态
**无法程序化迁移**（Chrome 127+ app-bound 加密，实测迁移 48 个 cookie 后登录态仍不生效）。

### P1｜多 agent 会互相抢锁（与"给 dsh/trae/codex 都用"矛盾）

**问题**：全局单锁 + 单 profile，意味着三个工具**必须完全串行**。

**修复**：引入实例作用域 `CHATGPT_AGENT`，profile / CDP 端口 / 锁文件全部按实例隔离，
实测 `default→9444`、`trae→9807/profile-trae`、`codex→9470/profile-codex`。
不设实例名时仍是"共用 + 串行"，行为向后兼容。

### P1｜分发缺件

缺 `LICENSE`、`package.json` 无 `license`/`keywords`/`engines`/`files`、
无安装脚本。已补齐，并新增 `scripts/install.sh`（内置 `--dry-run`，
**只复制能力文件，绝不复制 `tasks/` 与运行数据**）。

## 三、端到端测试暴露过的缺陷（真实修复记录）

这些**全部是实跑发现的**，纯代码审阅一个都看不出来：

| # | 缺陷 | 根因 | 怎么发现的 |
|---|---|---|---|
| 1 | 选择器匹配 0 个元素 | `article[data-testid^='conversation-turn-']` 的容器已不是 `<article>` | 实测 `querySelectorAll` 计数=0 |
| 2 | 3 个附件只挂上 1 个 | `parseArgs` 把后续 `--file` 当成前一个的值 | 端到端 A/B 对比 |
| 3 | 点击发送无效就判失败 | 只尝试一次，没有回退 | `send` 返回 `submitted:false` 但页面有文本 |
| 4 | `wait` 永久卡死 | 全页正文正则命中**回答内容本身**里的"正在搜索" | 直接探测判定字段真实值 |
| 5 | 可能返回上一条历史回答 | 缺"本次回复已开始"的 latch | 故意给错基线做**反向测试** |
| 6 | 基线口径脆弱 | 用 conversation-turn 容器数，而 user/assistant 各占一个 | 审查 + 实测计数 |
| 7 | 假的 `conversation_drift` | 新聊天先给临时 `/c/WEB:<uuid>` 再换最终 UUID | 追踪 URL 序列 |
| 8 | `read` 未被锁覆盖 | `wait` 成功后页面可能被别的任务切走 | 逐条核对锁覆盖范围 |
| 9 | 长 prompt 注入被判失败 | ProseMirror 异步提交，回读太早（实测 100ms 内才生效） | 分段回读对比 |
| 10 | `--mode generation` 被维度校验拦截 | bypass 分支放在校验之后（**自己引入的回归**） | CLI 分支逐条实测 |
| 11 | 附件已上传却报 `uploadedCount:0` | chip 检测窗口只有 20s，UI 忙时超时；且只扫全页文本 | **本轮审核后的回归测试**发现 |
| 12 | 附件未确认时**静默继续发送** | 原逻辑清空 `uploaded` 后照发 | 审查发现；已改为直接中止并留 `probe` 诊断 |

## 四、可迁移经验（下次做同类 skill 直接复用）

### 1. 选择器只绑语义属性，绝不绑标签名
`data-testid` / `data-message-author-role` 稳定；`article`、`div` 这类结构标签会漂移。
一次实测就发现容器早已不是 `<article>`。

### 2. 状态判定要"latch + 目标绑定 + 稳定窗口 + 双采样"
四件套缺一不可：
- **latch**：没有"本次任务已开始"的证据，绝不判完成（否则返回上一条历史回答）；
- **目标绑定**：所有判定绑到"本次新增的那条消息"，不做全页查询；
- **稳定窗口**：用持续时间而非瞬时布尔；
- **双采样**：间隔几百毫秒两次一致才落地。

### 3. 工作态信号必须限定在受控区域
扫全页找"正在思考/正在搜索"必然踩雷——**回答内容里可能就在讨论这个词**。

### 4. "看起来相似"的指标要选无歧义的
`conversation-turn` 容器数（user/assistant 各一个）会被误当成轮次；
`assistant` 消息数才是无歧义的。**指标语义要能被一句话说清**。

### 5. 异步 UI 的读回必须轮询，不能只读一次
React 受控组件的提交是异步的。**"操作 + 验证"才叫确定性，读一次就断言不算。**

### 6. 自己新加的保护逻辑也要被测试
第 10 条缺陷就是新加的校验挡掉了合法的 bypass 分支。
**回归测试必须覆盖新增分支，而不只是主路径。**
第 11 条进一步说明：**改了底层（跨平台/隔离）之后必须重跑端到端**，
否则"看起来无关的重构"会以偶发超时的形式暴露。

### 6b. 超时判据窗口要留足，且多证据并用
附件 chip 检测最初只给 20s 且只扫全页文本，在"刚建完新会话"的场景下超时。
改为 30s + 同时认"form 文本 / body 文本 / input 已接收文件"三类证据。
**判据单一 + 窗口过紧 = 偶发假失败**，而假失败比真失败更消耗信任。

### 6c. 校验失败必须中止，不能继续执行
原逻辑在"附件未确认"时清空 `uploaded` 却**照常发送**，会发出空附件消息。
正确做法是**直接返回错误并附诊断**（`probe` 字段），让上层决定是否重试。

### 7. 失败要返回稳定状态码，不要返回一坨页面文本
上层 agent 需要的是"这是什么失败、下一步该干什么"，而不是让它去解析 HTML。
`success / timeout / conversation_drift / auth_required / rate_limit / network_error /
ui_changed / empty_response / no_response_started / busy`。

### 8. 防"假装成功"是设计目标，不是锦上添花
宁可报 `uploaded: []` / `composer-not-filled` / `Plateau`，
也不要让中间产物变成错误事实源。

### 9. 多 agent 共享页面必须有隔离或互斥，二选一
没有它会出现**"看起来成功、只是答案属于别人"**——比报错危险得多。

### 10. 文档里不准确的断言比缺失更危险
本 skill 曾写"原子动作全部幂等"，而 `new`/`send` 天然不幂等。
**断言必须逐条验证**，否则 agent 会照着错的文档重发消息。

### 11. 上下文选择必须是显式动作，不能靠"当前页面"
`ask`/`send` 默认接在"当前活跃会话"里。实测就出现了"新克隆测试接在审计会话后面"的情况
（内容正确、但会话不是预期的那个）。
**会话选择必须由上层显式声明（`new`/`goto`/`project`），不能靠隐式状态**，
否则多任务切换时会出现"答案正确但归属错误"——这与并发串线是同一类风险。

### 12. "用哪个浏览器/profile"必须是机器级显式绑定，不能由 skill 猜
本机（Windows）实测：默认自动化 profile 没登录，而用户日常 Chrome 的另一个 user-data-dir
里**已经登录**了 GPT。让用户在默认 profile 里再登录一次，等于**同一账号重复登录，有风控风险**；
但若不显式绑定，skill 就会一直打开"不是用户指定的那个浏览器"，而用户看到的只是"你怎么又开了个空窗口"。
结论：**把绑定提升为机器级显式配置**（`~/.chatgpt-web/config.json`，不进仓库），
优先级 环境变量 > config.json > 宿主级 `.env.agent` > 默认值，且**默认值里绝不含浏览器与 profile 路径**。

### 13. 进程状态可以"尽力验证"，但不可"假装验证"
Windows 实测：`--remote-debugging-port` 只对应主进程，但 renderer 子进程的 cmdline 里
**同样带** `--user-data-dir`；因此判"谁占用了这个 profile"要优先取主进程（`--type=` 缺失的那个）。
本平台拿不到进程信息时返回 `supported:false` + `profileVerified:null`：
`doctor` 会明说"无法验证"，**不把 unknown 当 true**。

## 五、Windows 实机验证（2026-09-20，首次）

环境：Windows + Chrome 153（Program Files 安装，Edge 只装在 Program Files (x86)），
Node v24.11，skills 根目录由 `DSH_HOME` 指定（**不是** `~/.dsh/skills`），
绑定 profile 为一个"用户已登录 GPT"的日常 user-data-dir（非默认目录）。

**已实机跑通**（非推理）：`doctor` / `init`（探测）/ `config` / `launch` / `status` / `new` / `send`（带附件）/
`wait` / `read --md` / `ask` / `model` / `route` / `method`。
附件链路验证方式：附件里写 `SECTION-TOKEN = ALPHA-7788`，GPT 的回复里**真的把它念了回来**，
说明附件确实送达并被读取，不是"看起来发送成功"。

本轮实机发现并修掉的缺陷：

| # | 缺陷 | 根因（Windows 实测） | 修法 |
|---|---|---|---|
| 1 | `read --json` 的 `code` 变成 `[]` | 协议信封写成 `{协议字段, ...payload}`，payload 里同名的业务字段（代码块数组）**顶掉了状态码** | 信封改为 payload 在前、协议字段在后覆盖 |
| 2 | 带附件时 `send` 白等 10s 才回退 Enter | chip 文本先出现、上传未完成时按钮是 `aria-disabled="true"`（`disabled` 属性仍为 false），坐标点击被 UI 忽略 | 上传后轮询等按钮真正可用（`attachmentReady`），不可用则跳过点击直接 Enter；按钮确认窗口 10s→6s |
| 3 | "没装浏览器"报成 `spawn ENOENT` | `cmdLaunch` 在 `launchChrome()` **之后**才判 `!CHROME`，而 `spawn('')` 先抛异常 | 判空前置到 spawn 之前，返回 `CHROME_NOT_FOUND` + 可操作提示 |
| 4 | Edge 探测漏判 | 候选表只查 `%PROGRAMFILES%\Microsoft\Edge`，本机 Edge **只装在 `%ProgramFiles(x86)%`** | 候选表按 Program Files / (x86) / LocalAppData × Chrome/Beta/Dev/Canary/Chromium/Edge/Brave 展开 |
| 5 | `install.sh` 在 Windows 装错位置 | bash 脚本 + 硬编码 `$HOME/.dsh/skills`，而本机 skills 根是 `$DSH_HOME/skills` | 新增跨平台 `scripts/install.mjs`（支持 `--root/--only/--dry-run/--agent`）；`install.sh` 改为跟随 `DSH_HOME` |
| 6 | `.env.agent` 是死配置 | `install.sh --agent` 会写它，但**没有任何代码读它**（文档承诺的实例隔离不生效） | 新增 `config.mjs` 真正读取它（宿主级实例名，优先级低于环境变量、高于 config.json 默认值） |
| 7 | 重跑 `init` 会静默改绑定 | 无冲突检查 | 与既有绑定不同时必须 `--force`，否则 `CONFIG_ERROR` + `conflicts` 明细 |

**仍未验证 / 已知限制**：
- 图片生成落盘（`read --save`）、Deep Research（正文在 iframe 内）、`project` 项目上下文在 Windows 上未实机验证。
- 用户日常 profile 与自动化实例**互斥**：同一个 user-data-dir 同时只能有一个可调试实例
  （已实测：换个实例名再用同一 profile → `PROFILE_IN_USE_OTHER_PORT`，并给出确切手工启动命令）。
- 若用户**已经**用普通方式打开了那个 profile（没有调试端口），运行中的 Chrome 无法事后开启 CDP，
  此时返回 `PROFILE_IN_USE_NO_CDP` 并提示用户用绑定参数重启；**skill 不会去杀用户浏览器，也不会偷偷换 profile**。
- 默认 user-data-dir（`%LOCALAPPDATA%\Google\Chrome\User Data`）即使有 ChatGPT 登录也**不可绑定**：
  Chrome 136+ 禁止默认目录开远程调试端口。`init` 会就此给出显式警告。

### 判断"这个 profile 登录过 GPT"不能只靠 Cookies 文件
Windows 实测：Chrome 运行时**独占** `<profile>\Default\Network\Cookies`（读它报"正被另一个进程使用"），
于是"cookie 里有 chatgpt.com 吗"会返回 **null**，而 null 很容易被误当成 false（进而推荐错的 profile）。
改用**不依赖被锁文件**的证据：`IndexedDB\https_chatgpt.com_0.indexeddb.leveldb`
（目录名自带 origin）+ `Local Storage\leveldb\*` 里的明文 origin。
拿不到任何证据时如实返回 `null`（unknown），**不返回 false**。

## 六、生图任务实机验证（2026-09-20，Windows）

需求：**在聊天流程里让 GPT 生图，并把图片下载到本地文件夹**；
语义是"**一张图 = 一个 GPT 会话（新聊天）**"——每个会话发完提示词、等 URL 定型即可开下一个，
同时最多 N 张在途，收图时按会话回取。

### 关键取证（决定了实现方式）

| 现象 | 实测证据 |
|---|---|
| 生图**成功**了 | 会话 JSON 里 `image_asset_pointer: sediment://file_0000000070d081fd8cdf5a4e751234ff`，`image/png`，`size_bytes: 791638`，`1254x1254` |
| 但 **DOM 里没有图** | `conversation-turn-2` 内只有"编辑" + 空的 `data-conversation-screenshot-content`；全页只有 `image-gen-overlay-*` 空壳节点，无 `<img>`/`<canvas>`/背景图/iframe |
| 后端 API 需要应用内 token | 只带 cookie 请求 `/backend-api/conversation/<id>` → **404 `conversation_inaccessible`**；带 `Authorization: Bearer`（来自 `/api/auth/session`，plus 账号）→ 200 |
| 下载链路可用 | `/backend-api/files/<id>/download` → JSON `download_url` → GET 得 791638 B，魔数 `89504e470d0a1a0a`（PNG） |
| URL 确实稳定 | 临时 `/c/WEB:<uuid>` → 约 15s 后换成正式 UUID，之后不再变（文本对话通常 1s 内定型） |
| **页面切走不影响生成** | 会话 B 刚定型就开 C（同一标签页导航走），B 仍在服务端生成完成并 `ready` |

### 落地的命令与语义

`image start`（开新会话 + 发提示词 + 等 URL 定型 + 记账，**不等生成**）、
`image list` / `image wait` / `image download [--all]` / `image run`。
同时在途上限默认 10（`--max` / `CHATGPT_IMAGE_MAX` / config `imageMaxInFlight`），
**"在途"= 还没被观测到完成的任务**：`image list/wait/download` 观测到出图后名额立即释放
（这正好对应用户说的"前面生成完后面又可以补充进去"）；落盘
`<CHATGPT_OUT_DIR>/<jobId>/<序号>-<服务端文件名>.<ext>` + `images.json`。

### 本轮实机发现并修掉的缺陷

| # | 缺陷 | 根因（实测） | 修法 |
|---|---|---|---|
| 1 | `wait` 直接崩：`Execution context was destroyed` | 生成中途页面导航（临时 URL → 正式 UUID / 整页重载），`page.evaluate` 抛错被当成失败 | 采样与双采样都容忍导航（连续失败上限后才报 `ui_changed`） |
| 2 | 生图任务误报 `NOT_LOGGED_IN` | 新标签页 `domcontentloaded` 时 composer 还没渲染，`isLoggedIn` 只看 `#prompt-textarea` | 开新会话/新标签页后**等 composer 出现**再判定 |
| 3 | 附件 chip 检测失败（`inForm: 0`，`inputFiles: 1`） | 页面有 **5 个 file input**；`input[type=file]` 的 `.first()` 顺序依赖，文件被"照片"通道吃掉，chip 不渲染 | 显式投给 `#upload-files`（兜底 `input[type=file]:not([accept])`），并在返回值里带 `attachInput` |
| 4 | 修 #3 后**仍然**检测失败 | 草稿里的同名附件跨"新聊天"保留 → ChatGPT 去重重命名为 `attach(2).md`，而匹配用的是**精确文件名** | 匹配容忍 `(n)` 后缀，并把 `attachmentsRenamed` 作为"草稿里本来就有同名附件"的证据上报 |
| 5 | 生图收图拿到 0 张图 | 见上表"DOM 里没有图" | 改走会话 JSON + `/files/<id>/download`（并且**不解密、不导出凭证**） |

### 验证结果（真实生成 + 落盘 + 像素核对）

- 三个任务并行（A 绿圆 9 / B 橙三角 / C 紫五角星），`image wait --all` 全部 `ready`；
  B 是在"页面已被 C 切走"的情况下照样生成完的。
- `image download --all` 落盘 3 个 PNG，`verified: true`（下载字节 == 服务端 `size_bytes`），
  `images.json` 记录 fileId/尺寸/校验。
- 用浏览器把 PNG 解码后采样像素核对内容：绿圆 center `rgb(2,172,7)`、橙三角 center `rgb(254,129,6)`、
  紫五角星 center `rgb(141,5,212)`，四角均为近白 —— 与提示词一致（不依赖任何图像库）。
- 上限闸门：在途 1 时 `--max 1` → `IMAGE_LIMIT_REACHED`（不消耗生成）；下载后 in-flight 归 0，
  再 `--max 1` 即可继续 start。
- 重构 `send`/DOM 层（抽到 `compose.mjs`）后**回归复测**普通对话 + 附件：`attachmentReady: true`，
  GPT 再次回读了附件里的 `ALPHA-7788`。

### 工程教训（Windows 专属，踩了两次）

- **不要用 PowerShell 的 `Get-Content -Raw` + `Set-Content` 改写源码**：Windows PowerShell 默认按
  系统 ANSI（本机 CP936）读 UTF-8 文件 → 中文被转成 mojibake、不可逆处变成 `?`，写回时还带 BOM
  破坏 shebang。本轮 `scripts/chatgpt.mjs` 就是这样被写坏（352 个 U+FFFD），只能 `git checkout` 后重做。
  结论：**改文件用 UTF-8 安全的编辑器/工具；要校验就 `node --check` + 统计 U+FFFD**。

## 七、生图取图：三条路的实测对比（2026-09-20，第二轮）

起因是有人问："为什么不模拟点击图片 → 点图片的下载？" 我们按"先取证再设计"重做了一轮：

| 问题 | 实测答案 |
|---|---|
| 后台标签页里图片在 DOM 吗？ | **不在**。只有空的 `image-gen-overlay-*` 壳节点，全页无 `<img>`/`<canvas>`/背景图/iframe |
| 前台呢？ | **在**：`page.bringToFront()` 后同一会话出现 3 个 `<img src="…/backend-api/estuary/content?id=file_…">`，`naturalSize 1254x1254`；但**冷加载要轮询 ~24s** 才出现 |
| 有"图片下载"按钮吗？ | **没有**。图片 overlay 只有 `编辑图片` / `分享此图片`；会话"更多操作"只有 `查看聊天中的文件/分享/置顶聊天/归档/删除/移至项目`；唯一含"下载"的是无关的 `下载应用` |
| 点图片会开灯箱吗？ | 不会（无 `role=dialog` / lightbox 出现） |
| estuary URL 需要 token 吗？ | **不需要**（浏览器渲染图片用的就是 cookie）。但**会话 JSON** 需要 `Bearer accessToken`，只带 cookie 会 404 `conversation_inaccessible` |
| 三条路字节一致吗？ | **完全一致**：cookie-only == with-token == `/files/<id>/download`，`bytes=723875`、`sha256=26d831a6638d3f9f…` |
| 耗时对比 | api ≈ 2s（不碰页面）；dom ≈ **50.4s** 且要抢前台；native = 按钮不存在 |

据此落地 `image download --mode api|dom|native|auto`：
- 默认 **api**（主线、无人值守）；`dom`/`native` 必须显式 `--allow-ui`，否则 `FOREGROUND_REQUIRED`；
- UI 路径独占浏览器（抢全局锁，占用时 `status: busy`）；
- `auto` = api → （仅在 `--allow-ui` 时）dom；**绝不静默走 native 点击**；
- 返回值带 `mode` / `fileId` / `bytes` / `sha256`，便于跨路径对比复现。

### 本轮修掉的缺陷

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | 之前文档断言"生图不要抓 DOM，DOM 里没有图"**不准确** | 当时标签页一直在后台；前台是会渲染的 | 改为"后台不渲染、前台渲染但要等 ~25s"，并保留 api 为默认（后台/无人值守仍不该抓 DOM） |
| 2 | `native` 模式错报 `DOWNLOAD_EVENT_TIMEOUT` | 宽松选择器 `[aria-label*='下载']` 命中了无关的 **`下载应用`**（Download app），点了它自然等不到 download 事件 | 选择器收窄为 data-testid / 精确 label / overlay 范围，排除"下载应用"；没有真按钮时如实返回 `NATIVE_ACTION_UNAVAILABLE` |
| 3 | UI 路径可能偷偷抢用户前台 | 最初实现无门禁 | 加 `--allow-ui` 硬门禁 + 全局锁 + `FOREGROUND_REQUIRED` |

### 与 GPT 的协作结论（其中一次调用就是本 skill 自己发起的）

GPT 的判断与实测一致：**API 做主链路，原生点击只做诊断/兜底**（UI 依赖前台渲染、按钮存在性、
hover、文案漂移，还会抢用户焦点；`connectOverCDP` 官方也属较低 fidelity）。
它同时给了可用建议并被采纳：`--mode api|native` 显式化、`--allow-ui` 门禁、
先监听 `download` 事件再点击、返回 `mode/fileId/path/bytes/sha256`、
以及**分层测试判据**（①事件/HTTP 成功 ②魔数+尺寸+字节数 ③重复下载 SHA 稳定
④跨路径 SHA 相同作为强证据但不硬性要求字节一致）。
风控上它指出：没有证据表明"模拟点击更安全"，真正该控的是频率/并发/会话 churn。

## 八、仍未解决 / 未验证（诚实清单）

- **登录态跨机迁移**：无法程序化完成，每台新机器需用户登录一次（或绑定用户已有的登录 profile，
  见 `init`）。已用 `doctor` 把这一步显性化。
- **Windows / Linux**：Windows 已实机验证（见上）；**Linux 仍未实机验证**。
- **AppleScript 备选通道**：仅 macOS；需用户手动开启"允许 Apple 事件中的 JavaScript"；附件上传不可靠。
- **路由阈值未校准**：`route` 的 4/2 阈值、`method` 的 7 信号映射，均来自设计推理 + 三轮压测，
  **未用真实任务回放校准**（方法见 `THINKING.md` 第 9 节）。
- **`cancel` / `read --after`**：已在协议里定义语义，尚未实现。
- **图片生成落盘**：已实机验证（第六、七节）。仍**未**验证：一次返回 2 张以上的多图会话、
  图生图（`--file` 传参考图）、以及 `read --save` 这条旧的 DOM 抓图路径。
- **`native` 模式**：当前 UI 无下载按钮，只验证到"如实报 `NATIVE_ACTION_UNAVAILABLE`"；
  一旦 UI 加上按钮，`download` 事件路径需要重新实机验证。
- **Deep Research**：正文在 iframe 内，`read` 取不到；未实机验证。
- **`project` 项目上下文**：未在 Windows 实机验证（当前以 URL 的 `projectId` 为权威判据）。
- **"开机即用"未落地**：目前靠用户/上层显式 `launch`。要让那个已登录 profile 在开机后自动带调试端口启动，
  需在 Windows 上做快捷方式/登录时计划任务（参数必须与 `config` 输出一致）；本仓库不代为创建系统级任务。
