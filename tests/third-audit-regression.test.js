import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhiteboardManager } from '../js/whiteboard.js';
import { WhiteboardPlugin } from '../js/plugins/whiteboard-plugin.js';
import { MessageDispatcher } from '../js/core/message-dispatcher.js';
import { sendWhiteboardSnapshot } from '../js/whiteboard/transfer.js';
import { DiscordUIController } from '../js/discord-ui.js';
import { VoiceManager } from '../js/voice.js';
import { MockMediaStream, MockMediaStreamTrack } from './mocks/webrtc.mock.js';

const { readImage } = vi.hoisted(() => ({ readImage: vi.fn() }));
vi.mock('../js/whiteboard/shared.js', async importOriginal => ({ ...await importOriginal(), processImageFile: readImage }));
const cleanups = [];
const rect = id => ({ id, type: 'rectangle', startX: 10, startY: 10, endX: 60, endY: 60 });
const image = { id: 'large-image', type: 'image', startX: 0, startY: 0, endX: 100, endY: 100, dataUrl: 'data:image/png;base64,' + 'A'.repeat(90000) };
const board = () => { const m = new WhiteboardManager(); cleanups.push(() => m.dispose()); return m; };
function plugin(m, context = {}) {
  const dispatcher = new MessageDispatcher();
  const p = new WhiteboardPlugin({ manager: m });
  p.init({ dispatcher, ...context }); cleanups.push(() => p.destroy());
  return dispatcher;
}
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Third audit: whiteboard relay', () => {
  it('relays a full history snapshot and an atomic chunked image snapshot only after completion', () => {
    const host = board(), receiver = board();
    const receive = plugin(receiver);
    const broadcast = vi.fn(data => receive.dispatch(data, { peer: 'host' }));
    const dispatch = plugin(host, { isRoomMode: () => false, getViewersCount: () => 2, broadcastDataMessage: broadcast });
    dispatch.dispatch({ type: 'WHITEBOARD_SYNC', elements: [rect('first')] }, { peer: 'writer' });
    expect(receiver.elements).toEqual(host.elements);
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'WHITEBOARD_SYNC' }), 'writer');
    broadcast.mockClear();
    const packets = [];
    sendWhiteboardSnapshot([image, rect('after-image')], data => packets.push(data));
    for (const data of packets.slice(0, -1)) dispatch.dispatch(data, { peer: 'writer' });
    expect(broadcast).not.toHaveBeenCalled();
    expect(host.elements.map(e => e.id)).toEqual(['first']);
    dispatch.dispatch(packets.at(-1), { peer: 'writer' });
    expect(receiver.elements).toEqual([image, rect('after-image')]);
    expect(host.elements).toEqual(receiver.elements);
    expect(broadcast.mock.calls.every(([, excluded]) => excluded === 'writer')).toBe(true);
  });

  it('does not relay invalid snapshots or retransmit a Room mesh snapshot', () => {
    const broadcast = vi.fn(), m = board();
    const dispatch = plugin(m, { isRoomMode: () => true, getViewersCount: () => 2, broadcastDataMessage: broadcast });
    dispatch.dispatch({ type: 'WHITEBOARD_SYNC', elements: [rect('valid')] }, { peer: 'writer' });
    dispatch.dispatch({ type: 'WHITEBOARD_SYNC', elements: [{ id: 'invalid', type: 'formula', latex: '' }] }, { peer: 'writer' });
    expect(m.elements).toEqual([rect('valid')]); expect(broadcast).not.toHaveBeenCalled();
  });

  it('preserves authenticated cursor authors through a host and ignores direct author spoofing', () => {
    const host = board(), viewer = board();
    const downstream = plugin(viewer, { isTrustedWhiteboardRelayPeer: peer => peer === 'host' });
    const dispatch = plugin(host, { isRoomMode: () => false, getPeerId: () => 'host', getViewersCount: () => 2,
      broadcastDataMessage: data => downstream.dispatch(data, { peer: 'host' }) });
    dispatch.dispatch({ type: 'WHITEBOARD_CURSOR', x: .2, y: .3, peerId: 'victim', relayedBy: 'writer' }, { peer: 'writer' });
    downstream.dispatch({ type: 'WHITEBOARD_CURSOR', x: .4, y: .5 }, { peer: 'host' });
    expect([...viewer.remoteCursors.keys()]).toEqual(['writer', 'host']);
    expect(host.remoteCursors.has('victim')).toBe(false);
    downstream.dispatch({ type: 'WHITEBOARD_CURSOR', x: .6, y: .7, peerId: 'victim', relayedBy: 'attacker' }, { peer: 'attacker' });
    expect(viewer.remoteCursors.has('victim')).toBe(false);
    expect(viewer.remoteCursors.has('attacker')).toBe(true);
  });
});

