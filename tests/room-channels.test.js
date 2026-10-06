import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { RoomManager } from '../js/room.js';
import { MAX_VOICE_CHANNELS } from '../js/room/voice-channels.js';
import { createSessionContext } from '../js/core/session-context.js';
import { bindSessionMessageHandlers } from '../js/protocol/session-handlers.js';
import { DiscordUIController } from '../js/discord-ui.js';
import { ChatManager } from '../js/chat.js';
import { VoiceManager } from '../js/voice.js';
import { createRoomSession } from '../js/session/room-session.js';
import { SoundboardPlugin } from '../js/plugins/soundboard-plugin.js';

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
function room(master = true) {
  const r = new RoomManager({ roomId: 'channels', userName: master ? 'Host' : 'Guest' });
  r.join(master ? r.masterPeerId : 'guest', master); cleanups.push(() => r.leave()); return r;
}
function pair() {
  const host = room(), guest = room(false);
  const toGuest = { peer: guest.myPeerId, open: true, close() {}, send: data => guest.handleRoomMessage(host.myPeerId, data, toHost) };
  const toHost = { peer: host.myPeerId, open: true, close() {}, send: data => host.handleRoomMessage(guest.myPeerId, data, toGuest) };
  host.promoteConnection(guest.myPeerId, toGuest, { name: 'Guest' });
  guest.promoteConnection(host.myPeerId, toHost, { name: 'Host', isMaster: true });
  return { host, guest, toHost, toGuest };
}

describe('coordinated voice channels', () => {
  it('starts in a silent lobby and creates channels requested by an admitted member', () => {
    const { host, guest } = pair();
    expect(host.voiceChannelId).toBeNull(); expect(guest.members.get(guest.myPeerId).voiceChannelId).toBeNull();
    expect([...host.voiceChannels.values()].map(c => c.name)).toEqual(['Bate-papo 1', 'Bate-papo 2']);
    expect(guest.createVoiceChannel('Time da partida')).toBe(true);
    expect([...guest.voiceChannels]).toEqual([...host.voiceChannels]);
    expect(host.voiceChannels.size).toBe(3);
    const errors = vi.fn(); guest.on('voiceChannelError', errors);
    guest.createVoiceChannel('Time da partida'); expect(host.voiceChannels.size).toBe(3); expect(errors).toHaveBeenCalled();
  });
  it('rejects forged catalogs, malformed names, stale snapshots and excessive channels', () => {
    const { host, guest, toGuest } = pair();
    const previous = [...guest.voiceChannels];
    guest.authenticatedPeers.add('attacker');
    guest.handleRoomMessage('attacker', { type: 'ROOM_VOICE_CHANNELS', roomId: guest.roomId, channels: [{ id: 'voice-x', name: 'evil' }], revision: 99 }, { peer: 'attacker' });
    expect([...guest.voiceChannels]).toEqual(previous);
    host.handleRoomMessage('unadmitted', { type: 'ROOM_VOICE_CHANNEL_CREATE', roomId: host.roomId, name: 'evil' }, { peer: 'unadmitted' });
    expect(host.voiceChannels.size).toBe(2);
    expect(host.createVoiceChannel(' ')).toBe(false); expect(host.createVoiceChannel('a'.repeat(33))).toBe(false);
    for (let n = 3; n <= MAX_VOICE_CHANNELS; n++) host.createVoiceChannel('Sala ' + n);
    expect(host.createVoiceChannel('Excesso')).toBe(false); expect(host.voiceChannels.size).toBe(MAX_VOICE_CHANNELS);
    expect(guest.applyVoiceChannels([...host.voiceChannels.values()], -1)).toBe(false);
    expect(guest.applyVoiceChannels([{ id: 'voice-bad', name: 'Bad' }], 100)).toBe(false);
    expect(guest.voiceChannels.size).toBe(MAX_VOICE_CHANNELS);
  });
  it('synchronizes custom channels and active voice presence for a late arrival', () => {
    const host = room(); host.createVoiceChannel('Equipe'); host.setLocalVoiceChannel([...host.voiceChannels.keys()][2]);
    const guest = room(false);
    const conn = { peer: host.myPeerId, open: true, close() {} };
    guest.registerConnection(host.myPeerId, conn); guest.promoteConnection(host.myPeerId, conn, { isMaster: true });
    guest.handleRoomMessage(host.myPeerId, { type: 'ROOM_SYNC_ALL', roomId: guest.roomId, voiceChannels: [...host.voiceChannels.values()], voiceChannelsRevision: host.voiceChannelsRevision, members: host.getMembersList() }, conn);
    expect(guest.voiceChannels.size).toBe(3);
    expect(guest.members.get(host.myPeerId).voiceChannelId).toBe(host.voiceChannelId);
    expect(guest.setLocalVoiceChannel('unknown')).toBe(false);
    expect(guest.setLocalVoiceChannel('voice-2')).toBe(true);
    guest.setLocalVoiceChannel(null); expect(guest.voiceChannelId).toBeNull();
  });
});

