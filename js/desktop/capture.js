import { isDesktopApp } from './ipc.js';
import { invokeDesktopCommand } from './ipc.js';
/** capture: commands receive explicit compatibility ports; no page initialization. */
export function normalizeCaptureSource(source = {}) {
    const sourceId = source.sourceId || source.source_id || source.id || '';
    const sourceType = source.sourceType || source.source_type || (source.monitorId || source.monitor_id ? 'monitor' : 'window');
    return {
        ...source,
        id: sourceId,
        sourceId,
        sourceType,
        processName: source.processName || source.process_name || '',
        processId: source.processId ?? source.process_id ?? null,
        monitorId: source.monitorId || source.monitor_id || null,
        width: Number(source.width) || 0,
        height: Number(source.height) || 0,
        left: Number(source.left) || 0,
        top: Number(source.top) || 0,
        dpi: Number(source.dpi) || 96,
        isMinimized: Boolean(source.isMinimized ?? source.is_minimized),
        supportsAudio: Boolean(source.supportsAudio ?? source.supports_audio)
    };
}

export function normalizeNativeCaptureState(state = {}) {
    return {
        ...state,
        state: state.state || 'idle',
        sessionId: state.sessionId || state.session_id || null,
        sourceId: state.sourceId || state.source_id || null,
        sourceType: state.sourceType || state.source_type || null,
        audioMode: state.audioMode || state.audio_mode || null,
        width: state.width == null ? null : Number(state.width),
        height: state.height == null ? null : Number(state.height),
        dpi: state.dpi == null ? null : Number(state.dpi),
        videoCodec: state.videoCodec || state.video_codec || null,
        h264Encoder: state.h264Encoder || state.h264_encoder || null,
        captureBackend: state.captureBackend || state.capture_backend || null,
        captureApi: state.captureApi || state.capture_api || null,
        captureFallbackReason: state.captureFallbackReason || state.capture_fallback_reason || null,
        videoRtpPort: state.videoRtpPort == null && state.video_rtp_port == null
            ? null
            : Number(state.videoRtpPort ?? state.video_rtp_port),
        audioRtpPort: state.audioRtpPort == null && state.audio_rtp_port == null
            ? null
            : Number(state.audioRtpPort ?? state.audio_rtp_port),
        excludeApp: state.excludeApp || state.exclude_app || null,
        excludePid: state.excludePid ?? state.exclude_pid ?? null,
        error: state.error || null
    };
}

export function requireSourceId(sourceId) {
    if (typeof sourceId !== 'string' || sourceId.trim().length === 0 || sourceId.length > 256) {
        throw new Error('sourceId de captura inválido');
    }
    return sourceId.trim();
}

export async function getCapturableWindows() {
    if (!isDesktopApp()) return [];
    try {
        const windows = await invokeDesktopCommand('list_capturable_windows');
        return Array.isArray(windows) ? windows.map(normalizeCaptureSource) : [];
    } catch (err) {
        console.warn('[Desktop] Falha ao obter janelas capturáveis:', err);
        return [];
    }
}

export async function getCapturableSources() {
    if (!isDesktopApp()) return [];
    try {
        const sources = await invokeDesktopCommand('list_capture_sources');
        return Array.isArray(sources) ? sources.map(normalizeCaptureSource) : [];
    } catch (err) {
        console.warn('[Desktop] Falha ao obter fontes de captura:', err);
        return [];
    }
}

export async function getNativeCaptureCapabilities() {
    if (!isDesktopApp()) return { provider: 'browser', available: true };
    try {
        return await invokeDesktopCommand('get_native_capture_capabilities');
    } catch (err) {
        console.warn('[Desktop] Falha ao consultar capacidades de captura nativa:', err);
        return { provider: 'native', available: false, reason: err?.message || 'Capacidades indisponíveis' };
    }
}

export async function getNativeCaptureState() {
    if (!isDesktopApp()) return { state: 'idle' };
    return normalizeNativeCaptureState(await invokeDesktopCommand('get_native_capture_state'));
}

export async function getAudioExclusionCandidates() {
    if (!isDesktopApp()) return [];
    try {
        const candidates = await invokeDesktopCommand('list_audio_exclusion_candidates', {}, { omitArgs: true });
        return Array.isArray(candidates) ? candidates.map(c => ({
            id: c.id,
            label: c.label,
            processName: c.processName || c.process_name || '',
            processId: c.processId ?? c.process_id ?? null,
            isRunning: Boolean(c.isRunning ?? c.is_running)
        })) : [];
    } catch (err) {
        console.warn('[Desktop] Falha ao listar candidatos a exclusão de áudio:', err);
        return [];
    }
}

