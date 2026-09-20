# ChatGPT 页面结构参考

本文件是**唯一允许写选择器的地方**。`SKILL.md` 和业务脚本只调用 `scripts/chatgpt.mjs`，不得内联选择器。
ChatGPT 前端会漂移；选择器失效时只改本文件 + `scripts/chatgpt.mjs` 的 `SELECTORS`/`js` 对象。

## 1. 稳定定位元素

| 元素 | 选择器 | 说明 |
|---|---|---|
| 输入框 | `div#prompt-textarea[contenteditable='true']` | ProseMirror，`role=textbox` |
| 输入框兜底 | `textarea[name='prompt-textarea']` | 无 JS 时的原生 textarea（默认 `display:none`） |
| 发送 | `button[data-testid='send-button']` | `aria-label="发送提示"` |
| 停止 | `button[data-testid='stop-button']` | `aria-label="停止回答"`，**回复中才存在** |
| 语音 | `button[aria-label='启动语音功能']` | 未输入且空闲时的占位按钮 |
| 新聊天 | `a[data-testid='create-new-chat-button']` | `href="/"` |
| 侧边栏开合 | `button[data-testid='close-sidebar-button']` | `aria-label="关闭边栏"/"打开边栏"` |
| 文件上传 | `input[type='file']` | 隐藏 input，用 `setInputFiles` |

## 2. 消息与回复

| 元素 | 选择器 |
|---|---|
| 对话轮次容器 | `[data-testid^='conversation-turn-']` — **不要加 `article` 标签限定** |
| 用户消息 | `[data-message-author-role='user']` |
| 助手消息 | `[data-message-author-role='assistant']` |
| 流式中标记 | 助手消息内 `.result-streaming` |
| 回复操作组 | `div[aria-label='回复操作']` |
| 复制按钮 | `button[data-testid='copy-turn-action-button']` |
| 重新生成 | `button[data-testid='regenerate-turn-action-button']` |

> **2026-09-20 实测漂移**：容器元素已**不再是 `<article>`**（Chrome 153 / 当前灰度）。
> 使用 `article[data-testid^='conversation-turn-']` 会匹配到 **0 个**元素，
> 导致"取最后一条回答"静默失败。`data-testid` 前缀本身仍有效（实测匹配 2 个 = user + assistant）。
> 教训：**只依赖 `data-testid` / `data-message-author-role` 这类语义属性，不要绑定标签名。**

## 3. 项目

| 元素 | 选择器 / 说明 |
|---|---|
| 项目行 | `div.__menu-item`（`role=button`，文本为项目名） |
| 打开项目首页 | `button[aria-label='打开项目首页']` — **悬浮项目行后才出现** |
| 项目选项 | `button[aria-label*='项目选项']` |
| 新建项目 | `button[aria-label='新项目']` |
| 项目名输入 | `input#project-name` |
| 创建确认 | `form#project-modal-form` 内 `type=submit` |

**项目内新聊天 URL**：`https://chatgpt.com/g/{projectId}/c/{conversationId}`
**可靠信号**：composer 的 `aria-label` / placeholder 变成 `"{项目名}中的新聊天"`。若是 `"有问题，尽管问"` 则**不在项目里**（项目知识库不可见）。

> 子聊天标题会被 GPT 自动改名，**不能作为主键**。主键始终用 `projectId + conversationId`。

## 4. 回复完成的判定（多信号，不用单一信号）

任一条单独使用都会误判——简单回复可能产生多个"回复操作"元素，长回复可能在思考间隙短暂无 stop 按钮。

判定协议（`waitForCompletion` 实现，2026-09-20 升级）：

```text
SENT → RESPONSE_STARTED(latch) → GENERATING → SETTLING → SUCCESS / 状态码
```

**硬约束：未观察到"本次回复已开始"，绝不允许判定为完成。**

`RESPONSE_STARTED` 的 latch 条件（满足任一即永久置位）：
- 出现**基线之后的新轮次**（`turnCount > baselineTurns`），或
- 目标轮次里出现了 assistant 节点，或
- 见到过 `stop-button`

latch 之前**只允许等待**，不得判完成——否则页面原本静止（上一条回答还在、无 stop 按钮）时
会把**历史回答**当成本次结果返回。这是本方案最危险的竞态。

latch 之后，完成需四项同时成立：

