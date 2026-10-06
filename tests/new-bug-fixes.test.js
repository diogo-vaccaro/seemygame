import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceManager } from '../js/voice.js';
import { DiscordUIController } from '../js/discord-ui.js';
import { WhiteboardManager } from '../js/whiteboard.js';
import { createRoomSession } from '../js/session/room-session.js';
import { getRoomMasterPeerId } from '../js/room.js';

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks(); localStorage.clear(); document.body.innerHTML = '';
});
const stream = kind => {
  const track = new MediaStreamTrack(kind), events = new EventTarget();
  track.addEventListener = events.addEventListener.bind(events);
  return new MediaStream([track]);
};
function emitter(fields = {}) {
  const listeners = new Map();
  return { ...fields,
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    emit(name, value) { for (const fn of listeners.get(name) || []) fn(value); }
  };
}
const silent = voice => expect([...voice.rawLocalStream.getAudioTracks(), ...voice.localStream.getAudioTracks()].every(t => !t.enabled)).toBe(true);
async function voiceFixture() {
  const voice = new VoiceManager(); cleanups.push(() => voice.leaveVoice());
  await voice.joinVoice({ peerId: 'local', customStream: stream('audio') });
  return voice;
}
async function roomFixture() {
  document.body.innerHTML = '<div id="video-grid"></div><div id="toast-container"></div>';
  const factory = createRoomSession();
  const runtime = await factory.initRoomApp(); cleanups.push(() => runtime.dispose());
  const peer = emitter({ id: getRoomMasterPeerId('general'), destroyed: false, destroy: vi.fn(), call: vi.fn() });
  runtime.state.peer = peer;
  await factory.setupRoomSession(peer.id, runtime.session);
  return { runtime, peer, rm: runtime.state.roomManager, voice: runtime.session.services.voiceManager };
}
function mediaCall(peer = 'guest') {
  const c = emitter({ peer, metadata: { type: 'ROOM_STREAM' }, peerConnection: new RTCPeerConnection(), answer: vi.fn() });
  c.close = vi.fn(() => { c.peerConnection.close(); c.emit('close'); });
  return c;
}

describe('B01: independent microphone gates', () => {
  it.each(['mode', 'PTT', 'unmute'])('keeps deafen effective during %s changes', async action => {
    const voice = await voiceFixture();
    voice.setVoiceMode('ptt'); voice.setDeafened(true);
    if (action === 'mode') voice.setVoiceMode('vad');
    if (action === 'PTT') voice.setPttActive(true);
    if (action === 'unmute') { voice.setVoiceMode('vad'); voice.setMuted(false); }
    expect(voice.isDeafened).toBe(true); expect(voice.isMuted).toBe(true); silent(voice);
  });
  it('preserves manual mute across mode changes and PTT key presses', async () => {
    const voice = await voiceFixture(); voice.setMuted(true);
    voice.setVoiceMode('ptt'); voice.setPttActive(true); silent(voice);
    voice.setVoiceMode('vad'); expect(voice.isMuted).toBe(true); silent(voice);
    voice.setMuted(false); expect(voice.localStream.getAudioTracks()[0].enabled).toBe(true);
  });
  it.each([false, true])('restoring hearing preserves manual mute=%s', async muted => {
    const voice = await voiceFixture(); voice.setMuted(muted); voice.setDeafened(true);
    voice.setVoiceMode('ptt'); voice.setVoiceMode('vad'); voice.setDeafened(false);
    expect(voice.isMuted).toBe(muted);
    expect(voice.localStream.getAudioTracks()[0].enabled).toBe(!muted);
  });
  it('requires a fresh PTT press after deafen interrupts a held key', async () => {
    const voice = await voiceFixture(); voice.setVoiceMode('ptt'); voice.setPttActive(true);
    voice.setDeafened(true); voice.setDeafened(false);
    expect(voice.isPttActive).toBe(false); silent(voice);
    voice.setPttActive(true); expect(voice.isMuted).toBe(false);
    voice.setPttActive(false); silent(voice);
  });
  it('the unmute button in idle PTT clears manual mute without bypassing the PTT gate', async () => {
    const voice = await voiceFixture(); voice.setVoiceMode('ptt');
    voice.toggleMute();
    expect(voice.isManuallyMuted).toBe(false); silent(voice);
    voice.setPttActive(true); expect(voice.isMuted).toBe(false);
    voice.toggleMute(); expect(voice.isManuallyMuted).toBe(true); silent(voice);
    voice.setPttActive(false); voice.toggleMute(); silent(voice);
    voice.setPttActive(true); expect(voice.isMuted).toBe(false);
  });
  it('applies deafen to microphone tracks obtained after joining', async () => {
    const voice = new VoiceManager(); cleanups.push(() => voice.leaveVoice());
    voice.setDeafened(true); voice.setVoiceMode('ptt'); voice.setVoiceMode('vad');
    await voice.joinVoice({ peerId: 'local', customStream: stream('audio') });
    expect(voice.isMuted).toBe(true); silent(voice);
  });
  it('clears both held PTT shortcuts when deafen interrupts the UI', async () => {
    const voice = await voiceFixture(); voice.setVoiceMode('ptt');
    const ui = new DiscordUIController({ voiceManager: voice }); ui.init(); cleanups.push(() => ui.destroy());
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    key('keydown', 'ControlRight'); key('keydown', 'CapsLock');
    voice.setDeafened(true); voice.setDeafened(false); key('keyup', 'ControlRight');
    expect(voice.isPttActive).toBe(false); silent(voice);
    key('keyup', 'CapsLock'); key('keydown', 'ControlRight');
    expect(voice.isPttActive).toBe(true); expect(voice.isMuted).toBe(false);
  });
});

