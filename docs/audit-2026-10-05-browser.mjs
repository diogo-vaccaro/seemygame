import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const output = new URL('../output/playwright/audit-2026-10-05-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
const signaling = await startSignalingServer();
const evidence = { checks: [], errors: [], limitations: ['Chrome, synthetic screen and microphone; real PeerJS and WebRTC.'] };
const wait = (page, predicate) => waitForAsync(() => page.evaluate(predicate), { timeout: 20000 });
let browser;
try {
  browser = await launchTestBrowser();
  const contexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  for (const [i, page] of pages.entries()) {
    page.on('pageerror', err => evidence.errors.push(err.message));
    await page.goto(server.origin + '/room.html?room=exit-audit');
    await page.locator('#green-room-user-name').fill('Audit ' + i);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  for (const page of pages) await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  const [author, recipient] = pages;
  await author.evaluate(async () => {
    const m = (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager;
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    canvas.getContext('2d').fillRect(0, 0, 10, 10);
    const OriginalImage = window.Image;
    // Decode a real PNG; hold only delivery of its already completed load event.
    window.Image = function () {
      const image = new OriginalImage();
      Object.defineProperty(image, 'onload', { set(fn) { image.addEventListener('load', () => { window.auditReleaseImage = () => fn.call(image, new Event('load')); }); } });
      return image;
    };
    m.addElement({ id: 'before-image-clear', type: 'rectangle', startX: 10, startY: 10, endX: 50, endY: 50 });
    window.auditImageInsertion = m.addImageFromDataUrl(canvas.toDataURL('image/png'));
    window.Image = OriginalImage;
  });
  await wait(author, () => Boolean(window.auditReleaseImage));
  const imageClear = await author.evaluate(async () => {
    const m = (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager;
    m.clear(); const empty = m.elements.length;
    window.auditReleaseImage(); await window.auditImageInsertion;
    return { immediatelyAfterClear: empty, afterLoad: m.elements.map(e => e.type) };
  });
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.some(e => e.type === 'image'));
  evidence.checks.push({ name: 'Clear cancels an image insertion awaiting decode completion', passed: imageClear.afterLoad.length === 0,
    observed: imageClear, imageAlsoReachedRecipient: true });
  await author.locator('#dock-stream-btn').click();
  await wait(recipient, () => [...document.querySelectorAll('video')].some(v => v.videoWidth === 640 && v.readyState >= 2));
  await recipient.locator('#dock-stream-btn').click();
  await wait(author, async () => {
    const s = (await import('/js/entries/room-entry.js')).roomState;
    return [...s.remoteStreams].some(([id, r]) => r.stream && document.getElementById('card-' + id)?.querySelector('video')?.videoWidth === 640) && s.features.clipping.recorder.isRecording;
  });
  const replayState = page => page.evaluate(async () => {
    const s = (await import('/js/entries/room-entry.js')).roomState;
    const r = s.features.clipping.recorder;
    return { sources: [...r.sources.keys()], recorders: [...r.recorders.keys()], recording: r.isRecording,
      remoteTracks: [...s.remoteStreams.values()].flatMap(v => v.stream?.getTracks().map(t => t.readyState) || []),
      decodedRemote: [...s.remoteStreams.keys()].some(id => document.getElementById('card-' + id)?.querySelector('video')?.videoWidth === 640) };
  });
  const replayBefore = await replayState(author);
  await author.locator('#dock-stream-btn').click();
  await wait(author, async () => !(await import('/js/entries/room-entry.js')).roomState.localStream);
  const replayAfter = await replayState(author);
  evidence.checks.push({ name: 'Stopping own stream preserves remote replay', passed: replayAfter.recording && replayAfter.sources.length > 0,
    before: replayBefore, after: replayAfter });
  await author.locator('#dock-stream-btn').click();
  await wait(author, async () => Boolean((await import('/js/entries/room-entry.js')).roomState.localStream));
  await author.locator('#dock-mic-btn').click();
  await wait(author, async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
  await author.locator('#rail-btn-voice').click();
  await author.locator('#voice-mode-btn').click();
  await author.evaluate(() => {
    window.auditKeys = [];
    window.addEventListener('keydown', e => window.auditKeys.push(e.code));
  });
  await author.keyboard.down('ControlRight');
  const ptt = await author.evaluate(async () => {
    const v = (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager;
    return { ...v.getLocalVoiceState(), enabled: v.localStream.getAudioTracks().map(t => t.enabled), keys: window.auditKeys };
  });
  await author.keyboard.up('ControlRight');
  await author.keyboard.down('CapsLock');
  const caps = await author.evaluate(async () => {
    const v = (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager;
    return { active: v.isPttActive, enabled: v.localStream.getAudioTracks().map(t => t.enabled), keys: window.auditKeys };
  });
  await author.keyboard.up('CapsLock');
  evidence.checks.push({ name: 'PTT hotkeys enable microphone while held', passed: ptt.isPttActive && ptt.enabled.every(Boolean) && caps.active, controlRight: ptt, capsLock: caps });
  await author.locator('#voice-mode-btn').click();
  await author.locator('#drawer-close-btn').click();
  await author.evaluate(async () => {
    const s = (await import('/js/entries/room-entry.js')).roomState;
    window.auditSession = s.session; window.auditTracks = s.localStream.getTracks();
  });
  await author.locator('#dock-leave-btn').click();
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 1);
  const left = await author.evaluate(async () => {
    const s = (await import('/js/entries/room-entry.js')).roomState;
    return { url: location.href, inRoom: s.roomManager.isInRoom, disposed: window.auditSession.isDisposed,
      peerDestroyed: s.peer.destroyed, voice: window.auditSession.services.voiceManager.isInVoice,
      tracks: window.auditTracks.map(t => ({ kind: t.kind, state: t.readyState })),
      localStream: Boolean(s.localStream), localCard: Boolean(document.getElementById('card-local-me')) };
  });
  evidence.checks.push({ name: 'Room exit returns home and releases session/capture', passed: !left.url.includes('/room.html') && left.disposed && left.tracks.every(t => t.state === 'ended'), observed: left });
  await author.screenshot({ path: fileURLToPath(new URL('after-exit.png', output)), fullPage: true });
  await author.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const disposed = await author.evaluate(() => ({ disposed: window.auditSession.isDisposed, tracks: window.auditTracks.map(t => t.readyState) }));
  evidence.checks.push({ name: 'Positive control: pagehide releases captured tracks', passed: disposed.disposed && disposed.tracks.every(t => t === 'ended'), observed: disposed });
  await Promise.all(contexts.map(c => c.close()));

  const relayContexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const relayPages = await Promise.all(relayContexts.map(c => c.newPage()));
  const [host, writer, observer] = relayPages;
  for (const p of relayPages) p.on('pageerror', err => evidence.errors.push(err.message));
  await host.goto(server.origin + '/streamer.html');
  await wait(host, async () => (await import('/js/entries/streamer-entry.js')).streamerState.peer?.id);
  const hostId = await host.evaluate(async () => (await import('/js/entries/streamer-entry.js')).streamerState.peer.id);
  await host.locator('#stream-btn').click();
  for (const p of [writer, observer]) {
    await p.goto(server.origin + '/viewer.html#watch=' + hostId);
    await wait(p, async () => (await import('/js/entries/viewer-entry.js')).viewerState.remoteStream);
  }
  for (const p of relayPages) await p.locator('#toggle-whiteboard-btn').click();
  const managerState = p => p.evaluate(async () => {
    const s = location.pathname.includes('streamer') ? (await import('/js/entries/streamer-entry.js')).streamerState : (await import('/js/entries/viewer-entry.js')).viewerState;
    return s.features.whiteboard.manager.elements.map(e => e.id);
  });
  await writer.evaluate(async () => {
    const m = (await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager;
    m.addElement({ id: 'relay-first', type: 'rectangle', startX: 100, startY: 100, endX: 200, endY: 200 });
    m.addElement({ id: 'relay-second', type: 'rectangle', startX: 300, startY: 100, endX: 400, endY: 200 });
  });
  for (const p of relayPages) await waitForAsync(async () => (await managerState(p)).length === 2, { timeout: 20000 });
  await writer.locator('#wb-undo-btn').click();
  await waitForAsync(async () => (await managerState(host)).length === 1, { timeout: 20000 });
  // A later relayed cursor proves the host and observer processed the preceding data.
  await writer.evaluate(async () => (await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager.onCursorMoved({ x: .123, y: .456 }));
  await wait(observer, async () => [...(await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager.remoteCursors.values()].some(c => c.x === .123 && c.y === .456));
  const relayAfter = await Promise.all(relayPages.map(managerState));
  evidence.checks.push({ name: 'Viewer undo reaches host and second Viewer', passed: relayAfter.every(ids => ids.length === 1), observed: relayAfter });
  await observer.screenshot({ path: fileURLToPath(new URL('relay-undo-observer.png', output)), fullPage: true });
  const writerId = await writer.evaluate(async () => (await import('/js/entries/viewer-entry.js')).viewerState.peer.id);
  const cursorBefore = await observer.evaluate(async () => [...(await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager.remoteCursors.keys()]);
  await host.evaluate(async () => (await import('/js/entries/streamer-entry.js')).streamerState.features.whiteboard.manager.onCursorMoved({ x: .333, y: .777 }));
  await wait(observer, async () => [...(await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager.remoteCursors.values()].some(c => c.x === .333 && c.y === .777));
  const cursorAfter = await observer.evaluate(async () => [...(await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager.remoteCursors.keys()]);
  evidence.checks.push({ name: 'Host relay preserves distinct cursor authors', passed: cursorAfter.includes(writerId) && cursorAfter.includes(hostId),
    expectedAuthors: [hostId, writerId], beforeHostMove: cursorBefore, afterHostMove: cursorAfter });
  await Promise.all(relayContexts.map(c => c.close()));
} finally {
  evidence.status = evidence.checks.some(c => c.passed === false) ? 'bugs-reproduced' : 'passed';
  await writeFile(new URL('report.json', output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2)); console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
