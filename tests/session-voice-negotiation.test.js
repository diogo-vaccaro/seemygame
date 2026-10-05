import { describe, it, expect, vi } from 'vitest';
import { createSessionContext } from '../js/core/session-context.js';
import { bindSessionMessageHandlers } from '../js/protocol/session-handlers.js';

describe('session voice admission and delayed joins', () => {
  function endpoint(id) {
    const session = createSessionContext();
    const voice = { isInVoice: false, localStream: null, addRemoteParticipant: vi.fn(), removeRemoteParticipant: vi.fn() };
    const peer = { call: vi.fn(() => ({ peer: 'z', on: vi.fn() })) };
    const handlers = bindSessionMessageHandlers(session, { voiceManager: voice, getLocalPeerId: () => id, getPeer: () => peer });
    return { id, session, voice, peer, handlers };
  }
  it.each([['a', 'z'], ['z', 'a']])('negotiates one call with a microphone when %s joins before %s', (first, second) => {
    const endpoints = [endpoint(first), endpoint(second)];
    const join = (local, remote) => {
      local.voice.isInVoice = true; local.voice.localStream = new MediaStream([new MediaStreamTrack('audio')]);
      remote.session.dispatcher.dispatch({ type: 'VOICE_SIGNAL', action: 'VOICE_JOINED', peerId: local.id }, { peer: local.id });
      local.handlers.connectVoiceTo(remote.id);
    };
    join(endpoints[0], endpoints[1]);
    expect(endpoints[0].peer.call).not.toHaveBeenCalled(); expect(endpoints[1].peer.call).not.toHaveBeenCalled();
    join(endpoints[1], endpoints[0]);
    const lower = endpoints.find(e => e.id === 'a'), higher = endpoints.find(e => e.id === 'z');
    expect(lower.peer.call).toHaveBeenCalledTimes(1); expect(higher.peer.call).not.toHaveBeenCalled();
    expect(lower.peer.call.mock.calls[0][1].getAudioTracks()).toHaveLength(1);
    const call = { peer: 'a', answer: vi.fn(), on: vi.fn(), close: vi.fn() };
    expect(higher.handlers.answerVoiceCall(call)).toBe(true);
    expect(call.answer).toHaveBeenCalledWith(higher.voice.localStream);
    lower.handlers.connectVoiceTo('z'); expect(lower.peer.call).toHaveBeenCalledTimes(1);
    endpoints.forEach(e => e.session.dispose());
  });
  it('rejects a call before local voice entry and ignores cleanup of a replaced call', () => {
    const { session, voice, handlers } = endpoint('z');
    const events = new Map();
    const old = { peer: 'a', answer: vi.fn(), close: vi.fn(), on: (type, fn) => events.set(type, fn) };
    expect(handlers.answerVoiceCall(old)).toBe(false); expect(old.answer).not.toHaveBeenCalled();
    voice.isInVoice = true; voice.localStream = new MediaStream([new MediaStreamTrack('audio')]);
    handlers.answerVoiceCall(old);
    const current = { peer: 'a', answer: vi.fn(), close: vi.fn(), on: vi.fn() };
    handlers.answerVoiceCall(current); events.get('close')();
    expect(handlers.activeVoiceCalls.get('a')).toBe(current); expect(voice.removeRemoteParticipant).not.toHaveBeenCalled();
    session.dispose();
  });
});
