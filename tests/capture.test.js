import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockMediaStream, MockMediaStreamTrack } from './mocks/webrtc.mock.js';
import {
  BrowserCaptureProvider,
  NativeCaptureProvider,
  CaptureManager,
  CAPTURE_STATES
} from '../js/capture.js';

describe('Abstração de captura browser/native', () => {
  const originalTauri = window.__TAURI_INTERNALS__;

  beforeEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    if (originalTauri) window.__TAURI_INTERNALS__ = originalTauri;
    else delete window.__TAURI_INTERNALS__;
  });

  it('usa getDisplayMedia apenas no provedor browser', async () => {
    const getDisplayMedia = vi.fn().mockResolvedValue(new MockMediaStream([
      new MockMediaStreamTrack('video')
    ]));
    const provider = new BrowserCaptureProvider({ mediaDevices: { getDisplayMedia } });

    const result = await provider.start({ constraints: { video: true, audio: false } });

    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(result.session.provider).toBe('browser');
    await provider.stop();
    expect(result.stream.getTracks()[0].readyState).toBe('ended');
  });

  it('o provedor nativo envia somente sourceId e exige stream da ponte', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ sessionId: 'native-1', state: 'starting' })
      .mockResolvedValueOnce({ state: 'idle' });
    window.__TAURI_INTERNALS__ = { invoke };
    const bridge = {
      createStream: vi.fn().mockResolvedValue(new MockMediaStream([
        new MockMediaStreamTrack('video')
      ])),
      closeStream: vi.fn().mockResolvedValue(undefined)
    };
    const provider = new NativeCaptureProvider({ mediaBridge: bridge });

    const result = await provider.start({ sourceId: 'capture_1_window_0', sourceType: 'window' });

    expect(invoke).toHaveBeenNthCalledWith(1, 'start_native_capture', {
      sourceId: 'capture_1_window_0',
      audioMode: 'none'
    });
    expect(bridge.createStream).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'capture_1_window_0',
      sourceType: 'window'
    }));
    expect(result.session.provider).toBe('native');
    await provider.stop();
    expect(bridge.closeStream).toHaveBeenCalledWith('native-1');
    expect(invoke).toHaveBeenNthCalledWith(2, 'stop_native_capture', { sessionId: 'native-1' });
  });

  it('encaminha DXGI separado de D3D12 e normaliza o método ativo retornado pelo Rust', async () => {
    const invoke = vi.fn().mockResolvedValue({ session_id: 'native-dxgi', state: 'live', capture_api: 'dxgi', capture_backend: 'd3d12' });
    window.__TAURI_INTERNALS__ = { invoke };
    const provider = new NativeCaptureProvider({ mediaBridge: {
      createStream: vi.fn().mockResolvedValue(new MockMediaStream([new MockMediaStreamTrack('video')]))
    } });
    const result = await provider.start({ sourceId: 'capture_1_monitor_0', sourceType: 'monitor', captureApi: 'dxgi', captureBackend: 'd3d12' });
    expect(invoke).toHaveBeenCalledWith('start_native_capture', expect.objectContaining({ captureApi: 'dxgi', captureBackend: 'd3d12' }));
    expect(result.session).toMatchObject({ captureApi: 'dxgi', captureBackend: 'd3d12' });
    await provider.reconfigure({ bitrateKbps: 5000, captureApi: 'dxgi' });
    expect(invoke).toHaveBeenCalledWith('reconfigure_native_capture', expect.objectContaining({ captureApi: 'dxgi', bitrateKbps: 5000 }));
    await provider.stop();
  });

  it('encerra o worker quando a negociação WebRTC falha', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ sessionId: 'native-failed', state: 'starting' })
      .mockResolvedValueOnce({ state: 'idle' });
    window.__TAURI_INTERNALS__ = { invoke };
    const provider = new NativeCaptureProvider({
      mediaBridge: { createStream: vi.fn().mockRejectedValue(new Error('SDP inválido')) }
    });

    await expect(provider.start({ sourceId: 'capture_1_window_0' })).rejects.toThrow('SDP inválido');
    expect(invoke).toHaveBeenNthCalledWith(2, 'stop_native_capture', { sessionId: 'native-failed' });
  });

  it('encaminha a seleção explícita de HEVC ao worker nativo', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ sessionId: 'native-hevc', state: 'live', videoCodec: 'hevc' })
      .mockResolvedValueOnce({ state: 'idle' });
    window.__TAURI_INTERNALS__ = { invoke };
    const provider = new NativeCaptureProvider({
      mediaBridge: {
        createStream: vi.fn().mockResolvedValue(new MockMediaStream([
          new MockMediaStreamTrack('video')
        ]))
      }
    });

    await provider.start({ sourceId: 'capture_1_monitor_0', videoCodec: 'hevc' });

    expect(invoke).toHaveBeenNthCalledWith(1, 'start_native_capture', {
      sourceId: 'capture_1_monitor_0',
      audioMode: 'none',
      videoCodec: 'hevc'
    });
    await provider.stop();
  });

  it('encaminha excludeApp ao worker nativo via NativeCaptureProvider', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ sessionId: 'native-exclude', state: 'live', exclude_app: 'discord' })
      .mockResolvedValueOnce({ state: 'idle' });
    window.__TAURI_INTERNALS__ = { invoke };
    const provider = new NativeCaptureProvider({
      mediaBridge: {
        createStream: vi.fn().mockResolvedValue(new MockMediaStream([
          new MockMediaStreamTrack('video')
        ]))
      }
    });

    await provider.start({
      sourceId: 'capture_1_monitor_0',
      audioMode: 'system',
      excludeApp: 'discord'
    });

    expect(invoke).toHaveBeenNthCalledWith(1, 'start_native_capture', {
      sourceId: 'capture_1_monitor_0',
      audioMode: 'system',
      excludeApp: 'discord'
    });
    await provider.stop();
  });

  it('mantém estados explícitos e não faz fallback implícito do native para browser', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('backend indisponível'));
    window.__TAURI_INTERNALS__ = { invoke };
    const getDisplayMedia = vi.fn();
    const manager = new CaptureManager({
      browserProvider: new BrowserCaptureProvider({ mediaDevices: { getDisplayMedia } }),
      nativeProvider: new NativeCaptureProvider({ mediaBridge: null })
    });

    await expect(manager.start({ provider: 'native', sourceId: 'capture_2_monitor_0' }))
      .rejects.toThrow('backend indisponível');
    expect(manager.state).toBe(CAPTURE_STATES.ERROR);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('não promove uma captura para LIVE se stop ocorrer durante o start pendente', async () => {
    let resolveStart;
    const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
    const provider = {
      start: vi.fn(() => new Promise((resolve) => { resolveStart = () => resolve({ stream, session: { provider: 'browser' } }); })),
      stop: vi.fn(async () => {
        stream.getTracks().forEach((track) => track.stop());
        return { state: CAPTURE_STATES.IDLE };
      })
    };
    const manager = new CaptureManager({ browserProvider: provider });

    const startPromise = manager.start({ provider: 'browser' });
    await manager.stop();
    resolveStart();

    await expect(startPromise).rejects.toMatchObject({ name: 'CaptureCancelledError' });
    expect(manager.state).toBe(CAPTURE_STATES.IDLE);
    expect(provider.stop).toHaveBeenCalled();
    expect(stream.getTracks()[0].readyState).toBe('ended');
  });
});
