/**
 * Abstração de captura do SeeMyGame.
 *
 * O provedor browser devolve um MediaStream vindo do seletor do navegador.
 * O provedor native aceita somente um sourceId opaco e espera que o worker
 * nativo entregue um MediaStream WebRTC através da ponte desktop. Não há
 * transporte de quadros por IPC neste módulo.
 */

import {
  getNativeCaptureState,
  getNativeCaptureCapabilities,
  startNativeCapture,
  reconfigureNativeCapture,
  stopNativeCapture,
  setNativeCaptureAudioMode,
  listenNativeCapture
} from './desktop.js';
import './native-webrtc.js';
import { getVideoCapabilities, selectCodec } from './streaming/codecs.js';

export const CAPTURE_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  LIVE: 'live',
  STOPPING: 'stopping',
  ERROR: 'error'
});

export class CaptureCancelledError extends Error {
  constructor() {
    super('Captura cancelada durante a inicialização');
    this.name = 'CaptureCancelledError';
  }
}

function isMediaStream(value) {
  return value && typeof value.getTracks === 'function' && typeof value.getVideoTracks === 'function';
}

function stopTracks(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  stream.getTracks().forEach((track) => {
    try { track.stop(); } catch (error) { /* idempotente */ }
  });
}

function normalizeCaptureError(error, fallback = 'Falha desconhecida na captura nativa') {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error);
  if (error?.message) return new Error(String(error.message));
  if (typeof error?.error === 'string' && error.error.trim()) return new Error(error.error);
  if (error?.error) {
    try { return new Error(JSON.stringify(error.error)); } catch (serializationError) { /* fallback */ }
  }
  if (error != null) {
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return new Error(serialized);
    } catch (serializationError) { /* fallback */ }
  }
  return new Error(fallback);
}

export class BrowserCaptureProvider {
  constructor({ mediaDevices = globalThis.navigator?.mediaDevices } = {}) {
    this.mediaDevices = mediaDevices;
    this.stream = null;
    this.session = null;
    this._operationId = 0;
  }

  async start({ constraints } = {}) {
    if (!this.mediaDevices?.getDisplayMedia) {
      throw new Error('Captura de tela não é suportada neste navegador');
    }
    const operationId = ++this._operationId;
    const stream = await this.mediaDevices.getDisplayMedia(constraints || { video: true, audio: false });
    const session = {
      provider: 'browser',
      sessionId: `browser_${Date.now()}`,
      sourceType: 'browser-picker'
    };
    // A provider instance may have overlapping start calls while the user
    // cancels one picker and immediately opens another. Only the latest
    // operation is allowed to become the provider's active stream.
    if (operationId === this._operationId) {
      this.stream = stream;
      this.session = session;
    }
    return { stream, session, operationId };
  }

  async stop() {
    ++this._operationId;
    const stream = this.stream;
    stopTracks(stream);
    this.stream = null;
    this.session = null;
    return { state: CAPTURE_STATES.IDLE };
  }

  async disposeResult(result = {}) {
    // Dispose only the stream returned by an obsolete start. Calling the
    // provider-wide stop() here could tear down a newer capture session.
    if (result.stream) stopTracks(result.stream);
  }

  async setAudioMode() {
    // A trilha do navegador é trocada pelo app, que também precisa manter a
    // compatibilidade com o MediaConnection legado.
    return null;
  }
}

export class NativeCaptureProvider {
  constructor({ mediaBridge = globalThis.__SEEMYGAME_NATIVE_CAPTURE__ } = {}) {
    this.mediaBridge = mediaBridge;
    this.stream = null;
    this.session = null;
    this.unsubscribe = null;
    this._operationId = 0;
  }

  async start({ sourceId, audioMode = 'none', videoCodec = null, h264Encoder = null, captureBackend = null, captureApi = null, showCursor = undefined, sourceType = null, source = null, width, height, fps, bitrateKbps, excludeApp = null } = {}) {
    if (!sourceId) throw new Error('Selecione uma janela ou monitor antes de iniciar');

    const operationId = ++this._operationId;
    const browserCaps = getVideoCapabilities();
    const capabilities = browserCaps.receive.length ? await getNativeCaptureCapabilities() : null;
    if (browserCaps.receive.length && capabilities?.supports_h264 !== undefined) {
      const choice = selectCodec(videoCodec || 'auto', browserCaps, 'receive', capabilities);
      if (!choice.selected) throw new Error(choice.reason);
      this.codecSelection = choice;
      videoCodec = choice.selected;
    } else if (videoCodec === 'auto') videoCodec = 'h264';
    this.requestedSettings = { width, height, fps, bitrateKbps, videoCodec, captureBackend, captureApi, h264Encoder };
    let nativeState;
    try {
      nativeState = await startNativeCapture({ sourceId, audioMode, videoCodec, h264Encoder, captureBackend, captureApi, showCursor, width, height, fps, bitrateKbps, excludeApp });
    } catch (error) {
      throw normalizeCaptureError(error, 'Falha ao iniciar o worker nativo');
    }
    const bridge = this.mediaBridge || globalThis.__SEEMYGAME_NATIVE_CAPTURE__;
    let stream = null;

    if (bridge && typeof bridge.createStream === 'function') {
      try {
        stream = await bridge.createStream({
          ...nativeState,
          sourceId,
          sourceType,
          source
        });
      } catch (error) {
        await stopNativeCapture(nativeState?.sessionId || null).catch(() => {});
        throw normalizeCaptureError(error, 'Falha ao negociar a ponte WebRTC nativa');
      }
    }

    if (!isMediaStream(stream)) {
      await stopNativeCapture(nativeState?.sessionId || null).catch(() => {});
      throw new Error('O backend nativo não entregou um MediaStream WebRTC');
    }

    const session = {
      ...nativeState,
      provider: 'native',
      sourceId,
      sourceType,
      source
    };
    if (operationId !== this._operationId) {
      await this.disposeResult({ stream, session });
      throw new CaptureCancelledError();
    }

    this.stream = stream;
    this.session = session;
    return { stream, session, operationId };
  }

