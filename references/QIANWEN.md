# 千问渠道（qianwen.com，阿里）

> 状态：**契约已定稿并端到端验证**（2026-10-07，Edge 154）。
> 入口：`node scripts/qianwen.mjs <cmd>`　｜　实例：端口 **9447**，目录 `C:\EdgeProfiles\Qianwen`

## 1｜为什么是"独立实例"

和其他渠道同样的三条硬约束：

1. **已在运行的 Edge 无法事后开调试端口**——CDP 不能附加到已启动的实例。
2. **Chromium 136+ 禁止在默认 user-data-dir 上开 `--remote-debugging-port`**，
   表现是端口根本不监听（静默失败，不报错）。
3. 所以必须落到独立目录 → `C:\EdgeProfiles\Qianwen`，由
   `C:\EdgeProfiles\start-edge-qianwen.cmd` 拉起。

本实例是**全新干净目录**（不是从别人的 profile 复制），原因是新渠道只需要"能登录"，
不需要继承任何历史状态。访客态即可用，登录后解锁更多能力。

## 2｜绑定（`~/.chatgpt-web/config.json`）

```json
"qianwen": {
  "browserPath": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "userDataDir": "C:\\EdgeProfiles\\Qianwen",
  "profileDirectory": "Default",
  "cdpPort": 9447,
  "launcher": "C:\\EdgeProfiles\\start-edge-qianwen.cmd"
}
```

环境变量覆盖前缀 `QIANWEN_*`（如 `QIANWEN_CDP_PORT`）。

> ⚠️ **顶层扁平键不属于本渠道。** `config.json` 顶层的 `browserPath` / `userDataDir`
> 是主渠道 chatgpt 的绑定。`channel-kit.mjs` 的 `resolveBinding()` **默认不吃扁平回退**，
> 只有显式 `flatFallback: true` 才吃。踩过：新增渠道时忘了写 `targets.qianwen`，
> 扁平回退把 `browserPath` 指成了 chatgpt 的 Chrome + `C:\ChromeProfiles\Google2`，
> 而 `doctor` 依然报"一切正常"——真去 launch 就会用别人的 profile 开窗口。
> **判据**：`doctor` 输出的 `binding.source` 必须是 `config:targets.qianwen`。

## 3｜页面契约（改版时按这张表重探）

| 项 | 选择器 / 判据 | 备注 |
|---|---|---|
| 输入框 | `div[contenteditable="true"]` | ProseMirror 富文本，**不是** textarea |
| **提交方式** | 点 `button[aria-label="发送消息"]` | ★ **回车不提交** |
| 发送按钮可用性 | 空输入时 `disabled=true`，有字才 enable | 硬点 disabled 按钮会静默失败 |
| 模式触发器 | `button[aria-haspopup="menu"]` | 按钮文字即**当前模式** |
| 模式菜单 | `[role="menu"]` → `[role="menuitemcheckbox"]` | Radix 风格 |
| 模式状态字段 | `data-state="checked"｜"unchecked"` | ★ 菜单展开时可直接读 |
| 回复卡片 | `[class*="chat-answers-card-wrap"]` | 卡片含正文 + 推荐按钮 |
| 回复正文 | `.qk-markdown` | 必须与卡片**分开取**，否则混入 UI 文案 |
| 会话 URL | `https://www.qianwen.com/chat/<32位hex>` | 用于 `conversation_id` |

### 3.1 模式（「快速」⇄「思考研究」）

- 默认 **快速**（"适用于大多数情况"）。
- 目标 **思考研究**（"深度搜索、深度研究"）——本渠道默认值，见 `defaults.thinking = true`。
- 操作：点触发器 → 菜单里点目标项。**回读判据**：触发器文字变成目标项文字。

