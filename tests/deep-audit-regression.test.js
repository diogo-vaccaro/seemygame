// Regression coverage for the second audit: B01-B20.
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('../js/ui.js', async original => ({ ...await original(), addOrUpdateVideoCard: vi.fn(), removeVideoCard: vi.fn(), createPlaceholderCard: vi.fn(), showToast: vi.fn() }));
vi.mock('../js/config.js', async original => ({ ...await original(), fetchIceServersFromApi: vi.fn(async () => {}) }));
vi.mock('../js/discord-ui.js', () => ({ DiscordUIController: class { init() {} destroy() {} updateRoomPresence() {} syncStageView() {} } }));
import { VoiceManager } from '../js/voice.js';
import { MockMediaStream, MockMediaStreamTrack } from '../tests/mocks/webrtc.mock.js';
import { createSessionContext } from '../js/core/session-context.js';
import { createViewerSession } from '../js/session/viewer-session.js';
import { createRoomSession } from '../js/session/room-session.js';
import { getRoomMasterPeerId, RoomManager } from '../js/room.js';
import { grantCoopPlayer, handleHostCoopMessage } from '../js/coop/host.js';
import { handleKeyDown, handleKeyUp, pollGamepads, attachPlayer2InputListeners, detachPlayer2InputListeners, handleMouseDown, handleMouseUp, handleMouseMove } from '../js/coop/input.js';
import { initCompanionAgentConnection, dispatchHostGamepadInput } from '../js/coop/transport.js';
import { WhiteboardManager } from '../js/whiteboard.js';
import { bindWhiteboardUI } from '../js/whiteboard-ui.js';
import { createWhiteboardTransfers } from '../js/whiteboard/transfer.js';
import { TacticalPingManager } from '../js/ping.js';
const disposals = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
  document.body.innerHTML = ''; localStorage.clear();
});
const stream = () => new MockMediaStream([new MockMediaStreamTrack('audio')]);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function voice() {
  const value = new VoiceManager({ audioContextProvider: () => null }); value.initLocalVAD = vi.fn();
  disposals.push(() => value.leaveVoice()); return value;
}
function context() { const value = createSessionContext(); disposals.push(() => value.disposeAsync()); return value; }
function connection(peer) {
  const conn = new EventEmitter(); Object.assign(conn, { peer, open: true, send: vi.fn(), close: vi.fn(() => { conn.open = false; conn.emit('close'); }) }); return conn;
}
class Peer extends EventEmitter {
  static instances = [];
  constructor() { super(); this.id = `local-${Peer.instances.length}`; this.destroyed = false; this.connections = []; Peer.instances.push(this); }
  connect(id) { const conn = connection(id); this.connections.push(conn); return conn; }
  destroy() { this.destroyed = true; }
}
function inputPorts() {
  const ports = { isPlayer2: true, myAssignedSlot: 1, activeDataConn: connection('host'), activeHostCapabilities: { keyboard: true, mouse: true, gamepad: true },
    applyButtonMapping: x => x, applyRadialDeadzone: (x, y) => ({ x, y }), pollGamepads: vi.fn(), dispatchHostInputReset: vi.fn(),
    handleKeyDown: e => handleKeyDown(ports, e), handleKeyUp: e => handleKeyUp(ports, e), handleMouseDown: e => handleMouseDown(ports, e), handleMouseUp: e => handleMouseUp(ports, e), handleMouseMove: e => handleMouseMove(ports, e),
    focusControlWrapper: vi.fn(), handleControlVisibilityChange: vi.fn(), detachPlayer2InputListeners: () => detachPlayer2InputListeners(ports) };
  const card = document.createElement('div'); card.innerHTML = '<div class="video-wrapper" tabindex="0"><video></video></div><input />'; document.body.append(card); ports.attachedCard = card;
  return ports;
}

it('B01: stale failed join preserves a newer successful voice join without fallback capture', async () => {
  const manager = voice(), first = deferred(), second = deferred();
  navigator.mediaDevices.getUserMedia = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockRejectedValue(new Error('denied'));
  const stale = manager.joinVoice({ peerId: 'local' }).catch(error => error);
  const newer = manager.joinVoice({ peerId: 'local' }); second.resolve(stream()); await newer;
  expect(manager.isInVoice).toBe(true);
  first.reject(new Error('old request failed')); await stale;
  expect(manager.isInVoice).toBe(true); expect(manager.localStream.getAudioTracks()[0].readyState).toBe('live');
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
});

it('B02: custom voice stream uses the processed gain output', async () => {
  const manager = voice(), raw = stream(), processed = stream();
  manager.setupLocalAudioProcessing = vi.fn(() => { manager.processedStream = processed; return processed; });
  const returned = await manager.joinVoice({ peerId: 'local', customStream: raw });
  expect(returned).toBe(processed); expect(manager.localStream).toBe(processed);
});

