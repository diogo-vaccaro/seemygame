import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const output = new URL('../output/playwright/room-relay-migration-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });
const evidence = { status: 'running', checks: [], errors: [], limitations: ['Real WebRTC media and DataChannels in local Chrome; LAN/WAN classification controlled to force route changes.'] };
let server, signaling, browser;
const wait = (page, fn, arg) => waitForAsync(() => page.evaluate(fn, arg), { timeout: 25000 });
try {
  server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
  signaling = await startSignalingServer(); browser = await launchTestBrowser();
  const pages = [];
  for (const name of ['Origin', 'Relay', 'Viewer']) {
    const page = await (await prepareSessionContext(browser, signaling)).newPage();
    page.on('pageerror', error => evidence.errors.push(error.message));
    await page.goto(server.origin + '/room.html?room=relay-migration');
    await page.locator('#green-room-user-name').fill(name);
    await page.locator('#green-room-join-btn').click(); pages.push(page);
    for (const current of pages) await wait(current, async count => {
      const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
      return rm?.members.size === count && rm.authenticatedPeers.size === count - 1;
    }, pages.length);
  }
  const [origin, relay, viewer] = pages;
  const ids = await Promise.all(pages.map(page => page.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.peer.id)));
  await origin.evaluate(async ({ relayId, viewerId }) => {
    const entry = await import('/js/entries/room-entry.js');
    const state = entry.roomState;
    const tree = state.relayManager;
    tree.maxDirectViewers = 1;
    clearInterval(state.relayTransport.routeTimer);
    const update = tree.updateTelemetry.bind(tree);
    window.routeLan = {};
    tree.updateTelemetry = (peer, metrics) => update(peer, { ...metrics, isLan: Boolean(window.routeLan[peer]), isRelay: false, rtt: window.routeLan[peer] ? 2 : 50 });
    // Guarantee which peer becomes the forwarding parent for this controlled test.
    tree.registerViewer(relayId, { isLan: false, rtt: 50 });
    tree.registerViewer(viewerId, { isLan: false, rtt: 50 });
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d');
      let frame = 0;
      const timer = setInterval(() => { context.fillStyle = frame++ % 2 ? '#e53' : '#35e'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#fff'; context.fillText(String(frame), 40, 40); }, 33);
      state.session.registerCleanup(() => clearInterval(timer));
      return canvas.captureStream(30);
    };
  }, { relayId: ids[1], viewerId: ids[2] });
  await origin.locator('#dock-stream-btn').click();
  const currentPath = async ({ host, parent }) => {
    const state = (await import('/js/entries/room-entry.js')).roomState;
    const entry = state.remoteStreams.get(host);
    const video = document.querySelector(`#card-${host} video`);
    return entry?.call?.peer === parent && entry.stream && video?.readyState >= 2 && video.videoWidth > 0;
  };
  await wait(viewer, currentPath, { host: ids[0], parent: ids[1] });
  assert.equal(await origin.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.screenCalls.size), 1);
  evidence.checks.push('WAN viewer receives video through the assigned relay; origin has one upload');
  await origin.evaluate(async id => {
    window.routeLan[id] = true;
    (await import('/js/entries/room-entry.js')).roomState.relayManager.updateTelemetry(id, {});
  }, ids[2]);
  await wait(viewer, currentPath, { host: ids[0], parent: ids[0] });
  await wait(relay, async () => (await import('/js/entries/room-entry.js')).roomState.relayTransport.forwards.size === 0);
  evidence.checks.push('LAN transition replaces relayed media with direct media and closes the old forwarding call');
  await origin.evaluate(async id => {
    window.routeLan[id] = false;
    (await import('/js/entries/room-entry.js')).roomState.relayManager.updateTelemetry(id, {});
  }, ids[2]);
  await wait(viewer, currentPath, { host: ids[0], parent: ids[1] });
  evidence.checks.push('WAN transition restores relay media and closes the extra origin upload');
  await relay.close();
  await wait(viewer, currentPath, { host: ids[0], parent: ids[0] });
  evidence.checks.push('Relay departure falls back to direct media without leaving the player blank');
  assert.deepEqual(evidence.errors, []); evidence.status = 'passed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); await signaling?.close(); await server?.close();
  await writeFile(new URL('evidence.json', output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
