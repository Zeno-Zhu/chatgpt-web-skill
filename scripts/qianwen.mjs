#!/usr/bin/env node
// qianwen.mjs · 千问（qianwen.com，阿里）网页渠道
//
// 这是个**薄壳**：真正的通用逻辑在 channel-kit.mjs，这里只放"本站长什么样"。
// 契约来源：2026-10-07 实测（Edge 154，访客态即可复现模式下拉）。
//
//   node scripts/qianwen.mjs doctor
//   node scripts/qianwen.mjs status
//   node scripts/qianwen.mjs ask --text "用一句话解释什么是熵" --md out/ans.md
//
// 站点特征（实测记录，改版时按这里重探）：
//   · 模式选择器 = Radix 风格下拉：button[aria-haspopup="menu"]，按钮文字即当前模式。
//     菜单 [role="menu"] 内两项 [role="menuitemcheckbox"]，带 data-state="checked|unchecked"。
//     ★ data-state 是天然的回读字段——点完直接读它，不靠猜。
//   · 输入框是 contenteditable 的 div（不是 textarea）⇒ 必须用 keyboard.insertText，
//     用 fill() 对这类富文本编辑器不生效。
//   · 默认「快速」；本渠道默认切到「思考研究」（深度搜索、深度研究）。
import { runChannel } from './channel-kit.mjs';

runChannel({
  target: 'qianwen',
  url: 'https://www.qianwen.com/',
  envPrefix: 'QIANWEN',

  browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  userDataDir: 'C:\\EdgeProfiles\\Qianwen',
  profileDirectory: 'Default',
  cdpPort: 9447,
  launcher: 'C:\\EdgeProfiles\\start-edge-qianwen.cmd',

  settleMs: 6000,

  // 访客也能聊，所以不强制登录；登录状态只做报告
  requireLogin: false,

  composer: {
    kind: 'contenteditable',
    sel: 'div[contenteditable="true"][data-placeholder], div[contenteditable="true"][placeholder], div[contenteditable="true"]',
    // ★ 回车**不提交**，必须点这个按钮。空输入时它是 disabled，输入后才 enable。
    sendButton: 'button[aria-label="发送消息"]',
    sendKey: 'Enter',
  },

  // 助手回复：卡片选 [class*="chat-answers-card-wrap"]，正文只取 .qk-markdown。
  // ★ 必须两级：卡片里除了正文还有"好的，交给工作助理模式继续完成"这类推荐按钮文案，
  //   直接取卡片 innerText 会把它混进答案（实测踩到）。
  assistant: {
    sel: '[class*="chat-answers-card-wrap"], [class*="message-select-wrapper-answer"]',
    textSel: '.qk-markdown',
    // 卡片底部会插"推荐动作"按钮，其文案不是模型输出，按行剔除
    dropLines: ['^好的，交给.*继续完成$', '^交给工作助理.*$'],
  },

  busy: { sel: 'button[aria-label*="停止"], [class*="stop"]' },

  modes: [
    {
      key: 'thinking',
      label: '思考研究',
      type: 'dropdown',
      triggerSel: 'button[aria-haspopup="menu"]',
      onText: '思考研究',
      offText: '快速',
      menuSel: '[role="menu"]',
      itemSel: '[role="menuitemcheckbox"]',
      stateAttr: 'data-state',
      menuWaitMs: 900,
      settleMs: 800,
    },
  ],
  defaults: { thinking: true },

  newChat: { texts: ['新对话', '新建对话'], settleMs: 2200 },

  login: {
    // 访客态 localStorage 里有 `qianwen-web:input-capsule-stable-cms-config:v2:guest`
    probe: `
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const txt = (e) => (e.innerText || '').replace(/\\s+/g, ' ').trim();
      const signIn = [...document.querySelectorAll('button,a,[role="button"],div')].filter(vis)
        .some((e) => /^(登录|登入)$/.test(txt(e)));
      let guestKey = false, userKey = null;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (/input-capsule-stable-cms-config/.test(k)) { guestKey = /guest/.test(k); userKey = k; }
        }
      } catch (e) { /* ignore */ }
      return { loggedIn: !signIn, via: 'signin-button-absence', signInButtonVisible: signIn,
               guestConfigKey: guestKey, configKey: userKey, url: location.href };
    `,
  },
});
