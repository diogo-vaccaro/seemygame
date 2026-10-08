import {
    isDesktopApp,
    createNativeCapturePeer,
    addNativeCaptureIceCandidate,
    closeNativeCapturePeer,
    stopNativeCapture,
    listenNativeCaptureBridge,
    logDiagnostic
} from './desktop.js';

const TRACK_TIMEOUT_MS = 10_000;
const ICE_GATHER_TIMEOUT_MS = 3_000;

function waitForIceGatheringComplete(peerConnection) {
    if (peerConnection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            peerConnection.removeEventListener('icegatheringstatechange', onChange);
            resolve();
        };
        const onChange = () => {
            if (peerConnection.iceGatheringState === 'complete') finish();
        };
        const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
        peerConnection.addEventListener('icegatheringstatechange', onChange);
    });
}

function waitForFirstVideoFrame(stream, timeoutMs, signal) {
    // A track pode ser criada a partir do SDP antes de qualquer pacote RTP
    // chegar. Um elemento de vídeo oculto confirma que houve decodificação.
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        return Promise.resolve();
    }

    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.position = 'fixed';
    video.style.top = '0';
    video.style.left = '0';
    video.style.width = '2px';
    video.style.height = '2px';
    video.style.opacity = '0.01';
    video.style.pointerEvents = 'none';
    video.style.zIndex = '-9999';
    try {
        if (document.body) {
            document.body.appendChild(video);
        }
    } catch (_) {}
    video.srcObject = stream;

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let pollTimer = null;
        let frameCallbackId = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (pollTimer) clearInterval(pollTimer);
            signal?.removeEventListener('abort', onAbort);
            video.removeEventListener?.('loadeddata', onFrame);
            video.removeEventListener?.('canplay', onFrame);
            video.removeEventListener?.('playing', onFrame);
            video.removeEventListener?.('timeupdate', onFrame);
            if (frameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
                video.cancelVideoFrameCallback(frameCallbackId);
            }
            try { video.pause?.(); } catch (error) {}
            video.srcObject = null;
            try {
                if (video.parentNode) {
                    video.parentNode.removeChild(video);
                } else {
                    video.remove?.();
                }
            } catch (error) {}
        };
        const finish = (error = null) => {
            if (settled) return;
            settled = true;
            cleanup();
            error ? reject(error) : resolve();
        };
        const onFrame = () => finish();
        const onAbort = () => finish(new Error('Ponte nativa cancelada antes do primeiro frame'));

        video.addEventListener?.('loadeddata', onFrame, { once: true });
        video.addEventListener?.('canplay', onFrame, { once: true });
        video.addEventListener?.('playing', onFrame, { once: true });
        video.addEventListener?.('timeupdate', onFrame, { once: true });
        if (typeof video.requestVideoFrameCallback === 'function') {
            frameCallbackId = video.requestVideoFrameCallback(() => finish());
        }

        pollTimer = setInterval(() => {
            if (video.videoWidth > 0 || video.currentTime > 0) {
                finish();
            }
        }, 100);

        timer = setTimeout(() => {
            finish(new Error('A ponte nativa recebeu a trilha, mas não entregou o primeiro frame de vídeo'));
        }, Math.max(1, timeoutMs));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }

        try {
            const playPromise = video.play?.();
            playPromise?.catch?.(() => {
                // O evento loadeddata ainda pode confirmar a decodificação.
                // O timeout acima transforma falha persistente em erro claro.
            });
        } catch (error) {}
    });
}

