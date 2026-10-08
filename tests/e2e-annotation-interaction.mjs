import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const output = new URL(`../output/playwright/annotation-interaction-${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL(process.env.SEEMYGAME_E2E_DIST === '1' ? '../dist/' : '../', import.meta.url)) });
const signaling = await startSignalingServer();
const report = { checks: [], errors: [], limitations: ['Chrome with synthetic screen capture, real mouse events and real PeerJS WebRTC. Native executable UI is not covered.'] };
const pages = [];
let browser;
const wait = (page, predicate, arg) => waitForAsync(() => page.evaluate(predicate, arg), { timeout: 25000 });
const pixels = page => page.locator('.annotate-overlay-canvas').evaluate(canvas => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) painted++;
  return painted;
});
const draw = async (page, tool, start = [.25, .25], end = [.65, .55]) => {
  await page.locator(`.annotate-toolbar [data-tool="${tool}"]`).click();
  const box = await page.locator('.annotate-overlay-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * start[0], box.y + box.height * start[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * end[0], box.y + box.height * end[1], { steps: 12 });
  await page.mouse.up();
};
try {
  browser = await launchTestBrowser();
  for (const name of ['Transmissor', 'Participante']) {
    const context = await prepareSessionContext(browser, signaling);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`${server.origin}/room.html?room=annotation-interaction`);
    await page.locator('#green-room-user-name').fill(name);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  const [host, viewer] = pages;
  for (const page of pages) await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  await host.locator('#dock-stream-btn').click();
  for (const page of pages) await wait(page, () => document.querySelector('.video-card video')?.videoWidth > 0);
  await host.locator('.card-btn-annotate').click();
  await host.locator('[data-color="#2ed573"]').click();
  for (const tool of ['pen', 'highlighter', 'arrow', 'rect', 'circle']) {
    await draw(host, tool);
    await wait(viewer, async tool => (await import('/js/room/annotate.js')).annotateManager.strokes.some(stroke => stroke.tool === tool), tool);
    const counts = await Promise.all(pages.map(pixels));
    assert.ok(counts.every(count => count > 100), `${tool}: visible pixels on both peers`);
    report.checks.push({ tool, paintedPixels: counts });
    console.log(`PASS ${tool}: painted pixels ${counts.join(', ')}`);
    await host.locator('.annotate-clear-btn').click();
    await wait(viewer, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 0);
    assert.equal(await pixels(viewer), 0);
  }
  await draw(host, 'pen');
  await wait(viewer, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 1);
  await viewer.locator('.card-btn-annotate').click();
  await draw(viewer, 'arrow', [.65, .2], [.3, .5]);
  await wait(host, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 2);
  report.checks.push('Viewer can activate annotation and draw back to the host');
  await host.screenshot({ path: fileURLToPath(new URL('host-drawing.png', output)), fullPage: true });
  await viewer.screenshot({ path: fileURLToPath(new URL('viewer-drawing.png', output)), fullPage: true });
  await viewer.locator('.annotate-clear-btn').click();
  await wait(host, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 0);
  await draw(viewer, 'pen', [.25, .25], [.65, .25]);
  await wait(host, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 1);
  await draw(viewer, 'eraser', [.45, .25], [.46, .25]);
  await wait(host, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 0);
  assert.equal(await pixels(host), 0);
  report.checks.push('Eraser removes the actual line on both peers');
  await viewer.locator('.annotate-close-btn').click();
  await viewer.locator('#dock-room-tools-btn').click();
  await viewer.locator('[data-action="annotate"]').click();
  report.menuTarget = await viewer.evaluate(async () => {
    const m = (await import('/js/room/annotate.js')).annotateManager;
    return { container: m.container?.id, video: m.video?.id, videoBox: m.video?.getBoundingClientRect().toJSON(), toolbarBox: m.toolbarEl?.getBoundingClientRect().toJSON() };
  });
  assert.ok(report.menuTarget.container.startsWith('card-'));
  await draw(viewer, 'circle');
  await wait(host, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 1);
  report.checks.push('Room tools menu activates drawing');
  await viewer.setViewportSize({ width: 900, height: 800 });
  await draw(viewer, 'rect');
  await wait(host, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 2);
  report.checks.push('Drawing remains functional after viewport resize');
  await viewer.setViewportSize({ width: 1280, height: 720 });
  await viewer.locator('.video-card button[title="Alternar entre Modo Contido (ajustado à janela) e Modo Expandido"]').click();
  await draw(viewer, 'pen');
  await wait(host, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 3);
  report.checks.push('Expanded video supports drawing');
  await viewer.locator('.video-card button[title="Alternar Tela Cheia (F ou duplo clique)"]').click();
  await wait(viewer, () => Boolean(document.fullscreenElement));
  await draw(viewer, 'arrow');
  await wait(host, async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 4);
  assert.ok(await pixels(viewer) > 100);
  report.checks.push('Fullscreen supports drawing and synchronization');
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack;
  for (const [i, page] of pages.entries()) await page.screenshot({ path: fileURLToPath(new URL(`failure-${i}.png`, output)), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
