/** media-calls: commands receive explicit compatibility ports; no page initialization. */
import { createInitialCodecTransform } from '../streaming/codecs.js';
export function initiateMediaCallToViewer(compatibilityContext, viewerPeerId) {
  const isNativeActive = Boolean(compatibilityContext.isDesktopApp() && compatibilityContext.activeNativeCaptureProvider?.session?.sessionId);
  if ((!compatibilityContext.localStream && !isNativeActive) || !compatibilityContext.peer) return;

  // Barreira central de autorização: nunca inicia chamada ou negociação direta para peer não autorizado
  if (!compatibilityContext.isPeerAuthorizedForMedia(viewerPeerId)) {
    console.warn(`[Security] initiateMediaCallToViewer bloqueado para peer não autorizado: ${viewerPeerId}`);
    return;
  }

  // Alternativa 1: se captura nativa estiver ativa no desktop, transmite diretamente via GStreamer webrtcbin
  if (isNativeActive) {
    const sessionId = compatibilityContext.activeNativeCaptureProvider.session.sessionId;
    if (compatibilityContext.activeNativeViewerPeers.has(viewerPeerId) || compatibilityContext.activeDirectSignaling.has(viewerPeerId)) {
      console.log(`Stream direto nativo já ativo ou em negociação para: ${viewerPeerId}`);
      return;
    }
    const conn = compatibilityContext.connectedViewers.get(viewerPeerId) || (compatibilityContext.roomManager && compatibilityContext.roomManager.meshConnections.get(viewerPeerId));
    if (conn) {
      if (conn.open) {
        console.log(`Iniciando stream direto GStreamer para espectador: ${viewerPeerId}`);
        compatibilityContext.activeDirectSignaling.add(viewerPeerId);
        conn.send({
          type: 'START_DIRECT_STREAM',
          sessionId,
          hasAudio: Boolean(compatibilityContext.activeNativeCaptureProvider.session.audioRtpPort || compatibilityContext.activeNativeCaptureProvider.session.audio_rtp_port)
        });
      } else {
        console.log(`Aguardando abertura de canal de dados para stream direto com: ${viewerPeerId}`);
        compatibilityContext.activeDirectSignaling.add(viewerPeerId);
        const onOpen = () => {
          console.log(`Canal de dados aberto. Enviando START_DIRECT_STREAM para: ${viewerPeerId}`);
          try {
            conn.send({
              type: 'START_DIRECT_STREAM',
              sessionId,
              hasAudio: Boolean(compatibilityContext.activeNativeCaptureProvider.session.audioRtpPort || compatibilityContext.activeNativeCaptureProvider.session.audio_rtp_port)
            });
          } catch (e) {
            compatibilityContext.activeDirectSignaling.delete(viewerPeerId);
          }
        };
        if (typeof conn.once === 'function') {
          conn.once('open', onOpen);
        } else if (typeof conn.on === 'function') {
          const handler = () => {
            conn.off?.('open', handler);
            onOpen();
          };
          conn.on('open', handler);
        }
      }
      return;
    }
  }

  if (!compatibilityContext.localStream) return;

  // Garante que não criamos chamadas duplicadas para o mesmo espectador
  const existingCall = compatibilityContext.activeMediaCalls.get(viewerPeerId);
  if (existingCall && !existingCall._closed) {
    const pcState = existingCall.peerConnection?.connectionState;
    const isAlive = !pcState || pcState === 'new' || pcState === 'connecting' || pcState === 'connected';
    if (isAlive) {
      console.log(`Chamada de mídia já ativa ou em andamento para: ${viewerPeerId}`);
      return;
    }
  }

  // Árvore P2P Relay (Tree Mesh): se exceder uploads diretos, delega retransmissão para o melhor peer
  if (compatibilityContext.isRoomMode() && compatibilityContext.isTreeRelayEnabled && compatibilityContext.roomRelayManager && compatibilityContext.peer) {
    const telemetry = compatibilityContext.lastViewerTelemetry.get(viewerPeerId) || { rtt: 50, packetLoss: 0 };
    const allocation = compatibilityContext.roomRelayManager.registerViewer(viewerPeerId, telemetry);

    if (allocation && allocation.role === 'relay' && allocation.parentPeerId) {
      console.log(`[RelayTree] Espectador ${viewerPeerId} alocado como RELAY sob o nó pai ${allocation.parentPeerId}`);

      const parentConn = compatibilityContext.roomManager?.meshConnections?.get(allocation.parentPeerId);
      if (parentConn && parentConn.open) {
        parentConn.send({
          type: 'RELAY_FORWARD_REQUEST',
          targetPeerId: viewerPeerId,
          hostPeerId: compatibilityContext.peer.id
        });
      }

      const viewerConn = compatibilityContext.roomManager?.meshConnections?.get(viewerPeerId);
      if (viewerConn && viewerConn.open) {
        viewerConn.send({
          type: 'RELAY_UPSTREAM_ASSIGNED',
          parentPeerId: allocation.parentPeerId,
          hostPeerId: compatibilityContext.peer.id
        });
      }
      return; // Economiza upload direto do streamer!
    }
  }

  console.log(`Iniciando chamada com foco em alta fluidez para: ${viewerPeerId}`);
  const call = compatibilityContext.peer.call(viewerPeerId, compatibilityContext.localStream, {
    sdpTransform:createInitialCodecTransform(()=>compatibilityContext.videoCodecSelect?.value||'auto')
  });
  
  if (call) {
    call._direction = 'outgoing';
    compatibilityContext.activeMediaCalls.set(viewerPeerId, call);

    if (call.peerConnection) {
      compatibilityContext.hookPeerConnectionSdp(call.peerConnection, () => compatibilityContext.customBitrateBps);
      compatibilityContext.applyTransceiverOptimizations(call.peerConnection);

      compatibilityContext.startStatsMonitor(viewerPeerId, call.peerConnection, true, (sample) => {
        if (sample && typeof sample.rtt === 'number') {
          compatibilityContext.lastViewerTelemetry.set(viewerPeerId, {
            rtt: sample.rtt,
            packetLoss: sample.packetLossRate || 0,
            isLan: sample.isLan,
            isRelay: sample.isRelay
          });
          if (compatibilityContext.roomRelayManager) {
            compatibilityContext.roomRelayManager.updateTelemetry(viewerPeerId, {
              rtt: sample.rtt,
              packetLoss: sample.packetLossRate || 0,
              isLan: sample.isLan,
              isRelay: sample.isRelay
            });
          }
        }
        if (compatibilityContext.adaptiveBitrateController.isEnabled) {
          compatibilityContext.adaptiveBitrateController.processSample({
            packetLossRate: sample.packetLossRate || 0,
            rttMs: sample.rtt || 0,
            qualityLimitationReason: sample.qualityReason || sample.qualityLimitationReason,
            encodeTimeMs: sample.encodeTimeMs,
            isLan: sample.isLan,
            isRelay: sample.isRelay
          }, viewerPeerId);
        }
      });

      setTimeout(() => {
        let scaleFactor = 1;
        const videoTrack = compatibilityContext.localStream?.getVideoTracks()[0];
        if (videoTrack && typeof videoTrack.getSettings === 'function') {
          const settings = videoTrack.getSettings();
          const nativeHeight = settings.height || 1080;
          const targetHeight = compatibilityContext.selectedProfile.height || 1080;
          if (nativeHeight > targetHeight) {
            scaleFactor = Number((nativeHeight / targetHeight).toFixed(2));
          }
        } else if (compatibilityContext.selectedProfile.height && compatibilityContext.selectedProfile.height < 1080) {
          scaleFactor = Number((1080 / compatibilityContext.selectedProfile.height).toFixed(2));
        }
        compatibilityContext.applySenderOptimizations(call.peerConnection, compatibilityContext.customBitrateBps, compatibilityContext.selectedProfile.fps, scaleFactor, compatibilityContext.selectedProfile?.degradationPreference || 'maintain-resolution');
      }, 300);
    }

    call.on('close', () => {
      call._closed = true;
      if (compatibilityContext.activeMediaCalls.get(viewerPeerId) === call) {
        compatibilityContext.activeMediaCalls.delete(viewerPeerId);
        compatibilityContext.stopStatsMonitor(viewerPeerId);
      }
    });

    call.on('error', (err) => {
      console.error(`Erro na chamada com ${viewerPeerId}:`, err);
      call._closed = true;
      if (compatibilityContext.activeMediaCalls.get(viewerPeerId) === call) {
        compatibilityContext.activeMediaCalls.delete(viewerPeerId);
        compatibilityContext.stopStatsMonitor(viewerPeerId);
      }
    });
  }
}

