import { afterEach, expect, it, vi } from 'vitest';
import { CaptureManager, CAPTURE_STATES, NativeCaptureProvider } from '../js/capture.js';
import { BasePlugin } from '../js/plugins/base-plugin.js';
import { createSessionContext } from '../js/core/session-context.js';
import { NativeReplayRecorder } from '../js/clipping/native-recorder.js';
import { ClipRecorderRegistry } from '../js/clipping/registry.js';
import { ClippingPlugin } from '../js/plugins/clipping-plugin.js';
import { MockMediaStream, MockMediaStreamTrack } from './mocks/webrtc.mock.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__TAURI_INTERNALS__; });

it('two concurrent stops cannot clear the state of a replacement capture', async () => {
  const stops = [deferred(), deferred()];
  const provider = { start: vi.fn(async () => ({ stream: new MockMediaStream([new MockMediaStreamTrack()]), session: { id: Math.random() } })),
    stop: vi.fn().mockImplementationOnce(() => stops[0].promise).mockImplementationOnce(() => stops[1].promise) };
  const manager = new CaptureManager({ browserProvider: provider });
  await manager.start();
  const first = manager.stop(), second = manager.stop();
  stops[0].resolve(); await first;
  await manager.start(); const current = manager.session;
  stops[1].resolve(); await second;
  expect(manager.state).toBe(CAPTURE_STATES.LIVE);
  expect(manager.session).toBe(current);
});

it('a native provider stop cannot wipe a stream started while bridge cleanup is pending', async () => {
  const closing = deferred();
  const bridge = { createStream: vi.fn(async () => new MockMediaStream([new MockMediaStreamTrack()])), closeStream: vi.fn(() => closing.promise) };
  let index = 0;
  window.__TAURI_INTERNALS__ = { invoke: vi.fn(async command => command === 'start_native_capture' ? { sessionId: `capture-${++index}` } : {}) };
  const provider = new NativeCaptureProvider({ mediaBridge: bridge });
  await provider.start({ sourceId: 'first' });
  const pending = provider.stop();
  const current = await provider.start({ sourceId: 'second' });
  closing.resolve(); await pending;
  expect(provider.session).toBe(current.session);
  expect(provider.stream).toBe(current.stream);
  await provider.stop();
});

it('native reconfiguration cannot publish settings over a replaced session', async () => {
  const reconfigured = deferred();
  window.__TAURI_INTERNALS__ = { invoke: vi.fn(command => command === 'reconfigure_native_capture' ? reconfigured.promise : Promise.resolve({})) };
  const provider = new NativeCaptureProvider();
  provider.session = { sessionId: 'old' };
  const pending = provider.reconfigure({ fps: 30 });
  provider.session = { sessionId: 'new' }; provider.requestedSettings = { fps: 60 };
  reconfigured.resolve({ sessionId: 'old', fps: 30 }); await pending;
  expect(provider.session.sessionId).toBe('new');
  expect(provider.requestedSettings.fps).toBe(60);
});

it('native cleanup uses the bridge installed after the provider was constructed', async () => {
  const provider = new NativeCaptureProvider({ mediaBridge: null });
  window.__TAURI_INTERNALS__ = { invoke: vi.fn(async command => command === 'start_native_capture' ? { sessionId: 'late-bridge' } : {}) };
  const bridge = { createStream: vi.fn(async () => new MockMediaStream([new MockMediaStreamTrack()])), closeStream: vi.fn(async () => {}) };
  vi.stubGlobal('__SEEMYGAME_NATIVE_CAPTURE__', bridge);
  await provider.start({ sourceId: 'source' }); await provider.stop();
  expect(bridge.closeStream).toHaveBeenCalledWith('late-bridge');
});

it('plugin cleanups are drained before session disposal reports completion', async () => {
  const release = deferred(); let complete = false;
  class Plugin extends BasePlugin { setupListeners() { this.registerCleanup(() => release.promise); } }
  const session = createSessionContext();
  session.pluginManager.register(new Plugin('async-cleanup')); session.pluginManager.initAll();
  const pending = session.disposeAsync().then(() => { complete = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(complete).toBe(false);
  release.resolve(); await pending;
});

it('base plugin cleanup can recursively destroy without repeating cleanup', async () => {
  const plugin = new BasePlugin('recursive'); plugin.init();
  const cleanup = vi.fn(() => plugin.destroy()); plugin.registerCleanup(cleanup);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await plugin.destroy();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('a failed obsolete native replay start cannot poison a successful retry', async () => {
  const first = deferred(); let starts = 0;
  window.__TAURI_INTERNALS__ = { invoke: vi.fn(command => command === 'start_native_replay' && ++starts === 1 ? first.promise : Promise.resolve()) };
  const recorder = new NativeReplayRecorder({ sessionId: 'replay-retry' });
  recorder.start(); const obsolete = recorder.ready;
  await Promise.resolve();
  recorder.start(); first.reject(new Error('obsolete startup'));
  await obsolete; await recorder.ready;
  expect(recorder.isRecording).toBe(true);
  expect(recorder.lastError).toBe(null);
  await recorder.stop();
});

it('clipping shutdown waits for the native recorder owned by its registry', async () => {
  const release = deferred(); let disposed = false;
  window.__TAURI_INTERNALS__ = { invoke: vi.fn(command => command === 'stop_native_replay' ? release.promise : Promise.resolve()) };
  const registry = new ClipRecorderRegistry({ getNativeContext: () => ({ sessionId: 'shutdown-replay' }) });
  const session = createSessionContext();
  session.pluginManager.register(new ClippingPlugin({ recorder: registry })); session.pluginManager.initAll();
  registry.start(new MockMediaStream(), 'remote'); await registry.getRecorder().ready;
  const pending = session.disposeAsync().then(() => { disposed = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(disposed).toBe(false);
  release.resolve(); await pending;
});

it('replay registry can initialize when the localStorage property itself is blocked', () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('storage blocked'); });
  expect(() => new ClipRecorderRegistry()).not.toThrow();
});

it('native replay startup failure reaches the registry UI and allows retrying the same source', async () => {
  let starts = 0;
  window.__TAURI_INTERNALS__ = { invoke: vi.fn(command => command === 'start_native_replay' && ++starts === 1
    ? Promise.reject(new Error('native tap unavailable')) : Promise.resolve()) };
  const registry = new ClipRecorderRegistry({ getNativeContext: () => ({ sessionId: 'registry-retry' }) });
  registry.onChange = vi.fn();
  const stream = new MockMediaStream();
  registry.start(stream, 'remote'); await registry.getRecorder().ready;
  expect(registry.lastError?.message).toBe('native tap unavailable');
  expect(registry.onChange).toHaveBeenCalledTimes(2);
  expect(registry.start(stream, 'remote')).toBe(true);
  await registry.getRecorder().ready;
  expect(registry.isRecordingFor('remote')).toBe(true);
  expect(registry.lastError).toBe(null);
  await registry.stop();
});