describe('voice isolation at the media boundary', () => {
  function endpoint() {
    const session = createSessionContext(), channels = new Map([['a', 'voice-1'], ['z', 'voice-2']]);
    const voice = { isInVoice: true, localStream: new MediaStream([new MediaStreamTrack('audio')]), addRemoteParticipant: vi.fn(), removeRemoteParticipant: vi.fn() };
    const events = new Map(); const call = { peer: 'z', metadata: { voiceChannelId: 'voice-1' }, on: (name, fn) => events.set(name, fn), close: vi.fn() };
    const peer = { call: vi.fn(() => call) };
    const handlers = bindSessionMessageHandlers(session, { role: 'room', voiceManager: voice, getLocalPeerId: () => 'a', getPeer: () => peer, getVoiceChannelId: () => channels.get('a'), getPeerVoiceChannelId: id => channels.get(id), getVoicePeerIds: () => channels.keys() });
    cleanups.push(() => session.disposeAsync()); return { session, channels, voice, call, peer, handlers, events };
  }
  it('never calls or answers someone in another channel, including a silent lobby', () => {
    const { channels, handlers, peer } = endpoint();
    handlers.syncVoicePeers(); expect(peer.call).not.toHaveBeenCalled();
    const incoming = { peer: 'z', metadata: { voiceChannelId: 'voice-2' }, close: vi.fn(), answer: vi.fn() };
    expect(handlers.answerVoiceCall(incoming)).toBe(false); expect(incoming.answer).not.toHaveBeenCalled();
    channels.set('a', null); channels.set('z', null);
    expect(handlers.answerVoiceCall(incoming)).toBe(false); handlers.syncVoicePeers(); expect(peer.call).not.toHaveBeenCalled();
  });
  it('connects only matching channels, closes audio on a switch and ignores delayed streams', () => {
    const { channels, handlers, peer, voice, call, events } = endpoint();
    channels.set('z', 'voice-1'); handlers.syncVoicePeers();
    expect(peer.call).toHaveBeenCalledWith('z', voice.localStream, expect.objectContaining({ metadata: expect.objectContaining({ voiceChannelId: 'voice-1' }) }));
    events.get('stream')(new MediaStream()); expect(voice.addRemoteParticipant).toHaveBeenCalledTimes(1);
    channels.set('z', 'voice-2'); handlers.syncVoicePeers();
    expect(call.close).toHaveBeenCalled(); expect(voice.removeRemoteParticipant).toHaveBeenCalledWith('z');
    events.get('stream')(new MediaStream()); expect(voice.addRemoteParticipant).toHaveBeenCalledTimes(1);
    expect(handlers.activeVoiceCalls.size).toBe(0);
  });
  it('rejects a stale call with mismatched channel metadata after a switch', () => {
    const { channels, handlers } = endpoint(); channels.set('z', 'voice-1');
    const call = { peer: 'z', metadata: { voiceChannelId: 'voice-2' }, close: vi.fn(), answer: vi.fn() };
    expect(handlers.answerVoiceCall(call)).toBe(false); expect(call.close).toHaveBeenCalled();
  });
});

