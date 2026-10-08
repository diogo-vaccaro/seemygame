import { afterEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { MultitrackRecorder } from '../js/room/multitrack-recorder.js';
import { PollManager, pollManager } from '../js/room/poll-manager.js';
import { AnnotateManager } from '../js/room/annotate.js';
import { StreamerModeController } from '../js/room/streamer-mode.js';
import { RoomToolsController } from '../js/room/room-tools.js';
import { PipController } from '../js/room/pip-controller.js';
import { createParticipantVolumePopover } from '../js/ui/participant-controls.js';
import { calculateCrc32 } from '../js/utils/zip-builder.js';

const resources = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ''; localStorage.clear();
});
const stream = () => ({ getTracks: () => [{ readyState: 'live' }], getVideoTracks: () => [], getAudioTracks: () => [{}] });
class Recorder {
  static isTypeSupported = () => true;
  constructor(media, options = {}) { this.media = media; this.state = 'inactive'; this.mimeType = options.mimeType; }
  start() { if (this.media.fail) throw new Error('Device failed'); this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new NodeBlob(['real track bytes']) }); this.onstop?.(); }
}

it('includes every media track in the ZIP with exact content, CRC and manifest', async () => {
  vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('Blob', NodeBlob);
  const recorder = new MultitrackRecorder(); resources.push(() => recorder.dispose());
  await recorder.startRecording({ master: stream(), 'participant-é': stream() });
  const result = await recorder.exportZip({ autoDownload: false });
  const bytes = new Uint8Array(await result.blob.arrayBuffer()), view = new DataView(bytes.buffer), entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true), length = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + length));
    const start = offset + 30 + length + extra, content = bytes.slice(start, start + size);
    expect(calculateCrc32(content)).toBe(view.getUint32(offset + 14, true));
    entries.set(name, new TextDecoder().decode(content)); offset = start + size;
  }
  expect(entries.get('tracks/master.webm')).toBe('real track bytes');
  expect(entries.get('tracks/participant-é.webm')).toBe('real track bytes');
  expect(JSON.parse(entries.get('manifest.json')).tracks).toHaveLength(2);
});

it('rolls back every started recorder if a later track fails', async () => {
  const instances = [];
  vi.stubGlobal('MediaRecorder', class extends Recorder { constructor(...args) { super(...args); instances.push(this); } });
  const recorder = new MultitrackRecorder(); resources.push(() => recorder.dispose());
  await expect(recorder.startRecording({ first: stream(), broken: { ...stream(), fail: true } })).rejects.toThrow('Device failed');
  expect(instances.every(instance => instance.state === 'inactive')).toBe(true);
  expect(recorder.isRecording).toBe(false); expect(recorder.tickInterval).toBeNull();
});

it('rejects ended tracks and nested participant maps instead of pretending to record them', async () => {
  const recorder = new MultitrackRecorder();
  await expect(recorder.startRecording({ participants: { a: stream() }, ended: { getTracks: () => [{ readyState: 'ended' }] } })).rejects.toThrow();
});

