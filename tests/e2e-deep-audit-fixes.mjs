import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';
const output = new URL('../output/playwright/deep-audit-fixes-2026-10-05/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) }), signaling = await startSignalingServer();
const evidence = { checks: [], errors: [], limitations: ['Synthetic capture; no physical gamepad or operating system input.'] };
let browser;
const wait = (page, predicate) => waitForAsync(() => page.evaluate(predicate), { timeout: 20000 });
try {
  browser = await launchTestBrowser();
  const contexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const [i, page] of pages.entries()) {
    page.on('pageerror', error => evidence.errors.push(error.message));
    await page.goto(server.origin + '/room.html?room=deep-audit-2026-10-04');
    await page.locator('#green-room-user-name').fill('Deep audit ' + i);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  for (const page of pages) await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  await Promise.all(pages.map(page => page.locator('#dock-stream-btn').click()));
  for (const page of pages) await wait(page, () => document.querySelectorAll('.video-card video').length === 2 && [...document.querySelectorAll('.video-card video')].every(video => video.videoWidth > 0));
  // Control the two layouts so each participant shows their own source first.
  for (const page of pages) await page.locator('#card-local-me').evaluate(card => { card.style.order = '-1'; });
  const sourcePeer = await pages[0].evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.peer.id);
  const source = await pages[0].locator('#card-local-me video').boundingBox();
  const point = { x: source.x + source.width * .5, y: source.y + source.height * .5 };
  await pages[0].mouse.move(point.x, point.y);
  await pages[0].locator('#ping-mode-btn').click();
  await pages[0].mouse.click(point.x, point.y);
  await wait(pages[1], async () => (await import('/js/entries/room-entry.js')).roomState.features.ping.manager.pings.length > 0);
  const received = await pages[1].evaluate(async sourcePeer => {
    const manager = (await import('/js/entries/room-entry.js')).roomState.features.ping.manager;
    const ping = manager.pings.at(-1), canvas = document.querySelector('#ping-canvas').getBoundingClientRect();
    const { getVideoContentRect } = await import('/js/ui/video-geometry.js');
    const target = getVideoContentRect(document.getElementById('card-' + sourcePeer).querySelector('video'));
    const local = document.getElementById('card-local-me').querySelector('video').getBoundingClientRect();
    const projected = manager.projectPoint(ping);
    const actual = { x: canvas.left + projected.x * canvas.width / manager.canvas.width, y: canvas.top + projected.y * canvas.height / manager.canvas.height };
    const expected = { x: target.left + target.width * .5, y: target.top + target.height * .5 };
    return { ping, actual, expected, localRect: local.toJSON(), remoteRect: target, displacement: Math.hypot(actual.x - expected.x, actual.y - expected.y) };
  }, sourcePeer);
  assert.ok(received.displacement < 2, 'Ping must be projected on its original source');
  assert.equal(received.ping.sourceId, sourcePeer);
  const actualInLocal = received.actual.x >= received.localRect.left && received.actual.x <= received.localRect.right && received.actual.y >= received.localRect.top && received.actual.y <= received.localRect.bottom;
  assert.equal(actualInLocal, false);
  evidence.checks.push({ id: 'B12', observation: 'Ping on sender stream A appears on source A in the recipient layout', sourcePeer, sentPoint: point, ...received });
  await pages[0].screenshot({ path: fileURLToPath(new URL('sender.png', output)) });
  await pages[1].screenshot({ path: fileURLToPath(new URL('recipient.png', output)) });
  await pages[0].locator('#laser-mode-btn').click();
  await pages[0].mouse.move(point.x, point.y); await pages[0].mouse.down();
  await pages[0].mouse.move(point.x + 40, point.y + 12, { steps: 4 });
  await wait(pages[1], async () => (await import('/js/entries/room-entry.js')).roomState.features.ping.manager.laserTrails.some(trail => trail.points.length >= 2));
  await pages[1].locator('#card-' + sourcePeer).locator('button').filter({ hasText: 'Tela Cheia' }).first().click();
  await wait(pages[1], () => Boolean(document.fullscreenElement));
  await pages[0].mouse.move(point.x + 50, point.y + 16, { steps: 2 });
  const laser = await pages[1].evaluate(async sourcePeer => {
    const manager = (await import('/js/entries/room-entry.js')).roomState.features.ping.manager;
    const trail = manager.activeLaserTrails.get(sourcePeer), last = trail.points.at(-1), projected = manager.projectPoint(last);
    const { getVideoContentRect } = await import('/js/ui/video-geometry.js');
    const rect = getVideoContentRect(document.getElementById('card-' + sourcePeer).querySelector('video'));
    const canvas = manager.canvas.getBoundingClientRect();
    const actual = { x: canvas.left + projected.x * canvas.width / manager.canvas.width, y: canvas.top + projected.y * canvas.height / manager.canvas.height };
    return { sourceId: last.sourceId, pointCount: trail.points.length, displacement: Math.hypot(actual.x - rect.left - last.x * rect.width, actual.y - rect.top - last.y * rect.height), fullscreen: document.fullscreenElement.contains(manager.canvas) };
  }, sourcePeer);
  assert.equal(laser.sourceId, sourcePeer); assert.ok(laser.displacement < 2); assert.equal(laser.fullscreen, true);
  evidence.checks.push({ id: 'B12-laser-fullscreen', ...laser });
  await pages[1].screenshot({ path: fileURLToPath(new URL('laser-fullscreen.png', output)) });
  await pages[0].mouse.up();
  await pages[1].evaluate(() => document.exitFullscreen());
  assert.deepEqual(evidence.errors, []); evidence.status = 'confirmed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); await signaling.close(); await server.close();
  await writeFile(new URL('evidence.json', output), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
}
