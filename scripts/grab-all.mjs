// 一次性抓取 DeepSeek 当前会话里助手回复的**全文**（技能自带 read 只取最后一个 md 块，长回复会被截断）
// 用法：node grab-all.mjs --out <绝对路径.md> [--port 9445]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const out = get('--out', null);
const port = Number(get('--port', '9445'));
if (!out) { console.error('need --out'); process.exit(1); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
let page = null;
for (const p of ctx.pages()) {
  if (/chat\.deepseek\.com/.test(p.url())) { page = p; break; }
}
if (!page) { console.error('no deepseek page'); await browser.close(); process.exit(2); }

const res = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const md = [...document.querySelectorAll('[class*="ds-markdown"]')].filter(vis);
  const blocks = md.map((e, i) => ({ i, len: (e.innerText || '').length, head: (e.innerText || '').slice(0, 40) }));

  // 逐个 md 块向上找最近的「足够长」的祖先，作为该块的完整容器
  const pick = (e) => {
    let cur = e;
    let best = e;
    for (let up = 0; up < 8 && cur; up++) {
      const t = (cur.innerText || '').trim();
      if (t.length > (best.innerText || '').length) best = cur;
      cur = cur.parentElement;
    }
    return best;
  };

  const last = md[md.length - 1];
  const container = last ? pick(last) : null;
  const text = container ? (container.innerText || '').trim() : '';
  return { blocks, nBlocks: md.length, containerCls: container ? String(container.className).slice(0, 120) : null, chars: text.length, text };
});

writeFileSync(out, res.text, 'utf-8');
console.log(JSON.stringify({ nBlocks: res.nBlocks, containerCls: res.containerCls, chars: res.chars, out }, null, 2));
console.log('--- blocks ---');
for (const b of res.blocks) console.log(b.i, b.len, JSON.stringify(b.head));
await browser.close();