function pollFixture() {
  vi.useFakeTimers();
  const creator = new PollManager(), viewer = new PollManager();
  resources.push(() => creator.dispose(), () => viewer.dispose());
  const poll = creator.createPoll({ question: 'Next map?', options: ['A', 'B'], creatorId: 'alice', durationSeconds: 5 });
  viewer.handleRemoteMessage({ type: 'POLL_CREATE', poll: creator._serializePoll(poll) }, 'alice');
  return { creator, viewer, poll };
}
it('uses the actual transport sender for votes and restricts remote closing to the creator', () => {
  const { viewer, poll } = pollFixture();
  viewer.handleRemoteMessage({ type: 'POLL_VOTE', pollId: poll.id, voterId: 'alice', optionIndex: 1 }, 'bob');
  expect(viewer.currentPoll.options[1].voterIds).toEqual(['bob']);
  viewer.handleRemoteMessage({ type: 'POLL_END', pollId: poll.id }, 'bob');
  expect(viewer.currentPoll.isActive).toBe(true);
  viewer.handleRemoteMessage({ type: 'POLL_END', pollId: poll.id }, 'alice');
  expect(viewer.currentPoll.isActive).toBe(false);
});
it('announces expiry exactly once from the creator, and stops all timers on dispose', () => {
  const { creator, viewer } = pollFixture(), announce = vi.fn(), remoteAnnounce = vi.fn();
  creator.setOnChatAnnounce(announce); viewer.setOnChatAnnounce(remoteAnnounce);
  vi.advanceTimersByTime(5000); creator.endPoll();
  expect(announce).toHaveBeenCalledOnce(); expect(remoteAnnounce).not.toHaveBeenCalled();
  creator.dispose(); viewer.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it('ignores malformed sync without replacing an existing poll or its votes', () => {
  const { viewer, poll } = pollFixture();
  viewer.vote(poll.id, 0, 'bob');
  viewer.handleRemoteMessage({ type: 'POLL_SYNC', poll: { ...poll, options: 'broken' } }, 'alice');
  viewer.handleRemoteMessage({ type: 'POLL_SYNC', poll: { ...poll, options: [{ text: 'A', voterIds: [] }, { text: 'B', voterIds: [] }] } }, 'alice');
  expect(viewer.currentPoll.options[0].voterIds).toEqual(['bob']);
});
it('preserves an active poll when a replacement contains only whitespace options', () => {
  const { creator, poll } = pollFixture();
  expect(() => creator.createPoll({ question: 'invalid', options: [' ', ' '] })).toThrow();
  expect(poll.isActive).toBe(true);
});

function annotateFixture() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ scale: vi.fn(), clearRect: vi.fn() });
  const manager = new AnnotateManager(); manager.redraw = vi.fn(); resources.push(() => manager.detach());
  document.body.innerHTML = '<div class="video-card" id="card-a"><video></video></div><div class="video-card" id="card-b"><video></video></div>';
  return manager;
}
const stroke = id => ({ id, tool: 'pen', width: 4, points: [{ x: .5, y: .5 }] });
it('erases rectangle edges and line interiors without clearing unrelated strokes', () => {
  const manager = annotateFixture(), broadcast = vi.fn(); manager.setBroadcast(broadcast);
  manager.strokes = [
    { ...stroke('rectangle'), tool: 'rect', shapeStart: { x: .1, y: .1 }, shapeEnd: { x: .9, y: .9 }, points: [{ x: .1, y: .1 }] },
    { ...stroke('line'), points: [{ x: .1, y: .4 }, { x: .9, y: .4 }] }, stroke('keep')
  ];
  manager._eraseNear({ x: .5, y: .1 }); manager._eraseNear({ x: .5, y: .4 });
  expect(manager.strokes.map(stroke => stroke.id)).toEqual(['keep']);
  expect(broadcast).toHaveBeenCalledWith({ type: 'ANNOTATE_REMOVE', strokeId: 'rectangle' });
  expect(broadcast).toHaveBeenCalledWith({ type: 'ANNOTATE_REMOVE', strokeId: 'line' });
});
it('routes strokes to the matching stream, deduplicates them and leaves remote overlays noninteractive', () => {
  const manager = annotateFixture();
  manager.handleRemoteMessage({ type: 'ANNOTATE_DRAW', streamId: 'b', stroke: stroke('s') });
  manager.handleRemoteMessage({ type: 'ANNOTATE_DRAW', streamId: 'b', stroke: stroke('s') });
  expect(manager.container.id).toBe('card-b'); expect(manager.strokes).toHaveLength(1);
  expect(manager.canvas.style.pointerEvents).toBe('none');
  manager.attach(document.getElementById('card-a'));
  expect(manager.strokes).toHaveLength(0);
  manager.handleRemoteMessage({ type: 'ANNOTATE_CLEAR', streamId: 'b' });
  manager.attach(document.getElementById('card-b')); expect(manager.strokes).toHaveLength(0);
});
it('rejects malformed remote drawings and cancels an unfinished pointer stroke on detach', () => {
  const manager = annotateFixture(); manager.attach(document.getElementById('card-a'));
  manager.handleRemoteMessage({ type: 'ANNOTATE_DRAW', stroke: { ...stroke('bad'), points: 'malformed' } });
  expect(manager.strokes).toHaveLength(0);
  manager._onPointerDown({ button: 0, clientX: 0, clientY: 0 }); manager.detach();
  expect(manager.isDrawing).toBe(false); expect(manager.currentStroke).toBeNull();
});
it('aligns annotations with displayed video pixels, excluding header and letterboxing', () => {
  const manager = annotateFixture(), card = document.getElementById('card-a'), video = card.querySelector('video');
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  video.getBoundingClientRect = () => ({ left: 0, top: 60, width: 800, height: 400 });
  video.style.objectFit = 'contain'; Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
  manager.attach(card, video);
  expect(manager.canvas.style.height).toBe('400px'); expect(manager.canvas.style.width).toBe('711px');
  expect(manager.canvas.style.top).toBe('60px'); expect(parseFloat(manager.canvas.style.left)).toBeCloseTo(44.444);
});