it('B03: concurrent viewer connect shares a single ready peer', async () => {
  Peer.instances = []; vi.stubGlobal('Peer', Peer);
  const runtime = createViewerSession(), session = context(); runtime.viewerState.session = session;
  const a = runtime.connectToStreamer('host-a', null, session), b = runtime.connectToStreamer('host-b', null, session);
  await vi.waitFor(() => expect(Peer.instances).toHaveLength(1));
  expect(Peer.instances[0].connections).toHaveLength(0);
  Peer.instances[0].emit('open', Peer.instances[0].id); await Promise.all([a, b]);
  expect(Peer.instances).toHaveLength(1); expect(Peer.instances[0].connections.map(conn => conn.peer)).toEqual(['host-a', 'host-b']);
});

it('B03: a disposed initialization does not block the next viewer session', async () => {
  Peer.instances = []; vi.stubGlobal('Peer', Peer);
  const runtime = createViewerSession(), first = context(); runtime.viewerState.session = first;
  const stale = runtime.initViewerPeer(first).catch(error => error);
  await vi.waitFor(() => expect(Peer.instances).toHaveLength(1));
  await first.disposeAsync();
  const second = context(); runtime.viewerState.session = second;
  const next = runtime.connectToStreamer('host-new', null, second);
  await vi.waitFor(() => expect(Peer.instances).toHaveLength(2));
  Peer.instances[0].emit('open', 'old'); Peer.instances[1].emit('open', 'new');
  await next; expect((await stale).name).toBe('AbortError');
  expect(Peer.instances[0].connections).toHaveLength(0);
  expect(Peer.instances[1].connections.map(conn => conn.peer)).toEqual(['host-new']);
});

it('B04: host A PIN prompt sends its PIN only to host A, even if B accepts first', async () => {
  Peer.instances = []; vi.stubGlobal('Peer', Peer);
  const runtime = createViewerSession(), session = context(); runtime.viewerState.session = session;
  const pending = runtime.initViewerPeer(session); await vi.waitFor(() => expect(Peer.instances).toHaveLength(1)); Peer.instances[0].emit('open', 'local'); await pending;
  await runtime.connectToStreamer('host-a', null, session); await runtime.connectToStreamer('host-b', null, session);
  const a = runtime.watchingHosts.get('host-a').conn, b = runtime.watchingHosts.get('host-b').conn;
  a.emit('data', { type: 'PIN_REQUIRED' }); expect(runtime.viewerState.targetHostId).toBe('host-a');
  b.emit('data', { type: 'PIN_ACCEPTED' });
  expect(runtime.submitViewerPin('1234')).toBe(true); expect(b.send).not.toHaveBeenCalled();
  expect(a.send).toHaveBeenCalledWith(expect.objectContaining({ pin: '1234' }));
});

it('B05: rejected duplicate room connection cannot remove the authenticated member', async () => {
  const session = context(), runtime = createRoomSession(), peer = new Peer();
  runtime.roomState.session = session; runtime.roomState.peer = peer;
  await runtime.setupRoomSession(getRoomMasterPeerId('general'), session);
  const rm = runtime.roomState.roomManager; disposals.push(() => rm.leave());
  const current = connection('friend'); peer.emit('connection', current); current.emit('data', { type: 'ROOM_JOIN_REQUEST', roomId: 'general', name: 'Friend' });
  expect(rm.isPeerAuthorized('friend')).toBe(true); expect(rm.meshConnections.get('friend')).toBe(current);
  const duplicate = connection('friend'); peer.emit('connection', duplicate);
  expect(rm.meshConnections.get('friend')).toBe(current); duplicate.close();
  expect(duplicate.open).toBe(false); expect(current.open).toBe(true); expect(rm.isPeerAuthorized('friend')).toBe(true); expect(rm.members.has('friend')).toBe(true);
});

it('B06: leaving while microphone permission is pending never announces a late join', async () => {
  const session = context(), manager = voice(), runtime = createRoomSession({ voiceManager: manager });
  const rm = { myPeerId: 'local', userName: 'Local', isMaster: false, voiceChannels: new Map([['voice-1', {}]]), setLocalVoiceChannel: vi.fn(), meshConnections: new Map(), broadcast: vi.fn() }, pending = deferred();
  navigator.mediaDevices.getUserMedia = vi.fn(() => pending.promise);
  const join = runtime.joinRoomVoice(rm, session); runtime.leaveRoomVoice(rm, session); pending.resolve(stream()); await join;
  expect(manager.isInVoice).toBe(false);
  expect(rm.broadcast.mock.calls.map(([message]) => message.action)).toEqual(['LEAVE', 'LEAVE']);
  expect(rm.setLocalVoiceChannel).toHaveBeenLastCalledWith(null);
});

