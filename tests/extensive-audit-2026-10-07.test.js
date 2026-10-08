import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus } from '../js/core/event-bus.js';
import { MessageDispatcher } from '../js/core/message-dispatcher.js';
import { PluginManager } from '../js/core/plugin-manager.js';
import { getPublicOrigin } from '../js/config.js';
import turnHandler from '../api/turn.js';
import { VoiceManager } from '../js/voice.js';
import { MockMediaStream, MockMediaStreamTrack } from './mocks/webrtc.mock.js';
import { MockAudioContext } from './mocks/webaudio.mock.js';
import { getClientSessionId } from '../js/app/session-identity.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Extensive audit: lifecycle and dispatch regressions', () => {
  it('runs a once listener only once during nested emissions', () => {
    const bus = new EventBus();
    let nested = false;
    bus.on('tick', () => { if (!nested) { nested = true; bus.emit('tick'); } }, { priority: 1 });
    const once = vi.fn();
    bus.once('tick', once);
    bus.emit('tick');
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes the exact registration when callbacks are shared', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('tick', handler);
    const removeOnce = bus.once('tick', handler);
    removeOnce();
    bus.emit('tick'); bus.emit('tick');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not skip the next message handler when one unregisters itself', () => {
    const dispatcher = new MessageDispatcher();
    let remove;
    remove = dispatcher.register('TEST', () => remove());
    const next = vi.fn();
    dispatcher.register('TEST', next);
    dispatcher.dispatch({ type: 'TEST' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects replacing a registered plugin rather than losing its resource owner', () => {
    const manager = new PluginManager();
    const plugin = { name: 'resource', init: vi.fn(), destroy: vi.fn() };
    manager.register(plugin); manager.initAll();
    expect(() => manager.register({ ...plugin })).toThrow();
    manager.destroyAll();
    expect(plugin.destroy).toHaveBeenCalledTimes(1);
  });

  it('initializes an owned plugin once and contains asynchronous individual teardown failures', async () => {
    const bus = new EventBus();
    const error = vi.fn(); bus.on('system:error', error);
    const manager = new PluginManager({ eventBus: bus });
    const plugin = { name: 'async', init: vi.fn(), destroy: vi.fn().mockRejectedValue(new Error('teardown')) };
    manager.register(plugin); manager.initAll(); manager.initAll();
    expect(plugin.init).toHaveBeenCalledTimes(1);
    await manager.destroy('async');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('can tear down again inside a plugin destruction callback', async () => {
    const manager = new PluginManager();
    const destroy = vi.fn(() => manager.destroyAll());
    manager.register({ name: 'reentrant', init() {}, destroy }); manager.initAll();
    await manager.destroyAll();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps invitations usable when local storage access fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    expect(getPublicOrigin()).toBe('https://seemygame.vercel.app');
  });

  it('can create voice services when device preference storage fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    const voice = new VoiceManager();
    expect(voice.selectedMicId).toBe('');
    expect(voice.selectedSpeakerId).toBe('');
  });

  it('can assign a client session ID when session storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    expect(getClientSessionId()).toMatch(/^sess_/);
  });

  it('releases the decoder element and all VAD nodes when leaving voice', () => {
    const voice = new VoiceManager({ audioContextProvider: () => new MockAudioContext() });
    voice.addRemoteParticipant('remote', new MockMediaStream([new MockMediaStreamTrack('audio')]));
    const participant = voice.participants.get('remote');
    const sourceElement = participant.sourceAudioElem;
    const source = participant.vadSource, analyser = participant.vadAnalyser;
    expect(sourceElement.isConnected).toBe(true);
    voice.leaveVoice();
    expect(sourceElement.isConnected).toBe(false);
    expect(sourceElement.srcObject).toBe(null);
    expect(source.disconnect).toHaveBeenCalled();
    expect(analyser.disconnect).toHaveBeenCalled();
    expect(participant.vadInterval).toBe(null);
  });

  it('restarting local VAD releases the preceding graph and timer', () => {
    const voice = new VoiceManager({ audioContextProvider: () => new MockAudioContext() });
    voice.localStream = new MockMediaStream([new MockMediaStreamTrack('audio')]);
    voice.initLocalVAD();
    const source = voice.localVad.source, analyser = voice.localVad.analyser;
    voice.initLocalVAD();
    expect(source.disconnect).toHaveBeenCalled();
    expect(analyser.disconnect).toHaveBeenCalled();
    voice.leaveVoice();
  });
});

describe('Extensive audit: TURN credentials', () => {
  function response() {
    const res = { setHeader: vi.fn(), json: vi.fn(), end: vi.fn() };
    res.status = vi.fn(() => res);
    return res;
  }
  function request(token) {
    return { method: 'GET', headers: { origin: 'https://seemygame.vercel.app',
      'x-real-ip': `audit-${Math.random()}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } };
  }
  function configure() {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURN_ALLOWED_ORIGINS', 'https://seemygame.vercel.app');
    vi.stubEnv('TURN_ACCESS_TOKEN', 'audit-token');
    vi.stubEnv('METERED_DOMAIN', ''); vi.stubEnv('METERED_API_KEY', '');
    vi.stubEnv('TURN_SERVERS_JSON', ''); vi.stubEnv('TURN_USERNAME', '');
    vi.stubEnv('TURN_PASSWORD', ''); vi.stubEnv('TURN_CREDENTIAL', '');
  }
  it.each(['json', 'static'])('protects %s credentials with the same production authentication', async source => {
    configure();
    if (source === 'json') vi.stubEnv('TURN_SERVERS_JSON', JSON.stringify([{ urls: 'turn:example.org', username: 'test', credential: 'test' }]));
    else { vi.stubEnv('TURN_USERNAME', 'test'); vi.stubEnv('TURN_PASSWORD', 'test'); }
    const denied = response(); await turnHandler(request(), denied);
    expect(denied.status).toHaveBeenCalledWith(401);
    const allowed = response(); await turnHandler(request('audit-token'), allowed);
    expect(allowed.status).toHaveBeenCalledWith(200);
    expect(allowed.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
  it('returns only public STUN when no private TURN service is configured in production', async () => {
    configure();
    const res = response(); await turnHandler(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].iceServers.every(server => server.urls.startsWith('stun:'))).toBe(true);
  });
});
