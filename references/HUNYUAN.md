# 混元渠道（Hy AI Studio，aistudio.tencent.com）

> 状态：**契约已定稿**（2026-10-07 实测，Edge 154）。端到端跑通、登录态落盘重开验证通过。
> 入口：`node scripts/hunyuan.mjs <cmd>`　｜　实例：端口 **9446**，目录 `C:\EdgeProfiles\Hunyuan`
> 目标：**默认打开 High**（提供更充分的思考与推理）——用户明确要求。

## 1｜状态表

| 项 | 状态 |
|---|---|
| 独立实例（`C:\EdgeProfiles\Hunyuan` + `start-edge-hunyuan.cmd`，端口 9446） | ✅ |
| 绑定写进 `config.json` → `targets.hunyuan` | ✅ `binding.source` 必须是 `config:targets.hunyuan` |
| 登录态 | ✅ `loggedIn: true`，`quit` 落盘后重开仍为 true |
| 输入框 `textarea.t-textarea__inner` | ✅ |
| 提交方式 | ✅ **回车即提交**（不需要点发送按钮） |
| 回复正文 | ✅ `.hyc-common-markdown`（两级选择器，见 §3） |
| 档位 No Think ⇄ High | ✅ 双向可切、回读一致 |
| 新对话 | ✅ 点侧栏「对话」 |
| 端到端 `ask` | ✅ 实测 15.2s / 20.2s（High，含思考） |

## 2｜实例与绑定

```bash
cd ~/.workbuddy/skills/chatgpt-web
node scripts/hunyuan.mjs doctor     # 看 binding.source / browserExists / cdpPortListens
node scripts/hunyuan.mjs status     # 看 loggedIn / hyUserName / modes
```

- 启动器 `C:\EdgeProfiles\start-edge-hunyuan.cmd`，`--remote-debugging-port=9446`。
- 浏览器**跨调用存活**靠"后台任务把它包住"（见 `SKILL.md` §9.1）。
- `doctor` 里 `binding.source` **必须是 `config:targets.hunyuan`**。若显示 `config:flat`
  或 `spec-default`，说明绑定被顶层扁平键吃掉了（见 `SKILL.md` §12.9）。

## 3｜页面契约

| 用途 | 选择器 / 事实 |
|---|---|
| 落地页 | `https://aistudio.tencent.com/`（Hy AI Studio 首页 = 新会话态） |
| 会话页 | `https://aistudio.tencent.com/chat/HunyuanDefault/<id>?modelId=hy4-preview` |
| 输入框 | `textarea.t-textarea__inner`（tdesign），placeholder「有问题，尽管问」 |
| 提交 | **`Enter`**。发送键 `div.hy-chat-input-send-btn` 是 div，空输入时带
| | `hy-chat-input-send-btn--disabled` 修饰类——**Playwright 的 `isDisabled()` 读不到**，
| | 配了它反而会"假 enable"。所以这个渠道不要配 `composer.sendButton`。 |
| 回复容器 | `sel: '.agent-chat__list__item--ai'`（每条 AI 消息一个） |
| 回复正文 | `textSel: '.hyc-common-markdown'` |
| | ⚠️ 外层 `.agent-chat__bubble__content` 会多带一行状态字「处理完成」，**不能当正文** |
| 档位触发器 | `div.paint-button`（是 **div**，不是 button；**无任何 aria 属性**） |
| 档位浮层 | `.paint-button-overlay-inner-thinking-mode` |
| 档位选项 | `.paint-button-item`（文案 `No Think` / `High`） |
| 档位回读 | **触发器文字**（`High` ⇄ `No Think`）。选中项会多一个 `.paint-button-item-icon`
| | （对勾 svg），但**没有 `aria-checked` / `data-state`** ⇒ `stateAttr: null` |
| 新对话 | 点侧栏 `.layout-menu__menu-item` 文案「对话」→ URL 回到 `/`，AI 消息数归零 |
| 登录判据 | URL 不在 auth 路径 **且** `localStorage.hyUserName` 存在（见 §6.3） |

### 3.1｜档位只可靠在落地页

**这是本渠道最反直觉的一条**，两条实测证据：

1. 进会话后，档位控件**时有时无**——同一会话，p19 采样到
   `querySelectorAll('.paint-button').length === 0`，p21 采样到 `length === 1`。
   惰性渲染，**不能依赖**。
2. 实测 `modes` 命令在那种状态下回读为 `thinking: null`（读不到），
   而另一次在同一页面成功读作 `High` 并切成了 `No Think`。

**结论（也就是 spec 的默认行为）**：
> 档位统一在**落地页 `/`** 上设，然后开新会话、再发送。
> 这正是 `ask` 的默认顺序：`newChat` → `applyModes` → `sendText`。

- 档位是**全局偏好**：在会话里改成 No Think，回到落地页也读作 No Think（实测）。
  所以只要每次发送前在 `/` 上设一次，就不会漂。
- `--no-new`（续聊）时档位**不可控**，信封里 `modes.thinking` 可能是 `null`。
  **别把 `null` 当"已开 High"**。
- 触发器不存在时，引擎会**立刻**回 `err: 'trigger-absent'` 并给一句 hint，
  不会白等 8s 点击超时（2026-10-07 加的通用护栏）。

