import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-slot-test-'));
process.env.CHATGPT_STATE_DIR = dir;
const { slotName, selectSlotPage, selectUnclaimedPage, resetSlot } = await import('../scripts/slot-page.mjs');

function mockBrowser() {
  const pages = [];
  let next = 0;
  const addPage = () => {
    const id = `target-${++next}`;
    const page = {
      id, windowId: next, currentUrl: 'https://chatgpt.com/', closed: false,
      context: () => ctx,
      goto: async (url) => { page.currentUrl = url; },
      url: () => page.currentUrl,
      isClosed: () => page.closed,
      close: async () => { page.closed = true; },
    };
    pages.push(page);
    return page;
  };
  const ctx = {
    pages: () => pages,
    newCDPSession: async (page) => ({ send: async () => ({ targetInfo: { targetId: page.id } }), detach: async () => {} }),
    newPage: async () => { throw new Error('slot must create a browser window'); },
  };
  return {
    contexts: () => [ctx],
    newBrowserCDPSession: async () => ({
      send: async (method, arg) => {
        if (method === 'Target.createTarget') {
          assert.equal(arg.newWindow, true);
          return { targetId: addPage().id };
        }
        if (method === 'Browser.getWindowForTarget') return { windowId: pages.find((p) => p.id === arg.targetId).windowId };
        if (method === 'Target.closeTarget') { pages.find((p) => p.id === arg.targetId).closed = true; return {}; }
        throw new Error(`unexpected ${method}`);
      },
      detach: async () => {},
    }),
  };
}

test('two slots retain separate browser windows while legacy selection skips both', async () => {
  const browser = mockBrowser();
  const a = await selectSlotPage(browser, 'chat-a');
  const b = await selectSlotPage(browser, 'chat-b');
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.windowId, b.windowId);
  a.currentUrl = 'https://chatgpt.com/c/one';
  b.currentUrl = 'https://chatgpt.com/c/two';
  assert.equal(await selectSlotPage(browser, 'chat-a'), a);
  assert.equal(await selectSlotPage(browser, 'chat-b'), b);
  assert.equal(await selectUnclaimedPage(browser, { create: false }), null);
});

test('closed window fails explicitly until reset', async () => {
  const browser = mockBrowser();
  const page = await selectSlotPage(browser, 'closed');
  page.closed = true;
  await assert.rejects(selectSlotPage(browser, 'closed'), /SLOT_PAGE_CLOSED/);
  assert.equal(resetSlot('closed'), true);
  const replacement = await selectSlotPage(browser, 'closed');
  assert.notEqual(replacement.id, page.id);
});

test('slot names cannot escape state directory', () => {
  assert.equal(slotName('window_2'), 'window_2');
  assert.throws(() => slotName('../other'), /INVALID_SLOT/);
});
