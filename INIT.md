# INIT.md · 只读一次的初始化说明

> **这个文件正常情况下不需要读。**
> 只有当下面任一条件成立时才读它——读它是为了少花 token，不是为了走流程：
>
> - 换了一台新电脑 / 换了浏览器 / 换了 profile；
> - `doctor --json` 返回 `ready: false`，或出现 `CHROME_NOT_FOUND` / `CONFIG_ERROR` / `PROFILE_*`；
> - `~/.chatgpt-web/STATE.json` 不存在，或里面 `targets.<渠道>.verified !== true`；
> - 用户明确说"帮我配一下 / 换个浏览器"。
>
> 否则**直接按 SKILL.md 干活**，不要读本文件、不要重新探测浏览器、不要问登录。

## 0｜先读机器状态（一个小文件，代替重新探测）

```bash
cat ~/.chatgpt-web/STATE.json      # 或 node <skill>/scripts/chatgpt.mjs state --json
```

它记录：每个渠道用了哪个浏览器 / 哪个 profile / 哪个调试端口 / 什么时候验过。
`verified: true` 就意味着**不用再查登录、不用再问浏览器**。

## 1｜为什么初始化产出必须放在 `~/.chatgpt-web/`

| 位置 | 内容 | 拉取/更新 skill 时 |
|---|---|---|
| skill 目录（`<skill>/`） | 代码与文档 | **会被覆盖** |
| `~/.chatgpt-web/` | 机器级绑定、状态、锁、请求记账、产物目录 | **永不触碰** |

所以规矩是：**一切"这台机器专属"的产出都写 `~/.chatgpt-web/`，绝不写进 skill 目录。**
这样"初始化一次"才能真的只做一次，且升级 skill 不会丢。

## 2｜初始化流程（一次性）

### 2.1 让用户选浏览器（不要替他猜）

问用户一句话即可：

> 这个渠道你想用哪个浏览器？本机检测到：Chrome / Edge / …

- 候选由 `init` 探测（`node <skill>/scripts/chatgpt.mjs init`，只读，会列出已装浏览器）。
- **不要**默认挑一个就绑定——绑错 profile 的代价是让用户重复登录，甚至有风控风险。
- 多台电脑不必相同：绑定是**每台机器一份**，跟着 `~/.chatgpt-web/` 走。

### 2.2 两条路，**优先走 A**：能复用用户已有的登录态就别让他重登

#### A. 复制用户已登录的 profile（2026-10-06 实测可行，**首选**）

前提：用户**在某台机器上已经登录过**目标网站（不管是在日常 profile 里登录的）。

做法：**把那个已登录的 profile 复制到一个非默认目录**，然后用复制出来的副本启动。

```powershell
# ★ 必须先完全退出该浏览器（见下方"为什么"）
Stop-Process -Name msedge -Force; Start-Sleep 3
robocopy "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default" "C:\EdgeProfiles\DeepSeek\Default" `
  /MIR /R:1 /W:1 /NFL /NDL /NJH /NP `
  /XD Cache "Code Cache" "Service Worker" GPUCache DawnGraphiteCache DawnWebGPUCache GrShaderCache ShaderCache GPUPersistentCache Crashpad BrowserMetrics component_crx_cache extensions_crx_cache "Media Cache" `
  /XF load_statistics.db