it('B07: key and mouse releases outside the selected card reach the host once', () => {
  const ports = inputPorts(); attachPlayer2InputListeners(ports, ports.attachedCard);
  disposals.push(() => detachPlayer2InputListeners(ports));
  const wrapper = ports.attachedCard.querySelector('.video-wrapper'), input = ports.attachedCard.querySelector('input');
  wrapper.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
  wrapper.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  wrapper.dispatchEvent(new FocusEvent('blur'));
  expect(ports.activeDataConn.send.mock.calls.map(([message]) => message.action)).toEqual(['down', 'down', 'up', 'up']);
});

it('B08: unplugged physical gamepad sends a neutral state to its slot', () => {
  const ports = inputPorts(); vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  const pad = { connected: true, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0, value: i === 0 ? 1 : 0 })), axes: [1, 0, 0, 0] };
  navigator.getGamepads = vi.fn().mockReturnValueOnce([pad]).mockReturnValueOnce([null]);
  pollGamepads(ports); pollGamepads(ports);
  expect(ports.activeDataConn.send).toHaveBeenCalledTimes(2); expect(ports.lastGamepadState).toBeNull();
  expect(ports.activeDataConn.send).toHaveBeenLastCalledWith(expect.objectContaining({ slot: 1, state: { buttons: new Array(17).fill(false), triggers: [0, 0], axes: [0, 0, 0, 0] } }));
});

it('B09: stale native grant cannot unplug its replacement', async () => {
  const first = deferred(), second = deferred();
  const ports = { isCoopEnabled: true, nextCoopSlotGeneration: 0, coopSlots: new Map(), getNextAvailableSlot: slot => slot, isTauriEnvironment: () => true,
    plugVirtualGamepad: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), unplugVirtualGamepad: vi.fn(async () => {}),
    companionCapabilities: {}, showToast: vi.fn(), broadcastSlotsUpdate: vi.fn(), notifyStateChange: vi.fn() };
  const a = grantCoopPlayer(ports, 'friend-a', connection('friend-a'), 'A', 1); ports.coopSlots.delete(1);
  const bconn = connection('friend-b'), b = grantCoopPlayer(ports, 'friend-b', bconn, 'B', 1);
  second.resolve(); await b; expect(bconn.send).toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
  first.resolve(); await a; expect(ports.coopSlots.get(1).peerId).toBe('friend-b'); expect(ports.unplugVirtualGamepad).not.toHaveBeenCalled();
});

it('B10: repeated companion setup before open shares one socket', () => {
  const sockets = []; vi.stubGlobal('WebSocket', class { constructor() { sockets.push(this); } });
  const ports = { isCompanionConnected: false, companionSocket: null, showToast: vi.fn() };
  initCompanionAgentConnection(ports, 'token'); initCompanionAgentConnection(ports, 'token');
  expect(sockets).toHaveLength(1); expect(ports.companionSocket).toBe(sockets[0]);
});

it('B11: mouse coordinates exclude the video letterbox bars', () => {
  const ports = inputPorts(), video = ports.attachedCard.querySelector('video');
  Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } }); video.style.objectFit = 'contain';
  video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
  handleMouseMove(ports, { clientX: 500, clientY: 218.75 }); // Top edge of a 16:9 picture centered in a square.
  expect(ports.activeDataConn.send).toHaveBeenCalledWith(expect.objectContaining({ x: 0.5, y: 0 }));
});

it('B16: whiteboard undo synchronizes a large image snapshot within room limits', () => {
  document.body.innerHTML = '<div id="whiteboard-modal"><canvas id="whiteboard-canvas"></canvas><button id="wb-undo-btn"></button></div>';
  const local = new WhiteboardManager(), remote = new WhiteboardManager(), rm = new RoomManager({ roomId: 'general' }); local.render = vi.fn();
  local.addElement({ id: 'image', type: 'image', startX: 0, startY: 0, endX: 100, endY: 100, dataUrl: 'data:image/png;base64,' + 'A'.repeat(300000) }, false);
  local.addElement({ id: 'rect', type: 'rectangle', startX: 0, startY: 0, endX: 100, endY: 100, color: '#ffffff' }, false);
  remote.setElements([...local.elements]); rm.myPeerId = 'local'; rm.authenticatedPeers.add('remote');
  const conn = connection('remote'); rm.meshConnections.set('remote', conn);
  const transfers = createWhiteboardTransfers(remote), source = { peer: 'local' }; disposals.push(() => transfers.dispose());
  conn.send = vi.fn(data => {
    if (data.type === 'WHITEBOARD_SYNC') transfers.receiveFull(data, source);
    if (data.type === 'WHITEBOARD_SYNC_BATCH') transfers.receiveBatch(data, source);
    if (data.type === 'WHITEBOARD_ELEMENT_CHUNK') transfers.receiveChunk(data, source);
    if (data.type === 'WHITEBOARD_SYNC_END') transfers.endSnapshot(data, source);
  });
  const broadcast = vi.fn(data => rm.broadcast(data));
  const ui = bindWhiteboardUI(local, { broadcast }); disposals.push(() => ui.destroy());
  document.getElementById('wb-undo-btn').click();
  expect(local.elements).toHaveLength(1); expect(remote.elements).toEqual(local.elements);
  expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'WHITEBOARD_SYNC_END' }));
  expect(broadcast.mock.results.every(result => result.value === true)).toBe(true);
  expect(conn.send.mock.calls.every(([data]) => new TextEncoder().encode(JSON.stringify(data)).length < 256 * 1024)).toBe(true);
});

