import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL(`../output/playwright/room-channels-${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root }), signaling = await startSignalingServer();
const report = { status: 'running', checks: [], errors: [], limitations: ['One machine; isolated Chrome contexts, fake microphone, real WebRTC voice and data transport.'] };
let browser;
const pages = [];
const wait = (p, predicate, arg) => waitForAsync(() => p.evaluate(predicate, arg), { timeout: 25000 });
const state = p => p.evaluate(async () => {
  const { roomState: r } = await import('/js/entries/room-entry.js');
  const v = r.session.services.voiceManager;
  return { channel: r.roomManager.voiceChannelId, inVoice: v.isInVoice,
    channels: [...r.roomManager.voiceChannels.values()], calls: r.messageHandlers.activeVoiceCalls.size,
    remoteStreams: [...v.participants.values()].filter(p => !p.isLocal && p.stream).length };
});
try {
  browser = await launchTestBrowser();
  const addPerson = async index => {
    const context = await prepareSessionContext(browser, signaling);
    const page = await context.newPage(); pages.push(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    page.on('pageerror', e => report.errors.push(e.message));
    await page.goto(server.origin + '/room.html?room=lobby-channels-e2e');
    await page.locator('#green-room-user-name').fill(['Alice', 'Bruno', 'Carla', 'Diego'][index]);
    await page.locator('#green-room-join-btn').click();
    for (const p of pages) await wait(p, async count => {
      const r = (await import('/js/entries/room-entry.js')).roomState.roomManager;
      return r?.isInRoom && r.members.size === count && r.authenticatedPeers.size === count - 1;
    }, pages.length);
    return page;
  };
  for (let i = 0; i < 3; i++) await addPerson(i);
  for (const p of pages) {
    const s = await state(p); assert.equal(s.channel, null); assert.equal(s.inVoice, false);
    assert.equal(s.calls, 0); assert.equal(s.channels.length, 2);
    assert.equal(await p.locator('#quick-mic-btn').isDisabled(), true);
    assert.ok(await p.locator('#room-chat').isVisible());
  }
  report.checks.push('Silent lobby with two voice rooms and disabled microphone');
  await pages[0].screenshot({ path: fileURLToPath(new URL('lobby.png', output)) });
  await pages[0].locator('#chat-input').fill('Olá do lobby');
  await pages[0].locator('#chat-send-btn').click();
  for (const p of pages) await wait(p, () => document.getElementById('chat-messages-container').textContent.includes('Olá do lobby'));
  report.checks.push('Lobby text delivered to all three members');
  await pages[0].locator('[data-voice-channel="voice-1"]').click();
  await pages[1].locator('[data-voice-channel="voice-2"]').click();
  for (const p of pages.slice(0, 2)) await wait(p, async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (const p of pages) { const s = await state(p); assert.equal(s.calls, 0); assert.equal(s.remoteStreams, 0); }
  report.checks.push('Different channels do not establish voice calls');
  await pages[1].locator('[data-voice-channel="voice-1"]').click();
  for (const p of pages.slice(0, 2)) await wait(p, async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    const calls = [...r.messageHandlers.activeVoiceCalls.values()];
    if (calls.length !== 1) return false;
    const stats = await calls[0].peerConnection.getStats();
    return [...stats.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > 0);
  });
  assert.equal((await state(pages[2])).remoteStreams, 0);
  report.checks.push('Same channel receives actual WebRTC audio; lobby remains silent');
  for (const p of pages) await p.evaluate(async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    window.__soundsReceived = 0;
    r.session.eventBus.on('soundboard:played', () => window.__soundsReceived++);
  });
  const sendSound = p => p.evaluate(async () => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    const soundId = (await import('/js/soundboard.js')).SOUNDBOARD_PRESETS[0].id;
    rm.broadcast({ type: 'SOUNDBOARD_PLAY', soundId, voiceChannelId: 'voice-1' });
  });
  await sendSound(pages[2]); // A lobby member cannot inject sound into a voice room.
  await sendSound(pages[1]);
  await wait(pages[0], () => window.__soundsReceived === 1);
  await pages[0].locator('#quick-deaf-btn').click();
  await sendSound(pages[1]);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await pages[0].evaluate(() => window.__soundsReceived), 1);
  assert.equal(await pages[2].evaluate(() => window.__soundsReceived), 0);
  await pages[0].locator('#quick-deaf-btn').click();
  await pages[0].locator('#quick-mic-btn').click();
  report.checks.push('Soundboard respects voice channels, silent lobby and deafen');
  await pages[2].locator('[data-voice-channel="voice-2"]').click();
  await pages[1].locator('[data-voice-channel="voice-2"]').click();
  await wait(pages[0], async () => (await import('/js/entries/room-entry.js')).roomState.messageHandlers.activeVoiceCalls.size === 0);
  for (const p of pages.slice(1, 3)) await wait(p, async () => [...(await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.participants.values()].some(v => !v.isLocal && v.stream));
  report.checks.push('Switch closes previous voice and connects only to the new channel');
  await pages[1].locator('#create-voice-channel-btn').click();
  await pages[1].locator('#voice-channel-name').fill('Equipe azul');
  await pages[1].locator('#create-voice-channel-form button[type="submit"]').click();
  for (const p of pages) await wait(p, async () => [...(await import('/js/entries/room-entry.js')).roomState.roomManager.voiceChannels.values()].some(c => c.name === 'Equipe azul'));
  await addPerson(3);
  assert.equal((await state(pages[3])).channels.length, 3);
  assert.equal((await state(pages[3])).inVoice, false);
  report.checks.push('Guest creates channel; late member receives catalog and stays in lobby');
  await pages[1].evaluate(async () => {
    const v = (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager;
    window.__previousMicTracks = [...v.rawLocalStream.getTracks(), ...v.localStream.getTracks()];
  });
  await pages[1].locator('[data-voice-channel="lobby"]').click();
  await wait(pages[1], async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    return !r.session.services.voiceManager.isInVoice && !r.roomManager.voiceChannelId && r.messageHandlers.activeVoiceCalls.size === 0 && window.__previousMicTracks.every(t => t.readyState === 'ended');
  });
  await wait(pages[2], async () => (await import('/js/entries/room-entry.js')).roomState.messageHandlers.activeVoiceCalls.size === 0);
  report.checks.push('Returning to lobby stops microphone tracks and remote calls');
  await pages[1].locator('#chat-input').fill('Texto entre salas'); await pages[1].locator('#chat-send-btn').click();
  for (const p of pages) await wait(p, () => document.getElementById('chat-messages-container').textContent.includes('Texto entre salas'));
  report.checks.push('Text remains global regardless of voice channel');
  await pages[0].screenshot({ path: fileURLToPath(new URL('channels.png', output)) });
  await pages[0].locator('#toggle-voice-btn').click();
  await wait(pages[0], () => document.getElementById('discord-drawer').getBoundingClientRect().right <= window.innerWidth);
  await pages[0].screenshot({ path: fileURLToPath(new URL('voice-settings.png', output)) });
  await pages[0].locator('#drawer-close-btn').click();
  await pages[0].setViewportSize({ width: 900, height: 720 });
  await wait(pages[0], () => document.getElementById('room-chat').classList.contains('is-collapsed'));
  await pages[0].locator('#room-chat-toggle').click();
  assert.ok(await pages[0].locator('#room-chat').isVisible());
  await pages[0].screenshot({ path: fileURLToPath(new URL('compact.png', output)) });
  report.checks.push('Compact viewport keeps channels and opens chat on demand');
  await pages[0].locator('#room-chat-toggle').click();
  await pages[0].setViewportSize({ width: 600, height: 800 });
  assert.ok(await pages[0].locator('[data-voice-channel="lobby"]').isVisible());
  const sidebarBounds = await pages[0].locator('.room-sidebar').boundingBox();
  assert.ok(sidebarBounds.x >= 0 && sidebarBounds.width > 0);
  await pages[0].screenshot({ path: fileURLToPath(new URL('mobile.png', output)) });
  report.checks.push('Narrow viewport keeps channel navigation visible');
  await pages[3].locator('#dock-stream-btn').click();
  await wait(pages[3], async () => Boolean((await import('/js/entries/room-entry.js')).roomState.localStream));
  assert.equal((await state(pages[3])).inVoice, false);
  assert.equal(await pages[3].locator('[data-is-local="true"] .card-btn-danger').count(), 0);
  for (const p of pages.slice(0, 3)) await wait(p, () => [...document.querySelectorAll('video')].some(v => v.getVideoPlaybackQuality().totalVideoFrames >= 10));
  await pages[3].screenshot({ path: fileURLToPath(new URL('lobby-streaming.png', output)) });
  await pages[3].locator('#dock-stream-btn').click();
  await wait(pages[3], async () => !(await import('/js/entries/room-entry.js')).roomState.localStream);
  report.checks.push('Lobby member streams to all channels and stops with the single dock action');
  assert.deepEqual(report.errors, []); report.status = 'passed';
  console.log('PASS room channels:', report.checks);
} catch (error) { report.status = 'failed'; report.failure = error.stack; throw error; }
finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