  async stop() {
    ++this._operationId;
    const sessionId = this.session?.sessionId || null;
    const stream = this.stream;
    if (sessionId && typeof this.mediaBridge?.closeStream === 'function') {
      await this.mediaBridge.closeStream(sessionId).catch(() => {});
    }
    stopTracks(stream);
    this.stream = null;
    this.session = null;
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch (error) { /* idempotente */ }
      this.unsubscribe = null;
    }
    return stopNativeCapture(sessionId).catch(() => ({ state: CAPTURE_STATES.IDLE }));
  }

  async disposeResult(result = {}) {
    stopTracks(result.stream);
    const sessionId = result.session?.sessionId || null;
    if (sessionId && typeof this.mediaBridge?.closeStream === 'function') {
      await this.mediaBridge.closeStream(sessionId).catch(() => {});
    }
    if (sessionId) await stopNativeCapture(sessionId).catch(() => {});
  }

  async setAudioMode(audioMode) {
    if (!this.session?.sessionId) return null;
    return setNativeCaptureAudioMode(this.session.sessionId, audioMode);
  }

  async reconfigure(options = {}) {
    if (!this.session?.sessionId) return null;
    const res = await reconfigureNativeCapture({
      sessionId: this.session.sessionId,
      ...options
    });
    if (res) {
      this.session = { ...this.session, ...res };
      this.requestedSettings = { ...this.requestedSettings, ...options };
    }
    return res;
  }

  async getState() {
    return getNativeCaptureState();
  }
}

export class CaptureManager {
  constructor({ onStateChange = () => {}, browserProvider, nativeProvider } = {}) {
    this.onStateChange = onStateChange;
    this.browserProvider = browserProvider || new BrowserCaptureProvider();
    this.nativeProvider = nativeProvider || new NativeCaptureProvider();
    this.provider = null;
    this.session = null;
    this.state = CAPTURE_STATES.IDLE;
    this.transitionId = 0;
  }

  setState(state, details = {}) {
    this.state = state;
    this.onStateChange({ state, ...details });
  }

  async disposeProviderResult(providerInstance, result) {
    if (typeof providerInstance?.disposeResult === 'function') {
      await providerInstance.disposeResult(result);
      return;
    }
    stopTracks(result?.stream);
  }

  async start({ provider = 'browser', ...options } = {}) {
    if (this.state === CAPTURE_STATES.STARTING || this.state === CAPTURE_STATES.STOPPING) {
      throw new Error('Já existe uma transição de captura em andamento');
    }
    if (this.session) await this.stop();

    this.setState(CAPTURE_STATES.STARTING, { provider });
    const transitionId = ++this.transitionId;
    const providerInstance = provider === 'native' ? this.nativeProvider : this.browserProvider;
    this.provider = providerInstance;
    try {
      const result = await providerInstance.start(options);
      if (transitionId !== this.transitionId || this.provider !== providerInstance || this.state === CAPTURE_STATES.STOPPING) {
        await this.disposeProviderResult(providerInstance, result);
        throw new CaptureCancelledError();
      }
      if (!isMediaStream(result?.stream)) {
        throw new Error('O provedor de captura não entregou um MediaStream');
      }
      this.session = result.session || { provider };
      this.setState(CAPTURE_STATES.LIVE, { provider, session: this.session });
      return result;
    } catch (error) {
      const isStale = transitionId !== this.transitionId || this.provider !== providerInstance;
      if (isStale || error?.name === 'CaptureCancelledError') {
        // A stale start must never clear the state installed by a newer
        // start using the same provider instance.
        if (!isStale && this.provider === providerInstance) {
          this.provider = null;
          this.session = null;
          this.setState(CAPTURE_STATES.IDLE);
        }
      } else {
        this.session = null;
        this.setState(CAPTURE_STATES.ERROR, { provider, error });
      }
      throw error;
    }
  }

  async stop() {
    if (!this.provider && !this.session) {
      this.setState(CAPTURE_STATES.IDLE);
      return { state: CAPTURE_STATES.IDLE };
    }
    const providerInstance = this.provider;
    ++this.transitionId;
    this.setState(CAPTURE_STATES.STOPPING, { session: this.session });
    try {
      const result = await providerInstance?.stop?.();
      return result || { state: CAPTURE_STATES.IDLE };
    } finally {
      if (this.provider === providerInstance) {
        this.provider = null;
        this.session = null;
        this.setState(CAPTURE_STATES.IDLE);
      }
    }
  }

  async setAudioMode(audioMode) {
    return this.provider?.setAudioMode?.(audioMode) || null;
  }

  async syncNativeEvents() {
    if (!this.nativeProvider || this.nativeProvider.unsubscribe) return;
    this.nativeProvider.unsubscribe = await listenNativeCapture((state) => {
      if (this.provider !== this.nativeProvider) return;
      const mappedState = state?.state || CAPTURE_STATES.ERROR;
      this.setState(mappedState, { session: state });
    });
  }
}
