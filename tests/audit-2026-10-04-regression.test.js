// Regression coverage for the findings in docs/analise-completa-codigo-2026-10-04.md.
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('../js/ui.js', async original => ({
  ...await original(), addOrUpdateVideoCard: vi.fn(), removeVideoCard: vi.fn(),
  createPlaceholderCard: vi.fn(), showToast: vi.fn()
}));
import { VoiceManager } from '../js/voice.js';
import { MockMediaStream, MockMediaStreamTrack } from '../tests/mocks/webrtc.mock.js';
import { createSessionContext } from '../js/core/session-context.js';
import { bindSessionMessageHandlers } from '../js/protocol/session-handlers.js';
import { handleHostCoopMessage } from '../js/coop/host.js';
import { handleMouseDown, handleControlVisibilityChange } from '../js/coop/input.js';
import { createViewerSession } from '../js/session/viewer-session.js';
import { createStreamerSession } from '../js/session/streamer-session.js';
import { addOrUpdateVideoCard, removeVideoCard } from '../js/ui.js';
import { NativeMediaPlugin } from '../js/plugins/native-media-plugin.js';
import { addOrUpdateVideoCard as createRealCard, removeVideoCard as removeRealCard } from '../js/ui/video-cards.js';
import { dispatchHostInputReset } from '../js/coop/transport.js';

const disposals = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
  document.body.innerHTML = ''; localStorage.clear();
});
const stream = () => new MockMediaStream([new MockMediaStreamTrack('audio')]);
function voice() {
  const manager = new VoiceManager({ audioContextProvider: () => null });
  manager.initLocalVAD = vi.fn();
  disposals.push(() => manager.leaveVoice());
  return manager;
}
function session() {
  const value = createSessionContext();
  disposals.push(() => value.disposeAsync());
  return value;
}
function connection(peer) {
  const conn = new EventEmitter();
  Object.assign(conn, { peer, open: true, send: vi.fn(), close: vi.fn(() => conn.emit('close')) });
  return conn;
}
class PeerMock extends EventEmitter {
  constructor() { super(); this.id = 'local'; queueMicrotask(() => this.emit('open', this.id)); }
  connect(id) { return connection(id); }
  destroy() { this.destroyed = true; }
}
async function viewer() {
  vi.stubGlobal('Peer', PeerMock);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  const runtime = createViewerSession(), context = session();
  runtime.viewerState.session = context;
  await runtime.initViewerPeer(context);
  return { runtime, context };
}

it('A01: a microphone switch completing after leave discards late capture', async () => {
  const manager = voice(); await manager.joinVoice({ peerId: 'local', customStream: stream() });
  let finish; navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const pending = manager.setAudioInputDevice('other-mic'); manager.leaveVoice();
  const replacement = stream(); finish(replacement); await pending;
  expect(manager.isInVoice).toBe(false);
  expect(manager.localStream).toBeNull();
  expect(replacement.getAudioTracks()[0].readyState).toBe('ended');
});

it('A02: switching a processed microphone stops old raw capture and rebuilds gain', async () => {
  const manager = voice(), raw = stream(), processed = stream(), replacement = stream();
  let outputs = 0;
  const freshProcessed = stream();
  const source = { connect: vi.fn(), disconnect: vi.fn() }, gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  manager.audioContextProvider = () => ({ createMediaStreamSource: () => source, createGain: () => gain, createMediaStreamDestination: () => ({ stream: outputs++ ? freshProcessed : processed }) });
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValueOnce(raw).mockResolvedValueOnce(replacement);
  await manager.joinVoice({ peerId: 'local' });
  await manager.setAudioInputDevice('other-mic');
  expect(raw.getAudioTracks()[0].readyState).toBe('ended');
  expect(processed.getAudioTracks()[0].readyState).toBe('ended');
  expect(manager.rawLocalStream).toBe(replacement);
  expect(manager.processedStream).toBe(freshProcessed);
  expect(manager.localStream).toBe(freshProcessed);
  expect(source.disconnect).toHaveBeenCalled();
});

