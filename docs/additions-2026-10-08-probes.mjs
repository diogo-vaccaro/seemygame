import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';
const output = new URL('../output/playwright/additions-audit-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
const signaling = await startSignalingServer();
const report = { findings: [], controls: [], errors: [], limitations: ['Chrome isolated contexts, synthetic devices, real PeerJS/WebRTC, local signaling. Assertions document current defects.'] };
let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = (page, fn, arg) => waitForAsync(() => page.evaluate(fn, arg), { timeout: 25000 });
const note = page => page.evaluate(async () => {
  const r = (await import('/js/entries/room-entry.js')).roomState;
  const n = (await import('/js/room/notepad.js')).notepadManager;
  return { text: n.text, version: n.version, isHost: n.isHost, coordinator: r.roomManager.isMaster };
});
try {
  browser = await launchTestBrowser();
  const newPage = async path => {
    const context = await prepareSessionContext(browser, signaling), page = await context.newPage();
    page.on('pageerror', e => report.errors.push(e.message)); await page.goto(server.origin + path); return page;
  };
  const pages = [];
  const join = async name => {
    const page = await newPage('/room.html?room=additions-audit'); pages.push(page);
    await page.locator('#green-room-user-name').fill(name); await page.locator('#green-room-join-btn').click();
    for (const p of pages) await wait(p, async count => {
      const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
      return rm?.members.size === count && rm.authenticatedPeers.size === count - 1;
    }, pages.length);
    return page;
  };
  const host = await join('Host'), guest = await join('Guest');
  await host.locator('#dock-room-tools-btn').click();
  await host.locator('[data-action="notepad"]').click();
  await host.locator('#notepad-textarea').fill('Existing shared note');
  await wait(guest, async () => (await import('/js/room/notepad.js')).notepadManager.text === 'Existing shared note');
  report.controls.push('Live note edits reach an already admitted guest.');
  const late = await join('Late');
  await late.locator('#dock-room-tools-btn').click(); await late.locator('[data-action="notepad"]').click();
  await wait(late, async () => (await import('/js/room/notepad.js')).notepadManager.text === 'Existing shared note');
  report.notepad = await Promise.all(pages.map(note));
  assert.equal(report.notepad[0].coordinator, true);
  assert.equal(report.notepad[0].isHost, true);
  assert.equal(report.notepad[2].text, 'Existing shared note');
  report.controls.push('A01 FIXED: The Room coordinator is assigned as notepad host and late participants receive existing snapshot.');
  await host.locator('#notepad-close-btn').click(); await late.locator('#notepad-close-btn').click();

  await host.evaluate(() => {
    window.__reactionKeys = [];
    document.addEventListener('keydown', e => window.__reactionKeys.push({ key: e.key, code: e.code, shift: e.shiftKey }));
  });
  await host.keyboard.press('Shift+Digit1'); await pause(350);
  report.shiftDigit = { events: await host.evaluate(() => window.__reactionKeys), reactions: await host.locator('.floating-reaction').count() };
  assert.ok(report.shiftDigit.events.some(e => e.key === '!' && e.code === 'Digit1' && e.shift));
  assert.ok(report.shiftDigit.reactions >= 2, 'Shift+Digit1 must trigger an emoji burst');
  report.controls.push('A02 FIXED: The physical Shift+1 shortcut with key="!" triggers an emoji burst.');
  await wait(guest, () => document.querySelectorAll('.floating-reaction').length > 0);

  await host.keyboard.press('f');
  await host.locator('#dock-stream-btn').click(); await guest.locator('#dock-stream-btn').click();
  for (const p of [host, guest]) await wait(p, () => [...document.querySelectorAll('.video-card video')].filter(v => v.videoWidth === 640).length === 2);
  report.focusAfterStreams = await host.evaluate(() => ({ mode: document.getElementById('video-grid').className, cards: [...document.querySelectorAll('.video-card')].map(c => ({ id: c.id, cls: c.className })) }));
  assert.ok(report.focusAfterStreams.mode.includes('layout-focus'));
  assert.equal(await host.locator('.video-card.focused').count(), 1);
  report.controls.push('A03 FIXED: Focus layout automatically applies to newly added video cards.');
  const guestId = await guest.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.peer.id);
  await host.evaluate(async id => (await import('/js/room/room-layout.js')).roomLayoutController.setLayoutMode('cinema', id), guestId);
  await guest.locator('#dock-stream-btn').click();
  await wait(host, () => document.querySelectorAll('.video-card video').length === 1);
  report.cinemaAfterStop = await host.evaluate(async () => ({ localLive: (await import('/js/entries/room-entry.js')).roomState.localStream.getTracks().every(t => t.readyState === 'live'), visibleVideos: [...document.querySelectorAll('.video-card video')].filter(v => v.getBoundingClientRect().width > 0).length, mode: document.getElementById('video-grid').className }));
  assert.equal(report.cinemaAfterStop.localLive, true);
  assert.equal(report.cinemaAfterStop.visibleVideos, 1, 'Remaining stream stays visible when focused stream stops');
  report.controls.push('A03 FIXED: Layout automatically re-evaluates focus and displays remaining live stream.');
  await host.keyboard.press('Escape'); await host.locator('#dock-stream-btn').click();

  const streamer = await newPage('/streamer.html');
  await wait(streamer, async () => Boolean((await import('/js/entries/streamer-entry.js')).streamerState.peer?.id));
  const streamerId = await streamer.evaluate(async () => (await import('/js/entries/streamer-entry.js')).streamerState.peer.id);
  await streamer.locator('#stream-btn').click();
  await wait(streamer, async () => Boolean((await import('/js/entries/streamer-entry.js')).streamerState.localStream));
  const viewer = await newPage('/viewer.html#watch=' + streamerId + '&mode=readonly');
  await wait(viewer, () => [...document.querySelectorAll('video')].some(v => v.videoWidth === 640));
  report.readonlyControl = await viewer.evaluate(async () => {
    const r = (await import('/js/entries/viewer-entry.js')).viewerState;
    return { readonly: r.isReadonly, connectionOpen: r.activeConn?.open, width: document.querySelector('.video-card video')?.videoWidth };
  });
  assert.equal(report.readonlyControl.readonly, true); assert.equal(report.readonlyControl.connectionOpen, true);
  report.controls.push('Read-only viewer receives decoded video from an actual Streamer peer.');
  await streamer.evaluate(async () => {
    const r = (await import('/js/entries/streamer-entry.js')).streamerState;
    await r.session.services.voiceManager.joinVoice({ peerId: r.peer.id, name: 'Host' });
    const answer = r.messageHandlers.answerVoiceCall.bind(r.messageHandlers);
    r.messageHandlers.answerVoiceCall = call => { window.__readonlyVoiceAccepted = answer(call); return window.__readonlyVoiceAccepted; };
  });
  await viewer.evaluate(async hostId => {
    const r = (await import('/js/entries/viewer-entry.js')).viewerState;
    window.__probeMic = await navigator.mediaDevices.getUserMedia({ audio: true });
    window.__probeCall = r.peer.call(hostId, window.__probeMic, { metadata: { type: 'VOICE_CHAT' } });
  }, streamerId);
  await wait(streamer, () => typeof window.__readonlyVoiceAccepted === 'boolean');
  report.readonlyVoice = await streamer.evaluate(() => window.__readonlyVoiceAccepted);
  assert.equal(report.readonlyVoice, false, 'Host must reject audio call from peer registered as readonly-viewer');
  report.controls.push('A04 FIXED: Admitted readonly data connection audio call is properly rejected by the host.');
  await viewer.evaluate(() => { window.__probeCall.close(); window.__probeMic.getTracks().forEach(t => t.stop()); });
  assert.deepEqual(report.errors, []); report.status = 'all-bugs-fixed';
} catch (error) { report.status = 'probe-failed'; report.failure = error.stack; process.exitCode = 1; }
finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
