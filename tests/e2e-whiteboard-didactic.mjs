import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const output = new URL('../output/playwright/whiteboard-didactic-2026-10-05/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
const signaling = await startSignalingServer();
const evidence = { checks: [], errors: [], dialogs: [] };
let browser;
const wait = (page, predicate) => waitForAsync(() => page.evaluate(predicate), { timeout: 20000 });
const elements = page => page.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements);
const drag = async (page, from, to) => { await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 8 }); await page.mouse.up(); };
try {
  browser = await launchTestBrowser();
  const contexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', error => evidence.errors.push(error.message));
    page.on('dialog', async dialog => { evidence.dialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.goto(`${server.origin}/room.html?room=didactic-tools`);
    await page.locator('#green-room-user-name').fill(`Aula ${index}`);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  for (const page of pages) {
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
    await page.locator('#dock-whiteboard-btn').click();
  }
  const [author, recipient] = pages;
  await author.mouse.dblclick(420, 235);
  const editor = author.locator('.wb-inline-text-editor');
  await editor.fill('Área do triângulo\nA = (base × altura) ÷ 2');
  await editor.press('Shift+Enter'); assert.equal(await editor.count(), 1);
  await author.screenshot({ path: fileURLToPath(new URL('inline-text.png', output)) });
  await editor.press('Enter');
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.some(element => element.type === 'text'));
  evidence.checks.push({ check: 'Inline multiline text synchronizes without dialog', text: (await elements(recipient))[0] });

  await author.locator('#wb-shapes-btn').click();
  await author.screenshot({ path: fileURLToPath(new URL('shapes-menu.png', output)) });
  await author.locator('[data-tool="triangle"]').click();
  assert.equal(await author.locator('#wb-shapes-menu').isVisible(), false);
  await author.locator('[data-color="#06b6d4"]').click();
  await author.locator('[data-fill="semi"]').click();
  await drag(author, [430, 330], [620, 490]);
  await author.locator('#wb-shapes-btn').click(); await author.locator('[data-tool="right-triangle"]').click();
  await drag(author, [735, 330], [925, 490]);
  await author.locator('#wb-shapes-btn').click(); await author.locator('[data-tool="hexagon"]').click();
  await drag(author, [1030, 345], [1150, 465]);
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 4);
  assert.deepEqual((await elements(recipient)).slice(1).map(element => element.type), ['triangle', 'right-triangle', 'hexagon']);
  evidence.checks.push({ check: 'Three new shapes synchronize', shapes: (await elements(recipient)).slice(1) });

  await author.locator('[data-tool="line"]').click();
  await drag(author, [440, 550], [640, 550]);
  const simple = (await elements(author)).at(-1); assert.equal(simple.type, 'line'); assert.equal(simple.points.length, 2);
  await author.mouse.click(735, 550); await author.mouse.move(830, 585); await author.mouse.click(830, 585);
  assert.equal((await elements(author)).length, 5);
  await author.mouse.move(945, 520); await author.mouse.dblclick(945, 520);
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 6);
  const polyline = (await elements(recipient)).at(-1); assert.equal(polyline.type, 'line'); assert.equal(polyline.points.length, 3);
  await author.keyboard.press('Control+z');
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 5);
  await author.keyboard.press('Control+y');
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 6);
  assert.deepEqual(await elements(author), await elements(recipient));
  evidence.checks.push({ check: 'Drag and click vertices, double click completion, synchronized undo/redo', simple, polyline });
  await author.screenshot({ path: fileURLToPath(new URL('board-author.png', output)) });
  await recipient.screenshot({ path: fileURLToPath(new URL('board-recipient.png', output)) });

  await author.mouse.click(700, 630); await author.keyboard.press('Escape');
  assert.equal(await author.locator('#whiteboard-modal').isVisible(), true);
  await author.locator('[data-tool="select"]').click(); await author.mouse.dblclick(425, 240);
  await editor.fill('Texto cancelado'); await editor.press('Escape');
  assert.equal((await elements(author))[0].text, (await elements(recipient))[0].text);

  await author.setViewportSize({ width: 390, height: 844 });
  await author.locator('#wb-shapes-btn').click();
  const bounds = await author.locator('#wb-shapes-menu').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await author.screenshot({ path: fileURLToPath(new URL('shapes-mobile.png', output)) });
  await author.keyboard.press('Escape'); assert.equal(await author.locator('#whiteboard-modal').isVisible(), true);
  const mobileButtons = await author.locator('.whiteboard-topbar button').evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect(); return { label: button.title, left: rect.left, right: rect.right };
  }));
  assert.ok(mobileButtons.every(button => button.left >= 0 && button.right <= 390), 'Mobile toolbar buttons stay within viewport');
  await author.screenshot({ path: fileURLToPath(new URL('toolbar-mobile.png', output)) });
  evidence.checks.push({ check: 'Mobile shape menu stays within viewport; Escape closes only the menu', bounds });
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.dialogs, []); evidence.status = 'passed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); await signaling.close(); await server.close();
  await writeFile(new URL('evidence.json', output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
