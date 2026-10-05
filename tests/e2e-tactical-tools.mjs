import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/tactical-tools-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root }), signaling = await startSignalingServer();
let browser;
const evidence = { status: 'running', checks: [], errors: [],
  limitations: ['Chrome on one machine with isolated contexts and synthetic video capture; actual PeerJS data channels. Native desktop and fullscreen are not covered.'] };
const wait = (page, predicate, arg) => waitForAsync(() => page.evaluate(predicate, arg), { timeout: 20000 });
const snapshot = page => page.evaluate(async () => {
  const { roomState } = await import('/js/entries/room-entry.js');
  const manager = roomState.features.ping.manager;
  return { pings: manager.pings, trails: manager.laserTrails, drawing: manager.isDrawingLaser };
});
try {
  browser = await launchTestBrowser();
  const contexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', error => evidence.errors.push(error.message));
    await page.goto(server.origin + '/room.html?room=tactical-e2e');
    await page.locator('#green-room-user-name').fill('Tactical ' + index);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  for (const page of pages) await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  await pages[0].locator('#dock-stream-btn').click();
  for (const page of pages) await page.locator('.video-card video').first().waitFor({ state: 'visible' });
  const bounds = await pages[0].locator('#ping-canvas').boundingBox();
  const point = { x: bounds.x + bounds.width * .5, y: bounds.y + bounds.height * .45 };
  for (const mode of ['ping', 'danger']) {
    await pages[0].locator(`#${mode}-mode-btn`).click();
    await pages[0].mouse.click(point.x, point.y);
    for (const page of pages) await wait(page, async type => {
      const manager = (await import('/js/entries/room-entry.js')).roomState.features.ping.manager;
      return manager.pings.some(p => p.type === type && p.senderName === 'Tactical 0');
    }, mode);
    evidence.checks.push({ mode, localAndRemote: 'passed' });
  }
  await pages[0].locator('#laser-mode-btn').click();
  await pages[0].mouse.move(point.x, point.y); await pages[0].mouse.down();
  // Let the first segment expire, then verify that continued drawing becomes visible.
  await wait(pages[0], async () => {
    const manager = (await import('/js/entries/room-entry.js')).roomState.features.ping.manager;
    return manager.isDrawingLaser && manager.currentLaserTrail.points.length === 0;
  });
  await pages[0].mouse.move(point.x + 80, point.y + 30, { steps: 8 });
  for (const page of pages) await wait(page, async () => {
    const manager = (await import('/js/entries/room-entry.js')).roomState.features.ping.manager;
    return manager.laserTrails.some(trail => trail.points.length >= 2);
  });
  const laser = await snapshot(pages[1]);
  assert.equal(laser.trails.length, 1);
  evidence.checks.push({ laserAfterPause: 'passed', remotePointCount: laser.trails[0].points.length });
  await pages[0].screenshot({ path: fileURLToPath(new URL('local-laser.png', output)), fullPage: true });
  await pages[1].screenshot({ path: fileURLToPath(new URL('remote-laser.png', output)), fullPage: true });
  // Releasing outside the canvas must stop both sides.
  await pages[0].mouse.move(2, 2); await pages[0].mouse.up();
  for (const page of pages) await wait(page, async () => {
    const manager = (await import('/js/entries/room-entry.js')).roomState.features.ping.manager;
    return manager.activeLaserTrails.size === 0;
  });
  evidence.checks.push({ releaseOutsideCanvas: 'passed' });

  // The other sender can draw in the opposite direction without mixing origins.
  const remoteBounds = await pages[1].locator('#ping-canvas').boundingBox();
  await pages[1].locator('#laser-mode-btn').click();
  await pages[1].mouse.move(remoteBounds.x + remoteBounds.width * .65, remoteBounds.y + remoteBounds.height * .6);
  await pages[1].mouse.down();
  await pages[1].mouse.move(remoteBounds.x + remoteBounds.width * .7, remoteBounds.y + remoteBounds.height * .65, { steps: 5 });
  await wait(pages[0], async () => {
    const state = (await import('/js/entries/room-entry.js')).roomState;
    return state.features.ping.manager.activeLaserTrails.has([...state.roomManager.members.keys()].find(id => id !== state.peer.id));
  });
  await pages[1].mouse.up();
  evidence.checks.push({ reverseDirection: 'passed' });
  await Promise.all(contexts.map(context => context.close()));

  const hostContext = await prepareSessionContext(browser, signaling);
  const viewerContexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const host = await hostContext.newPage(), viewers = await Promise.all(viewerContexts.map(context => context.newPage()));
  for (const page of [host, ...viewers]) page.on('pageerror', error => evidence.errors.push(error.message));
  await host.goto(server.origin + '/streamer.html');
  await wait(host, async () => (await import('/js/entries/streamer-entry.js')).streamerState.peer?.id);
  const hostId = await host.evaluate(async () => (await import('/js/entries/streamer-entry.js')).streamerState.peer.id);
  await host.locator('#stream-btn').click();
  await wait(host, async () => Boolean((await import('/js/entries/streamer-entry.js')).streamerState.localStream));
  for (const viewer of viewers) {
    await viewer.goto(`${server.origin}/viewer.html#watch=${hostId}`);
    await wait(viewer, () => [...document.querySelectorAll('.video-card video')].some(video => video.readyState >= 2));
  }
  const viewerBox = await viewers[0].locator('#ping-canvas').boundingBox();
  await viewers[0].locator('#danger-mode-btn').click();
  await viewers[0].mouse.click(viewerBox.x + viewerBox.width * .5, viewerBox.y + viewerBox.height * .45);
  await wait(host, async () => (await import('/js/entries/streamer-entry.js')).streamerState.features.ping.manager.pings.some(p => p.type === 'danger'));
  await wait(viewers[1], async () => (await import('/js/entries/viewer-entry.js')).viewerState.features.ping.manager.pings.some(p => p.type === 'danger'));
  evidence.checks.push({ viewerPingRelayedThroughHost: 'passed' });
  await viewers[0].locator('#laser-mode-btn').click();
  await viewers[0].mouse.move(viewerBox.x + viewerBox.width * .5, viewerBox.y + viewerBox.height * .45);
  await viewers[0].mouse.down();
  await viewers[0].mouse.move(viewerBox.x + viewerBox.width * .55, viewerBox.y + viewerBox.height * .5, { steps: 5 });
  const authorId = await viewers[0].evaluate(async () => (await import('/js/entries/viewer-entry.js')).viewerState.peer.id);
  await wait(viewers[1], async author => {
    const manager = (await import('/js/entries/viewer-entry.js')).viewerState.features.ping.manager;
    return manager.activeLaserTrails.get(author)?.points.length >= 2;
  }, authorId);
  await viewers[0].mouse.up();
  await wait(viewers[1], async () => (await import('/js/entries/viewer-entry.js')).viewerState.features.ping.manager.activeLaserTrails.size === 0);
  evidence.checks.push({ viewerLaserIdentityAndStopThroughHost: 'passed' });
  await host.locator('#ping-canvas').scrollIntoViewIfNeeded();
  const hostBox = await host.locator('#ping-canvas').boundingBox();
  assert.ok(hostBox.height >= 280, 'Streamer stage remains usable in a 1280×720 window');
  evidence.checks.push({ streamerStageAt720p: 'passed', height: hostBox.height });
  await host.mouse.move(hostBox.x + hostBox.width * .5, hostBox.y + hostBox.height * .45);
  await host.keyboard.down('Shift'); await host.mouse.down();
  await host.mouse.move(hostBox.x + hostBox.width * .55, hostBox.y + hostBox.height * .5, { steps: 5 });
  const hostDrawing = await host.evaluate(async () => (await import('/js/entries/streamer-entry.js')).streamerState.features.ping.manager.isDrawingLaser);
  await host.screenshot({ path: fileURLToPath(new URL('streamer-laser.png', output)), fullPage: true });
  assert.equal(hostDrawing, true, 'Actual pointer starts the Streamer laser');
  for (const viewer of viewers) await wait(viewer, async author => {
    const manager = (await import('/js/entries/viewer-entry.js')).viewerState.features.ping.manager;
    return manager.activeLaserTrails.get(author)?.points.length >= 2;
  }, hostId);
  await host.mouse.up(); await host.keyboard.up('Shift');
  evidence.checks.push({ streamerLaserWithShift: 'passed' });
  for (const size of [{ width: 1920, height: 1080 }, { width: 800, height: 600 }]) {
    await host.setViewportSize(size);
    await host.locator('#ping-canvas').scrollIntoViewIfNeeded();
    const bounds = await host.locator('#ping-canvas').boundingBox();
    assert.ok(bounds.height >= 280);
    evidence.checks.push({ streamerStage: size, height: bounds.height });
  }
  assert.deepEqual(evidence.errors, []);
  evidence.status = 'passed';
  console.log('PASS: room ping/alert/laser in both directions, pause and release outside canvas; Streamer/Viewer tools, host relay with identity and stop');
} catch (error) {
  evidence.status = 'failed'; evidence.failure = error.stack; throw error;
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(evidence, null, 2));
  console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