1. 目标轮次内 assistant 文本**持续 `settleQuietMs`（默认 2000ms）不变**；
2. `stop-button` **连续 `settleStopMs`（默认 1500ms）不存在**（用持续时间，不是瞬时布尔）；
3. 目标轮次内无 `.result-streaming`；
4. 正文无进行时工作态字样（`正在思考|正在搜索|正在分析|正在生成|正在浏览|正在调用`）。

满足后再**间隔 500ms 双采样**，两次文本一致才落地，杜绝瞬时静止误判。

**所有判定都绑定 `targetTurn`**（基线之后新增的那个轮次）内部元素，**不做全页面查询**。

### 失败分类（不给上层一坨网页文本）

完成后先分类再返回，`status` 取值：

| status | 含义 |
|---|---|
| `success` | 正常拿到回答 |
| `no_response_started` | 超时且从未观察到开始生成 |
| `timeout` | 已开始生成但未在预算内 settle |
| `conversation_drift` | 当前 URL 的 conversationId 与预期不符（**可能读到别的任务**） |
| `auth_required` | 掉登录 |
| `rate_limit` | 触发限额 |
| `network_error` | 页面出现报错文案 |
| `ui_changed` | 既无新轮次也无 stop 按钮，疑似改版 |
| `empty_response` | 轮次存在但文本为空 |

**不要**用"回复操作按钮出现"当唯一判据，也不要靠固定 sleep 猜时长。
不要用瞬时布尔代替持续状态。

### 并发隔离

多个 agent 共享同一页面时，并发任务会串线，且**"看起来成功、只是答案属于别人"**。
CLI 对 `new/project/goto/send/wait/ask` 加单 profile 全局互斥锁（`~/.chatgpt-web/lock.json`），
被占用时返回 `status: busy`；崩溃残留锁超过 15 分钟会被抢占。

## 5. 输入文字的正确姿势

ProseMirror 是 React 受控组件，直接改 `innerText`/`value` **不会**更新状态（发送按钮保持禁用）。

正确做法：聚焦后派发带 `DataTransfer` 的 `paste` 事件（`scripts/chatgpt.mjs` 的 `js.insertText` 已实现）：

```js
const dt = new DataTransfer();
dt.setData('text/plain', text);
el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
```

历史上还用过 `document.execCommand('insertText', false, text)`，也可行，但已废弃；两者都失效时再考虑逐字 `keyboard.type`。

## 6. 上传文件

- 走 `input[type='file']` + Playwright `setInputFiles(绝对路径)`。
- **不要**触发 `+` → `添加照片和文件` 菜单（多依赖 UI 漂移，且需要 `filechooser` 事件）。扁平 input 更稳。
- 上传后等 ~2.5s 让 chip 渲染，再发送。
- 输入框里的附件 chip 可点 `移除文件...` 取消，不影响未发送的消息。

## 7. 生成图片

- 图片出现在 assistant 消息内，是 `<img>`（`src` 指向 `https://chatgpt.com/backend-api/...` 或 blob）。
- 抓取时过滤掉头像/图标类 URL（`avatar|profile|emoji|icon`）。
- `read --save` 时用页面自带 `request` 上下文下载，避免额外鉴权。

## 8. 深度研究 / Canvas 等特殊产物

- 深度研究触发后：composer 的 `aria-label`/placeholder 变为 `获取详细报告`，出现 `深度研究` chip 与 `应用` 按钮；发送后先出"研究计划卡片"，需点其中的 **开始** 才真正开跑。
- 报告正文渲染在 `iframe[title="internal://deep-research"]` 内，**外层 `<main>` 取不到正文**。此时 `read` 只拿到卡片外壳，务必如实标注"正文在 iframe 内，未提取"。
- 跨小时任务不要在主流程里干等：用 `wait --timeout` 分段轮询，或交由上层 agent 的循环处理。

## 9. 已知漂移与坑

- 模型选择器可能出现在 composer 附近**或顶部 banner**；不同账户可见项不同（可能只有 `ChatGPT` + 升级入口）。**不得硬编码模型名**，用 `model` 命令读当前可见项。
- 菜单项文案随语言/灰度变化（如 `添加文件等`、`思考一下`），点击前必须先读当前文本。
- `+` 菜单、`@` 候选都不是唯一入口。
- 页面 UI 语言可能是英文（`New chat`）或中文（`新聊天`）：**选择器优先，文本只作辅助**。
- 同一 Chrome 上多个 debugger 控制方（其它扩展、DevTools、chrome-devtools-mcp）会抢占目标页，表现为操作 detached/unknown error。本 skill 用**独立 profile + 独立 CDP 端口**就是为了隔离这一点。
