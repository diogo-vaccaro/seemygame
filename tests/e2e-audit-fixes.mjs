import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/audit-fixes-2026-10-04/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root }), signaling = await startSignalingServer();
let browser;
const evidence = { checks: [], errors: [], limitations: ['Chrome with synthetic capture; no interactive Tauri hardware test.'] };
const wait = (page, predicate) => waitForAsync(() => page.evaluate(predicate), { timeout: 20000 });
try {
  browser = await launchTestBrowser();
  const contexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const [i, page] of pages.entries()) {
    page.on('pageerror', e => evidence.errors.push(e.message));
    await page.goto(server.origin + '/room.html?room=audit-2026-10-04');
    await page.locator('#green-room-user-name').fill('Audit ' + i);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  for (const page of pages) await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  await pages[0].locator('#dock-stream-btn').click();
  for (const page of pages) await page.locator('.video-card video').first().waitFor({ state: 'visible' });
  const remoteAction = await pages[1].locator('.card-btn-coop').first().evaluate(button => ({ label: button.textContent, onclick: typeof button.onclick }));
  assert.equal(remoteAction.onclick, 'function');
  evidence.checks.push({ id: 'A11', observation: 'Room remote Pedir Controle has an action', ...remoteAction });
  await pages[1].locator('.card-btn-coop').first().click();
  await pages[0].locator('#coop-modal').waitFor({ state: 'visible' });
  await pages[0].locator('#coop-approve-btn').click();
  await wait(pages[1], async () => (await import('/js/entries/room-entry.js')).roomState.session.services.coopController.getCoopState().isPlayer2);
  const control = await pages[1].evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.session.services.coopController.getCoopState());
  assert.equal(control.myAssignedSlot, 1);
  evidence.checks.push({ id: 'A04', observation: 'Room request, approval and player input binding work', assignedSlot: control.myAssignedSlot });
  // The active-control button pulses continuously; use an actual pointer click.
  const release = await pages[1].locator('.card-btn-coop').first().boundingBox();
  await pages[1].mouse.click(release.x + release.width * .5, release.y + release.height * .5);
  await wait(pages[1], async () => !(await import('/js/entries/room-entry.js')).roomState.session.services.coopController.getCoopState().isPlayer2);
  await wait(pages[0], async () => (await import('/js/entries/room-entry.js')).roomState.session.services.coopController.getCoopState().activeSlotsCount === 0);
  const stage = await pages[0].locator('#room-stage').boundingBox();
  await pages[0].mouse.move(stage.x + stage.width * .5, stage.y + stage.height * .5);
  await pages[0].locator('#laser-mode-btn').click();
  const fullscreenButton = pages[0].locator('.video-card button').filter({ hasText: 'Tela Cheia' }).first();
  await fullscreenButton.click();
  await wait(pages[0], () => Boolean(document.fullscreenElement));
  const fullscreen = await pages[0].evaluate(() => ({
    tag: document.fullscreenElement.tagName,
    includesPingCanvas: document.fullscreenElement.contains(document.getElementById('ping-canvas')),
    canvasExists: Boolean(document.getElementById('ping-canvas'))
  }));
  assert.notEqual(fullscreen.tag, 'VIDEO'); assert.equal(fullscreen.includesPingCanvas, true);
  evidence.checks.push({ id: 'A13', observation: 'Fullscreen includes the tactical overlay', ...fullscreen });
  const bounds = await pages[0].locator('#ping-canvas').boundingBox();
  const viewport = pages[0].viewportSize();
  assert.ok(bounds.width >= viewport.width - 2 && bounds.height >= viewport.height - 2);
  await pages[0].mouse.move(bounds.x + bounds.width * .45, bounds.y + bounds.height * .5);
  await pages[0].mouse.down();
  await pages[0].mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .55, { steps: 5 });
  await wait(pages[0], async () => (await import('/js/entries/room-entry.js')).roomState.features.ping.manager.laserTrails.some(trail => trail.points.length >= 2));
  await wait(pages[1], async () => (await import('/js/entries/room-entry.js')).roomState.features.ping.manager.laserTrails.some(trail => trail.points.length >= 2));
  await pages[0].mouse.up();
  evidence.checks.push({ id: 'A13-laser', observation: 'Laser draws in fullscreen and reaches the other member', canvasBounds: bounds });
  await pages[0].screenshot({ path: fileURLToPath(new URL('fullscreen.png', output)) });
  await pages[0].evaluate(() => document.exitFullscreen());
  await wait(pages[0], () => !document.querySelector('.tactical-fullscreen-stage'));
  await pages[1].screenshot({ path: fileURLToPath(new URL('room-coop.png', output)), fullPage: true });
  assert.deepEqual(evidence.errors, []);
  evidence.status = 'confirmed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = error.stack; process.exitCode = 1;
} finally {
  await browser?.close(); await signaling.close(); await server.close();
  await writeFile(new URL('evidence.json', output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