Copy-Item -Force "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Local State" "C:\EdgeProfiles\DeepSeek\Local State"
```

**为什么必须"先完全退出"**：localStorage 的 leveldb **运行中写缓冲未落盘**，
开着浏览器复制出来的是**旧稳态**——文件都在、大小正常、**不报任何错**，
但里面根本没有 `userToken`。实测：Edge 开着时扫遍 8 个 profile 全找不到凭证；
干净退出后再复制，凭证是完整 JWT。

**为什么同机复制能复用登录态**（这条纠正了本文件旧版的错误结论）：
app-bound 加密绑的是 **「本机 + 本 Windows 用户 + 该浏览器」**，
**不绑 profile 目录路径** ⇒ **同机换目录可用**；只有跨机器 / 跨用户才不行。
旧版说"搬过来不生效"，那是 **macOS 跨机**场景的结论，**不要外推到 Windows 同机复制**。

> 判据：复制完启动后 `status` 里 `loggedIn: true` ⇒ 成。
> 否则先核对"复制前是否真的退干净了"，而不是急着让用户重登。

#### B. 让用户在专用 profile 里登录一次（兜底）

当 A 不可用时（用户在**这台机器**上从没登录过 / 跨机器迁移 / 读不到 `Local State`）：

- 用专用目录（如 `C:\ChromeProfiles\<渠道>`、`C:\EdgeProfiles\<渠道>`）启动浏览器并带
  `--remote-debugging-port=<端口>`，由用户在里面**登录一次**。
- **登录这一步只能由用户做**，agent 绝不代登录、绝不过验证码/OAuth。

#### 两条路共同的前提

- **不能直接用日常 profile 的目录**：Chromium 136+ **禁止在默认 user-data-dir 上开调试端口**
  （本机实测：带端口参数启动，端口**不监听**，静默失败）；而且日常窗口会抢占同一 user-data-dir。
- 所以无论如何都要落到一个**非默认目录**上——区别只是"拷贝一份"（A）还是"让用户重登一次"（B）。
- **启动器必须走 `.cmd` + `explorer.exe`**（见 `SKILL.md §9.1`）：直接 `spawn` 的 GUI 进程
  活不过一次工具调用。DeepSeek 渠道的现成启动器：`C:\EdgeProfiles\start-edge-deepseek.cmd`。

### 2.3 绑定是显式的

```bash
node <skill>/scripts/chatgpt.mjs init \
  --target <渠道> --browser "<浏览器 exe 绝对路径>" \
  --user-data-dir "<专用 profile 目录>" [--profile-directory Default] [--cdp-port <端口>]
```

已有绑定要改必须加 `--force`；skill 不会偷偷换 profile。

### 2.4 验证并落状态

```bash
node <skill>/scripts/chatgpt.mjs doctor --json     # 期望 ready: true
```

然后**由 agent 把结果写进 `~/.chatgpt-web/STATE.json`**（`verified: true` + 时间 + 内容摘要）。
下次开工只需读这个文件，不必再跑 `doctor`、更不必读本文件。

## 3｜登录问题：默认已登录，不要重复问

**绑定完成后，目标网页通常就一直处于登录态。** 因此：

- 不要每次开工都检查登录、不要问用户"你登录了吗"、不要把"登录"当流程步骤。
- 只有出现下面**硬证据**时才交给用户：
  - URL 稳定落在登录页（`auth.openai.com` / `/auth/login` / DeepSeek 的登录弹窗）；
  - 复检一轮后仍返回 `NOT_LOGGED_IN` / `auth_required`。
- 冷加载瞬时误报不算：先等 composer 就绪（CLI 内置等待窗口），再复检一次。
  用户明确说"我登录是好的" → 按 UI/检测器漂移处理，不要让用户重复登录。

## 4｜多台电脑 / 换渠道时的检查清单

- [ ] `init` 探测已装浏览器 → 问用户选哪个
- [ ] **先试 A：复制用户已登录的 profile**（复制前**必须完全退出**那台浏览器）
- [ ] A 不成立（本机没登录过）→ 走 B：专用 profile 目录已创建，浏览器能用调试端口起来
- [ ] **用户已登录目标网站**（A 成功后无需此步；B 需要用户亲自做，agent 不代劳）
- [ ] 启动了 `.cmd` 启动器，并用 `explorer.exe` 触发（否则活不过一次工具调用）
- [ ] `doctor` 到 `ready: true`（DeepSeek 渠道：`deepseek.mjs doctor` + `status` 里 `loggedIn: true`）
- [ ] 已写 `~/.chatgpt-web/STATE.json`（`verified: true`）
- [ ] 之后正常开工时：**不再读本文件**

## 5｜新增初始化产出时必须同步改三处安装清单

任何新增的顶层文件（如 `INIT.md`、`HANDOVER.md`）都要同时登记：

1. `scripts/install.sh` 的 `FILES`
2. `scripts/install.mjs` 的 `FILES`
3. `package.json` 的 `files`

`references/` 与 `scripts/` 是**整目录复制**（见 `install.mjs` 的 `DIRS`），
所以这两个目录里新增文件**不用**登记。
漏登记的后果是**新机器装上后缺文件**，而报错现场离根因很远。

