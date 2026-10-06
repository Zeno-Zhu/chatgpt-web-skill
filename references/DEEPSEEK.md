# DeepSeek 网页渠道（`deepseek.mjs`）

> **什么时候读本文件**：要改这个渠道、它报错了、或要看具体选择器与判据时。
> 正常调用只看 `SKILL.md §11`；本文件是排障与改版的依据。
>
> 打通日期：2026-10-06（本机实测）。上游平台会改前端，改版时按 §6 的顺序重新探。

---

## 1. 它是什么

`chatgpt-web` skill 下的**第二条网页渠道**，与 `chatgpt.mjs`（ChatGPT）并列。
用途：把 DeepSeek 网页当成一个**确定性可调用的问答端点**，从而做
「同一个问题问两家 / 交叉质询 / 圆桌讨论」（编排标准见 `DESIGN-multichannel.md` §5）。

绑定与 ChatGPT **完全隔离**：用不同浏览器、不同 profile 目录、不同端口，
所以两边可以同时开着，互不抢。

---

## 2. 绑定（`~/.chatgpt-web/config.json` 的 `targets.deepseek`）

```json
{
  "version": 2,
  "targets": {
    "chatgpt":  { "browserPath": "...\\chrome.exe", "userDataDir": "C:\\ChromeProfiles\\Google2", "profileDirectory": "Default", "cdpPort": 9444 },
    "deepseek": { "browserPath": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                  "userDataDir": "C:\\EdgeProfiles\\DeepSeek",
                  "profileDirectory": "Default",
                  "cdpPort": 9445,
                  "launcher": "C:\\EdgeProfiles\\start-edge-deepseek.cmd" }
  }
}
```

- 读法：`targets.<name>` 优先，回退到顶层扁平键（兼容 v1）。
- 环境变量可临时覆盖：`DEEPSEEK_BROWSER` / `DEEPSEEK_PROFILE` / `DEEPSEEK_PROFILE_DIRECTORY` / `DEEPSEEK_CDP_PORT` / `DEEPSEEK_LAUNCHER`。

---

## 3. 为什么必须用**复制出来的** profile（本渠道最关键的一步）

绑定**不能**直接用你日常那个 `User Data\Default`，两个硬原因：

1. **已经在跑的浏览器无法事后开调试端口** —— CDP 不能附加到已运行实例（Chromium 硬限制）。
2. **Chromium 136+ 禁止在「默认」user-data-dir 上开 `--remote-debugging-port`**。
   本机实测：带 `--remote-debugging-port` + 默认目录启动，端口**不监听**，静默失败。

所以做法是：**把你已登录的 profile 复制到一个非默认目录，用那个目录启动。**

```powershell
# ⚠️ 必须先完全退出该浏览器！否则复制出来的是旧稳态（见下方 ★）
Stop-Process -Name msedge -Force
Start-Sleep 3
$src = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default"
$dst = "C:\EdgeProfiles\DeepSeek\Default"
robocopy $src $dst /MIR /R:1 /W:1 /NFL /NDL /NJH /NP `
  /XD Cache "Code Cache" "Service Worker" GPUCache DawnGraphiteCache DawnWebGPUCache GrShaderCache ShaderCache GPUPersistentCache Crashpad BrowserMetrics component_crx_cache extensions_crx_cache "Media Cache" `
  /XF load_statistics.db
Copy-Item -Force "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Local State" "C:\EdgeProfiles\DeepSeek\Local State"
```

**★ 为什么必须"先完全退出"**（这是最容易踩空的一步）：

- 浏览器的 localStorage 落在 leveldb 上，**运行中时写缓冲还没落盘**。
- 实测：Edge 开着的时候，扫遍 8 个 profile 的 `Local Storage\leveldb` **全都找不到 `userToken`**；
  干净退出后复制，`userToken` 是**完整的 JWT**。
- 现象很有欺骗性：文件明明在、大小也正常，就是**内容停在旧稳态**，而且**不报任何错**。

**★ 为什么同机复制就能复用登录态**（纠正旧结论）：

- Chrome/Edge 127+ 的 cookie 是 app-bound 加密，但绑的是
  **「这台机器 + 这个 Windows 用户 + 这个浏览器」**，**不绑 profile 目录路径**。
- 所以**同机换目录可用**；跨机器 / 跨用户才不行。
- （仓库里 `config.mjs` 的老注释说"登录态无法程序化迁移"，那是按 **macOS 跨机**场景写的，不要外推到 Windows 同机。）

---

## 4. 启动器（必须走 `explorer.exe`，否则浏览器活不过一次工具调用）

`C:\EdgeProfiles\start-edge-deepseek.cmd`：

