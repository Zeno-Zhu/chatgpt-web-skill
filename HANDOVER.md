# 交接说明：给下一个使用本 skill 的 AI

本文件面向**其他 AI agent**（workbuddy / codex / trae / claude code …）。
读完这页你就能直接调用网页版 GPT，不需要知道浏览器怎么驱动。

## 0｜一句话

**只用 CLI，不要自己碰浏览器。**

```bash
node <skill>/scripts/chatgpt.mjs <命令>
```

`<skill>` 是你的宿主里的安装路径，例如 `~/.dsh/skills/chatgpt-web`、
`~/.claude/skills/chatgpt-web`、`~/.codex/skills/chatgpt-web`、`~/.trae-cn/skills/chatgpt-web`。

## 1｜三条铁律

1. **不要自己写 Playwright/Puppeteer、不要连 CDP 端口、不要读 cookie。**
   浏览器实现全部封在 CLI 里；你自己接会抢页面、破坏完成判定。
2. **不要自己 `launch`。** 本机通常已有实例在跑，`doctor` 会告诉你能否直接用。
   同一台机器上**一个已登录 profile 只能有一个可调试实例**——多开必然冲突。
3. **每次委托前先 `doctor`**：`ready: true` 才继续；否则按它给的 `nextAction` 办，
   涉及登录/授权/OAuth 的**停下来交给用户**，不要代劳。

## 2｜标准流程

```bash
# ① 预检（每次都做，开销极小）
node <skill>/scripts/chatgpt.mjs doctor --json

# ② 声明上下文（必须显式！见下方"最容易犯的错"）
node <skill>/scripts/chatgpt.mjs new --json                      # 新会话
node <skill>/scripts/chatgpt.mjs goto <url> --json               # 指定会话
node <skill>/scripts/chatgpt.mjs project "<项目名>" --json        # 项目上下文

# ③ 发送（务必带 --request-id，断线重试才不会重复发）
node <skill>/scripts/chatgpt.mjs send --request-id <唯一ID> \
  --text-file <prompt.md> --file <附件> --json

# ④ 等完成（看 status，不要只看 ok）
node <skill>/scripts/chatgpt.mjs wait --timeout 600 --json

# ⑤ 取回（默认只回 4000 字符，够用就别加大）
node <skill>/scripts/chatgpt.mjs read --json
```

一条龙（等价于 ③④⑤）：`ask --request-id <ID> --text-file <prompt.md> --json`

## 3｜调用前先过两道 Gate

**该不该问 GPT**（Impact / Uncertainty / Gap 各 0-2）：

```bash
node <skill>/scripts/chatgpt.mjs route --impact N --uncertainty N --gap N --json
```

- `mode: LOCAL` → **别调用**，本地能判定，调用是浪费；
- `mode: LOCAL_FIRST` → 先做一次廉价本地验证再复算；
- `mode: CONSULT` → 调用，按返回的 `consultType` 声明 mode；
- 能力委托/外部事实 → `--mode generation` / `--mode evidence` 走 bypass。

**探讨/研究类问题**再算一次方法论路由（7 个信号，默认 NONE）：

```bash
node <skill>/scripts/chatgpt.mjs method --f N --v N --e N --p N --a N --m N --x N --json
```

`primary: NONE` 是默认——**不要为了"显得深入"套方法论**。
`blocked: true`（F=2）→ 先补事实再开始想。`operator: M4`（A=2）→
关键答案只能问用户，**不得用假设替代**。

## 4｜必须遵守的判据

| 项 | 规则 |
|---|---|
| `send` | 必须 `submitted: true`，且 `uploadedCount` 等于你传的附件数；否则**不要进入 wait** |
| `wait` | 只有 `status: "success"` 才算拿到结果 |
| 非 success | 按状态码分支：`timeout` / `conversation_drift` / `rate_limit` / `auth_required` / `ui_changed` / `empty_response` / `no_response_started` / `busy` / `composer-has-preexisting-attachments`；**不要把非 success 的文本当回答** |
| `busy` | 另一个任务正占用浏览器 → 串行等待，不要并发硬闯 |
| `read` | 返回受 `--max-chars`（默认 4000）限制；`readRatio` 长期接近 1.0 说明选择性读取失效 |
| 全文 | 要全文先 `--md` 落盘，再按段读，别一次性灌进你的上下文 |
| 长任务 | 默认 2-4 轮，但**轮次不等于深度**：每轮要有 Decision Delta，否则按 `Plateau` 如实收口 |

## 5｜最容易犯的错（实测踩过）

> **`send` / `ask` 接在"当前活跃会话"里。**
> 不先 `new` / `goto`，你的问题会混进上一个话题。实测出现过
> "答案正确、但归属不是预期的会话"——**这种错误比报错更危险**。

其他：
- **不要用固定 `sleep` 猜回复结束**——用 `wait`。
- **不要重发同一 prompt 来"确认"**——用 `--request-id`，重复调用会被幂等去重。
- **不要为了让结果好看而截断或改写 GPT 的回答**；截断了要标注"可能不完整"。

## 6｜新机器 / 新 profile 的绑定

`~/.chatgpt-web/config.json`（**不进 git**）记录本机用哪个浏览器与哪个已登录 profile。
优先级：**环境变量 > config.json > 宿主 `.env.agent` > 内置默认**。

```bash
node <skill>/scripts/chatgpt.mjs init          # 探测本机浏览器与已登录 GPT 的 profile
node <skill>/scripts/chatgpt.mjs config        # 只读展示当前绑定与来源
```

⚠️ 若用户日常 Chrome 里**已经登录** GPT，优先把它绑成 automation profile 的来源，
而**不要**让用户"再登录一次"——同一账号重复登录会话有风控风险。

## 7｜禁止清单

1. 不导出/不保存/不读取 cookie、token、localStorage、storage_state。
2. 不代替用户登录、过 MFA/CAPTCHA、点 OAuth 同意、绕过付费墙与限额。
3. 不往 ChatGPT 发送凭据类内容（cookie / API key / 私钥 / 身份证号）。
4. 不触发**分享/公开链接**、删除会话/项目、清空 Memory（需用户明确同意）。
5. 不自己启动浏览器或复用日常浏览器 profile。

## 8｜出问题时的诊断顺序

```bash
node <skill>/scripts/chatgpt.mjs doctor --json     # ① 环境/登录/绑定
node <skill>/scripts/chatgpt.mjs config --json     # ② 到底在用哪个浏览器与 profile
node <skill>/scripts/chatgpt.mjs status --json     # ③ CDP + 登录态 + 当前会话
node <skill>/scripts/chatgpt.mjs tabs              # ④ 页面是否被切走
```

若 `wait` 一直不结束：先 `read` 看页面是否其实已经有答案（选择器漂移会导致判定失灵），
再检查是否有**残留进程占着锁**（`~/.chatgpt-web/lock*.json`）。
ChatGPT 前端改版会让旧选择器失效——此时只改 `scripts/compose.mjs` 与
`references/chatgpt-dom.md`，**不要动业务逻辑**。
