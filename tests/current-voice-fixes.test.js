import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../js/room.js';
import { createSessionContext } from '../js/core/session-context.js';
import { bindSessionMessageHandlers } from '../js/protocol/session-handlers.js';
import { createRoomSession } from '../js/session/room-session.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); document.body.innerHTML = '';
});

function call(peer = 'a', channel = 'voice-1') {
  const events = new Map();
  const c = { peer, metadata: { voiceChannelId: channel }, answer: vi.fn(), close: vi.fn(() => c.emit('close')),
    on: (name, handler) => { if (!events.has(name)) events.set(name, []); events.get(name).push(handler); },
    emit: (name, value) => { for (const fn of events.get(name) || []) fn(value); } };
  return c;
}
function endpoint(id = 'z') {
  vi.useFakeTimers();
  const session = createSessionContext(); cleanups.push(() => session.disposeAsync());
  const channels = new Map([['a', null], ['z', 'voice-1']]);
  const authorized = new Set(['a', 'z']);
  const voice = { isInVoice: true, localStream: new MediaStream([new MediaStreamTrack('audio')]),
    addRemoteParticipant: vi.fn(), removeRemoteParticipant: vi.fn() };
  const peer = { call: vi.fn(peerId => call(peerId)) };
  const handlers = bindSessionMessageHandlers(session, { role: 'room', voiceManager: voice,
    getPeer: () => peer, getLocalPeerId: () => id, isAuthorizedPeer: id => authorized.has(id),
    getVoiceChannelId: () => channels.get(id), getPeerVoiceChannelId: id => channels.get(id), getVoicePeerIds: () => channels.keys() });
  return { session, channels, authorized, voice, peer, handlers };
}

