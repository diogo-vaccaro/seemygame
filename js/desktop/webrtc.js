import { isDesktopApp } from './ipc.js';
import { invokeDesktopCommand } from './ipc.js';
/** webrtc: commands receive explicit compatibility ports; no page initialization. */
export async function createNativeCapturePeer(sessionId, offerSdp) {
    if (!isDesktopApp()) throw new Error('Ponte WebRTC nativa só está disponível no app desktop');
    if (!sessionId || typeof offerSdp !== 'string' || offerSdp.length === 0 || offerSdp.length > 256 * 1024) {
        throw new Error('Oferta SDP nativa inválida');
    }
    return await invokeDesktopCommand('create_native_capture_peer', { sessionId, offerSdp });
}

export async function closeNativeCapturePeer(sessionId) {
    if (!isDesktopApp() || !sessionId) return null;
    return invokeDesktopCommand('close_native_capture_peer', { sessionId });
}

export async function createNativeViewerPeer(sessionId, viewerId, offerSdp, iceServers = null, negotiationId = null) {
    if (!isDesktopApp()) throw new Error('Ponte WebRTC nativa só está disponível no app desktop');
    if (!sessionId || !viewerId || typeof offerSdp !== 'string' || offerSdp.length === 0 || offerSdp.length > 256 * 1024) {
        throw new Error('Parâmetros de oferta SDP do espectador nativo inválidos');
    }
    const payload = { sessionId, viewerId, offerSdp };
    if (negotiationId) payload.negotiationId = negotiationId;
    if (iceServers) payload.iceServers = iceServers;
    return await invokeDesktopCommand('create_native_viewer_peer', payload);
}

export async function addNativeViewerIceCandidate(sessionId, viewerId, mlineIndex, candidate, negotiationId = null) {
    if (!isDesktopApp()) return null;
    if (!sessionId || !viewerId || !Number.isInteger(Number(mlineIndex)) || typeof candidate !== 'string' || candidate.length > 16 * 1024) {
        throw new Error('Candidato ICE do espectador nativo inválido');
    }
    return invokeDesktopCommand('add_native_viewer_ice_candidate', {
        sessionId,
        viewerId,
        mlineIndex: Number(mlineIndex),
        candidate,
        ...(negotiationId ? { negotiationId } : {})
    });
}

export async function closeNativeViewerPeer(sessionId, viewerId, negotiationId = null) {
    if (!isDesktopApp() || !sessionId || !viewerId) return null;
    return invokeDesktopCommand('close_native_viewer_peer', { sessionId, viewerId, ...(negotiationId ? { negotiationId } : {}) });
}

export async function getNativeStreamStats(sessionId, viewerId) {
    if (!isDesktopApp() || !sessionId || !viewerId) return [];
    return invokeDesktopCommand('get_native_stream_stats', { sessionId, viewerId });
}

export async function startNativeViewer(hostId, offerSdp, iceServers = null, openDedicatedWindow = true) {
    if (!isDesktopApp()) throw new Error('Visualizador nativo requer o aplicativo desktop');
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
