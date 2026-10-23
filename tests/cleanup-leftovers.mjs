// 清理本次实验遗留的临时 Chrome 实例：只对**指定端口**发 CDP Browser.close。
// 不按进程名、不碰用户实例。用完即弃。
import { chromium } from 'playwright-core';

const ports = process.argv.slice(2).map(Number).filter(Boolean);

for (const port of ports) {
  const url = `http://127.0.0.1:${port}`;
  let browser;
  try {
    browser = await chromium.connectOverCDP(url, { timeout: 5000 });
    const s = await browser.newBrowserCDPSession();
    await s.send('Browser.close').catch(() => {});
    console.log(`closed via CDP: ${port}`);
  } catch (e) {
    console.log(`skip ${port}: ${e.message.split('\n')[0]}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

await new Promise(r => setTimeout(r, 2500));
console.log('done.');
