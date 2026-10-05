import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const output = new URL('../output/playwright/whiteboard-math-2026-10-05/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) }), signaling = await startSignalingServer();
const evidence = { checks: [], errors: [], dialogs: [], mathRequests: [] }; let browser;
const wait = (page, predicate) => waitForAsync(() => page.evaluate(predicate), { timeout: 20000 });
const evaluateManager = (page, fn, arg) => page.evaluate(async ({ fn, arg }) => {
  const manager = (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager;
  return Function('manager', 'arg', `return (${fn})(manager, arg)`)(manager, arg);
}, { fn: fn.toString(), arg });
const elements = page => evaluateManager(page, manager => manager.elements);
const editorSelector = '.wb-inline-text-editor';
try {
  browser = await launchTestBrowser();
  const contexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', error => evidence.errors.push(error.message));
    page.on('dialog', async dialog => { evidence.dialogs.push(dialog.type()); await dialog.dismiss(); });
    page.on('request', request => { if (request.url().includes('/mathjax/')) evidence.mathRequests.push(request.url()); });
    await page.goto(`${server.origin}/room.html?room=math-tools`);
    await page.locator('#green-room-user-name').fill(`Matemática ${index}`); await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  const [author, recipient] = pages;
  for (const page of pages) {
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
    await page.locator('#dock-whiteboard-btn').click();
  }
  await author.locator('[data-tool="formula"]').click(); await author.mouse.click(430, 240);
  await author.locator(editorSelector).fill(String.raw`A = \frac{b\cdot h}{2}`);
  await author.locator('.wb-math-preview canvas:visible').waitFor();
  await author.screenshot({ path: fileURLToPath(new URL('formula-preview.png', output)) });
  assert.equal((await elements(author)).length, 0, 'preview does not send drafts');
  await author.locator(editorSelector).press('Enter'); await author.locator(editorSelector).waitFor({ state: 'detached' });
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 1);
  await evaluateManager(recipient, manager => manager.prepareMathElement(manager.elements[0]));
  assert.deepEqual(await elements(author), await elements(recipient));
  evidence.checks.push('Formula preview, source-only P2P synchronization and recipient rendering');

  await author.locator('[data-tool="select"]').click(); await author.mouse.dblclick(435, 245);
  await author.locator(editorSelector).fill(String.raw`\badcommand{x}`); await author.locator(editorSelector).press('Enter');
  await author.locator('.wb-math-status.is-error').waitFor(); assert.equal((await elements(author))[0].latex, String.raw`A = \frac{b\cdot h}{2}`);
  await author.locator(editorSelector).press('Escape');
  evidence.checks.push('Invalid edits remain open; Escape preserves the synchronized expression');

  await author.locator('[data-tool="formula"]').click(); await author.mouse.click(790, 240);
  await author.locator('.wb-math-palette button[aria-label="Matriz"]').click();
  await author.locator('.wb-math-preview canvas:visible').waitFor(); await author.locator(editorSelector).press('Enter');
  await author.locator(editorSelector).waitFor({ state: 'detached' });
  await author.mouse.click(1060, 260); await author.locator(editorSelector).fill(String.raw`\sqrt{x^2+1} + \alpha + \beta`);
  await author.locator(editorSelector).press('Enter'); await author.locator(editorSelector).waitFor({ state: 'detached' });
  await author.locator('[data-tool="text"]').click(); await author.mouse.click(435, 450);
  await author.locator(editorSelector).fill(String.raw`Área: \(\frac{b\cdot h}{2}\) unidades quadradas
\[\sum_{i=1}^{n} x_i = S\]
R$ 10 continua texto`);
  await author.locator('.wb-math-preview canvas:visible').waitFor();
  await author.screenshot({ path: fileURLToPath(new URL('mixed-text-preview.png', output)) });
  await author.locator(editorSelector).press('Enter'); await author.locator(editorSelector).waitFor({ state: 'detached' });
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 4);
  await evaluateManager(recipient, manager => Promise.all(manager.elements.map(el => manager.prepareMathElement(el))));
  assert.deepEqual(await elements(author), await elements(recipient));
  evidence.checks.push('Matrix palette, roots, Greek letters, inline fractions and display sums');

  await author.keyboard.press('Control+z'); await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 3);
  await author.keyboard.press('Control+y'); await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 4);
  await author.locator('[data-tool="select"]').click(); await author.mouse.move(435, 245); await author.mouse.down(); await author.mouse.move(535, 325, { steps: 8 }); await author.mouse.up();
  await waitForAsync(async () => JSON.stringify(await elements(author)) === JSON.stringify(await elements(recipient)), { timeout: 20000 });
  assert.ok((await elements(author))[0].x > 430 * 1920 / 1400, 'formula moves in board coordinates');
  evidence.checks.push('Synchronized undo, redo and dragging formulas');
  const resizeHandle = await evaluateManager(author, manager => {
    const handle = manager.getResizeHandles(manager.elements[0]).br, rect = manager.canvas.getBoundingClientRect();
    return { x: rect.left + handle.x * rect.width / 1920, y: rect.top + handle.y * rect.height / 1080 };
  });
  await author.mouse.move(resizeHandle.x, resizeHandle.y); await author.mouse.down();
  await author.mouse.move(resizeHandle.x + 40, resizeHandle.y + 30, { steps: 8 }); await author.mouse.up();
  await evaluateManager(author, manager => manager.prepareMathElement(manager.elements[0]));
  assert.ok((await elements(author))[0].fontSize > 32, 'Dragging the handle resizes formula');
  await waitForAsync(async () => JSON.stringify(await elements(author)) === JSON.stringify(await elements(recipient)), { timeout: 20000 });
  const png = await evaluateManager(author, async manager => {
    manager.selectedElementId = null; manager.remoteCursors.clear(); const blob = await manager.exportToBlob();
    const image = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const data = ctx.getImageData(0, 0, image.width, image.height).data;
    let bright = 0; for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i+1] > 200 && data[i+2] > 200) bright++;
    return { bright, data: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });
  assert.ok(png.bright > 500, 'PNG contains visible text and mathematical glyphs'); await writeFile(new URL('board.png', output), new Uint8Array(png.data));
  evidence.checks.push('Resizing and PNG export wait for complete formula rendering');
  await author.screenshot({ path: fileURLToPath(new URL('board-author.png', output)) });
  await recipient.screenshot({ path: fileURLToPath(new URL('board-recipient.png', output)) });
  await author.setViewportSize({ width: 390, height: 844 }); await author.locator('[data-tool="formula"]').click(); await author.mouse.click(200, 440);
  await author.locator(editorSelector).fill(String.raw`\int_a^b x^2\,dx`); await author.locator('.wb-math-preview canvas:visible').waitFor();
  const bounds = await author.locator('.wb-math-preview').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  const sourceBounds = await author.locator(editorSelector).boundingBox();
  assert.ok(bounds.y + bounds.height <= sourceBounds.y || bounds.y >= sourceBounds.y + sourceBounds.height, 'Preview does not cover source');
  assert.ok(await author.locator(editorSelector).evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 14));
  await author.screenshot({ path: fileURLToPath(new URL('formula-mobile.png', output)) }); await author.locator(editorSelector).press('Escape');
  evidence.checks.push('Mobile formula editor and palette stay within the viewport');

  // A fresh context with external networking blocked verifies the first load is local.
  const offlineContext = await prepareSessionContext(browser, signaling), offline = await offlineContext.newPage();
  await offline.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  await offline.goto(server.origin + '/viewer.html');
  const local = await offline.evaluate(async () => {
    const { renderLatexSvg, decodeMathSvg } = await import('/js/whiteboard/math-renderer.js');
    const result = await renderLatexSvg(String.raw`\mathfrak{ABCDEFGHIJKLMNOPQRSTUVWXYZ} + \int_0^1 x^2 dx`); await decodeMathSvg(result.svg); return { width: result.width, height: result.height };
  }); assert.ok(local.width > 0); evidence.checks.push({ check: 'Fresh renderer works with external requests blocked, including dynamic glyphs', ...local });
  assert.ok(evidence.mathRequests.every(url => url.startsWith(server.origin))); assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.dialogs, []); evidence.status = 'passed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.stack; process.exitCode = 1; }
finally { await browser?.close(); await signaling.close(); await server.close(); await writeFile(new URL('evidence.json', output), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2)); }
