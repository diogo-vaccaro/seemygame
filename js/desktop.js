/**
 * SeeMyGame - Módulo de Integração com o App Desktop Nativo (Tauri v2 / Rust)
 */

export function isDesktopApp() {
    return typeof window !== 'undefined' && (
        Boolean(window.__TAURI_INTERNALS__) ||
        Boolean(window.__TAURI__)
    );
}

export async function invokeDesktopCommand(cmd, args = {}, { omitArgs = false } = {}) {
    if (typeof window === 'undefined') {
        throw new Error('Ambiente de navegador/janela não disponível');
    }
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
        return omitArgs
            ? window.__TAURI_INTERNALS__.invoke(cmd)
            : window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    if (window.__TAURI__?.core && typeof window.__TAURI__.core.invoke === 'function') {
        return omitArgs
            ? window.__TAURI__.core.invoke(cmd)
            : window.__TAURI__.core.invoke(cmd, args);
    }
    throw new Error(`Ambiente desktop Tauri não detectado para invocar "${cmd}"`);
}

/**
 * Comandos de gamepad usam o mesmo adaptador do restante do desktop. O
 * retorno da Promise é importante: a UI só deve anunciar um dispositivo
 * virtual depois que o backend confirmou a criação.
 */
export function isNativeGamepadAvailable() {
    return typeof window !== 'undefined' && Boolean(
        typeof window.__TAURI_INTERNALS__?.invoke === 'function' ||
        typeof window.__TAURI__?.core?.invoke === 'function'
    );
}

export function plugVirtualGamepad(slot) {
    return invokeDesktopCommand('plug_virtual_gamepad', { slot: Number(slot) });
}

export function updateVirtualGamepad(slot, report) {
    return invokeDesktopCommand('update_virtual_gamepad', { slot: Number(slot), report });
}

export function unplugVirtualGamepad(slot) {
    return invokeDesktopCommand('unplug_virtual_gamepad', { slot: Number(slot) });
}

export function unplugAllVirtualGamepads() {
    return invokeDesktopCommand('unplug_all_virtual_gamepads', {}, { omitArgs: true });
}

export function testGamepadVibration(gamepadIndex, strongMagnitude, weakMagnitude, durationMs) {
    return invokeDesktopCommand('test_gamepad_vibration', {
        gamepadIndex: Number(gamepadIndex),
        strongMagnitude: Number(strongMagnitude),
        weakMagnitude: Number(weakMagnitude),
        durationMs: Number(durationMs)
    });
}

export function getXInputGamepads() {
    return invokeDesktopCommand('get_xinput_gamepads', {}, { omitArgs: true });
}

export function checkVirtualGamepadDriver() {
    return invokeDesktopCommand('check_gamepad_driver_status', {}, { omitArgs: true });
}

export function installViGEmDriver() {
    return invokeDesktopCommand('install_vigem_driver', {}, { omitArgs: true });
}

/**
 * Normaliza o contrato enviado pelo Rust. IDs são opacos: o frontend apenas
 * os repassa ao comando de captura e nunca tenta convertê-los em HWND/HMONITOR.
 */
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
        videoRtpPort: state.videoRtpPort == null && state.video_rtp_port == null
            ? null
            : Number(state.videoRtpPort ?? state.video_rtp_port),
        audioRtpPort: state.audioRtpPort == null && state.audio_rtp_port == null
            ? null
            : Number(state.audioRtpPort ?? state.audio_rtp_port),
        error: state.error || null
    };
}

function requireSourceId(sourceId) {
    if (typeof sourceId !== 'string' || sourceId.trim().length === 0 || sourceId.length > 256) {
        throw new Error('sourceId de captura inválido');
    }
    return sourceId.trim();
}

/**
 * Obtém lista de janelas e jogos ativos enumerados pela API Win32 em Rust
 * @returns {Promise<Array<{id: string, title: string, process_name: string, is_minimized: boolean}>>}
 */
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