export async function startNativeCapture({ sourceId, audioMode = 'none', videoCodec = null, h264Encoder = null, captureBackend = null, captureApi = null, showCursor = undefined, width, height, fps, bitrateKbps, excludeApp } = {}) {
    if (!isDesktopApp()) throw new Error('Captura nativa só está disponível no app desktop');
    const args = {
        sourceId: requireSourceId(sourceId),
        audioMode: String(audioMode || 'none')
    };
    if (showCursor !== undefined) args.showCursor = Boolean(showCursor);
    if (videoCodec) args.videoCodec = String(videoCodec);
    if (h264Encoder) args.h264Encoder = String(h264Encoder);
    if (captureBackend) args.captureBackend = String(captureBackend);
    if (captureApi) args.captureApi = String(captureApi);
    if (width != null) args.width = Number(width);
    if (height != null) args.height = Number(height);
    if (fps != null) args.fps = Number(fps);
    if (bitrateKbps != null) args.bitrateKbps = Number(bitrateKbps);
    if (excludeApp !== undefined && excludeApp !== null) args.excludeApp = String(excludeApp);
    const state = await invokeDesktopCommand('start_native_capture', args);
    return normalizeNativeCaptureState(state);
}

export async function reconfigureNativeCapture(options = {}) {
    if (!isDesktopApp()) return null;
    const { sessionId, audioMode, videoCodec, h264Encoder, captureBackend, captureApi, showCursor, width, height, fps, bitrateKbps, excludeApp } = options;
    if (!sessionId) throw new Error('Sessão de captura nativa inválida para reconfiguração');
    const args = { sessionId };
    if (audioMode !== undefined) args.audioMode = String(audioMode);
    if (videoCodec !== undefined) args.videoCodec = String(videoCodec);
    if (h264Encoder !== undefined) args.h264Encoder = String(h264Encoder);
    if (captureBackend != null) args.captureBackend = String(captureBackend);
    if (captureApi != null) args.captureApi = String(captureApi);
    if (showCursor !== undefined) args.showCursor = Boolean(showCursor);
    if (width != null) args.width = Number(width);
    if (height != null) args.height = Number(height);
    if (fps != null) args.fps = Number(fps);
    if (bitrateKbps != null) args.bitrateKbps = Number(bitrateKbps);
    if (excludeApp !== undefined && excludeApp !== null) args.excludeApp = String(excludeApp);

    const state = await invokeDesktopCommand('reconfigure_native_capture', args);
    return normalizeNativeCaptureState(state);
}

export async function setNativeCaptureAudioMode(sessionId, audioMode) {
    if (!isDesktopApp()) return null;
    if (!sessionId) throw new Error('Sessão de captura nativa inválida');
    const state = await invokeDesktopCommand('set_native_capture_audio_mode', {
        sessionId,
        audioMode: String(audioMode || 'none')
    });
    return normalizeNativeCaptureState(state);
}

export async function stopNativeCapture(sessionId = null) {
    if (!isDesktopApp()) return { state: 'idle' };
    return normalizeNativeCaptureState(await invokeDesktopCommand('stop_native_capture', { sessionId }));
}

export async function addNativeCaptureIceCandidate(sessionId, mlineIndex, candidate) {
    if (!isDesktopApp()) return null;
    if (!sessionId || !Number.isInteger(Number(mlineIndex)) || typeof candidate !== 'string' || candidate.length > 16 * 1024) {
        throw new Error('Candidato ICE nativo inválido');
    }
    return invokeDesktopCommand('add_native_capture_ice_candidate', {
        sessionId,
        mlineIndex: Number(mlineIndex),
        candidate
    });
}

export async function listenNativeCapture(callback) {
    if (!isDesktopApp() || typeof callback !== 'function') return () => {};
    try {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals || typeof internals.transformCallback !== 'function') {
            return () => {};
        }
        const event = 'native-capture-state';
        const callbackId = internals.transformCallback((payload) => callback(normalizeNativeCaptureState(payload?.payload ?? payload)));
        const eventId = await invokeDesktopCommand('plugin:event|listen', {
            event,
            target: { kind: 'Any' },
            handler: callbackId
        });
        return async () => {
            try { internals.unregisterCallback?.(callbackId); } catch (error) { /* idempotente */ }
            try { window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(event, eventId); } catch (error) { /* idempotente */ }
            try { await invokeDesktopCommand('plugin:event|unlisten', { event, eventId }); } catch (error) { /* idempotente */ }
        };
    } catch (err) {
        console.warn('[Desktop] Eventos de captura nativa indisponíveis:', err);
        return () => {};
    }
}

export async function listenNativeCaptureBridge(callback) {
    if (!isDesktopApp() || typeof callback !== 'function') return () => {};
    try {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals || typeof internals.transformCallback !== 'function') {
            return () => {};
        }
        const event = 'native-capture-bridge';
        const callbackId = internals.transformCallback((payload) => {
            callback(payload?.payload ?? payload);
        });
        const eventId = await invokeDesktopCommand('plugin:event|listen', {
            event,
            target: { kind: 'Any' },
            handler: callbackId
        });
        return async () => {
            try { internals.unregisterCallback?.(callbackId); } catch (error) { /* idempotente */ }
            try { window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(event, eventId); } catch (error) { /* idempotente */ }
            try { await invokeDesktopCommand('plugin:event|unlisten', { event, eventId }); } catch (error) { /* idempotente */ }
        };
    } catch (err) {
        console.warn('[Desktop] Eventos ICE da ponte nativa indisponíveis:', err);
        return () => {};
    }
}