it('A03: current voice calls replace their sender after microphone switch', async () => {
  const manager = voice(), context = session(), old = stream(), replacement = stream();
  await manager.joinVoice({ peerId: 'local', customStream: old });
  const sender = { track: old.getAudioTracks()[0], replaceTrack: vi.fn() }, call = connection('remote');
  call.metadata = {}; call.answer = vi.fn(); call.peerConnection = { getSenders: () => [sender] };
  const handlers = bindSessionMessageHandlers(context, { role: 'room', voiceManager: manager });
  handlers.answerVoiceCall(call);
  navigator.mediaDevices.getUserMedia = vi.fn(async () => replacement);
  await manager.setAudioInputDevice('other-mic');
  expect(sender.track.readyState).toBe('ended');
  await vi.waitFor(() => expect(sender.replaceTrack).toHaveBeenCalledWith(replacement.getAudioTracks()[0]));
  expect(manager.listeners.audioInputTrackChange.size).toBe(1);
  await context.disposeAsync();
  expect(manager.listeners.audioInputTrackChange.size).toBe(0);
});

it('A04: room co-op approvals are routed to the player handler', () => {
  const context = session(), controller = { handleHostCoopMessage: vi.fn(), handleViewerCoopMessage: vi.fn() };
  bindSessionMessageHandlers(context, { role: 'room', coopController: controller });
  const result = context.dispatcher.dispatch({ type: 'COOP_RESPONSE', approved: true, slot: 2 }, connection('host'));
  expect(result.handled).toBe(true);
  expect(controller.handleHostCoopMessage).not.toHaveBeenCalled();
  expect(controller.handleViewerCoopMessage).toHaveBeenCalledWith(expect.objectContaining({ approved: true }), 'host', null, expect.anything());
});

it('A05: peer A cannot spoof the muted state of participant B', () => {
  const context = session(), manager = voice();
  manager.participants.set('victim', { peerId: 'victim', isMuted: false });
  bindSessionMessageHandlers(context, { role: 'room', voiceManager: manager });
  expect(context.dispatcher.dispatch({ type: 'VOICE_STATE_UPDATE', peerId: 'victim', isMuted: true }, connection('attacker')).handled).toBe(true);
  expect(manager.participants.get('victim').isMuted).toBe(false);
});

it('A06: visibility reset includes slot and is applied for player slot 2', () => {
  const conn = connection('host');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  handleControlVisibilityChange({ isPlayer2: true, activeDataConn: conn, myAssignedSlot: 2 });
  const reset = conn.send.mock.calls[0][0]; expect(reset.slot).toBe(2);
  const effect = vi.fn();
  handleHostCoopMessage({ coopSlots: new Map([[2, { peerId: 'player' }]]), maxCoopPlayers: 3, dispatchHostInputReset: effect }, 'player', reset, conn);
  expect(effect).toHaveBeenCalledWith({ slot: 2, unplugVirtualGamepads: false });
});

it('A06b: slot 1 reset is restricted to the player slot', () => {
  const effect = vi.fn();
  handleHostCoopMessage({ coopSlots: new Map([[1, { peerId: 'player' }], [2, { peerId: 'other' }]]), maxCoopPlayers: 3, dispatchHostInputReset: effect }, 'player', { type: 'INPUT_RESET', slot: 1 }, connection('host'));
  expect(effect).toHaveBeenCalledWith({ slot: 1 });
});

it('A07: mouse down blocks input when host mouse capability is disabled', () => {
  const conn = connection('host');
  handleMouseDown({ isPlayer2: true, activeDataConn: conn, activeHostCapabilities: { mouse: false }, myAssignedSlot: 1 }, { button: 0 });
  expect(conn.send).not.toHaveBeenCalled();
  conn.send.mockClear();
  handleMouseDown({ isPlayer2: true, activeDataConn: conn, activeHostCapabilities: { mouse: true }, myAssignedSlot: 1 }, { button: 0 });
  expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'INPUT_MOUSE', action: 'down' }));
});

it('A08: closing an old viewer data connection preserves its replacement', async () => {
  const { runtime, context } = await viewer();
  await runtime.connectToStreamer('host', null, context); const old = runtime.viewerState.activeConn;
  await runtime.connectToStreamer('host', null, context); const current = runtime.viewerState.activeConn;
  expect(runtime.watchingHosts.get('host').conn).toBe(current);
  old.emit('close');
  expect(current.open).toBe(true);
  expect(runtime.watchingHosts.get('host').conn).toBe(current);
  expect(removeVideoCard).not.toHaveBeenCalled();
});

it('A09: old viewer media close preserves the current video and replay source', async () => {
  const { runtime, context } = await viewer();
  await runtime.connectToStreamer('host', null, context);
  const old = connection('host'), current = connection('host');
  old.answer = vi.fn(); current.answer = vi.fn();
  runtime.viewerState.peer.emit('call', old); runtime.viewerState.peer.emit('call', current);
  current.emit('stream', stream());
  const stopped = vi.fn(); context.eventBus.on('stream:stopped', stopped);
  removeVideoCard.mockClear(); old.emit('close');
  expect(runtime.watchingHosts.get('host').call).toBe(current);
  expect(removeVideoCard).not.toHaveBeenCalled();
  expect(stopped).not.toHaveBeenCalled();
});

