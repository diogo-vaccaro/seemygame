import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL(`../output/playwright/room-tools-regressions-${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root }), signaling = await startSignalingServer();
const report = { checks: [], errors: [], limitations: ['Synthetic capture and microphone; isolated Chromium contexts with real WebRTC. PiP lifecycle uses a document window stub.'] };
const pages = [];
let browser;
const wait = (page, predicate, arg) => waitForAsync(() => page.evaluate(predicate, arg), { timeout: 25000 });
const pollState = page => page.evaluate(async () => (await import('/js/room/poll-manager.js')).pollManager.currentPoll);
try {
  browser = await launchTestBrowser();
  const addPerson = async name => {
    const context = await prepareSessionContext(browser, signaling), page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(server.origin + '/room.html?room=room-tools-deep-review');
    await page.locator('#green-room-user-name').fill(name); await page.locator('#green-room-join-btn').click();
    for (const current of pages) await wait(current, async count => {
      const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
      return rm?.members.size === count && rm.authenticatedPeers.size === count - 1;
    }, pages.length);
    return page;
  };
  const alice = await addPerson('Alice'), bob = await addPerson('Bob');
  const identities = await Promise.all(pages.map(page => page.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.peer.id)));
  const pollId = await alice.evaluate(async () => {
    const tools = (await import('/js/room/room-tools.js')).roomToolsController;
    return (await import('/js/room/poll-manager.js')).pollManager.createPoll({ question: 'Review poll', options: ['A', 'B'], creatorId: tools.getPeerId(), durationSeconds: 60 }).id;
  });
  await wait(bob, async id => (await import('/js/room/poll-manager.js')).pollManager.currentPoll?.id === id, pollId);
  const carol = await addPerson('Carol');
  await carol.evaluate(async () => (await import('/js/room/room-tools.js')).roomToolsController.openPollModal());
  await wait(carol, async id => (await import('/js/room/poll-manager.js')).pollManager.currentPoll?.id === id, pollId);
  report.checks.push('Late join requests and receives the active poll over real WebRTC');
  await bob.evaluate(async ({ pollId, aliceId }) => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    rm.broadcast({ type: 'POLL_VOTE', pollId, optionIndex: 0, voterId: aliceId });
    rm.broadcast({ type: 'POLL_END', pollId });
  }, { pollId, aliceId: identities[0] });
  await wait(alice, async bobId => (await import('/js/room/poll-manager.js')).pollManager.currentPoll.options[0].voterIds.includes(bobId), identities[1]);
  assert.equal((await pollState(alice)).isActive, true);
  assert.deepEqual((await pollState(alice)).options[0].voterIds, [identities[1]]);
  report.checks.push('Forged voter identity is replaced with transport identity; noncreator cannot end the poll');
  await alice.evaluate(async () => (await import('/js/room/poll-manager.js')).pollManager.endPoll());
  for (const page of pages) await wait(page, async () => (await import('/js/room/poll-manager.js')).pollManager.currentPoll?.isActive === false);
  report.checks.push('Creator closes the poll on all three peers');

  await carol.locator('.poll-modal-close').click();
  for (const page of [alice, bob]) await page.locator('#dock-stream-btn').click();
  for (const page of pages) await wait(page, () => document.querySelectorAll('.video-card video').length === 2);
  const strokeId = await alice.evaluate(async bobId => {
    const manager = (await import('/js/room/annotate.js')).annotateManager;
    const card = document.getElementById(`card-${bobId}`); manager.attach(card, card.querySelector('video'));
    manager.setAutoClear(true, 1500);
    const rect = manager.canvas.getBoundingClientRect();
    manager._onPointerDown({ button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    manager._onPointerUp({}); return manager.strokes.at(-1).id;
  }, identities[1]);
  for (const page of [bob, carol]) await wait(page, async id => (await import('/js/room/annotate.js')).annotateManager.strokes.some(stroke => stroke.id === id), strokeId);
  for (const page of [bob, carol]) {
    const overlay = await page.evaluate(async () => {
      const manager = (await import('/js/room/annotate.js')).annotateManager;
      return { streamId: manager.streamId, cardId: manager.container.id, pointerEvents: manager.canvas.style.pointerEvents };
    });
    assert.equal(overlay.streamId, identities[1]);
    assert.equal(overlay.pointerEvents, 'none');
    assert.equal(overlay.cardId, page === bob ? 'card-local-me' : `card-${identities[1]}`);
  }
  report.checks.push('Annotations select the correct stream with two simultaneous broadcasters; remote overlay preserves interactions');
  for (const page of pages) await wait(page, async id => !(await import('/js/room/annotate.js')).annotateManager.strokes.some(stroke => stroke.id === id), strokeId);
  report.checks.push('Auto-clear removal reaches all peers');

  const pipCheck = await alice.evaluate(async bobId => {
    const { pipController } = await import('/js/room/pip-controller.js');
    const { removeVideoCard } = await import('/js/ui/video-cards.js');
    const card = document.getElementById(`card-${bobId}`), video = card.querySelector('video'), parent = card.parentElement;
    const pipDocument = document.implementation.createHTMLDocument(); let onHide;
    Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow: async () => ({
      document: pipDocument, close() { onHide?.(); }, addEventListener(type, callback) { onHide = callback; }
    }) } });
    await pipController.enterPip(video, card);
    const moved = card.ownerDocument === pipDocument;
    removeVideoCard({ stopStatsMonitor() {}, stopAudioAnalyser() {}, updateGridEmptyState() {} }, bobId);
    const removed = !card.isConnected && !parent.querySelector('.pip-placeholder-box') && pipController.pipWindow === null;
    delete window.documentPictureInPicture;
    return { moved, removed };
  }, identities[1]);
  assert.equal(pipCheck.moved, true); assert.equal(pipCheck.removed, true);
  report.checks.push('Removing a stream while in Document PiP restores/disposes its card and placeholder');
  for (const page of pages) {
    const cleanup = await page.evaluate(async () => {
      await (await import('/js/room/room-tools.js')).roomToolsController.dispose();
      const { annotateManager } = await import('/js/room/annotate.js'), { pollManager } = await import('/js/room/poll-manager.js');
      const { multitrackRecorder } = await import('/js/room/multitrack-recorder.js');
      return { annotation: annotateManager.canvas, poll: pollManager.currentPoll, pollTimer: pollManager.timerId, recording: multitrackRecorder.isRecording };
    });
    assert.deepEqual(cleanup, { annotation: null, poll: null, pollTimer: null, recording: false });
  }
  report.checks.push('Disposal leaves no annotation, poll timer or recording active');
  assert.deepEqual(report.errors, []); report.status = 'passed';
  console.log(report.checks.map(check => `PASS ${check}`).join('\n'));
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; throw error;
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(fileURLToPath(output)); await browser?.close(); await signaling.close(); await server.close();
}