describe('voice offers arriving before channel presence', () => {
  it('defers an authorized offer, answers after presence, and delivers only its verified stream', () => {
    const { handlers, channels, voice } = endpoint(); const c = call();
    expect(handlers.answerVoiceCall(c)).toBe(false);
    expect(c.answer).not.toHaveBeenCalled(); expect(c.close).not.toHaveBeenCalled();
    c.emit('stream', new MediaStream()); expect(voice.addRemoteParticipant).not.toHaveBeenCalled();
    channels.set('a', 'voice-1'); handlers.syncVoicePeers();
    expect(c.answer).toHaveBeenCalledWith(voice.localStream);
    c.emit('stream', new MediaStream()); expect(voice.addRemoteParticipant).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20000); expect(c.close).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'leave', 'switch', 'revocation', 'dispose'])('cancels deferred voice on %s', async reason => {
    const { handlers, channels, authorized, session } = endpoint(); const c = call();
    handlers.answerVoiceCall(c);
    if (reason === 'timeout') vi.advanceTimersByTime(5000);
    if (reason === 'leave') handlers.closeVoiceCalls();
    if (reason === 'switch') { channels.set('z', 'voice-2'); handlers.syncVoicePeers(); }
    if (reason === 'revocation') { authorized.delete('a'); handlers.syncVoicePeers(); }
    if (reason === 'dispose') await session.disposeAsync();
    expect(c.close).toHaveBeenCalledTimes(1);
    channels.set('a', channels.get('z')); handlers.syncVoicePeers();
    expect(c.answer).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects unauthorized and stale-channel offers immediately', () => {
    const { handlers, authorized } = endpoint();
    const stale = call('a', 'voice-2'); handlers.answerVoiceCall(stale);
    expect(stale.close).toHaveBeenCalledTimes(1);
    authorized.delete('a'); const untrusted = call(); handlers.answerVoiceCall(untrusted);
    expect(untrusted.close).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds unanswered outgoing calls to an initial offer and two retries', () => {
    const { handlers, channels, peer } = endpoint('a'); channels.set('a', 'voice-1');
    handlers.syncVoicePeers();
    vi.advanceTimersByTime(20000);
    expect(peer.call).toHaveBeenCalledTimes(3);
    for (const result of peer.call.mock.results) expect(result.value.close).toHaveBeenCalledTimes(1);
    expect(handlers.activeVoiceCalls.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels negotiation timeout after receiving a stream', () => {
    const { handlers, channels, peer } = endpoint('a'); channels.set('a', 'voice-1');
    const c = handlers.connectVoiceTo('z'); c.emit('stream', new MediaStream());
    vi.advanceTimersByTime(20000);
    expect(peer.call).toHaveBeenCalledTimes(1); expect(c.close).not.toHaveBeenCalled();
  });
  it.each(['leave', 'switch', 'dispose'])('never retries outgoing voice after %s', async reason => {
    const { handlers, channels, peer, session } = endpoint('a'); channels.set('a', 'voice-1');
    handlers.connectVoiceTo('z');
    if (reason === 'leave') handlers.closeVoiceCalls();
    if (reason === 'switch') { channels.set('a', 'voice-2'); handlers.syncVoicePeers(); }
    if (reason === 'dispose') await session.disposeAsync();
    vi.advanceTimersByTime(20000); expect(peer.call).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('authoritative catalog on coordinator readmission', () => {
  const room = () => {
    const rm = new RoomManager({ roomId: 'catalog-restart', userName: 'Guest' }); rm.join('a', false);
    cleanups.push(() => rm.leave()); return rm;
  };
  const sync = (rm, conn, channels, revision) => rm.handleRoomMessage(rm.masterPeerId,
    { type: 'ROOM_SYNC_ALL', roomId: rm.roomId, voiceChannels: channels, voiceChannelsRevision: revision, members: [] }, conn);
  it('accepts a lower revision only on a new coordinator connection and clears a removed local channel', () => {
    const rm = room(), defaults = [...rm.voiceChannels.values()];
    const conn = { peer: rm.masterPeerId, open: true, send: vi.fn(), close: vi.fn() };
    rm.promoteConnection(rm.masterPeerId, conn, { isMaster: true });
    sync(rm, conn, [...defaults, { id: 'voice-custom', name: 'Custom' }], 3);
    rm.setLocalVoiceChannel('voice-custom');
    sync(rm, conn, defaults, 0); expect(rm.voiceChannelsRevision).toBe(3);
    const next = { ...conn, send: vi.fn(), close: vi.fn() }; rm.promoteConnection(rm.masterPeerId, next, { isMaster: true });
    const removed = vi.fn(); rm.on('voiceChannelRemoved', removed);
    sync(rm, next, defaults, 0);
    expect(rm.voiceChannelsRevision).toBe(0); expect(rm.voiceChannelId).toBeNull();
    expect(rm.members.get('a').voiceChannelId).toBeNull(); expect(removed).toHaveBeenCalledTimes(1);
    sync(rm, conn, [...defaults, { id: 'voice-ghost', name: 'Ghost' }], 10);
    expect(rm.voiceChannels.size).toBe(2);
  });
  it('rejects invalid snapshots even on a fresh authenticated connection', () => {
    const rm = room(), defaults = [...rm.voiceChannels.values()];
    const conn = { peer: rm.masterPeerId, open: true, send: vi.fn(), close: vi.fn() };
    rm.promoteConnection(rm.masterPeerId, conn, { isMaster: true });
    rm.applyVoiceChannels([...defaults, { id: 'voice-custom', name: 'Custom' }], 3);
    sync(rm, conn, defaults, -1); sync(rm, conn, [{ id: 'invalid', name: 'Invalid' }], 0);
    expect(rm.voiceChannelsRevision).toBe(3); expect(rm.voiceChannels.size).toBe(3); expect(rm.voiceCatalogConnection).toBeNull();
  });
});

describe('room channel switches preserve user voice controls', () => {
  it.each(['muted', 'deafened', 'ptt'])('keeps %s capture silent when changing channel', async mode => {
    localStorage.clear(); document.body.innerHTML = '<div id="toast-container"></div>';
    const runtime = await createRoomSession().initRoomApp(); cleanups.push(() => runtime.dispose());
    const rm = new RoomManager({ roomId: 'switch-controls', userName: 'User' }); rm.join('a', false);
    runtime.state.roomManager = rm; cleanups.push(() => rm.leave());
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async () => new MediaStream([new MediaStreamTrack('audio')]));
    await runtime.joinVoice('voice-1');
    const v = runtime.session.services.voiceManager;
    if (mode === 'muted') v.setMuted(true);
    if (mode === 'deafened') v.setDeafened(true);
    if (mode === 'ptt') { v.setVoiceMode('ptt'); v.setPttActive(true); }
    const old = [...v.rawLocalStream.getTracks(), ...v.localStream.getTracks()];
    await runtime.joinVoice('voice-2');
    expect(rm.voiceChannelId).toBe('voice-2'); expect(v.isMuted).toBe(true);
    expect(v.rawLocalStream.getAudioTracks().every(t => !t.enabled)).toBe(true);
    expect(v.localStream.getAudioTracks().every(t => !t.enabled)).toBe(true);
    for (const track of old) expect(track.stop).toHaveBeenCalled();
    if (mode === 'deafened') expect(v.isDeafened).toBe(true);
    if (mode === 'ptt') expect(v.isPttActive).toBe(false);
  });
});

describe('complete voice presence on room readmission', () => {
  it.each([false, true])('restores mute/deafen with an existing member: %s', existing => {
    const rm = new RoomManager({ roomId: 'readmission', userName: 'Host' }); rm.join(rm.masterPeerId, true);
    cleanups.push(() => rm.leave());
    const conn = { peer: 'a', open: true, send: vi.fn(), close: vi.fn() };
    if (existing) rm.promoteConnection('a', conn, { name: 'Guest', isMuted: false, isDeafened: false });
    else rm.registerConnection('a', conn);
    rm.handleRoomMessage('a', { type: 'ROOM_JOIN_REQUEST', roomId: rm.roomId, name: 'Guest',
      isMuted: true, isDeafened: true, isSpeaking: false, voiceChannelId: 'voice-1' }, conn);
    expect(rm.members.get('a')).toMatchObject({ isMuted: true, isDeafened: true, isSpeaking: false, voiceChannelId: 'voice-1' });
    const snapshot = conn.send.mock.calls.find(([data]) => data.type === 'ROOM_SYNC_ALL')[0];
    expect(snapshot.members.find(m => m.peerId === 'a')).toMatchObject({ isMuted: true, isDeafened: true });
  });
  it('does not restore speaking presence for an unknown voice channel', () => {
    const rm = new RoomManager({ roomId: 'readmission', userName: 'Host' }); rm.join(rm.masterPeerId, true);
    cleanups.push(() => rm.leave());
    const conn = { peer: 'a', open: true, send: vi.fn(), close: vi.fn() }; rm.registerConnection('a', conn);
    rm.handleRoomMessage('a', { type: 'ROOM_JOIN_REQUEST', roomId: rm.roomId, name: 'Guest',
      isMuted: false, isSpeaking: true, voiceChannelId: 'voice-unknown' }, conn);
    expect(rm.members.get('a')).toMatchObject({ isSpeaking: false, voiceChannelId: null });
  });
});