### 3.2｜High 有很长的"静默思考期"

实测时间线（同一句改写任务，逐 2s 采样）：

```
t=2s   ai=1 md=0 len=0     ← AI 气泡已出现，但正文是空的
t=38s  ai=1 md=0 len=0     ← 40 秒里一直这样（High 在想）
t=40s  ai=1 md=1 len=26    ← 正文一次性出现，且此后不再变
```

- **不要用"AI 气泡出现了"当答完的判据**——那会在第 2 秒就误判。
  引擎的判据要求**正文非空**且稳定 `stableMs`，正是为了这个（`channel-kit.mjs` 里那句 `lastText &&`）。
- 思考耗时波动很大：**15s / 40s / 50s / 175s** 都出现过（同一句话）。
  ⇒ `--timeout` 给足（默认 300000 够用），别按 30s 设。
- 答案**几乎是一次性出现的**，所以默认 `stableMs: 4000` 够；若碰到长文被截断，
  用 `--stable 7000` 加大窗口。

## 4｜命令

```bash
node scripts/hunyuan.mjs doctor
node scripts/hunyuan.mjs status
node scripts/hunyuan.mjs new                            # 回落地页（开新会话）
node scripts/hunyuan.mjs modes                          # 回读档位
node scripts/hunyuan.mjs modes --thinking on            # 切 High
node scripts/hunyuan.mjs modes --thinking off           # 切 No Think
node scripts/hunyuan.mjs ask --text "..." --md out/ans.md
node scripts/hunyuan.mjs ask --text "..." --no-new      # 续聊（档位不可控，见 §3.1）
node scripts/hunyuan.mjs quit                           # 关浏览器并把凭证落盘
```

## 5｜实测记录（可复核）

| 检查 | 结果 |
|---|---|
| `modes` 回读 | `{ "thinking": true }` ✅ |
| `modes --thinking off` | `High → No Think`，`changed:true ok:true satisfied:true` ✅ |
| `modes --thinking on` | `No Think → High`，同上 ✅ |
| `ask`（默认 High） | `code: OK`，`newChat {ok:true, via:"对话"}`，`modes.thinking: true`，`elapsedMs: 15176`，正文干净 ✅ |
| `ask` 第 1 轮 | `elapsedMs: 20237`，答案「阳光进入大气层后…瑞利散射…」 ✅ |
| `quit` → 重开 | 端口 9446 关闭；重启后 `loggedIn: true`、`hyUserName` 还在、`thinking: true` ✅ |

## 6｜踩坑（都是真跑出来的）

1. **模式触发器不是 button、也没有 aria。**
   全站 `aria-haspopup` 命中数为 **0**。别按通用套路找 `button[aria-haspopup]`。
   真身是 `div.paint-button`。
2. **档位浮层常驻 DOM。** 菜单关着时它仍在，只是 `0×0`。
   所以"元素存在"**不能**证明菜单开着；反过来，靠它判"没开"也会误判。
   ⇒ 引擎在点触发器前先按 `Escape` 归零（开关型触发器最怕起点是"已开"）。
3. **"没有登录按钮"≠"已登录"。** 未登录时会停在 `/scan`（扫码页），而那页
   本身就没有登录按钮。判据必须是 **URL auth 段 + `hyUserName`**。
   同理，**标签页过期**也会骗人：一次 `status` 报 `loggedIn:false`，
   重新导航首页后发现其实早就登录了。
4. **`localStorage['thinking-selected-mode']` 读出来是 `null`。**
   早先的线索以为它存档位，实测（真登录态、档位已设为 High）它仍是 `null`。
   ⇒ **别依赖它**，回读走触发器文字。
5. **回车能提交，但别顺手加发送按钮。**
   发送键是 `div`，靠 `--disabled` 修饰类表示禁用，`isDisabled()` 读不到 →
   会"假 enable" → 点了可能什么也不发生，再叠加基线的交叉验证就变成一笔糊涂账。
6. **`newChat` 的假阴性。** 已经在落地页（0 条 AI 消息）时再点「对话」，
   页面什么都不变，旧逻辑于是报 `ok:false` —— 真相是"无需动作"。
   现在引擎见到 `count === 0` 直接回 `via: 'already-fresh'`。
   副作用也是线索：若某渠道的 `assistant.sel` 配错（永远 count=0），
   你会看到它一直走 `already-fresh`。

## 7｜站点改版时的重探顺序

1. `status` → 确认 `loggedIn`。
2. 输入框还在不在：`page.evaluate(() => document.querySelectorAll('textarea.t-textarea__inner').length)`。
3. 档位：**在落地页 `/`** 上找 `[class*="paint-button"]`，点开后 dump 浮层里每个选项的
   `class / 文案 / 有没有 aria-*`。判"选中态"的字段是**选中项多出的那个子元素**，
   若改成 aria 属性，就把 `stateAttr` 填上（比触发器文字更稳）。
4. 回复正文：发一条短的，dump `[class*="agent-chat"]` 与 `[class*="markdown"]` 的计数与文本，
   确认哪一层**只含正文**。
5. 提交方式：真发一条，看输入框是否清空 + **助手容器数是否增加**（双判据）。
6. 最后一定跑一次 `quit` && 重开 && `status`，确认登录态真的落盘。