describe('B02: room screen call lifetime', () => {
  it('closes both directions on member removal and sends a fresh call on readmission', async () => {
    const { runtime, peer, rm } = await roomFixture();
    const conn = { peer: 'guest', open: true, send: vi.fn(), close: vi.fn() };
    rm.promoteConnection('guest', conn, { name: 'Guest' });
    const outgoing = mediaCall(), incoming = mediaCall(), replacement = mediaCall();
    peer.call.mockReturnValueOnce(outgoing).mockReturnValueOnce(replacement);
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream('video'));
    await runtime.startCapture({ audioMode: 'none' });
    expect(runtime.state.screenCalls.get('guest')).toBe(outgoing);
    peer.emit('call', incoming);
    const remote = stream('video'); runtime.state.remoteStreams.get('guest').stream = remote;
    const stopped = vi.fn(); runtime.session.eventBus.on('stream:stopped', stopped);
    rm.removeMember('guest');
    expect(outgoing.close).toHaveBeenCalledOnce(); expect(incoming.close).toHaveBeenCalledOnce();
    expect(runtime.state.screenCalls.size).toBe(0); expect(runtime.state.remoteStreams.size).toBe(0);
    expect(remote.getTracks()[0].readyState).toBe('ended');
    expect(stopped).toHaveBeenCalledWith({ sourceId: 'guest' });
    expect(runtime.state.localStream.getTracks()[0].readyState).toBe('live');
    rm.promoteConnection('guest', conn, { name: 'Guest' });
    expect(peer.call).toHaveBeenCalledTimes(2);
    expect(runtime.state.screenCalls.get('guest')).toBe(replacement);
  });
  it('a late old-call close cannot remove a replacement incoming call', async () => {
    const { runtime, peer, rm } = await roomFixture();
    rm.promoteConnection('guest', { peer: 'guest', open: true, send: vi.fn() }, { name: 'Guest' });
    const old = mediaCall(), current = mediaCall();
    peer.emit('call', old);
    const oldStream = stream('video'), currentStream = stream('video');
    runtime.state.remoteStreams.get('guest').stream = oldStream;
    peer.emit('call', current);
    expect(oldStream.getTracks()[0].readyState).toBe('ended');
    runtime.state.remoteStreams.get('guest').stream = currentStream;
    old.emit('close');
    expect(runtime.state.remoteStreams.get('guest').call).toBe(current);
    expect(currentStream.getTracks()[0].readyState).toBe('live');
    current.emit('error', new Error('media failed'));
    expect(runtime.state.remoteStreams.size).toBe(0);
    expect(currentStream.getTracks()[0].readyState).toBe('ended');
  });
  it('disposal releases incoming media before clearing the stream registry', async () => {
    const { runtime, peer, rm } = await roomFixture();
    rm.promoteConnection('guest', { peer: 'guest', open: true, send: vi.fn() }, { name: 'Guest' });
    const incoming = mediaCall(), remote = stream('video');
    peer.emit('call', incoming); runtime.state.remoteStreams.get('guest').stream = remote;
    runtime.dispose();
    expect(remote.getTracks()[0].readyState).toBe('ended');
    expect(incoming.close).toHaveBeenCalled(); expect(runtime.state.remoteStreams.size).toBe(0);
  });
});

