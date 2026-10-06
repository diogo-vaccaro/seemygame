import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';
import assert from 'node:assert/strict';

const output = new URL('../output/playwright/third-audit-fixes-' + Date.now() + '/', import.meta.url);
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
    window.auditReleaseImage(); const inserted = await window.auditImageInsertion;
    m.onCursorMoved({ x: .111, y: .222 });
    return { immediatelyAfterClear: empty, afterLoad: m.elements.map(e => e.type), inserted: Boolean(inserted) };
  });
  await wait(recipient, async () => [...(await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.remoteCursors.values()].some(c => c.x === .111 && c.y === .222));
  const recipientElements = await recipient.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.features.whiteboard.manager.elements.length);
  evidence.checks.push({ name: 'Clear cancels an image insertion awaiting decode completion', passed: imageClear.afterLoad.length === 0,
    observed: imageClear, recipientElements });
  assert.equal(recipientElements, 0); assert.equal(imageClear.inserted, false);
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
  await author.locator('[data-voice-channel="voice-1"]').click();
  await wait(author, async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
  await author.locator('#toggle-voice-btn').click();
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
    const session = s.session, peer = s.peer, tracks = s.localStream.getTracks();
    session.eventBus.on('session:disposed', () => {
      sessionStorage.setItem('audit-exit', JSON.stringify({ disposed: session.isDisposed,
        peerDestroyed: peer.destroyed, voice: session.services.voiceManager.isInVoice,
        tracks: tracks.map(t => ({ kind: t.kind, state: t.readyState })),
        localStream: Boolean(s.localStream), localCard: Boolean(document.getElementById('card-local-me')) }));
    });
  });
  await author.locator('#dock-leave-btn').click();
  await author.waitForURL('**/index.html');
  await wait(recipient, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 1);
  const left = await author.evaluate(() => ({ ...JSON.parse(sessionStorage.getItem('audit-exit')), url: location.href }));
  evidence.checks.push({ name: 'Room exit returns home and releases session/capture', passed: !left.url.includes('/room.html') && left.disposed && left.tracks.every(t => t.state === 'ended'), observed: left });
  await author.screenshot({ path: fileURLToPath(new URL('after-exit.png', output)), fullPage: true });
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
  await writer.locator('#wb-redo-btn').click();
  for (const p of relayPages) await waitForAsync(async () => (await managerState(p)).length === 2, { timeout: 20000 });
  const relayRedo = await Promise.all(relayPages.map(managerState));
  evidence.checks.push({ name: 'Viewer undo and redo reach host and second Viewer', passed: relayAfter.every(ids => ids.length === 1) && relayRedo.every(ids => ids.length === 2), undo: relayAfter, redo: relayRedo });
  await writer.locator('#wb-undo-btn').click();
  for (const p of relayPages) await waitForAsync(async () => (await managerState(p)).length === 1, { timeout: 20000 });
  await observer.screenshot({ path: fileURLToPath(new URL('relay-undo-observer.png', output)), fullPage: true });
  const writerId = await writer.evaluate(async () => (await import('/js/entries/viewer-entry.js')).viewerState.peer.id);
  const cursorBefore = await observer.evaluate(async () => [...(await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager.remoteCursors.keys()]);
  await host.evaluate(async () => (await import('/js/entries/streamer-entry.js')).streamerState.features.whiteboard.manager.onCursorMoved({ x: .333, y: .777 }));
  await wait(observer, async () => [...(await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager.remoteCursors.values()].some(c => c.x === .333 && c.y === .777));
  const cursorAfter = await observer.evaluate(async () => [...(await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager.remoteCursors.keys()]);
  evidence.checks.push({ name: 'Host relay preserves distinct cursor authors', passed: cursorAfter.includes(writerId) && cursorAfter.includes(hostId),
    expectedAuthors: [hostId, writerId], beforeHostMove: cursorBefore, afterHostMove: cursorAfter });
  // Verify cursor coordinates against a differently transformed receiving board.
  const projected = await observer.evaluate(async writerId => {
    const m = (await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager;
    m.zoom = 2; m.panX = 100; m.panY = 50;
    m.remoteCursors.clear(); m.remoteCursors.set(writerId, { x: .25, y: .25, time: Date.now(), color: '#06b6d4' });
    const points = [], moveTo = m.ctx.moveTo.bind(m.ctx);
    m.ctx.moveTo = (x, y) => { points.push({ x, y }); moveTo(x, y); };
    try { m.drawRemoteCursors(m.ctx, 1000, 800); } finally { m.ctx.moveTo = moveTo; }
    return points[0];
  }, writerId);
  evidence.checks.push({ name: 'Cursor follows receiving zoom/pan', passed: projected.x === 600 && projected.y === 450, projected });
  const largeImage = await writer.evaluate(async () => {
    const m = (await import('/js/entries/viewer-entry.js')).viewerState.features.whiteboard.manager;
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(320, 240);
    let seed = 123;
    for (let i = 0; i < pixels.data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
    }
    ctx.putImageData(pixels, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    m.addElement({ id: 'relay-large-image', type: 'image', startX: 10, startY: 10, endX: 330, endY: 250, dataUrl });
    m.addElement({ id: 'relay-last', type: 'rectangle', startX: 100, startY: 300, endX: 200, endY: 400 });
    return dataUrl;
  });
  assert.ok(largeImage.length > 256 * 1024);
  for (const p of relayPages) await waitForAsync(async () => (await managerState(p)).length === 3, { timeout: 20000 });
  await writer.locator('#wb-undo-btn').click();
  for (const p of relayPages) await waitForAsync(async () => (await managerState(p)).length === 2, { timeout: 20000 });
  for (const p of [host, observer]) assert.equal(await p.evaluate(async () => {
    const state = location.pathname.includes('streamer') ? (await import('/js/entries/streamer-entry.js')).streamerState : (await import('/js/entries/viewer-entry.js')).viewerState;
    return state.features.whiteboard.manager.elements.find(e => e.id === 'relay-large-image')?.dataUrl;
  }), largeImage);
  evidence.checks.push({ name: 'Large image history snapshot reaches a second Viewer through host relay', passed: true, imageLength: largeImage.length, elements: await Promise.all(relayPages.map(managerState)) });
  await Promise.all(relayContexts.map(c => c.close()));
  assert.deepEqual(evidence.errors, []);
  assert.ok(evidence.checks.every(c => c.passed), 'Every audit regression must pass');
} finally {
  evidence.status = evidence.checks.length === 8 && evidence.checks.every(c => c.passed) && !evidence.errors.length ? 'passed' : 'failed';
  await writeFile(new URL('report.json', output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2)); console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