it('A09b: a stale stream event cannot overwrite the current viewer media', async () => {
  const { runtime, context } = await viewer();
  await runtime.connectToStreamer('host', null, context);
  const old = connection('host'), current = connection('host'); old.answer = vi.fn(); current.answer = vi.fn();
  runtime.viewerState.peer.emit('call', old); runtime.viewerState.peer.emit('call', current);
  const latest = stream(), stale = stream(); current.emit('stream', latest); old.emit('stream', stale);
  expect(runtime.viewerState.remoteStream).toBe(latest);
});

it('A10: closing an old streamer connection preserves the authenticated replacement', async () => {
  vi.stubGlobal('Peer', PeerMock); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  const runtime = createStreamerSession(), context = session(); runtime.streamerState.session = context;
  runtime.setStreamerPin('1234');
  await runtime.initStreamerPeer(null, context);
  const old = connection('viewer'), current = connection('viewer');
  runtime.streamerState.peer.emit('connection', old); old.emit('open');
  runtime.streamerState.peer.emit('connection', current); current.emit('open');
  runtime.streamerState.admissionGate.authenticate('viewer');
  const media = { close: vi.fn() }; runtime.streamerState.activeCalls.set('viewer', media);
  expect(runtime.streamerState.admissionGate.isAuthenticated('viewer')).toBe(true);
  old.emit('close');
  expect(current.open).toBe(true);
  expect(runtime.connectedViewers.get('viewer')).toBe(current);
  expect(runtime.streamerState.admissionGate.isAuthenticated('viewer')).toBe(true);
  expect(media.close).not.toHaveBeenCalled();
});

it('A11: a native remote video card receives a co-op action', async () => {
  const context = session(), plugin = new NativeMediaPlugin({ session: context, getProvider: () => null, isAuthorized: () => true, onCoop: vi.fn() });
  context.pluginManager.register(plugin); context.pluginManager.initAll();
  await plugin.receive({ sessionId: 'capture', negotiationId: 'generation' }, connection('host'));
  plugin.receivers.get('host').pc.ontrack({ track: new MockMediaStreamTrack('video') });
  expect(addOrUpdateVideoCard.mock.calls.at(-1)[0].onCoopClick).toBe(plugin.onCoop);
  addOrUpdateVideoCard.mock.calls.at(-1)[0].onCoopClick('host');
  expect(plugin.onCoop).toHaveBeenCalledWith('host');
});

it('A12: viewer video cards receive a per-source clip callback', async () => {
  const { runtime, context } = await viewer(); await runtime.connectToStreamer('host', null, context);
  const call = connection('host'); call.answer = vi.fn(); runtime.viewerState.peer.emit('call', call); call.emit('stream', stream());
  expect(addOrUpdateVideoCard).toHaveBeenLastCalledWith(expect.objectContaining({ peerId: 'host', onCoopClick: expect.any(Function) }));
  expect(addOrUpdateVideoCard.mock.calls.at(-1)[0].onClipClick).toBeTypeOf('function');
});

function realCardFixture(options) {
  document.body.innerHTML = '<div id="video-grid"></div><button id="clip-btn"></button>';
  const listeners = [], add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, ...rest) => {
    if (type.includes('fullscreenchange')) listeners.push([type, fn]);
    return add(type, fn, ...rest);
  });
  disposals.push(() => listeners.forEach(([type, fn]) => document.removeEventListener(type, fn)));
  const ports = new Proxy({ isValidPeerId: () => true, resolveCardDisplayStream: value => value }, { get: (object, key) => object[key] || (() => {}) });
  return { ...createRealCard(ports, options), ports, listeners };
}

it('A01: only the newest microphone switch may install its stream', async () => {
  const manager = voice(); await manager.joinVoice({ peerId: 'local', customStream: stream() });
  const pending = [];
  navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  const first = manager.setAudioInputDevice('first'), second = manager.setAudioInputDevice('second');
  const stale = stream(), latest = stream();
  pending[1](latest); await second; pending[0](stale); await first;
  expect(manager.localStream).toBe(latest);
  expect(stale.getAudioTracks()[0].readyState).toBe('ended');
  expect(latest.getAudioTracks()[0].readyState).toBe('live');
});