it('restores dynamically masked input values and keeps room badge masked during updates', async () => {
  document.body.innerHTML = '<span id="room-header-badge">Room A</span><button id="streamer-mode-btn"></button>';
  const controller = new StreamerModeController(); resources.push(() => controller.destroy()); controller.init(); controller.setStreamerMode(true);
  const input = document.createElement('input'); input.dataset.streamerMask = ''; input.value = 'real-code'; document.body.append(input);
  await Promise.resolve(); expect(input.value).toBe('••••••••');
  document.getElementById('room-header-badge').textContent = 'Room B'; await Promise.resolve();
  expect(document.getElementById('room-header-badge').textContent).toContain('Modo Streamer');
  controller.setStreamerMode(false); expect(input.value).toBe('real-code');
  expect(document.getElementById('room-header-badge').textContent).toBe('Room B');
});
it('removes the streamer toggle handler on destroy and avoids duplicate bindings', () => {
  const button = document.createElement('button'), controller = new StreamerModeController(); resources.push(() => controller.destroy());
  controller.init({ toggleBtn: button }); controller.init({ toggleBtn: button }); button.click(); expect(controller.enabled).toBe(true);
  controller.destroy(); button.click(); expect(controller.enabled).toBe(true);
});
it('cleans modal listeners on dispose and requests active polls when opening the modal', () => {
  document.body.innerHTML = '<div id="poll-modal" style="display:none"><form id="poll-create-form"><input id="poll-question-input" value="Q"><input id="poll-opt-1" value="A"><input id="poll-opt-2" value="B"></form></div>';
  const controller = new RoomToolsController(), broadcast = vi.fn(); resources.push(() => controller.dispose());
  controller.bindSession({ broadcast }); controller.bindDOM(); controller.openPollModal();
  expect(broadcast).toHaveBeenCalledWith({ type: 'POLL_SYNC_REQUEST' });
  const create = vi.spyOn(pollManager, 'createPoll'); controller.dispose();
  document.getElementById('poll-create-form').dispatchEvent(new Event('submit', { cancelable: true }));
  expect(create).not.toHaveBeenCalled(); expect(pollManager.listeners.size).toBe(0);
});
it('keeps multiple participant popovers synchronized and removes voice subscriptions on cleanup', () => {
  let volume = 100; const handlers = new Map();
  const voice = { getUserVolume: () => volume, isUserLocallyMuted: () => false,
    on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    off: (event, fn) => handlers.get(event).delete(fn) };
  const wrappers = [createParticipantVolumePopover({ peerId: 'p', voiceManager: voice }), createParticipantVolumePopover({ peerId: 'p', voiceManager: voice })];
  volume = 150; handlers.get('userVolumeChange').forEach(fn => fn({ peerId: 'p' }));
  wrappers.forEach(wrapper => { expect(wrapper.querySelector('input').value).toBe('150'); wrapper.cleanup(); });
  expect(handlers.get('userVolumeChange').size).toBe(0);
});
it('restores the PiP card synchronously and ignores delayed close events from the old window', async () => {
  const controller = new PipController(), pipDocument = document.implementation.createHTMLDocument(), callbacks = [];
  const pipWindow = { document: pipDocument, close: vi.fn(), addEventListener: (event, fn) => callbacks.push(fn) };
  vi.stubGlobal('documentPictureInPicture', undefined);
  Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow: async () => pipWindow } });
  resources.push(() => { delete window.documentPictureInPicture; });
  document.body.innerHTML = '<div id="parent"><div id="card"><video></video></div></div>';
  const card = document.getElementById('card'), video = card.querySelector('video');
  await controller.enterPip(video, card); expect(card.ownerDocument).toBe(pipDocument);
  await controller.exitPip(); expect(card.parentElement.id).toBe('parent');
  controller.activePipVideo = document.createElement('video'); const next = controller.activePipVideo;
  callbacks[0](); expect(controller.activePipVideo).toBe(next);
});

it('falls back to video PiP when Document PiP is refused', async () => {
  const controller = new PipController(), video = document.createElement('video');
  video.requestPictureInPicture = vi.fn().mockResolvedValue({});
  Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow: async () => { throw new Error('Permission refused'); } } });
  resources.push(() => { delete window.documentPictureInPicture; });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await controller.enterPip(video, document.createElement('div'))).toBe(true);
  expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
  expect(controller.entering).toBe(false);
  await controller.exitPip();
});

it('closes a pending Document PiP window if exit occurs before its request resolves', async () => {
  const controller = new PipController(); let resolve;
  const close = vi.fn(), pending = new Promise(done => { resolve = done; });
  Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow: () => pending } });
  resources.push(() => { delete window.documentPictureInPicture; });
  const entered = controller.enterPip(document.createElement('video'), document.createElement('div'));
  await controller.exitPip(); resolve({ close });
  expect(await entered).toBe(false); expect(close).toHaveBeenCalledOnce(); expect(controller.pipWindow).toBeNull();
});
