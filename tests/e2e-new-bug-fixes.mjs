import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

// Regression checks for B01-B04, with real PeerJS and WebRTC.
const output = new URL(`../output/playwright/new-bug-fixes-${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
const signaling = await startSignalingServer();
const report = { checks: [], errors: [], limitations: ['Two isolated Chrome contexts, synthetic microphones and canvas capture, real PeerJS/WebRTC, local signaling. Pending microphone permission simulated by delaying a real getUserMedia result.'] };
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
    oldScreenCallsClosed: window.__oldScreenPCs?.every(pc => pc.connectionState === 'closed'),
    incoming: await Promise.all([...r.remoteStreams].map(async ([peer, entry]) => {
      const video = document.getElementById('card-' + peer)?.querySelector('video');
      const stats = entry.call.peerConnection ? [...(await entry.call.peerConnection.getStats()).values()] : [];
      return { peer, state: entry.call.peerConnection?.connectionState,
        tracks: entry.stream?.getTracks().map(t => t.readyState) || [], card: Boolean(document.getElementById('card-' + peer)),
        video: Boolean(video), width: video?.videoWidth || 0, frames: video?.getVideoPlaybackQuality().totalVideoFrames || 0,
        replayRecording: r.features.clipping.recorder.isRecordingFor(peer),
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
  assert.equal(report.modeAfter.muted, true);
  assert.ok(report.modeAfter.tracks.length && [...report.modeAfter.tracks, ...report.modeAfter.rawTracks].every(t => !t.enabled && t.state === 'live'));
  report.checks.push('B01: PTT to VAD keeps a deafened microphone disabled.');
  await guest.screenshot({ path: fileURLToPath(new URL('mode-after.png', output)) });
  await guest.locator('#drawer-close-btn').click();
  await guest.locator('#quick-deaf-btn').click();
  await guest.locator('#quick-mic-btn').click();
  await guest.locator('#toggle-voice-btn').click();
  await guest.locator('#voice-mode-btn').click();
  await guest.locator('#voice-mode-btn').click();
  const manual = await snapshot(guest);
  assert.equal(manual.muted, true);
  assert.ok(manual.tracks.every(t => !t.enabled));
  report.checks.push('Manual mute survives a complete VAD/PTT/VAD mode cycle.');
  await guest.locator('#drawer-close-btn').click();
  for (const page of pages) await page.locator('[data-voice-channel="lobby"]').click();

  // A data-channel disconnect must not leave a live screen call detached from UI.
  await host.locator('#dock-stream-btn').click();
  await guest.locator('#dock-stream-btn').click();
  for (const page of pages) await wait(page, async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    return [...r.remoteStreams.keys()].some(id => document.getElementById('card-' + id)?.querySelector('video')?.videoWidth === 640);
  });
  report.videoBefore = await Promise.all(pages.map(snapshot));
  for (const page of pages) await page.evaluate(async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    window.__oldScreenPCs = [...r.screenCalls.values(), ...[...r.remoteStreams.values()].map(entry => entry.call)].map(call => call.peerConnection);
  });
  await guest.evaluate(async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    window.__oldCoordinator = r.coordinatorConn;
    r.coordinatorConn.close();
  });
  for (const page of pages) await wait(page, async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    return [...r.remoteStreams.keys()].some(id => {
      const video = document.getElementById('card-' + id)?.querySelector('video');
      return video?.videoWidth === 640 && video.getVideoPlaybackQuality().totalVideoFrames > 3;
    });
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
  assert.equal(after.video, true);
  assert.equal(after.width, 640);
  assert.equal(after.state, 'connected');
  assert.ok(later.bytes > after.bytes);
  assert.ok(later.frames > after.frames);
  assert.ok(report.videoAfter.every(s => s.oldScreenCallsClosed && s.localCapture.every(state => state === 'live') && s.incoming.some(e => e.video && e.replayRecording)));
  assert.ok(report.videoAfter[0].outgoing.length > 0);
  report.checks.push('B02: both screen streams recover after data reconnection, old calls close, decoded frames advance and remote replay resumes.');
  await guest.screenshot({ path: fileURLToPath(new URL('video-after-reconnect.png', output)) });
  await host.locator('#dock-stream-btn').click();
  await guest.locator('#dock-stream-btn').click();

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
  await wait(guest, () => window.__heldStream.getTracks().every(t => t.readyState === 'ended'));
  report.permissionAfter = await snapshot(guest);
  assert.equal(report.permissionAfter.channel, null);
  assert.equal(report.permissionAfter.inVoice, false);
  assert.equal(report.permissionAfter.micDisabled, true);
  assert.equal(report.permissionAfter.deafDisabled, true);
  assert.equal(report.permissionAfter.tracks.length, 0);
  assert.equal(report.permissionAfter.rawTracks.length, 0);
  report.checks.push('B03: a deleted pending channel leaves the guest in the lobby and stops the late microphone stream.');
  await guest.screenshot({ path: fileURLToPath(new URL('pending-permission-after.png', output)) });
  await guest.locator('[data-voice-channel="lobby"]').click();

  // Styling a selected shape must participate in synchronized undo and redo.
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
  assert.equal(report.styleAfter.undoDepth, report.styleBefore.undoDepth + 1);
  await host.locator('#wb-undo-btn').click();
  await wait(guest, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements[0]?.color === '#ffffff');
  report.styleUndo = await Promise.all(pages.map(board));
  assert.ok(report.styleUndo.every(s => s.elements.length === 1 && s.elements[0].color === '#ffffff'));
  await host.locator('#wb-redo-btn').click();
  await wait(guest, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements[0]?.color === '#ef4444');
  report.styleRedo = await Promise.all(pages.map(board));
  assert.deepEqual(report.styleRedo[0].elements, report.styleRedo[1].elements);
  report.checks.push('B04: undo restores the selected shape color on both peers and redo restores the new color.');
  await host.screenshot({ path: fileURLToPath(new URL('style-undo-after.png', output)) });
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack;
  report.failureStates = await Promise.all(pages.map(p => snapshot(p).catch(e => ({ error: e.message }))));
  process.exitCode = 1;
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