it('A05: authenticated host relay preserves another viewer voice identity', () => {
  const context = session(), manager = voice(); manager.participants.set('other', { peerId: 'other', isMuted: false });
  bindSessionMessageHandlers(context, { role: 'viewer', voiceManager: manager, isAuthorizedPeer: id => id === 'host', isTrustedChatRelayPeer: id => id === 'host' });
  context.dispatcher.dispatch({ type: 'VOICE_STATE_UPDATE', peerId: 'other', isMuted: true, relayedBy: 'host' }, connection('host'));
  expect(manager.participants.get('other').isMuted).toBe(true);
});

it('A06: reset of one slot keeps the other controller and held keys intact', () => {
  const keyup = vi.fn(); window.addEventListener('keyup', keyup);
  disposals.push(() => window.removeEventListener('keyup', keyup));
  const ports = { isTauriEnvironment: () => true, unplugVirtualGamepad: vi.fn(async () => {}), unplugAllVirtualGamepads: vi.fn(async () => {}),
    coopSlots: new Map([[1, {}], [2, {}]]), slotPressedKeys: new Map([[1, new Set(['KeyW', 'KeyA'])], [2, new Set(['KeyW'])]]), pressedBrowserKeys: new Set(['KeyW', 'KeyA']) };
  dispatchHostInputReset(ports, { slot: 1 });
  expect(ports.unplugVirtualGamepad).toHaveBeenCalledWith(1);
  expect(ports.unplugAllVirtualGamepads).not.toHaveBeenCalled();
  expect(ports.slotPressedKeys.has(2)).toBe(true);
  expect(ports.pressedBrowserKeys.has('KeyW')).toBe(true);
  expect(keyup).toHaveBeenCalledTimes(1); expect(keyup.mock.calls[0][0].code).toBe('KeyA');
});

it('A13: fullscreen includes the canvas and video rather than promoting the bare video', async () => {
  const { card, video } = realCardFixture({ peerId: 'host', stream: stream(), isLocal: false });
  const stage = document.getElementById('video-grid'), canvas = document.createElement('canvas'); canvas.id = 'ping-canvas'; stage.appendChild(canvas);
  stage.requestFullscreen = vi.fn(async () => {});
  const videoRequest = vi.spyOn(video, 'requestFullscreen');
  Array.from(card.querySelectorAll('.card-controls button')).find(button => button.innerText === '⛶ Tela Cheia').click();
  await Promise.resolve();
  expect(stage.requestFullscreen).toHaveBeenCalledOnce(); expect(videoRequest).not.toHaveBeenCalled();
  expect(stage.contains(canvas)).toBe(true); expect(card.classList.contains('fullscreen-card')).toBe(true);
  removeRealCard(new Proxy({}, { get: () => () => {} }), 'host');
  expect(stage.classList.contains('tactical-fullscreen-stage')).toBe(false);
});

it('A16: disposing the owning session removes its card and global listeners', async () => {
  const context = session(), { card } = realCardFixture({ session: context, peerId: 'host', stream: stream(), isLocal: false });
  const remove = vi.spyOn(document, 'removeEventListener');
  await context.disposeAsync();
  expect(card.isConnected).toBe(false); expect(card.querySelector('video').srcObject).toBeNull();
  expect(remove).toHaveBeenCalledWith('fullscreenchange', expect.any(Function));
});

it('A12b: clicking Clipar on host B exports host B despite host A being globally selected', () => {
  const exported = vi.fn();
  const { card } = realCardFixture({ peerId: 'host-b', stream: stream(), isLocal: false, onClipClick: exported });
  const selectedSourceId = 'host-a';
  document.getElementById('clip-btn').onclick = () => exported(selectedSourceId);
  card.querySelector('.card-btn-clip').click();
  expect(exported).toHaveBeenCalledWith('host-b', expect.anything());
});

it('A16: removing a video card removes document fullscreen listeners and clears its media', () => {
  const { card, ports, listeners } = realCardFixture({ peerId: 'host', stream: stream(), isLocal: false });
  const button = Array.from(card.querySelectorAll('button')).find(item => item.innerText === '⛶ Tela Cheia');
  const remove = vi.spyOn(document, 'removeEventListener');
  removeRealCard(ports, 'host');
  expect(card.isConnected).toBe(false); expect(listeners).toHaveLength(2);
  expect(remove).toHaveBeenCalledWith('fullscreenchange', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('webkitfullscreenchange', expect.any(Function));
  expect(card.querySelector('video').srcObject).toBeNull();
  button.innerText = 'detached marker'; document.dispatchEvent(new Event('fullscreenchange'));
  expect(button.innerText).toBe('detached marker');
});
