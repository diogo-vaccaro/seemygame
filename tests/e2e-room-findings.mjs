import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/room-findings-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root }), signaling = await startSignalingServer();
const evidence = { status: 'running', checks: [], errors: [], limitations: ['Two Chrome contexts with fake microphones and real PeerJS/WebRTC. Native IPC routing is covered by unit tests.'] };
const wait = (page, predicate, arg) => waitForAsync(() => page.evaluate(predicate, arg), { timeout: 20000 });
const sampleAudio = page => page.evaluate(async () => {
  const { roomState } = await import('/js/entries/room-entry.js');
  const calls = [...roomState.messageHandlers.activeVoiceCalls.values()];
  const stats = await Promise.all(calls.map(call => call.peerConnection.getStats()));
  return { calls: calls.length,
    senders: calls.flatMap(call => call.peerConnection.getSenders()).filter(sender => sender.track?.kind === 'audio').length,
    packets: stats.flatMap(report => [...report.values()]).filter(row => row.type === 'outbound-rtp' && (row.kind || row.mediaType) === 'audio').reduce((sum, row) => sum + (row.packetsSent || 0), 0) };
});
let browser;
try {
  browser = await launchTestBrowser();
  for (const order of ['lower-first', 'higher-first']) {
    const contexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
    try {
      const pages = await Promise.all(contexts.map(context => context.newPage()));
      const roomId = 'findings-' + order;
      for (const [index, page] of pages.entries()) {
        page.setDefaultTimeout(15000);
        page.on('pageerror', error => evidence.errors.push(error.message));
        await page.goto(server.origin + '/room.html?room=' + roomId);
        await page.locator('#green-room-user-name').fill('Findings ' + index);
        await page.locator('#green-room-join-btn').click();
        await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
      }
      for (const page of pages) await wait(page, async () => {
        const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
        return rm.members.size === 2 && [...rm.meshConnections].some(([id, conn]) => conn.open && rm.isPeerAuthorized(id));
      });
      const ids = await Promise.all(pages.map(page => page.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.peer.id)));
      const lower = ids[0].localeCompare(ids[1]) < 0 ? 0 : 1;
      const first = order === 'lower-first' ? lower : 1 - lower;
      await pages[first].locator('#dock-mic-btn').click();
      await wait(pages[first], async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
      await pages[1 - first].locator('#dock-mic-btn').click();
      for (const page of pages) await wait(page, async () => {
        const { roomState } = await import('/js/entries/room-entry.js');
        return [...roomState.session.services.voiceManager.participants.values()].some(p => !p.isLocal && p.stream)
          && [...roomState.messageHandlers.activeVoiceCalls.values()].some(call => call.peerConnection.connectionState === 'connected');
      });
      const before = await Promise.all(pages.map(sampleAudio));
      for (const [index, page] of pages.entries()) {
        assert.equal(before[index].calls, 1); assert.equal(before[index].senders, 1);
        await waitForAsync(async () => (await sampleAudio(page)).packets > before[index].packets, { timeout: 20000 });
      }
      const after = await Promise.all(pages.map(sampleAudio));
      const controls = await pages[0].evaluate(async () => {
        const { roomState } = await import('/js/entries/room-entry.js');
        const ui = roomState.discordUI, voice = roomState.session.services.voiceManager;
        const count = ui._cleanupFns.length;
        const remoteId = [...voice.participants.values()].find(p => !p.isLocal).peerId;
        voice.setUserVolume(remoteId, 75); voice.setUserMuted(remoteId, true);
        for (let i = 0; i < 200; i++) voice.updateParticipantState(remoteId, { isSpeaking: Boolean(i % 2) });
        return { before: count, after: ui._cleanupFns.length, volume: document.querySelector('.voice-user-volume-slider').value,
          muted: document.querySelector('.voice-user-mute-btn').classList.contains('muted') };
      });
      assert.equal(controls.after, controls.before); assert.equal(controls.volume, '75'); assert.equal(controls.muted, true);
      evidence.checks.push({ order, ids, before, after, controls });

      if (order === 'lower-first') {
        const coordinatorIndex = await pages[0].evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.isMaster) ? 0 : 1;
        const coordinator = pages[coordinatorIndex], member = pages[1 - coordinatorIndex];
        await member.locator('#edit-id-btn').click();
        assert.equal(await member.locator('#custom-id-modal').isVisible(), true);
        assert.equal(await member.locator('#custom-id-save-btn').isDisabled(), true);
        await member.locator('#custom-id-cancel-btn').click();
        await coordinator.locator('#edit-id-btn').click();
        assert.equal(await coordinator.locator('#custom-id-modal').isVisible(), true);
        await coordinator.locator('#room-pin-input').fill('9876');
        await coordinator.locator('#custom-id-save-btn').click();
        assert.equal(await coordinator.locator('#custom-id-modal').isVisible(), false);
        const pinState = await coordinator.evaluate(async () => {
          const { roomState } = await import('/js/entries/room-entry.js');
          let copied;
          navigator.clipboard.writeText = async text => { copied = text; };
          document.getElementById('share-link-btn').click(); await Promise.resolve();
          return { pin: roomState.roomManager.roomPin, members: roomState.roomManager.members.size, copied, url: location.href };
        });
        assert.equal(pinState.pin, '9876'); assert.equal(pinState.members, 2);
        assert.ok(pinState.copied.includes('&pin=9876')); assert.ok(pinState.url.includes('&pin=9876'));
        await coordinator.locator('#edit-id-btn').click(); await coordinator.locator('#custom-id-reset-btn').click();
        await coordinator.locator('#custom-id-save-btn').click();
        const cleared = await coordinator.evaluate(async () => ({ pin: (await import('/js/entries/room-entry.js')).roomState.roomManager.roomPin, url: location.href }));
        assert.equal(cleared.pin, null); assert.ok(!cleared.url.includes('pin='));
        await coordinator.screenshot({ path: fileURLToPath(new URL('room-controls.png', output)), fullPage: true });
        await coordinator.locator('#edit-id-btn').click(); await coordinator.locator('#custom-id-input').fill('findings-renamed');
        await coordinator.locator('#custom-id-save-btn').click();
        await coordinator.waitForURL('**/room.html#room=findings-renamed');
        await coordinator.locator('#green-room-join-btn').click();
        await wait(coordinator, async () => {
          const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
          return rm?.isInRoom && rm.isMaster && rm.roomId === 'findings-renamed';
        });
        evidence.checks.push({ roomSettings: 'passed', pinState, cleared, renamed: 'findings-renamed' });
      }
    } finally { await Promise.all(contexts.map(context => context.close())); }
  }
  assert.deepEqual(evidence.errors, []);
  evidence.status = 'passed'; console.log('PASS: both voice join orders, bidirectional audio RTP, bounded listeners and live Room settings');
} catch (error) { evidence.status = 'failed'; evidence.failure = error.stack; throw error; }
finally {
  await writeFile(new URL('report.json', output), JSON.stringify(evidence, null, 2));
  console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