describe('Third audit: cursor projection and image import cancellation', () => {
  it('projects cursor with zoom/pan and hides positions outside the viewport', () => {
    const m = board(); m.zoom = 2; m.panX = 100; m.panY = 50;
    m.remoteCursors.set('remote', { x: .25, y: .25, time: Date.now(), color: '#06b6d4' });
    const moveTo = vi.fn();
    const ctx = new Proxy({ moveTo, measureText: () => ({ width: 40 }) }, { get: (t, k) => k in t ? t[k] : () => {} });
    m.drawRemoteCursors(ctx, 1000, 800);
    expect(moveTo).toHaveBeenNthCalledWith(1, 600, 450);
    moveTo.mockClear(); m.panX = 2000;
    m.drawRemoteCursors(ctx, 1000, 800); expect(moveTo).not.toHaveBeenCalled();
  });

  it.each(['clear', 'setElements', 'dispose'])('%s resolves a pending decode without inserting or broadcasting its late image', async action => {
    const images = [];
    vi.stubGlobal('Image', class { constructor() { this.naturalWidth = 10; this.naturalHeight = 10; images.push(this); } });
    const m = board(), created = vi.fn(); m.onElementCreated = created;
    const pending = m.addImageFromDataUrl('data:image/png;base64,AAA');
    const lateLoad = images[0].onload;
    if (action === 'setElements') m.setElements([rect('replacement')]); else m[action]();
    expect(await pending).toBeNull();
    lateLoad();
    expect(m.elements).toEqual(action === 'setElements' ? [rect('replacement')] : []);
    expect(created).not.toHaveBeenCalled(); expect(m.pendingImageImports.size).toBe(0);
  });

  it('also cancels an import while FileReader/image processing is still pending', async () => {
    const m = board(); let finishFile;
    readImage.mockImplementation(() => new Promise(resolve => { finishFile = resolve; }));
    const insert = vi.spyOn(m, 'addImageFromDataUrl');
    const pending = m.importImageFile({ type: 'image/png' });
    m.clear(); finishFile('data:image/png;base64,AAA');
    expect(await pending).toBeNull(); expect(insert).not.toHaveBeenCalled();
  });
});

describe('Third audit: live UI Push-to-Talk', () => {
  let voice, ui, hidden;
  beforeEach(() => {
    document.body.innerHTML = '<input id="chat-input"><div contenteditable="true"><span id="editable-child"></span></div>';
    hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    voice = new VoiceManager();
    voice.rawLocalStream = voice.localStream = new MockMediaStream([new MockMediaStreamTrack('audio')]);
    voice.isInVoice = true; voice.setVoiceMode('ptt');
    ui = new DiscordUIController({ voiceManager: voice }); ui.init();
    cleanups.push(() => { ui.destroy(); voice.leaveVoice(); });
  });
  const key = (type, code, target = window) => target.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  it('accepts both shortcuts and stays active until the last held key is released', () => {
    key('keydown', 'ControlRight'); key('keydown', 'CapsLock'); key('keyup', 'ControlRight');
    expect(voice.isPttActive).toBe(true); expect(voice.localStream.getAudioTracks()[0].enabled).toBe(true);
    key('keyup', 'CapsLock'); expect(voice.isMuted).toBe(true); expect(voice.isPttActive).toBe(false);
  });
  it.each(['blur', 'pagehide', 'hidden', 'destroy'])('releases the microphone on %s', action => {
    key('keydown', 'ControlRight');
    if (action === 'hidden') { hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); }
    else if (action === 'destroy') ui.destroy(); else window.dispatchEvent(new Event(action));
    expect(voice.isPttActive).toBe(false); expect(voice.localStream.getAudioTracks()[0].enabled).toBe(false);
    if (action === 'destroy') { key('keydown', 'ControlRight'); expect(voice.isPttActive).toBe(false); }
  });
  it('ignores editable fields and never unmutes a deafened participant', () => {
    key('keydown', 'ControlRight', document.getElementById('chat-input'));
    key('keydown', 'CapsLock', document.getElementById('editable-child'));
    expect(voice.isPttActive).toBe(false);
    key('keydown', 'ControlRight'); key('keydown', 'CapsLock'); voice.setDeafened(true); key('keyup', 'ControlRight');
    expect(voice.isMuted).toBe(true); expect(voice.isPttActive).toBe(false);
  });
  it('switching away and back to PTT does not retain a previous held-key state', () => {
    key('keydown', 'ControlRight'); voice.setVoiceMode('vad'); voice.setVoiceMode('ptt');
    expect(voice.isPttActive).toBe(false); expect(voice.isMuted).toBe(true);
  });
});
