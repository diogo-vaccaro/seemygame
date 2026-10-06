import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

// Review probes: record current behavior; intentionally do not change application code.
const output = new URL(`../output/playwright/current-review-${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
const signaling = await startSignalingServer();
const report = { findings: [], errors: [], limitations: ['Two isolated Chrome contexts, synthetic microphones, real PeerJS/WebRTC; controlled delivery of presence messages in race probe.'] };
let browser;
const wait = (p, fn, arg) => waitForAsync(() => p.evaluate(fn, arg), { timeout: 25000 });
const snapshot = p => p.evaluate(async () => {
  const r = (await import('/js/entries/room-entry.js')).roomState;
  const v = r.session.services.voiceManager;
  return { id: r.peer.id, channel: r.roomManager.voiceChannelId, inVoice: v.isInVoice,
    muted: v.isMuted, deafened: v.isDeafened,
    micTracks: v.localStream?.getAudioTracks().map(t => ({ enabled: t.enabled, state: t.readyState })) || [],
    members: [...r.roomManager.members.values()].map(m => ({ id: m.peerId, channel: m.voiceChannelId, muted: m.isMuted, deafened: m.isDeafened })),
    calls: [...r.messageHandlers.activeVoiceCalls.values()].map(c => ({ peer: c.peer, open: c.open, state: c.peerConnection?.connectionState })),
    remoteStreams: [...v.participants.values()].filter(v => !v.isLocal && v.stream).length,
    rejectedCalls: window.__rejectedCalls || 0, heldMessages: window.__heldPresence?.length || 0 };
});
try {
  browser = await launchTestBrowser();
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await prepareSessionContext(browser, signaling);
    const p = await context.newPage(); pages.push(p);
    p.on('pageerror', e => report.errors.push(e.message));
    await p.goto(server.origin + '/room.html?room=current-review');
    await p.locator('#green-room-user-name').fill(`Review ${i}`);
    await p.locator('#green-room-join-btn').click();
    await wait(p, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }
  for (const p of pages) await wait(p, async () => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    return rm.members.size === 2 && rm.authenticatedPeers.size === 1;
  });
  const ids = await Promise.all(pages.map(p => snapshot(p)));
  const lowerIndex = ids[0].id.localeCompare(ids[1].id) < 0 ? 0 : 1;
  const lower = pages[lowerIndex], higher = pages[1 - lowerIndex];
  const lowerId = ids[lowerIndex].id;
  await higher.evaluate(async lowerId => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    window.__heldPresence = [];
    window.__originalHandle = r.roomManager.handleRoomMessage.bind(r.roomManager);
    r.roomManager.handleRoomMessage = (sender, message, conn) => {
      if (sender === lowerId && message.type === 'ROOM_MEMBER_STATE_UPDATE' && message.voiceChannelId === 'voice-1') {
        window.__heldPresence.push([sender, message, conn]); return true;
      }
      return window.__originalHandle(sender, message, conn);
    };
    const original = r.messageHandlers.answerVoiceCall.bind(r.messageHandlers);
    r.messageHandlers.answerVoiceCall = call => {
      const result = original(call);
      if (!result) window.__rejectedCalls = (window.__rejectedCalls || 0) + 1;
      return result;
    };
  }, lowerId);
  await higher.locator('[data-voice-channel="voice-1"]').click();
  await wait(lower, async higherId => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.get(higherId)?.voiceChannelId === 'voice-1', ids[1 - lowerIndex].id);
  await lower.locator('[data-voice-channel="voice-1"]').click();
  await wait(higher, () => window.__rejectedCalls > 0 && window.__heldPresence.length > 0);
  report.raceBeforeDelivery = await Promise.all(pages.map(snapshot));
  await higher.evaluate(async () => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    rm.handleRoomMessage = window.__originalHandle;
    for (const args of window.__heldPresence.splice(0)) window.__originalHandle(...args);
  });
  for (const p of pages) await wait(p, async () => [...(await import('/js/entries/room-entry.js')).roomState.roomManager.members.values()].every(m => m.voiceChannelId === 'voice-1'));
  await new Promise(resolve => setTimeout(resolve, 5000));
  report.raceAfterDelivery = await Promise.all(pages.map(snapshot));
  assert.ok(report.raceAfterDelivery.every(s => s.remoteStreams === 0));
  report.findings.push('R1: voice offer rejected before presence arrival; delivery of all held presence does not restore audio.');
  // Positive control with normal delivery and real inbound audio bytes.
  for (const p of pages) await p.locator('[data-voice-channel="lobby"]').click();
  for (const p of pages) await p.locator('[data-voice-channel="voice-2"]').click();
  for (const p of pages) await wait(p, async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    for (const c of r.messageHandlers.activeVoiceCalls.values()) {
      const stats = await c.peerConnection.getStats();
      if ([...stats.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > 0)) return true;
    }
    return false;
  });
  report.positiveControl = await Promise.all(pages.map(snapshot));
  const guest = pages.find((_, i) => !ids[i].id.startsWith('smg_room_'));
  const host = pages.find(p => p !== guest);
  assert.ok(guest && host);
  await guest.locator('#quick-mic-btn').click();
  await guest.locator('#quick-deaf-btn').click();
  const guestId = (await snapshot(guest)).id;
  await wait(host, async id => {
    const m = (await import('/js/entries/room-entry.js')).roomState.roomManager.members.get(id);
    return m?.isMuted && m?.isDeafened;
  }, guestId);
  report.reconnectBefore = await Promise.all(pages.map(snapshot));
  await guest.evaluate(async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    window.__oldCoordinator = r.coordinatorConn;
    r.coordinatorConn.close();
  });
  await wait(guest, async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    return r.coordinatorConn && r.coordinatorConn !== window.__oldCoordinator && r.coordinatorConn.open && r.roomManager.authenticatedPeers.size === 1;
  });
  await wait(host, async id => (await import('/js/entries/room-entry.js')).roomState.roomManager.isPeerAuthorized(id), guestId);
  await new Promise(resolve => setTimeout(resolve, 2500));
  report.reconnectAfter = await Promise.all(pages.map(snapshot));
  const observed = report.reconnectAfter[pages.indexOf(host)].members.find(m => m.id === guestId);
  assert.equal(observed.muted, false); assert.equal(observed.deafened, false);
  const own = report.reconnectAfter[pages.indexOf(guest)].members.find(m => m.id === guestId);
  assert.equal(own.muted, true); assert.equal(own.deafened, true);
  report.findings.push('R2: coordinator reconnection preserves guest voice channel but resets remote mute/deafen flags to false while local flags remain true.');
  await host.locator('#create-voice-channel-btn').click();
  await host.locator('#voice-channel-name').fill('Canal persistente');
  await host.locator('#create-voice-channel-form button[type="submit"]').click();
  for (const p of pages) await wait(p, async () => [...(await import('/js/entries/room-entry.js')).roomState.roomManager.voiceChannels.values()].some(c => c.name === 'Canal persistente'));
  const customId = await guest.evaluate(async () => [...(await import('/js/entries/room-entry.js')).roomState.roomManager.voiceChannels.values()].find(c => c.name === 'Canal persistente').id);
  await host.locator(`[data-voice-channel="${customId}"]`).click();
  await guest.locator(`[data-voice-channel="${customId}"]`).click();
  for (const p of pages) await wait(p, async id => (await import('/js/entries/room-entry.js')).roomState.roomManager.voiceChannelId === id, customId);
  await wait(guest, async () => [...(await import('/js/entries/room-entry.js')).roomState.messageHandlers.activeVoiceCalls.values()].some(c => c.peerConnection?.connectionState === 'connected'));
  report.switchAfter = await Promise.all(pages.map(snapshot));
  const switched = report.switchAfter[pages.indexOf(guest)];
  assert.equal(switched.muted, false); assert.equal(switched.deafened, false);
  assert.ok(switched.micTracks.length && switched.micTracks.every(t => t.enabled && t.state === 'live'));
  report.findings.push('R4: switching channels in VAD mode clears explicit mute/deafen and enables live microphone tracks without a mic-toggle action.');
  await host.reload();
  await host.locator('#green-room-user-name').fill('Review host restarted');
  await host.locator('#green-room-join-btn').click();
  for (const p of pages) await wait(p, async () => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    return rm?.members.size === 2 && rm.authenticatedPeers.size === 1;
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  report.restartAfter = await Promise.all(pages.map(snapshot));
  report.catalogsAfterRestart = await Promise.all(pages.map(p => p.evaluate(async () => {
    const rm = (await import('/js/entries/room-entry.js')).roomState.roomManager;
    return { revision: rm.voiceChannelsRevision, ids: [...rm.voiceChannels.keys()] };
  })));
  assert.ok(report.catalogsAfterRestart[pages.indexOf(guest)].ids.includes(customId));
  assert.ok(!report.catalogsAfterRestart[pages.indexOf(host)].ids.includes(customId));
  assert.equal(report.restartAfter[pages.indexOf(guest)].channel, customId);
  assert.equal(report.restartAfter[pages.indexOf(host)].members.find(m => m.id === guestId).channel, null);
  report.findings.push('R3: real coordinator reload resets catalog revision; connected guest rejects the new catalog and remains in a ghost voice channel.');
  assert.deepEqual(report.errors, []);
  report.status = 'bugs-reproduced';
  console.log(JSON.stringify(report, null, 2));
} catch (e) { report.status = 'failed'; report.failure = e.stack; throw e; }
finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log('Evidence:', fileURLToPath(output));
  await browser?.close(); await signaling.close(); await server.close();
}
