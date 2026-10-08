import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL(`../output/playwright/room-quality-${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root }), signaling = await startSignalingServer();
const report = { status: 'running', scope: 'Product room UI/session/real WebRTC; two Chrome contexts on one machine; synthetic 1080p capture, no hardware performance certification', checks: [], errors: [] };
let browser;
const room = `quality-e2e-${Date.now()}`;
const wait = predicate => waitForAsync(predicate, { timeout: 25000 });
try {
 browser = await launchTestBrowser();
 const pages = [];
 for (const name of ['QualitySender', 'QualityReceiver']) {
  const context = await prepareSessionContext(browser, signaling);
  if (!pages.length) await context.addInitScript(() => {
   navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    const ctx = canvas.getContext('2d'); let frame = 0;
    const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#152833' : '#553020'; ctx.fillRect(0, 0, canvas.width, canvas.height); }, 33);
    const stream = canvas.captureStream(30), track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
    track.stop = () => { clearInterval(timer); stop(); };
    // Deliberately refuses constraints: product sender scaling must still work.
    track.applyConstraints = async () => { throw new DOMException('Fixture source cannot resize', 'OverconstrainedError'); };
    return stream;
   };
  });
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${server.origin}/room.html?room=${room}`);
  await page.locator('#green-room-user-name').fill(name);
  await page.locator('#green-room-join-btn').click();
 }
 for (const page of pages) await wait(() => page.evaluate(async () => {
  const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
  return rm?.members.size === 2 && rm.authenticatedPeers.size === 1;
 }));
 const senderState = () => pages[0].evaluate(async () => {
  const r = (await import('/js/entries/room-entry.js')).roomState;
  const sender = [...r.screenCalls.values()][0]?.peerConnection.getSenders().find(s => s.track?.kind === 'video');
  const p = sender?.getParameters();
  return { settings: r.captureSettings, degradation: p?.degradationPreference, encoding: p?.encodings?.[0], source: sender?.track.getSettings() };
 });
 const receivedSize = () => pages[1].evaluate(() => {
  const v = [...document.querySelectorAll('video')].find(v => v.getVideoPlaybackQuality().totalVideoFrames > 10);
  return v ? { width: v.videoWidth, height: v.videoHeight } : null;
 });
 const change = (id, value) => pages[0].locator('#' + id).evaluate((element, value) => {
  element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
 }, value);
 await pages[0].locator('#dock-stream-btn').click();
 await wait(async () => (await senderState()).encoding?.maxBitrate === 7500000);
 await wait(async () => (await receivedSize())?.height === 1080);
 report.initial = await senderState(); report.checks.push('Active 1080p video reaches receiver');

 assert.equal(await pages[0].locator('#stream-performance-mode').isDisabled(), true);
 await change('stream-fps-select', '30');
 await change('stream-resolution-select', '720');
 await wait(async () => { const s=await senderState();return s.settings?.height===720&&s.settings.fps===30&&s.encoding?.maxFramerate===30&&s.encoding.maxBitrate===7500000; });
 await wait(async () => (await receivedSize())?.height===720);
 report.independentSettings=await senderState();
 report.checks.push('Independent 720p/30 FPS controls preserve 7.5 Mbps and reach the real WebRTC sender/receiver');
 await pages[0].locator('#tuning-modal').evaluate(el=>el.style.display='flex');
 await pages[0].screenshot({path:fileURLToPath(new URL('settings-wide.png',output))});
 const wideViewport=pages[0].viewportSize();
 await pages[0].setViewportSize({width:380,height:820});
 const fits=await pages[0].locator('.video-settings').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&el.scrollWidth<=el.clientWidth+1;});
 assert.equal(fits,true,'Independent video controls fit a 380px viewport');
 await pages[0].screenshot({path:fileURLToPath(new URL('settings-mobile.png',output))});
 await pages[0].locator('[data-streaming-help="stream-performance-help"]').focus();
 assert.equal(await pages[0].locator('#stream-performance-help').isVisible(),true);
 await pages[0].keyboard.press('Escape');
 assert.equal(await pages[0].locator('#stream-performance-help').isVisible(),false);
 await pages[0].setViewportSize(wideViewport);
 report.checks.push('Settings fit mobile and mode help opens with keyboard focus and closes with Escape');
 await pages[0].locator('#tuning-modal').evaluate(el=>el.style.display='none');

 await change('quality-preset', 'ultra');
 await wait(async () => { const s = await senderState(); return s.settings?.height === 720 && s.encoding?.scaleResolutionDownBy === 1.5 && s.encoding.maxBitrate === 4500000; });
 await wait(async () => { const s = await receivedSize(); return s?.width === 1280 && s.height === 720; });
 report.hd = await senderState(); report.hdReceived = await receivedSize();
 report.checks.push('UI profile reaches state/sender/receiver at 720p even with constraints refused');

 await change('bitrate-slider', '5000');
 await change('degradation-preference-select', 'balanced');
 await wait(async () => { const s = await senderState(); return s.degradation === 'balanced' && s.encoding?.maxBitrate === 5000000; });
 assert.equal((await senderState()).encoding.scaleResolutionDownBy, 1.5);
 await wait(async () => (await receivedSize())?.height === 720);
 report.adapted = await senderState();
 report.checks.push('Bitrate and adaptation update without losing 720p scale');

 await change('degradation-preference-select', 'maintain-resolution');
 await change('quality-preset', 'balanced');
 await wait(async () => { const s = await senderState(); return s.settings?.height === 1080 && s.encoding?.scaleResolutionDownBy === 1; });
 await wait(async () => (await receivedSize())?.height === 1080);
 report.checks.push('Profile returns to 1080p on same active connection');
 await pages[0].locator('#dock-stream-btn').click();
 await wait(() => pages[0].evaluate(async () => !(await import('/js/entries/room-entry.js')).roomState.localStream));
 report.checks.push('Stop releases active capture');
 assert.deepEqual(report.errors, []); report.status = 'passed';
 console.log('PASS room quality:', report.checks);
} catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
finally {
 await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
 await browser?.close(); await signaling.close(); await server.close();
 console.log('Evidence:', fileURLToPath(output));
}
