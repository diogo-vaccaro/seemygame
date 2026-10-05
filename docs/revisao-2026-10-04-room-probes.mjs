import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/review-room-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root }), signaling = await startSignalingServer(); let browser;
const evidence = { errors: [], observations: [] };
const wait = (page, fn) => waitForAsync(() => page.evaluate(fn), { timeout: 20000 });
try {
  browser = await launchTestBrowser();
  const contexts = await Promise.all([prepareSessionContext(browser, signaling), prepareSessionContext(browser, signaling)]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  for (const [index, page] of pages.entries()) {
    page.setDefaultTimeout(10000); page.on('pageerror', error => evidence.errors.push(error.message));
    await page.goto(server.origin + '/room.html?room=review-late-voice');
    await page.locator('#green-room-user-name').fill('Review ' + index); await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  for (const page of pages) await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  const identities = await Promise.all(pages.map(async page => ({ page, id: await page.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.myPeerId) })));
  identities.sort((a, b) => a.id.localeCompare(b.id));
  const normalOrder = process.argv.includes('--normal-order');
  if (normalOrder) identities.reverse();
  const [early, late] = identities.map(p => p.page);
  await early.locator('#dock-mic-btn').click();
  await wait(early, async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
  // Ensure the incoming voice call is answered while the later peer has not joined voice yet.
  if (!normalOrder) await wait(late, async () => (await import('/js/entries/room-entry.js')).roomState.messageHandlers.activeVoiceCalls.size > 0);
  await late.locator('#dock-mic-btn').click();
  await wait(late, async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
  for (const page of [early, late]) await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.messageHandlers.activeVoiceCalls.size > 0);
  evidence.joinOrder = normalOrder ? 'control: higher id joins first' : 'reproduction: lower id joins first';
  for (const [name, page] of [['early', early], ['late', late]]) {
    const state = await page.evaluate(async () => {
      const { roomState } = await import('/js/entries/room-entry.js'); const voice = roomState.session.services.voiceManager;
      return { isInVoice: voice.isInVoice, localAudioTracks: voice.localStream.getAudioTracks().length,
        calls: [...roomState.messageHandlers.activeVoiceCalls.values()].map(call => ({ peer: call.peer, audioSenders: call.peerConnection.getSenders().filter(s => s.track?.kind === 'audio').length })) };
    });
    evidence.observations.push({ name, ...state });
  }
  await late.locator('#edit-id-btn').click();
  const settingsVisible = await late.locator('#custom-id-modal').isVisible();
  evidence.observations.push({ settingsVisible });
  await late.screenshot({ path: fileURLToPath(new URL('late-voice.png', output)), fullPage: true });
  console.log(JSON.stringify(evidence, null, 2));
  // Correct behavior assertions; the audit records which ones fail in the current checkout.
  evidence.voicePassed = evidence.observations.slice(0, 2).every(s => s.calls.length && s.calls.every(c => c.audioSenders > 0));
  evidence.settingsPassed = settingsVisible;
  assert.ok(evidence.voicePassed, 'N03: every peer in voice must attach its microphone to the established audio call');
  assert.ok(settingsVisible, 'N04: Sala button must open its advertised settings modal');
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(evidence, null, 2));
  console.log('Evidence:', fileURLToPath(output)); await browser?.close(); await signaling.close(); await server.close();
}