function waitForMediaTracks(stream, peerConnection, expectAudio = false, signal) {
    const hasVideo = () => stream.getVideoTracks().length > 0;
    const hasAudio = () => !expectAudio || stream.getAudioTracks().length > 0;
    return new Promise((resolve, reject) => {
        let settled = false;
        let audioFallbackTimer = null;
        let timer = null;
        let framePromise = null;
        let frameStarted = false;

        const finish = (error = null) => {
            if (settled) return;
            settled = true;
            if (audioFallbackTimer) clearTimeout(audioFallbackTimer);
            if (timer) clearTimeout(timer);
            peerConnection.removeEventListener('track', onTrack);
            peerConnection.removeEventListener('connectionstatechange', onStateChange);
            signal?.removeEventListener('abort', onAbort);
            error ? reject(error) : resolve(stream);
        };
        const onAbort = () => finish(new Error('Ponte nativa cancelada durante a negociação'));
        const confirmFrame = () => {
            if (frameStarted || !hasVideo() || !hasAudio()) return;
            frameStarted = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            const elapsed = Date.now() - startedAt;
            framePromise = waitForFirstVideoFrame(stream, Math.max(1, TRACK_TIMEOUT_MS - elapsed), signal);
            framePromise.then(() => finish()).catch(finish);
        };
        const onTrack = () => {
            confirmFrame();
        };
        const onStateChange = () => {
            if (['failed', 'closed'].includes(peerConnection.connectionState)) {
                finish(new Error(`Ponte WebRTC nativa encerrou (${peerConnection.connectionState})`));
            }
        };

        if (expectAudio) {
            audioFallbackTimer = setTimeout(() => {
                confirmFrame();
            }, 3000);
        }

        timer = setTimeout(() => finish(new Error('A ponte nativa não entregou uma trilha de vídeo')), TRACK_TIMEOUT_MS);
        const startedAt = Date.now();
        peerConnection.addEventListener('track', onTrack);
        peerConnection.addEventListener('connectionstatechange', onStateChange);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        confirmFrame();
    });
}