export function handleIncomingMediaCall(compatibilityContext, call) {
  console.log(`Recebendo chamada de mídia de: ${call.peer}`);

  // Descarta se stream direto já está ativo para este peer
  if (compatibilityContext.directViewerPeerConnections.has(call.peer)) {
    console.log(`Chamada legada descartada: stream direto ativo com ${call.peer}`);
    try { call.close(); } catch (e) {}
    return;
  }

  // Se for chamada de áudio da Sala de Voz
  if (call.metadata?.type === 'VOICE_CHAT') {
    compatibilityContext.handleIncomingVoiceCall(call);
    return;
  }

  const isRelayedCall = Boolean(call.metadata?.type === 'RELAY_STREAM');
  const originHostId = call.metadata?.hostPeerId || call.peer;

  // Rejeição de chamadas não solicitadas: só aceita se o host estiver cadastrado em watchingHosts ou na sala (roomManager)
  if (!compatibilityContext.watchingHosts.has(call.peer) && !compatibilityContext.watchingHosts.has(originHostId) && !(compatibilityContext.roomManager && (compatibilityContext.roomManager.members.has(call.peer) || compatibilityContext.roomManager.members.has(originHostId)))) {
    console.warn(`Chamada de mídia não solicitada rejeitada de: ${call.peer}`);
    try {
      call.close();
    } catch (e) {}
    return;
  }

  if (compatibilityContext.roomManager && (compatibilityContext.roomManager.members.has(call.peer) || compatibilityContext.roomManager.members.has(originHostId))) {
    if (!compatibilityContext.watchingHosts.has(originHostId)) {
      compatibilityContext.watchingHosts.set(originHostId, {
        state: 'CONNECTED',
        conn: compatibilityContext.roomManager.meshConnections.get(originHostId) || null,
        call: call,
        timeoutTimer: null,
        isRelayed: isRelayedCall,
        relayParentPeerId: isRelayedCall ? call.peer : null
      });
    }
  }

  call._direction = 'incoming';

  // Se já existe uma chamada de entrada deste host, verifica se ela ainda está viva/conectando
  const existingCall = compatibilityContext.activeMediaCalls?.get(call.peer) || (originHostId ? compatibilityContext.activeMediaCalls?.get(originHostId) : null);
  const existingIncomingCall = compatibilityContext.watchingHosts.get(originHostId)?.call ||
    (existingCall?._direction === 'incoming' ? existingCall : null);
  if (existingIncomingCall && existingIncomingCall !== call) {
    const pc = existingIncomingCall.peerConnection;
    const pcState = pc?.connectionState;
    const sigState = pc?.signalingState;
    const isAlive = existingIncomingCall.open || pcState === 'connected' || pcState === 'connecting' || sigState === 'stable' || sigState === 'have-remote-offer';
    if (isAlive) {
      console.log(`[MediaCall] Já existe chamada ativa ou em conexão com ${call.peer} (pcState=${pcState}, sig=${sigState}), descartando chamada duplicada.`);
      try { call.close(); } catch (e) {}
      return;
    }
    try { existingIncomingCall.close(); } catch (e) {}
  }

  compatibilityContext.activeMediaCalls.set(call.peer, call);
  if (originHostId) compatibilityContext.activeMediaCalls.set(originHostId, call);
  if (compatibilityContext.watchingHosts.has(originHostId)) {
    compatibilityContext.watchingHosts.get(originHostId).call = call;
  }

  if (call.peerConnection) {
    compatibilityContext.hookPeerConnectionSdp(call.peerConnection, () => compatibilityContext.customBitrateBps);
    compatibilityContext.applyTransceiverOptimizations(call.peerConnection);
  }

  call.answer();

  call.on('stream', (remoteStream) => {
    console.log(`Stream remoto recebido de ${call.peer}${isRelayedCall ? ` (Relay originário de ${originHostId})` : ''}`);

    // Salva a stream remota para permitir que este nó retransmita para outros na árvore
    compatibilityContext.savedRemoteStreams.set(call.peer, remoteStream);
    compatibilityContext.savedRemoteStreams.set(originHostId, remoteStream);

    // Se haviam pedidos pendentes de retransmissão para este host, atende-os agora:
    if (compatibilityContext.pendingRelayRequests.length > 0) {
      const remaining = [];
      for (const req of compatibilityContext.pendingRelayRequests) {
        if ((req.hostPeerId === call.peer || req.hostPeerId === originHostId) && compatibilityContext.peer && !compatibilityContext.peer.destroyed) {
          console.log(`[RelayTree] Atendendo pedido de relay pendente para ${req.targetPeerId}`);
          const relayCall = compatibilityContext.peer.call(req.targetPeerId, remoteStream, {
            metadata: { type: 'RELAY_STREAM', hostPeerId: req.hostPeerId }
          });
          if (relayCall) {
            compatibilityContext.activeMediaCalls.set(req.targetPeerId, relayCall);
          }
        } else {
          remaining.push(req);
        }
      }
      compatibilityContext.pendingRelayRequests.length = 0;
      compatibilityContext.pendingRelayRequests.push(...remaining);
    }

    const displayHostId = originHostId;
    compatibilityContext.hideCardLoading(displayHostId);
    compatibilityContext.hideCardLoading(call.peer);
    compatibilityContext.setCardStreamPaused(displayHostId, false);
    compatibilityContext.setCardStreamPaused(call.peer, false);

    if (compatibilityContext.discordUI) {
      compatibilityContext.discordUI.syncStageView(true);
    }

    compatibilityContext.clipRecorder.start(remoteStream, displayHostId);
    const reactionsDock = document.getElementById('reactions-dock');
    if (reactionsDock) reactionsDock.style.display = 'flex';

    const hostConn = compatibilityContext.watchingHosts.get(displayHostId)?.conn || compatibilityContext.watchingHosts.get(call.peer)?.conn;
    const label = isRelayedCall
      ? `🎮 Tela de ${displayHostId.slice(0, 6)} (Relay via ${call.peer.slice(0, 4)})`
      : `🎮 Tela de ${displayHostId.slice(0, 6)}`;

    compatibilityContext.addOrUpdateVideoCard({
      stream: remoteStream,
      peerId: displayHostId,
      label,
      isLocal: false,
      onDisconnect: () => compatibilityContext.disconnectHost(displayHostId),
      onCoopClick: (hostId) => {
        const state = compatibilityContext.getCoopState();
        if (state.isPlayer2) {
          compatibilityContext.releaseCoopControl();
        } else {
          compatibilityContext.requestCoopControl(hostId, hostConn || compatibilityContext.watchingHosts.get(hostId)?.conn);
        }
      }
    });
    
    if (call.peerConnection) {
      compatibilityContext.applyTransceiverOptimizations(call.peerConnection);
      compatibilityContext.startStatsMonitor(displayHostId, call.peerConnection, false);
    }

    compatibilityContext.showToast(isRelayedCall
      ? `Transmissão de ${displayHostId.slice(0, 6)} conectada via Relay (${call.peer.slice(0, 4)})!`
      : `Transmissão de ${call.peer.slice(0, 6)} conectada em alta fluidez!`, 'success');
  });

  call.on('close', () => {
    compatibilityContext.clipRecorder.stop(call.peer);
    const reactionsDock = document.getElementById('reactions-dock');
    if (reactionsDock && compatibilityContext.watchingHosts.size === 0) reactionsDock.style.display = 'none';

    const hostData = compatibilityContext.watchingHosts.get(call.peer);
    if (hostData && hostData.conn && hostData.conn.open === true) {
      // Streamer apenas pausou a transmissão ou alternou fonte; mantém o card pausado sem desmontar
      compatibilityContext.setCardStreamPaused(call.peer, true, 'Transmissão pausada pelo streamer.');
      compatibilityContext.stopStatsMonitor(call.peer);
    } else {
      compatibilityContext.showToast(`Transmissão de ${call.peer.slice(0, 6)} encerrada.`, 'info');
      compatibilityContext.removeVideoCard(call.peer);
      compatibilityContext.stopStatsMonitor(call.peer);
    }
    if (compatibilityContext.activeMediaCalls.get(call.peer) === call) {
      compatibilityContext.activeMediaCalls.delete(call.peer);
    }
  });

  call.on('error', (err) => {
    console.error('Erro no stream recebido:', err);
    compatibilityContext.showToast(`Erro no stream: ${err.message}`, 'error');
    compatibilityContext.removeVideoCard(call.peer);
    compatibilityContext.stopStatsMonitor(call.peer);
    if (compatibilityContext.activeMediaCalls.get(call.peer) === call) {
      compatibilityContext.activeMediaCalls.delete(call.peer);
    }
  });

  compatibilityContext.activeMediaCalls.set(call.peer, call);
}
