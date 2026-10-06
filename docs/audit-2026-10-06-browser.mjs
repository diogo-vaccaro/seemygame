import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

// Review probes: assertions confirm existing bugs, not corrected behavior.
const output = new URL(`../output/playwright/audit-2026-10-06-${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
const signaling = await startSignalingServer();
const report = { findings: [], errors: [], limitations: ['Two isolated Chrome contexts, synthetic microphones and canvas capture, real PeerJS/WebRTC, local signaling. Pending microphone permission simulated by delaying a real getUserMedia result.'] };
let browser;
const pages = [];
const wait = (page, fn, arg) => waitForAsync(() => page.evaluate(fn, arg), { timeout: 30000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = page => page.evaluate(async () => {
  const r = (await import('/js/entries/room-entry.js')).roomState;
  const v = r.session.services.voiceManager;
  return { id: r.peer.id, channel: r.roomManager.voiceChannelId, catalog: [...r.roomManager.voiceChannels.keys()],
    inVoice: v.isInVoice, mode: v.voiceMode, muted: v.isMuted, deafened: v.isDeafened,
    rawTracks: v.rawLocalStream?.getAudioTracks().map(t => ({ enabled: t.enabled, state: t.readyState })) || [],
    tracks: v.localStream?.getAudioTracks().map(t => ({ enabled: t.enabled, state: t.readyState })) || [],
    micDisabled: document.getElementById('quick-mic-btn').disabled,
    deafDisabled: document.getElementById('quick-deaf-btn').disabled,
    localCapture: r.localStream?.getTracks().map(t => t.readyState) || [],
    outgoing: [...r.screenCalls].map(([peer, c]) => ({ peer, state: c.peerConnection?.connectionState })),
    incoming: await Promise.all([...r.remoteStreams].map(async ([peer, entry]) => {
      const video = document.getElementById('card-' + peer)?.querySelector('video');
      const stats = entry.call.peerConnection ? [...(await entry.call.peerConnection.getStats()).values()] : [];
      return { peer, state: entry.call.peerConnection?.connectionState,
        tracks: entry.stream?.getTracks().map(t => t.readyState) || [], card: Boolean(document.getElementById('card-' + peer)),
        video: Boolean(video), width: video?.videoWidth || 0, frames: video?.getVideoPlaybackQuality().totalVideoFrames || 0,
        bytes: stats.filter(s => s.type === 'inbound-rtp' && s.kind === 'video').reduce((sum, s) => sum + s.bytesReceived, 0) };
    })) };
});
try {
  browser = await launchTestBrowser();
  for (let i = 0; i < 2; i++) {
    const context = await prepareSessionContext(browser, signaling);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(server.origin + '/room.html?room=deep-review-2026-10-06');
    await page.locator('#green-room-user-name').fill('Audit ' + i);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  for (const page of pages) await wait(page, async () => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    return rm.members.size === 2 && rm.authenticatedPeers.size === 1;
  });
  const host = pages[0], guest = pages[1];

  // A mode change must not silently remove the mute applied by deafen.
  for (const page of pages) await page.locator('[data-voice-channel="voice-1"]').click();
  for (const page of pages) await wait(page, async () => [...(await import('/js/entries/room-entry.js')).roomState.messageHandlers.activeVoiceCalls.values()].some(c => c.peerConnection?.connectionState === 'connected'));
  await guest.locator('#toggle-voice-btn').click();
  await guest.locator('#voice-mode-btn').click();
  await wait(guest, async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.voiceMode === 'ptt');
  await guest.locator('#quick-deaf-btn').click();
  report.modeBefore = await snapshot(guest);
  assert.equal(report.modeBefore.deafened, true);
  assert.ok(report.modeBefore.tracks.every(t => !t.enabled));
  await guest.locator('#voice-mode-btn').click();
  report.modeAfter = await snapshot(guest);
  assert.equal(report.modeAfter.deafened, true);
  assert.equal(report.modeAfter.muted, false);
  assert.ok(report.modeAfter.tracks.length && report.modeAfter.tracks.every(t => t.enabled && t.state === 'live'));
  report.findings.push('B01: switching PTT to VAD while deafened enables the live microphone without clearing deafen.');
  await guest.screenshot({ path: fileURLToPath(new URL('mode-after.png', output)) });
  await guest.locator('#drawer-close-btn').click();
  for (const page of pages) await page.locator('[data-voice-channel="lobby"]').click();

  // A data-channel disconnect must not leave a live screen call detached from UI.
  await host.locator('#dock-stream-btn').click();
  await wait(guest, async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    return [...r.remoteStreams.keys()].some(id => document.getElementById('card-' + id)?.querySelector('video')?.videoWidth === 640);
  });
  report.videoBefore = await Promise.all(pages.map(snapshot));
  await guest.evaluate(async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    window.__oldCoordinator = r.coordinatorConn;
    r.coordinatorConn.close();
  });
  await wait(guest, async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    return r.coordinatorConn && r.coordinatorConn !== window.__oldCoordinator && r.coordinatorConn.open && r.roomManager.authenticatedPeers.size === 1;
  });
  await pause(2500);
  report.videoAfter = await Promise.all(pages.map(snapshot));
  await pause(1500);
  report.videoLater = await snapshot(guest);
  const after = report.videoAfter[1].incoming[0];
  const later = report.videoLater.incoming[0];
  assert.ok(after && later);
  assert.equal(after.video, false);
  assert.equal(after.state, 'connected');
  assert.ok(later.bytes > after.bytes);
  assert.ok(report.videoAfter[0].outgoing.length > 0);
  report.findings.push('B02: after coordinator data reconnection, the screen card has no video while the old media call remains connected and receives increasing RTP bytes.');
  await guest.screenshot({ path: fileURLToPath(new URL('video-after-reconnect.png', output)) });
  await host.locator('#dock-stream-btn').click();

  // Resetting a catalog while getUserMedia is pending must cancel the deleted target.
  await host.locator('#create-voice-channel-btn').click();
  await host.locator('#voice-channel-name').fill('Pending permission');
  await host.locator('#create-voice-channel-form button[type="submit"]').click();
  await wait(guest, async () => [...(await import('/js/entries/room-entry.js')).roomState.roomManager.voiceChannels.values()].some(c => c.name === 'Pending permission'));
  const customId = await guest.evaluate(async () => [...(await import('/js/entries/room-entry.js')).roomState.roomManager.voiceChannels.values()].find(c => c.name === 'Pending permission').id);
  await guest.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await original(options);
      window.__heldStream = stream;
      return new Promise(resolve => { window.__releaseMic = () => { navigator.mediaDevices.getUserMedia = original; resolve(stream); }; });
    };
  });
  await guest.locator(`[data-voice-channel="${customId}"]`).click();
  await wait(guest, () => Boolean(window.__releaseMic));
  report.permissionBefore = await snapshot(guest);
  await host.reload();
  await host.locator('#green-room-user-name').fill('Audit host reloaded');
  await host.locator('#green-room-join-btn').click();
  await wait(guest, async id => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    return rm.members.size === 2 && rm.authenticatedPeers.size === 1 && !rm.voiceChannels.has(id);
  }, customId);
  await guest.evaluate(() => window.__releaseMic());
  await wait(guest, async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
  report.permissionAfter = await snapshot(guest);
  assert.equal(report.permissionAfter.channel, null);
  assert.equal(report.permissionAfter.inVoice, true);
  assert.equal(report.permissionAfter.micDisabled, true);
  assert.equal(report.permissionAfter.deafDisabled, true);
  assert.ok(report.permissionAfter.tracks.length && report.permissionAfter.tracks.every(t => t.enabled && t.state === 'live'));
  report.findings.push('B03: granting delayed microphone permission after its custom channel disappears leaves an enabled microphone in the lobby with mute/deafen controls disabled.');
  await guest.screenshot({ path: fileURLToPath(new URL('pending-permission-after.png', output)) });
  await guest.locator('[data-voice-channel="lobby"]').click();

  // Styling a selected shape changes the document but creates no undo entry.
  const board = page => page.evaluate(async () => {
    const m = (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager;
    return { elements: m.elements, selected: m.selectedElementId, undoDepth: m.undoStack.length, redoDepth: m.redoStack.length };
  });
  for (const page of pages) await page.locator('#dock-whiteboard-btn').click();
  await pause(500);
  await host.locator('#wb-shapes-btn').click();
  await host.locator('[data-tool="rectangle"]').click();
  await host.mouse.move(430, 330); await host.mouse.down();
  await host.mouse.move(620, 490, { steps: 8 }); await host.mouse.up();
  await wait(guest, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 1);
  await host.locator('[data-tool="select"]').click();
  await host.mouse.click(525, 410);
  report.styleBefore = await board(host);
  assert.ok(report.styleBefore.selected);
  await host.locator('[data-color="#ef4444"]').click();
  await wait(guest, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements[0]?.color === '#ef4444');
  report.styleAfter = await board(host);
  assert.equal(report.styleAfter.elements[0].color, '#ef4444');
  assert.equal(report.styleAfter.undoDepth, report.styleBefore.undoDepth);
  await host.locator('#wb-undo-btn').click();
  await wait(guest, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length === 0);
  report.styleUndo = await Promise.all(pages.map(board));
  assert.ok(report.styleUndo.every(s => s.elements.length === 0));
  report.findings.push('B04: recoloring a selected rectangle adds no undo history; Undo deletes the rectangle on both peers instead of restoring its previous color.');
  await host.screenshot({ path: fileURLToPath(new URL('style-undo-after.png', output)) });
  assert.deepEqual(report.errors, []);
  report.status = 'bugs-reproduced';
} catch (error) {
  report.status = 'probe-failed'; report.failure = error.stack;
  report.failureStates = await Promise.all(pages.map(p => snapshot(p).catch(e => ({ error: e.message }))));
  process.exitCode = 1;
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