```bat
@echo off
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --remote-debugging-port=9445 ^
  --user-data-dir="C:\EdgeProfiles\DeepSeek" ^
  --profile-directory=Default ^
  --no-first-run --no-default-browser-check --disable-background-mode --start-maximized ^
  https://chat.deepseek.com/
```

触发（**从工具调用里就能触发，进程会常驻**）：

```bash
explorer.exe "C:\EdgeProfiles\start-edge-deepseek.cmd"
```

- 原理与反例见 `SKILL.md §9.1`：沙箱回收自己 `spawn` 的 GUI 子进程；`explorer` 挂到资源管理器下即可脱离。
- `deepseek.mjs launch` 已内置这条（读 `binding.launcher`，找不到就回退直接 spawn —— 那种只保证同一次调用内可用）。

---

## 5. 页面契约（选择器 + 判据）

> ⚠️ DeepSeek 的 class 大量是构建 hash（`_27c9245` / `f79352dc` / `_5a8ac7a`），
> **一律不写进选择器**。下面只用「语义前缀 + 文字 + ARIA」。

| 目标 | 选择器 | 备注 |
|---|---|---|
| 输入框 | `textarea[placeholder]` | placeholder：「给 DeepSeek 发送消息」 |
| 发送 | **在 textarea 里按 `Enter`** | 发送键没有 `aria-label`，按 Enter 最稳（Shift+Enter 换行） |
| 深度思考 / 智能搜索 | `div[class*="ds-toggle-button"]` + 文字匹配 | 状态：`aria-pressed === "true"`，回退 `ds-toggle-button--selected` |
| 新对话 | 文字**恰为**「开启新对话」的元素 | ⚠️ 命中 4 个，见下 |
| 助手回复正文 | `[class*="ds-markdown"]` 的**最后一个可见**元素 | 用户消息不在其中（所以"最后一个"就是本条回复） |
| 会话 id | URL `/a/chat/s/<uuid>` | 拿不到就退化为 `document.title` |
| 登录态 | `localStorage.userToken`（app-kit 信封 `{"value":"<JWT>"}`） | 另可读 `__appKit_userInfo.value.id` |

### 5.1｜`newChat` 的静默失败（务必保留回读校验）

「开启新对话」这个文本命中 **4 个**元素：外层包装 `div` / 可点 `div[tabindex="0"]` / 另一个 `div` / `span`。

- ❌ 点 `querySelectorAll` 的第一个（外层包装）：返回 `clicked = true`，**但 URL 未变、会话未切换**。
- ✅ 实测有效：**优先点命中 `[tabindex="0"]` 的那个**；点完**回读**（URL 变了 或 md 块数下降）
  才算成功；不成功就换下一个候选重试。
- 返回结构带 `ok / url / from{url,n} / preferTabindex`，方便对账。

### 5.2｜为什么不能用 hash 类名（具体证据）

用户给的 DOM 片段里带着 `_5a8ac7a a084f19e`（新对话入口）。
它当时**确实命中**，但它是构建产物 —— 下一次 DeepSeek 发版就可能变成别的。
所以用它**验收**（"我的选择器能不能找到"），不用它**实现**。

---

## 6. 等待"生成完成"的判据（踩过两次坑）

实测两版都不行，第三版才对：

| 版本 | 判据 | 结果 |
|---|---|---|
| v1 | 整页 `document.body.innerText` 停止变化 | ❌ **永不收敛**（侧栏/角标有持续变化的文字），每次拖满 timeout |
| v2 | 最后一条回复的文本"**比上一次更长**"= 已开始生成 | ❌ 新回复可能**比上一条更短**（实测 9 字 vs 52 字），永远判不出"已开始" |
| v3 ✅ | **输出容器级**文本 + **发送前快照**当基线 | ✅ 5 秒内判定完成 |

v3 的规则：

1. 发送**前**取快照 `{count, text}`（md 块数 + 最后一块文本），随 `SENDED` 落进
   `~/.chatgpt-web/deepseek-tabs.json` 的 `baseline`，`wait` 读它。
2. **已开始** = 块数 `> baseline.count` **或** 文本 `!== baseline.text`。
3. **已完成** = 已开始 且 文本非空 且 文本连续 `stableMs`（默认 4000ms）不变 且 无明显"停止"按钮。
4. 整体超时（默认 300s）→ 报 `TIMEOUT`，但**仍会把已抓到的文本一并返回**（有用，别丢）。

> 这两条其实是同一个思维方式：**别拿页面/全局状态当进度信号，要用"你关心的那个容器"+"动作前的基线"。**

---

## 7. 命令清单

