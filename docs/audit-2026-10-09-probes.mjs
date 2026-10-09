import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import handler, { resetMemoryRooms } from '../api/rooms.js';
import { RoomPublisher } from '../js/directory/room-publisher.js';
import { RelayManager } from '../js/relay.js';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';
const report = { findings: [], errors: [] };
const originalFetch = globalThis.fetch;
let publisher, browser, server, signaling;
const previousEnv = Object.fromEntries(['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'].map(key => [key, process.env[key]]));
async function request(method, url = '/api/rooms', body = {}) {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; }, end() {} };
  await handler({ method, url, body, headers: {} }, res);
  return res;
}
try {
  for (const key of Object.keys(previousEnv)) delete process.env[key];
  resetMemoryRooms();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') await gate;
    const res = await request(init.method, url, init.body ? JSON.parse(init.body) : {});
    return { ok: res.statusCode < 400 };
  };
  publisher = new RoomPublisher();
  const start = publisher.start({ roomId: 'audit-delayed-publish' });
  await publisher.stop();
  assert.equal((await request('GET')).body.count, 0);
  release(); await start;
  const latePublish = { active: publisher.isActive, timerAfterStop: publisher.timer !== null, roomsAfterStop: (await request('GET')).body.count };
  assert.equal(latePublish.active, false);
  assert.equal(latePublish.timerAfterStop, true);
  assert.equal(latePublish.roomsAfterStop, 1);
  report.findings.push({ id: 'F01', ...latePublish });
  publisher._stopTimer();
  globalThis.fetch = originalFetch;

  const relay = new RelayManager({ originPeerId: 'host', maxDirectViewers: 1 });
  relay.registerViewer('wan', { isLan: false, rtt: 50 });
  assert.equal(relay.registerViewer('late-lan', { rtt: 50 }).role, 'relay');
  relay.updateTelemetry('late-lan', { isLan: true, isRelay: false, rtt: 2 });
  const reclassified = relay.nodes.get('late-lan');
  assert.equal(reclassified.isLan, true);
  assert.equal(reclassified.role, 'relay');
  assert.equal(reclassified.parentPeerId, 'wan');
  const knownLan = relay.registerViewer('known-lan', { isLan: true, rtt: 2 });
  assert.equal(knownLan.role, 'direct');
  report.findings.push({ id: 'F03', reclassified: { isLan: reclassified.isLan, role: reclassified.role, parent: reclassified.parentPeerId }, knownLan });

  server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
  signaling = await startSignalingServer();
  browser = await launchTestBrowser();
  const pages = [];
  const wait = (page, fn, arg) => waitForAsync(() => page.evaluate(fn, arg), { timeout: 25000 });
  for (const name of ['Host', 'Guest', 'Target']) {
    const page = await (await prepareSessionContext(browser, signaling)).newPage();
    page.on('pageerror', err => report.errors.push(err.message));
    await page.goto(server.origin + '/room.html?room=audit-notes-authority');
    await page.locator('#green-room-user-name').fill(name); await page.locator('#green-room-join-btn').click();
    pages.push(page);
    for (const p of pages) await wait(p, async count => {
      const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
      return rm?.members.size === count && rm.authenticatedPeers.size === count - 1;
    }, pages.length);
  }
  const [host, guest, target] = pages;
  await host.evaluate(async () => (await import('/js/room/notepad.js')).notepadManager.setText('Original host note'));
  await wait(target, async () => (await import('/js/room/notepad.js')).notepadManager.text === 'Original host note');
  const targetId = await target.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.peer.id);
  await guest.evaluate(async targetId => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    rm.meshConnections.get(targetId).send({ type: 'NOTE_SYNC', text: 'Forged snapshot', version: 1000000, lastAuthor: 'Host' });
  }, targetId);
  await wait(target, async () => (await import('/js/room/notepad.js')).notepadManager.text === 'Forged snapshot');
  await host.evaluate(async () => (await import('/js/room/notepad.js')).notepadManager.setText('Legitimate next revision'));
  await wait(guest, async () => (await import('/js/room/notepad.js')).notepadManager.text === 'Legitimate next revision');
  await new Promise(resolve => setTimeout(resolve, 500));
  const notes = await Promise.all(pages.map(page => page.evaluate(async () => {
    const n = (await import('/js/room/notepad.js')).notepadManager;
    return { text: n.text, version: n.version, host: n.isHost };
  })));
  assert.equal(notes[0].text, 'Legitimate next revision');
  assert.equal(notes[2].text, 'Forged snapshot');
  assert.equal(notes[2].version, 1000000);
  report.findings.push({ id: 'F02', notes });
  assert.deepEqual(report.errors, []);
  report.status = 'three-new-defects-reproduced';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  publisher?._stopTimer(); globalThis.fetch = originalFetch; resetMemoryRooms();
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await browser?.close(); await signaling?.close(); await server?.close();
  await writeFile(new URL('../output/audit-2026-10-09-probes.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
