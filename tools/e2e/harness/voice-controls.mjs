import assert from 'node:assert/strict';
import { waitForAsync } from '../wait.mjs';

const wait = (page, predicate, argument) => waitForAsync(() => page.evaluate(predicate, argument), { timeout: 20000 });
export const readVoiceControls = page => page.evaluate(async () => {
  const { roomState } = await import('/js/entries/room-entry.js');
  const voice = roomState.session.services.voiceManager;
  return { badge: document.getElementById('copy-badge').textContent.trim(), ...voice.getLocalVoiceState(),
    roomTitle: document.getElementById('room-header-badge').textContent.trim(),
    onlineCount: Number(document.getElementById('sidebar-members-count').textContent.match(/\d+/)?.[0]),
    expectedRoomId: roomState.roomManager.roomId,
    microphoneTracks: voice.localStream?.getAudioTracks().map(t => ({ enabled: t.enabled, state: t.readyState })),
    rawTracks: voice.rawLocalStream?.getAudioTracks().map(t => ({ enabled: t.enabled, state: t.readyState })),
    micButtonMuted: document.getElementById('quick-mic-btn').classList.contains('active-muted'),
    deafButtonMuted: document.getElementById('quick-deaf-btn').classList.contains('active-muted'),
    remotes: [...voice.participants.values()].filter(p => !p.isLocal).map(p => ({ id: p.peerId,
      muted: p.isMuted, deafened: p.isDeafened, hasStream: Boolean(p.stream),
      audioMuted: p.audioElem?.muted, volume: p.audioElem?.volume, gain: p.gainNode?.gain?.value })) };
});

export async function exerciseVoiceControls(pages) {
  const evidence = [];
  for (const page of pages) page.setDefaultTimeout(15000);
  for (const page of pages) {
    assert.equal((await readVoiceControls(page)).isInVoice, false);
    await page.locator('[data-voice-channel="voice-1"]').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
  }
  for (const page of pages) await wait(page, async () => [...(await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.participants.values()].some(p => !p.isLocal && p.stream));
  for (const [index, page] of pages.entries()) {
    const remote = pages[1 - index];
    const before = await readVoiceControls(page);
    assert.ok(!before.badge.includes('Conectando'));
    assert.equal(before.roomTitle, `Sala: #${before.expectedRoomId}`); assert.equal(before.onlineCount, 2);
    await page.locator('#quick-mic-btn').click();
    const muted = await readVoiceControls(page);
    assert.equal(muted.isMuted, true); assert.equal(muted.micButtonMuted, true);
    for (const tracks of [muted.microphoneTracks, muted.rawTracks]) {
      assert.ok(tracks?.length > 0); assert.ok(tracks.every(t => !t.enabled && t.state === 'live'));
    }
    await page.locator('#quick-deaf-btn').click();
    const deafened = await readVoiceControls(page);
    assert.equal(deafened.isDeafened, true); assert.equal(deafened.deafButtonMuted, true);
    assert.ok(deafened.remotes.length > 0 && deafened.remotes.every(p => p.audioMuted || p.volume === 0 || p.gain === 0));
    await wait(remote, async () => [...(await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.participants.values()].some(p => !p.isLocal && p.isMuted && p.isDeafened));
    const propagated = await readVoiceControls(remote);
    await page.locator('#quick-deaf-btn').click(); await page.locator('#quick-mic-btn').click();
    const restored = await readVoiceControls(page);
    assert.equal(restored.isMuted, false); assert.equal(restored.isDeafened, false);
    assert.ok(restored.microphoneTracks.every(t => t.enabled));
    assert.ok(restored.remotes.every(p => !p.audioMuted && (p.gain ?? p.volume) > 0));
    await page.locator('#toggle-voice-btn').click();
    assert.ok(await page.locator('#drawer-panel-voice').isVisible());
    await page.locator('#drawer-close-btn').click();
    assert.equal((await readVoiceControls(page)).isMuted, false);
    assert.equal((await readVoiceControls(page)).isDeafened, false);
    evidence.push({ index, before, muted, deafened, propagated, restored, explicitChannelAndSingleControls: 'passed' });
  }
  // End voice before the capture measurements so this check does not add audio processing load.
  for (const page of pages) {
    await page.locator('#voice-connect-btn').click();
    await wait(page, async () => !(await import('/js/entries/room-entry.js')).roomState.session.services.voiceManager.isInVoice);
  }
  return evidence;
}
