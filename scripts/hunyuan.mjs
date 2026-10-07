#!/usr/bin/env node
// hunyuan.mjs · 混元（Hy AI Studio, aistudio.tencent.com）网页渠道
//
// 薄壳，通用逻辑在 channel-kit.mjs。
// ★ 状态：**契约已定稿**（2026-10-07 实测）。完整契约与踩坑见 references/HUNYUAN.md。
//
//   node scripts/hunyuan.mjs doctor
//   node scripts/hunyuan.mjs status
//   node scripts/hunyuan.mjs modes --thinking on          # 切到 High
//   node scripts/hunyuan.mjs ask --text "..." --md out/ans.md
//   node scripts/hunyuan.mjs quit                          # 关浏览器前把登录态落盘
//
// 实测契约要点（四条，都是真跑出来的）：
//   1. 输入框 = textarea.t-textarea__inner，**回车即提交**（不需要发送按钮）。
//   2. 回复正文 = .hyc-common-markdown（干净）；外层气泡 .agent-chat__bubble__content
//      会多带一行 UI 状态字「处理完成」，所以必须两级选择器。
//   3. 思考档位 = div.paint-button（**无 aria 属性**，不是 button），点开是常驻浮层
//      .paint-button-overlay-inner-thinking-mode，选项 .paint-button-item；
//      选中态 = 该选项多一个 .paint-button-item-icon（对勾 svg），但**没有 aria/data-state**，
//      所以回读走触发器文字（High ⇄ No Think），实测双向都对。
//   4. 新对话 = 点侧栏「对话」（URL 回到 /，消息数归零）；会话 URL 形如
//      /chat/HunyuanDefault/<id>?modelId=hy4-preview。
import { runChannel } from './channel-kit.mjs';

runChannel({
  target: 'hunyuan',
  url: 'https://aistudio.tencent.com/',
  envPrefix: 'HUNYUAN',

  browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  userDataDir: 'C:\\EdgeProfiles\\Hunyuan',
  profileDirectory: 'Default',
  cdpPort: 9446,
  launcher: 'C:\\EdgeProfiles\\start-edge-hunyuan.cmd',

  settleMs: 7000,
  requireLogin: true,   // 混元聊天必须登录

  composer: {
    kind: 'textarea',
    sel: 'textarea.t-textarea__inner, textarea[placeholder]',
    sendKey: 'Enter',       // 实测回车即提交；不要配 sendButton（发送键是 div，
                            // Playwright 的 isDisabled() 读不到 --disabled 修饰类，会假 enable）
  },

  assistant: {
    // 两级：容器定位"这一条 AI 消息"，textSel 只取正文（避开「处理完成」这类 UI 文案）
    sel: '.agent-chat__list__item--ai',
    textSel: '.hyc-common-markdown',
    dropLines: ['^处理完成$', '^以上内容由AI生成$'],
  },

  modes: [
    {
      key: 'thinking',
      label: 'High',
      type: 'dropdown',
      // 触发器是 div（不是 button），菜单关着时 class 恰好是 "paint-button"，
      // 开着时变成 "paint-button paint-button-active t-popup-open"。
      triggerSel: '.paint-button',
      onText: 'High',
      offText: 'No Think',
      // ★ 浮层常驻 DOM（关闭时也是 0×0 存在），所以不能靠"存在与否"判菜单开没开；
      //   这里沿用引擎做法：点完触发器直接找选项。万一没开，会等到 click 超时（约 8s）
      //   后由 diag 报 menu-count 0 —— 慢，但结论正确，不会误判成功。
      menuSel: '.paint-button-overlay-inner-thinking-mode',
      itemSel: '.paint-button-item',
      stateAttr: null,        // 无 aria-checked / data-state，回读退化到触发器文字
      menuWaitMs: 1000,
      settleMs: 900,
    },
  ],
  defaults: { thinking: true },   // 用户要求：默认打开 High

  newChat: { texts: ['对话'], settleMs: 3000 },

  conversationId: { urlPattern: '/chat/[^/]+/([A-Za-z0-9]+)' },

  login: {
    // ★ 本渠道必须自带判据，不能用通用兜底。
    //   实测：未登录时会跳到 https://aistudio.tencent.com/scan（扫码登录页），
    //   那一页**没有**"登录"按钮 ⇒ "没按钮就算登录"会假阳性（踩过）。
    //   URL 路径 + hyUserName 双信号才靠谱。
    probe: `
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const txt = (e) => (e.innerText || '').replace(/\\s+/g, ' ').trim();
      const signIn = [...document.querySelectorAll('button,a,[role="button"],div')].filter(vis)
        .some((e) => /^(登录|登入|立即登录)$/.test(txt(e)));
      const onAuthPage = /\\/(scan|login|signin|passport|sso)\\b/i.test(location.pathname);
      let hy = null; try { hy = localStorage.getItem('hyUserName'); } catch (e) { /* ignore */ }
      let mode = null; try { mode = localStorage.getItem('thinking-selected-mode'); } catch (e) { /* ignore */ }
      return {
        loggedIn: !onAuthPage && !signIn && !!hy,
        via: 'url-auth-path + hyUserName',
        signInButtonVisible: signIn, onAuthPage,
        hyUserName: hy, thinkingSelectedMode: mode, url: location.href,
      };
    `,
  },
});