describe('room lobby screen', () => {
  it('blocks preset and custom sounds when the channel playback policy rejects them', () => {
    const session = createSessionContext(), manager = { playSound: vi.fn() }, allowed = vi.fn(() => false);
    const plugin = new SoundboardPlugin({ manager }); plugin.init({ dispatcher: session.dispatcher, eventBus: session.eventBus, canReceiveSound: allowed });
    cleanups.push(() => { plugin.destroy(); session.dispose(); });
    const played = vi.fn(); session.eventBus.on('soundboard:custom-played', played);
    session.dispatcher.dispatch({ type: 'SOUNDBOARD_PLAY', soundId: 'test' }, { peer: 'guest' });
    session.dispatcher.dispatch({ type: 'SOUNDBOARD_PLAY_CUSTOM', audioBase64: 'invalid' }, { peer: 'guest' });
    expect(manager.playSound).not.toHaveBeenCalled(); expect(played).not.toHaveBeenCalled();
    allowed.mockReturnValue(true);
    session.dispatcher.dispatch({ type: 'SOUNDBOARD_PLAY', soundId: 'test' }, { peer: 'guest' });
    expect(manager.playSound).toHaveBeenCalledWith('test');
  });
  it('has unique actions, persistent chat and explicit voice entry without a rail', () => {
    const html = readFileSync('room.html', 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    const r = room(), join = vi.fn(), leave = vi.fn();
    const ui = new DiscordUIController({ roomManager: r, chatManager: new ChatManager(), voiceManager: new VoiceManager(), onJoinVoice: join, onLeaveVoice: leave });
    ui.init(); cleanups.push(() => ui.destroy()); ui.updateRoomPresence(r.getMembersList());
    expect(document.getElementById('discord-left-rail')).toBeNull();
    for (const id of ['dock-mic-btn', 'dock-deaf-btn', 'voice-mute-btn', 'voice-deaf-btn', 'quick-tuning-btn', 'toggle-whiteboard-btn']) expect(document.getElementById(id)).toBeNull();
    for (const id of ['quick-mic-btn', 'quick-deaf-btn', 'dock-stream-btn', 'dock-whiteboard-btn', 'toggle-emojis-btn', 'toggle-soundboard-btn', 'voice-connect-btn']) expect(document.querySelectorAll('#' + id)).toHaveLength(1);
    expect(document.getElementById('quick-mic-btn').disabled).toBe(true); document.getElementById('quick-mic-btn').click(); expect(join).not.toHaveBeenCalled();
    expect(document.getElementById('room-chat').contains(document.getElementById('chat-input'))).toBe(true);
    expect(document.getElementById('voice-stage-grid').textContent).toContain('Você está no lobby');
    document.querySelector('[data-voice-channel="voice-2"]').click(); expect(join).toHaveBeenCalledWith('voice-2');
    document.querySelector('[data-voice-channel="lobby"]').click(); expect(leave).toHaveBeenCalled();
    r.createVoiceChannel('<img src=x onerror=evil()>'); ui.renderRoomChannels();
    expect(document.querySelector('#room-channels-list img')).toBeNull();
  });
  it('cancels a pending microphone join when returning to the lobby', async () => {
    localStorage.clear(); document.body.innerHTML = '<div id="toast-container"></div>';
    const runtime = await createRoomSession().initRoomApp(); cleanups.push(() => runtime.dispose());
    runtime.state.roomManager = room();
    let resolve;
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = runtime.joinVoice('voice-1'); runtime.leaveVoice();
    const track = new MediaStreamTrack('audio'); resolve(new MediaStream([track])); await pending;
    expect(track.readyState).toBe('ended'); expect(runtime.state.roomManager.voiceChannelId).toBeNull();
    expect(runtime.session.services.voiceManager.isInVoice).toBe(false);
  });
});