| 命令 | 作用 | 关键返回字段 |
|---|---|---|
| `doctor` | 绑定 / profile / CDP / 启动器一次看全 | `binding` `browserExists` `profileExists` `cdpAlive` |
| `status` | 登录态 + 开关状态 | `loggedIn` `tokenLen` `userId` `toggles` |
| `launch` | 起浏览器（优先 `.cmd` + explorer） | `reused` `browser` |
| `new` | 新开对话（带回读校验） | `conversation_id` `ok` `from` |
| `toggles [--thinking on|off] [--search on|off]` | 读/设两个开关 | `before` `after` `satisfied` |
| `send --text "..." [--new] [--no-new]` | 只发送，不等 | `submitted` `baseline` |
| `wait [--timeout ms] [--stable ms]` | 等完成 | `done` `elapsedMs` `chars` |
| `read [--md "C:/out.md"] [--after "<上文>"]` | 取最后一条回复 | `via` `text` / `savedMarkdown` |
| `ask --text "..." [--md ...] [--no-new] [--thinking off] [--search off]` | **一次跑完全链路** | 上面字段的合集 |
| `dump` | 打印会话区 DOM 摘要（改版排障用） | `rows` |

信封与 `chatgpt.mjs` 同构：`protocol_version / ok / code / state / target / request_id / ts`。
`code` 取值：`OK` `LAUNCHED` `SENT` `DONE` `NEW_CHAT` `TOGGLES_SET` `NO_CHANGE` |
`CDP_DOWN` `NOT_LOGGED_IN` `NO_COMPOSER` `SEND_FAILED` `TIMEOUT` `BAD_ARGS` `BROWSER_MISSING` `INTERNAL`。

---

## 8. 本机实测记录（2026-10-06）

- 绑定：Edge `Edg/154.0.4258.53`，profile `C:\EdgeProfiles\DeepSeek`（由 `...\Edge\User Data\Default` 干净复制），端口 `9445`。
- 为什么是 `Default` 而不是 `Profile5`：`Profile5` 只是**访问过** deepseek（cookie 有痕迹），
  但 localStorage 的 `userToken` / `__appKit_userInfo.id` 都是 `null` ⇒ **从没登录过**。
  真正登录的是 `Default`（localStorage 里 `userToken` 是完整 JWT、`__appKit_userInfo.value.id` 有值，
  且带完整历史会话）。
  ★ **判登录要看 localStorage 的 `userToken`，不要只看 cookie 里的域名痕迹。**
  （★ 公开文档里**不要**贴真实 `userId` / 凭证片段 —— 写"有值即可"就够，见 §10 脱敏清单。）
- 耗时基线：短问答（开关关闭）≈ 5s；`ask` 含新开对话 + 开关设置 + 等待 + 读取，端到端 ≈ 10s。
- 多轮：`--no-new` 连续两轮会话 id 不变（实测 `4a4f8094-…`），第二轮能正确接住第一轮结论并给出反例。

---

## 9. 改版后的重探顺序

前端一改版，按这个顺序重跑一遍就能重建契约：

1. `node scripts/deepseek.mjs status` —— 先确认 CDP 与登录还在（不在就是环境问题，与改版无关）。
2. `node scripts/deepseek.mjs dump` —— 看会话区还在不在、像消息容器的元素变成什么样。
3. 在浏览器控制台/临时脚本里打印：
   - 输入框：`[...document.querySelectorAll('textarea,[contenteditable]')]`
   - 开关：`[...document.querySelectorAll('[class*="toggle"],[aria-pressed]')]`
   - 回复容器：`[...document.querySelectorAll('[class*="markdown"]')]`
4. 把新结果**按 §5 的三层选择器原则**（语义前缀 > 文字/角色 > ARIA）更新到 `deepseek.mjs`，
   **不要**把新 hash 类名写死。

---

## 10. 对外发布前的脱敏清单（本仓库是公开仓库）

推之前扫一遍，下面这些**一律不许进仓库**：

| 类别 | 例子 | 处理 |
|---|---|---|
| 账号标识 | 真实 `userId` / 手机号 / 邮箱 | 删掉，改写成"有值即可" |
| 凭证片段 | JWT（`eyJ…`）、`settingsJwt`、cookie 值 | 绝不出现，连前几位都不行 |
| 个人路径 | 含真实用户名的绝对路径 | 改成 `<profile 目录>` / `<skill>` 占位符 |
| 会话内容 | 用户的历史对话标题、提问原文 | 不要作为样例贴出 |

```bash
# 推送前跑一遍
grep -rnE "eyJ[A-Za-z0-9_-]{10,}|gho_|ghp_|sk-[A-Za-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" \
  SKILL.md references/ scripts/ 2>/dev/null | grep -v node_modules
```
（第一条正则里的 UUID 形态会命中"示例 id"，人工确认是不是真值再决定留删。）