> ★ **这个档位不是持久化的**（2026-10-07 实测）：设成「思考研究」→ 关浏览器 → 重开，
> 又回到「快速」。localStorage 里的键名也印证了这点——
> `qianwen:expert-mode:v2:**session**:<sid>`，是**会话级**的。
> ⇒ 所以 `ask` **每次都重新应用一次模式**，不能假设"上次设过就一直在"。
> 这正是"动作前对齐状态、动作后回读"这条纪律的价值所在；
> 顺带一提：只读的 `status` 也就因此有必要每次都跑。

> 关于 `data-state`：它在**菜单展开期间**是可靠的回读字段；点完菜单关闭，元素消失，
> `getAttribute` 会返回 `null`。所以引擎的策略是"能读 data-state 就用它校验，
> 读不到就退回触发器文字"——两条都留，不依赖单点。

## 4｜命令

```bash
cd ~/.workbuddy/skills/chatgpt-web

node scripts/qianwen.mjs doctor              # 绑定/端口/契约自检
node scripts/qianwen.mjs status              # 登录态 + 当前模式
node scripts/qianwen.mjs launch              # 起实例（若未运行）
node scripts/qianwen.mjs modes               # 只读当前模式
node scripts/qianwen.mjs modes --thinking on # 切到「思考研究」
node scripts/qianwen.mjs new                 # 新对话（带回读校验）
node scripts/qianwen.mjs ask --text "..." --md out/ans.md
node scripts/qianwen.mjs ask --no-new --text "..."   # 多轮，延续当前会话
node scripts/qianwen.mjs read --md out/ans.md        # 只读最后一条回复
node scripts/qianwen.mjs quit                # 关浏览器前先把凭证落盘
```

## 5｜本机实测记录（2026-10-07）

| 项 | 结果 |
|---|---|
| 单轮问答 | ✅ `ok:true` / `done:true` / **≈5.1s** / 26 字 |
| 多轮（`--no-new`） | ✅ 延续同一会话，正确接住上一轮 |
| 新对话 | ✅ URL 变化 + 回复块数 4→0（双判据） |
| 模式切换 | ✅ `快速 → 思考研究`，触发器文字回读一致 |
| 访客态 | ✅ 可用（`requireLogin: false`） |

## 6｜踩坑记录

1. **JS 的 `element.click()` 打不开菜单**。触发器的 `aria-expanded` 一直是 `false`，
   但点击"成功返回"。这类 React/Radix 组件监听指针事件 → 必须用 Playwright locator
   发**真实鼠标事件**。已写进 `channel-kit`：**所有交互一律走 locator**。
2. **回车不提交**。见 §3 表格。
3. **不能用"输入框是否清空"判断是否提交**。实测出现假阴性：消息其实已发出、答案正在生成，
   但输入框没被清空，于是报了 `SEND_FAILED`。现在用**双判据**：输入框内容变化 / 发送按钮变 disabled，
   **外加**"助手容器数量增加"的正向交叉验证。
4. **placeholder 是真实节点**，空白时 `innerText` 返回「向千问提问」而不是空串 ——
   任何"文本为空即视为未输入"的写法在这里都会失效。
5. **答题卡片 ≠ 正文**。卡片里混有"好的，交给工作助理模式继续完成"这类推荐按钮文案，
   直接用卡片 `innerText` 会把非模型输出带进答案。现在两级选择器 + `dropLines` 行级过滤。

## 7｜改版重探顺序

1. `status` → 看 `loggedIn` 与 `modes`；`modes: null` 说明触发器选择器失效。
2. `dump` → 列可见的小控件（带 `aria-haspopup` / `aria-expanded`），重新定位模式触发器。
3. `ask --text "1+1"` → 若 `SEND_FAILED`，先看 `composerAfter` 与 `how`；
   若 `done:false` 或文本里混入 UI 文案，重探 `assistant.sel` / `textSel`。
4. 每改一处，**只改 spec**（`scripts/qianwen.mjs`），不要动 `channel-kit.mjs`。
   引擎里的选择器一律来自 spec，这是这套结构的意义所在。
