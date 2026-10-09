import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import handler, { resetMemoryRooms } from '../api/rooms.js';
import { RoomPublisher } from '../js/directory/room-publisher.js';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const report = { findings: [], errors: [] };
const originalFetch = globalThis.fetch;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const keys = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let publisher, browser, server, signaling;
async function request(method, url = '/api/rooms', body = {}) {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; }, end() {} };
  await handler({ method, url, body, headers: {} }, res);
  return res;
}
try {
  for (const key of keys) delete process.env[key];
  resetMemoryRooms();
  let release, deletion;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') await gate;
    const res = await request(init.method, url, init.body ? JSON.parse(init.body) : {});
    return { ok: res.statusCode < 400 };
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    sendBeacon(url, blob) {
      deletion = blob.text().then(text => request('POST', url, JSON.parse(text)));
      return true;
    }
  } });
  publisher = new RoomPublisher();
  const start = publisher.start({ roomId: 'review-pagehide-race' });
  publisher._handleUnload();
  await deletion;
  assert.equal((await request('GET')).body.count, 0);
  release(); await start;
  const unload = { roomsAfterLatePost: (await request('GET')).body.count, active: publisher.isActive, timerActive: publisher.timer !== null };
  assert.equal(unload.roomsAfterLatePost, 1);
  report.findings.push({ id: 'R01', ...unload });
  await publisher.stop();
  globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else delete globalThis.navigator;

  server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
  signaling = await startSignalingServer(); browser = await launchTestBrowser();
  const pages = [];
  const wait = (page, fn, arg) => waitForAsync(() => page.evaluate(fn, arg), { timeout: 25000 });
  for (const name of ['Host', 'Guest', 'Target']) {
    const page = await (await prepareSessionContext(browser, signaling)).newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(server.origin + '/room.html?room=review-note-update-order');
    await page.locator('#green-room-user-name').fill(name);
    await page.locator('#green-room-join-btn').click();
    pages.push(page);
    for (const current of pages) await wait(current, async count => {
      const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
      return rm?.members.size === count && rm.authenticatedPeers.size === count - 1;
    }, pages.length);
  }
  const [host, guest, target] = pages;
  await host.evaluate(async () => (await import('/js/room/notepad.js')).notepadManager.setText('Authoritative note'));
  await wait(target, async () => (await import('/js/room/notepad.js')).notepadManager.text === 'Authoritative note');
  const targetId = await target.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.peer.id);
  await guest.evaluate(async targetId => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    rm.meshConnections.get(targetId).send({ type: 'NOTE_UPDATE', text: 'Non-authoritative stale edit', authorName: 'Guest' });
  }, targetId);
  await wait(target, async () => (await import('/js/room/notepad.js')).notepadManager.text === 'Non-authoritative stale edit');
  const readNotes = async () => (await import('/js/room/notepad.js')).notepadManager.getText();
  assert.equal(await host.evaluate(readNotes), 'Authoritative note');
  report.findings.push({ id: 'R02', host: await host.evaluate(readNotes), target: await target.evaluate(readNotes) });
  const relayIntegration = await host.evaluate(async () => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.relayManager;
    return { routeCallbackInstalled: typeof rm.onRouteChange === 'function' };
  });
  assert.equal(relayIntegration.routeCallbackInstalled, false);
  report.findings.push({ id: 'R03', ...relayIntegration });
  assert.deepEqual(report.errors, []);
  report.status = 'three-remaining-gaps-reproduced';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
} finally {
  publisher?._stopTimer(); globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else delete globalThis.navigator;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetMemoryRooms();
  await browser?.close(); await signaling?.close(); await server?.close();
  await writeFile(new URL('../output/review-additions-2026-10-09-probes.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