describe('B03: pending microphone joins', () => {
  it('cancels a removed pending channel before the late microphone is granted', async () => {
    const { runtime, rm, voice } = await roomFixture();
    const defaults = [...rm.voiceChannels.values()]; rm.createVoiceChannel('Pending');
    const id = [...rm.voiceChannels.keys()].find(id => !defaults.some(c => c.id === id));
    let grant; const late = stream('audio');
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const pending = runtime.joinVoice(id); const generation = voice.captureGeneration;
    rm.applyVoiceChannels(defaults, 0, { resetRevision: true });
    expect(voice.captureGeneration).toBeGreaterThan(generation);
    grant(late); await pending;
    expect(late.getTracks()[0].readyState).toBe('ended');
    expect(voice.isInVoice).toBe(false); expect(voice.localStream).toBeNull();
    expect(rm.voiceChannelId).toBeNull(); expect(runtime.state.pendingVoiceChannelId).toBeNull();
  });
  it('also revalidates the destination when a catalog changes without an event', async () => {
    const { runtime, rm, voice } = await roomFixture();
    let grant; const late = stream('audio');
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const pending = runtime.joinVoice('voice-1'); rm.voiceChannels.delete('voice-1');
    grant(late); await pending;
    expect(voice.isInVoice).toBe(false); expect(late.getTracks()[0].readyState).toBe('ended');
    expect(rm.voiceChannelId).toBeNull();
  });
  it('late cancellation cannot stop a newer valid join', async () => {
    const { runtime, rm, voice } = await roomFixture();
    let grant; const late = stream('audio'), current = stream('audio');
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementationOnce(() => new Promise(resolve => { grant = resolve; })).mockResolvedValueOnce(current);
    const old = runtime.joinVoice('voice-1'); await runtime.joinVoice('voice-2');
    grant(late); await old;
    expect(late.getTracks()[0].readyState).toBe('ended');
    expect(current.getTracks()[0].readyState).toBe('live');
    expect(voice.isInVoice).toBe(true); expect(rm.voiceChannelId).toBe('voice-2');
  });
});

describe('B04: whiteboard style history', () => {
  const rectangle = { id: 'shape', type: 'rectangle', startX: 10, startY: 10, endX: 100, endY: 80, color: '#ffffff', strokeWidth: 4, fill: 'none' };
  function board() { const m = new WhiteboardManager(); cleanups.push(() => m.dispose()); m.addElement({ ...rectangle }); m.selectedElementId = 'shape'; return m; }
  it.each([['setColor', 'color', '#ef4444'], ['setStrokeWidth', 'strokeWidth', 8], ['setFill', 'fill', 'semi']])('%s supports undo and redo without removing the object', (method, field, value) => {
    const m = board(); m[method](value);
    expect(m.elements[0][field]).toBe(value);
    m.undo(); expect(m.elements).toEqual([rectangle]);
    m.redo(); expect(m.elements).toEqual([{ ...rectangle, [field]: value }]);
  });
  it('a new style edit invalidates redo of an earlier edit', () => {
    const m = board(); m.setColor('#ef4444'); m.undo(); m.selectedElementId = 'shape';
    m.setStrokeWidth(8); expect(m.redo()).toBe(false);
    expect(m.elements[0]).toMatchObject({ color: '#ffffff', strokeWidth: 8 });
  });
  it('choosing an unchanged style or a future drawing style does not consume history', () => {
    const m = board(); const updated = vi.fn(); m.onElementUpdated = updated;
    m.setColor('#ffffff'); m.setStrokeWidth(4); m.setFill('none');
    m.selectedElementId = null; m.setColor('#ef4444'); m.setStrokeWidth(8); m.setFill('semi');
    expect(m.undoStack.length).toBe(1); expect(m.elements).toEqual([rectangle]);
    expect(updated).not.toHaveBeenCalled();
  });
});