/**
 * Enumera janelas e monitores. A enumeração cria IDs opacos no Rust e também
 * invalida IDs de enumerações anteriores.
 */
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

export async function startNativeCapture({ sourceId, audioMode = 'none', videoCodec = null, h264Encoder = null, showCursor = undefined, width, height, fps, bitrateKbps } = {}) {
    if (!isDesktopApp()) throw new Error('Captura nativa só está disponível no app desktop');
    const args = {
        sourceId: requireSourceId(sourceId),
        audioMode: String(audioMode || 'none')
    };
    if (showCursor !== undefined) args.showCursor = Boolean(showCursor);
    if (videoCodec) args.videoCodec = String(videoCodec);
    if (h264Encoder) args.h264Encoder = String(h264Encoder);
    if (width != null) args.width = Number(width);
    if (height != null) args.height = Number(height);
    if (fps != null) args.fps = Number(fps);
    if (bitrateKbps != null) args.bitrateKbps = Number(bitrateKbps);
    const state = await invokeDesktopCommand('start_native_capture', args);
    return normalizeNativeCaptureState(state);
}

export async function reconfigureNativeCapture(options = {}) {
    if (!isDesktopApp()) return null;
    const { sessionId, audioMode, videoCodec, h264Encoder, showCursor, width, height, fps, bitrateKbps } = options;
    if (!sessionId) throw new Error('Sessão de captura nativa inválida para reconfiguração');
    const args = { sessionId };
    if (audioMode !== undefined) args.audioMode = String(audioMode);
    if (videoCodec !== undefined) args.videoCodec = String(videoCodec);
    if (h264Encoder !== undefined) args.h264Encoder = String(h264Encoder);
    if (showCursor !== undefined) args.showCursor = Boolean(showCursor);
    if (width != null) args.width = Number(width);
    if (height != null) args.height = Number(height);
    if (fps != null) args.fps = Number(fps);
    if (bitrateKbps != null) args.bitrateKbps = Number(bitrateKbps);

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

export async function createNativeCapturePeer(sessionId, offerSdp) {
    if (!isDesktopApp()) throw new Error('Ponte WebRTC nativa só está disponível no app desktop');
    if (!sessionId || typeof offerSdp !== 'string' || offerSdp.length === 0 || offerSdp.length > 256 * 1024) {
        throw new Error('Oferta SDP nativa inválida');
    }
    return await invokeDesktopCommand('create_native_capture_peer', { sessionId, offerSdp });
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

export async function closeNativeCapturePeer(sessionId) {
    if (!isDesktopApp() || !sessionId) return null;
    return invokeDesktopCommand('close_native_capture_peer', { sessionId });
}

export async function createNativeViewerPeer(sessionId, viewerId, offerSdp, iceServers = null) {
    if (!isDesktopApp()) throw new Error('Ponte WebRTC nativa só está disponível no app desktop');
    if (!sessionId || !viewerId || typeof offerSdp !== 'string' || offerSdp.length === 0 || offerSdp.length > 256 * 1024) {
        throw new Error('Parâmetros de oferta SDP do espectador nativo inválidos');
    }
    const payload = { sessionId, viewerId, offerSdp };
    if (iceServers) payload.iceServers = iceServers;
    return await invokeDesktopCommand('create_native_viewer_peer', payload);
}

export async function addNativeViewerIceCandidate(sessionId, viewerId, mlineIndex, candidate) {
    if (!isDesktopApp()) return null;
    if (!sessionId || !viewerId || !Number.isInteger(Number(mlineIndex)) || typeof candidate !== 'string' || candidate.length > 16 * 1024) {
        throw new Error('Candidato ICE do espectador nativo inválido');
    }
    return invokeDesktopCommand('add_native_viewer_ice_candidate', {
        sessionId,
        viewerId,
        mlineIndex: Number(mlineIndex),
        candidate
    });
}

export async function closeNativeViewerPeer(sessionId, viewerId) {
    if (!isDesktopApp() || !sessionId || !viewerId) return null;
    return invokeDesktopCommand('close_native_viewer_peer', { sessionId, viewerId });
}

/**
 * Visualizador Nativo Direct3D 11 (Ultra Baixa Latência sem passar pelo WebView2)
 */
export async function startNativeViewer(hostId, offerSdp, iceServers = null, openDedicatedWindow = true) {
    if (!isDesktopApp()) throw new Error('Visualizador nativo Direct3D 11 requer o aplicativo desktop');
    return invokeDesktopCommand('start_native_viewer', {
        hostId: String(hostId),
        offerSdp: String(offerSdp),
        iceServers: Array.isArray(iceServers) ? iceServers : null,
        openDedicatedWindow: Boolean(openDedicatedWindow)
    });
}

export async function addNativeViewerCandidate(mlineIndex, candidate) {
    if (!isDesktopApp()) return;
    return invokeDesktopCommand('add_native_viewer_candidate', {
        mlineIndex: Number(mlineIndex),
        candidate: String(candidate)
    });
}

export async function stopNativeViewer() {
    if (!isDesktopApp()) return;
    return invokeDesktopCommand('stop_native_viewer', {}, { omitArgs: true });
}

export async function listenNativeViewerEvents(callback) {
    if (!isDesktopApp() || typeof callback !== 'function') return () => {};
    try {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals || typeof internals.transformCallback !== 'function') {
            return () => {};
        }
        const event = 'native-viewer-event';
        const callbackId = internals.transformCallback((payload) => {
            callback(payload?.payload ?? payload);
        });
        const eventId = await invokeDesktopCommand('plugin:event|listen', {
            event,
            target: { kind: 'Any' },
            handler: callbackId
        });
        return async () => {
            try { internals.unregisterCallback?.(callbackId); } catch (_) {}
            try { await invokeDesktopCommand('plugin:event|unlisten', { event, eventId }); } catch (_) {}
        };
    } catch (err) {
        console.warn('[Desktop] Eventos do visualizador nativo indisponíveis:', err);
        return () => {};
    }
}


/**
 * Escuta transições do worker nativo quando o runtime de mídia estiver
 * disponível. O import é tardio para manter o bundle web independente do
 * plugin de eventos do Tauri.
 */
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

/**
 * Solicita ao Rust elevar a prioridade de processo para HIGH_PRIORITY_CLASS
 * @returns {Promise<boolean>}
 */
export async function setHighPriority() {
    if (!isDesktopApp()) return false;
    try {
        const result = await invokeDesktopCommand('set_high_priority');
        return Boolean(result);
    } catch (err) {
        console.warn('[Desktop] Falha ao definir alta prioridade:', err);
        return false;
    }
}

/**
 * Alterna dinamicamente se a janela do SeeMyGame deve ficar fixada no topo (always-on-top)
 * @returns {Promise<boolean>} Retorna o novo estado
 */
export async function toggleAlwaysOnTop() {
    if (!isDesktopApp()) return false;
    try {
        const result = await invokeDesktopCommand('toggle_always_on_top');
        return Boolean(result);
    } catch (err) {
        console.warn('[Desktop] Falha ao alternar always-on-top:', err);
        return false;
    }
}


/**
 * Consulta se a janela está fixada no topo
 * @returns {Promise<boolean>}
 */
export async function isAlwaysOnTop() {
    if (!isDesktopApp()) return false;
    try {
        const result = await invokeDesktopCommand('is_always_on_top');
        return Boolean(result);
    } catch (err) {
        console.warn('[Desktop] Falha ao consultar always-on-top:', err);
        return false;
    }
}

/**
 * Envia log de diagnóstico para o arquivo native_debug.log gerenciado pelo Rust
 * @param {string} message
 */
export async function logDiagnostic(message) {
    if (!isDesktopApp()) return;
    try {
        await invokeDesktopCommand('log_diagnostic', { message: String(message) });
    } catch (_) {}
}