export function createNativeWebRtcBridge({ target = globalThis } = {}) {
    const sessions = new Map();
    return {
        async createStream(nativeState = {}) {
            if (!isDesktopApp()) throw new Error('Captura nativa só funciona no app desktop');
            if (typeof RTCPeerConnection !== 'function' || typeof MediaStream !== 'function') {
                throw new Error('WebRTC não está disponível no WebView');
            }
            const sessionId = nativeState.sessionId || nativeState.session_id;
            if (!sessionId) throw new Error('Sessão nativa sem identificador');

            const peerConnection = new RTCPeerConnection({ iceServers: [] });
            const stream = new MediaStream();
            const pendingCandidates = [];
            let isRemoteDescriptionSet = false;
            let unsubscribe = () => {};
            let closed = false;
            const cancellation = new AbortController();
            const ensureOpen = () => { if (closed) throw new Error('Negociação da ponte nativa cancelada'); };

            let telemetryTimer = null;
            const close = async () => {
                if (closed) return;
                closed = true;
                cancellation.abort();
                if (telemetryTimer) clearInterval(telemetryTimer);
                sessions.delete(sessionId);
                logDiagnostic(`[JS] Fechando sessão de stream nativo ${sessionId}`);
                try { await unsubscribe(); } catch (error) { /* idempotente */ }
                try { peerConnection.close(); } catch (error) { /* idempotente */ }
                stream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
                await closeNativeCapturePeer(sessionId).catch(() => {});
                await stopNativeCapture(sessionId).catch(() => {});
            };

            sessions.set(sessionId, { close });

            const applyReceiverJitter = () => {
                try {
                    const transceivers = peerConnection.getTransceivers ? peerConnection.getTransceivers() : [];
                    for (const t of transceivers) {
                        if (t?.receiver) {
                            const targetMs = 0; // Loopback interno localhost: zero latência e sem buffer artificial
                            if ('jitterBufferTarget' in t.receiver) t.receiver.jitterBufferTarget = targetMs;
                            if ('playoutDelayHint' in t.receiver) t.receiver.playoutDelayHint = targetMs / 1000;
                        }
                    }
                } catch (_) {}
            };

            peerConnection.addEventListener('track', (event) => {
                logDiagnostic(`[JS] Trilha de mídia recebida: kind=${event.track?.kind}, id=${event.track?.id}, readyState=${event.track?.readyState}`);
                const tracks = event.streams?.[0]?.getTracks?.() || [event.track];
                tracks.forEach((track) => {
                    if (track && track.kind === 'video') {
                        track.contentHint = 'motion';
                    }
                    if (!stream.getTracks().includes(track)) stream.addTrack(track);
                });
                applyReceiverJitter();
                event.track?.addEventListener?.('ended', () => close());
            });
            peerConnection.addEventListener('iceconnectionstatechange', () => {
                logDiagnostic(`[JS] iceConnectionState alterado para: ${peerConnection.iceConnectionState}`);
            });
            peerConnection.addEventListener('connectionstatechange', () => {
                logDiagnostic(`[JS] connectionState alterado para: ${peerConnection.connectionState}`);
                if (['failed', 'closed'].includes(peerConnection.connectionState)) close();
            });
            peerConnection.addEventListener('icecandidate', (event) => {
                const candidate = event.candidate;
                if (!candidate?.candidate) {
                    logDiagnostic('[JS] Fim dos candidatos ICE do navegador (null candidate)');
                    return;
                }
                logDiagnostic(`[JS] Candidato ICE gerado pelo WebView: mline=${candidate.sdpMLineIndex} cand=${candidate.candidate}`);
                addNativeCaptureIceCandidate(
                    sessionId,
                    candidate.sdpMLineIndex ?? 0,
                    candidate.candidate
                ).catch(() => {});
            });
            try {
                const hasNativeAudio = nativeState.audioRtpPort != null || nativeState.audio_rtp_port != null;
                const videoTransceiver = peerConnection.addTransceiver('video', { direction: 'recvonly' });
                if (videoTransceiver?.receiver) {
                    if ('jitterBufferTarget' in videoTransceiver.receiver) videoTransceiver.receiver.jitterBufferTarget = 0;
                    if ('playoutDelayHint' in videoTransceiver.receiver) videoTransceiver.receiver.playoutDelayHint = 0;
                }
                if (hasNativeAudio) {
                    const audioTransceiver = peerConnection.addTransceiver('audio', { direction: 'recvonly' });
                    if (audioTransceiver?.receiver) {
                        if ('jitterBufferTarget' in audioTransceiver.receiver) audioTransceiver.receiver.jitterBufferTarget = 0;
                        if ('playoutDelayHint' in audioTransceiver.receiver) audioTransceiver.receiver.playoutDelayHint = 0;
                    }
                }

                unsubscribe = await listenNativeCaptureBridge(async (event) => {
                    if (closed) return;
                    if (!event || (event.sessionId !== sessionId && event.session_id !== sessionId)) return;
                    if (event.peerId || event.peer_id) return;
                    if (event.event !== 'ice-candidate' || !event.candidate) return;
                    logDiagnostic(`[JS] Candidato da ponte Rust recebido via evento: ${event.candidate}`);
                    const candidateInit = {
                        candidate: event.candidate,
                        sdpMid: null,
                        sdpMLineIndex: Number(event.mlineIndex ?? event.mline_index ?? 0)
                    };
                    if (!isRemoteDescriptionSet) {
                        pendingCandidates.push(candidateInit);
                    } else {
                        try {
                            await peerConnection.addIceCandidate(candidateInit);
                        } catch (err) {
                            logDiagnostic(`[JS Bridge ICE Candidate Error] ${err?.message}`);
                            console.warn('[Bridge ICE Candidate Error]', err);
                        }
                    }
                });
                if (closed) {
                    const lateUnsubscribe = unsubscribe;
                    unsubscribe = () => {};
                    await lateUnsubscribe();
                    ensureOpen();
                }
                logDiagnostic(`[JS] Criando oferta SDP local...`);
                const offer = await peerConnection.createOffer();
                ensureOpen();
                await peerConnection.setLocalDescription(offer);
                ensureOpen();
                await waitForIceGatheringComplete(peerConnection);
                ensureOpen();
                const localOffer = peerConnection.localDescription;
                if (!localOffer?.sdp) throw new Error('WebView não gerou uma oferta SDP');
                logDiagnostic(`[JS] Oferta SDP gerada (${localOffer.sdp.length} bytes), enviando para Rust...`);
                const answer = await createNativeCapturePeer(sessionId, localOffer.sdp);
                ensureOpen();
                logDiagnostic(`[JS] Resposta SDP recebida do Rust (${answer?.sdp?.length} bytes), aplicando remote description...`);
                await peerConnection.setRemoteDescription({
                    type: answer.type || answer.sdpType || 'answer',
                    sdp: answer.sdp
                });
                ensureOpen();
                isRemoteDescriptionSet = true;
                applyReceiverJitter();

                logDiagnostic(`[JS] Remote description aplicada com sucesso. Drenando ${pendingCandidates.length} candidatos ICE em espera...`);
                for (const cand of pendingCandidates) {
                    try {
                        await peerConnection.addIceCandidate(cand);
                    } catch (err) {
                        logDiagnostic(`[JS Bridge Flush ICE Candidate Error] ${err?.message}`);
                        console.warn('[Bridge Flush ICE Candidate Error]', err);
                    }
                }
                pendingCandidates.length = 0;

                const expectAudio = nativeState.audioRtpPort != null || nativeState.audio_rtp_port != null;
                logDiagnostic(`[JS] Aguardando trilhas de mídia (expectAudio=${expectAudio})...`);
                await waitForMediaTracks(stream, peerConnection, expectAudio, cancellation.signal);
                ensureOpen();
                logDiagnostic(`[JS] Trilhas confirmadas! Vídeo: ${stream.getVideoTracks().length}, Áudio: ${stream.getAudioTracks().length}`);

                // Telemetria periódica no arquivo de log
                telemetryTimer = setInterval(async () => {
                    if (closed || !peerConnection || peerConnection.connectionState === 'closed') {
                        clearInterval(telemetryTimer);
                        return;
                    }
                    try {
                        const stats = await peerConnection.getStats();
                        let bytesReceived = 0;
                        let framesDecoded = 0;
                        let framesReceived = 0;
                        let width = 0;
                        let height = 0;
                        let candPairState = 'none';

                        stats.forEach((report) => {
                            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                                bytesReceived = report.bytesReceived ?? 0;
                                framesDecoded = report.framesDecoded ?? 0;
                                framesReceived = report.framesReceived ?? 0;
                                width = report.frameWidth ?? 0;
                                height = report.frameHeight ?? 0;
                            }
                            if (report.type === 'candidate-pair' && (report.nominated || report.state === 'succeeded')) {
                                candPairState = `${report.state} (rtt=${report.currentRoundTripTime})`;
                            }
                        });
                        logDiagnostic(`[JS Telemetria] ice=${peerConnection.iceConnectionState} conn=${peerConnection.connectionState} pair=${candPairState} bytes=${bytesReceived} framesDec=${framesDecoded} framesRecv=${framesReceived} res=${width}x${height}`);
                    } catch (_) {}
                }, 1500);

                return stream;
            } catch (error) {
                logDiagnostic(`[JS createStream Error] ${error?.message || error}`);
                await close();
                throw error;
            }
        },
        async closeStream(sessionId) {
            const session = sessions.get(sessionId);
            if (session) await session.close();
            else await closeNativeCapturePeer(sessionId).catch(() => {});
        }
    };
}

export function installNativeCaptureBridge({ target = globalThis } = {}) {
    if (!target || !isDesktopApp()) return null;
    if (!target.__SEEMYGAME_NATIVE_CAPTURE__) {
        target.__SEEMYGAME_NATIVE_CAPTURE__ = createNativeWebRtcBridge({ target });
    }
    return target.__SEEMYGAME_NATIVE_CAPTURE__;
}