it('B17: a long pencil stroke is preserved in bounded connected segments', () => {
  const manager = new WhiteboardManager(), canvas = document.createElement('canvas'); canvas.getContext = vi.fn(() => null); document.body.append(canvas);
  manager.render = vi.fn(); manager.onElementCreated = vi.fn(); manager.setCanvas(canvas); disposals.push(() => manager.dispose());
  canvas.onmousedown(new MouseEvent('mousedown', { clientX: 0, clientY: 0, button: 0 }));
  for (let i = 1; i <= 2001; i++) canvas.onmousemove(new MouseEvent('mousemove', { clientX: i * 10, clientY: i * 10 }));
  expect(manager.currentElement.points.length).toBeLessThanOrEqual(2000);
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  expect(manager.currentElement).toBeNull(); expect(manager.elements).toHaveLength(2);
  expect(manager.elements.every(element => element.points.length <= 2000)).toBe(true);
  expect(manager.elements[0].points.at(-1)).toEqual(manager.elements[1].points[0]);
  expect(manager.onElementCreated).toHaveBeenCalledTimes(2);
});

it('B18: deleting images releases the decoded cache while keeping undo history', () => {
  const manager = new WhiteboardManager(); manager.render = vi.fn(); disposals.push(() => manager.dispose());
  const ctx = new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) });
  for (let i = 0; i < 60; i++) {
    const element = { id: 'image-' + i, type: 'image', startX: 0, startY: 0, endX: 100, endY: 100, dataUrl: 'data:image/png;base64,AAAA' + i };
    manager.addElement(element, false); manager.renderImage(ctx, element); manager.removeElement(element.id, false);
  }
  manager.clear(false); expect(manager.elements).toHaveLength(0); expect(manager.imageCache.size).toBe(0); expect(manager.undo()).toBe(true);
});

it('B19: a gamepad-only slot rejects keyboard and mouse commands', () => {
  const player = connection('friend'), ports = { coopSlots: new Map([[2, { peerId: 'friend' }]]), maxCoopPlayers: 3, partyModeEnabled: false,
    dispatchHostKeyboardInput: vi.fn(), dispatchHostMouseInput: vi.fn() };
  handleHostCoopMessage(ports, 'friend', { type: 'INPUT_KEY', slot: 2, action: 'down', code: 'KeyW' }, player);
  handleHostCoopMessage(ports, 'friend', { type: 'INPUT_MOUSE', slot: 2, action: 'down', button: 0 }, player);
  expect(ports.dispatchHostKeyboardInput).not.toHaveBeenCalled(); expect(ports.dispatchHostMouseInput).not.toHaveBeenCalled();
  const receiver = inputPorts(); receiver.activeHostCapabilities.keyboard = false;
  handleKeyDown(receiver, new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
  expect(receiver.activeDataConn.send).not.toHaveBeenCalled();
});

it('B20: native Party Mode preserves slot zero', () => {
  const ports = { isTauriEnvironment: () => true, updateVirtualGamepad: vi.fn(async () => {}) };
  dispatchHostGamepadInput(ports, { slot: 0, state: { buttons: [true], axes: [1, 0, 0, 0] } });
  expect(ports.updateVirtualGamepad).toHaveBeenCalledWith(0, expect.objectContaining({ buttons: [true] }));
});

it('B12: projection follows the target source after layout changes and hides unavailable sources', () => {
  const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 1000;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
  const manager = new TacticalPingManager(); manager.canvas = canvas;
  let rect = { left: 500, top: 200, width: 400, height: 300 };
  manager.sourceRectProvider = source => source === 'source-a' ? rect : null;
  expect(manager.projectPoint({ sourceId: 'source-a', x: .5, y: .5 })).toEqual({ x: 700, y: 350 });
  rect = { left: 0, top: 0, width: 1000, height: 1000 };
  expect(manager.projectPoint({ sourceId: 'source-a', x: .5, y: .5 })).toEqual({ x: 500, y: 500 });
  expect(manager.projectPoint({ sourceId: 'missing', x: .5, y: .5 })).toBeNull();
});
