/** message-routing: commands receive explicit compatibility ports; no page initialization. */
export function isDuplicateMessage(compatibilityContext, msgId) {
  if (!msgId) return false;
  if (compatibilityContext.seenMessageIds.has(msgId)) return true;
  if (compatibilityContext.seenMessageIds.size > 2000) {
    const first = compatibilityContext.seenMessageIds.values().next().value;
    compatibilityContext.seenMessageIds.delete(first);
  }
  compatibilityContext.seenMessageIds.add(msgId);
  return false;
}

export function initPlugins(compatibilityContext) {
  compatibilityContext.pluginManager.initAll({
    broadcastDataMessage: (data, exclude) => compatibilityContext.broadcastDataMessage(data, exclude),
    isRoomMode: () => compatibilityContext.isRoomMode(),
    isTrustedLaserRelayPeer: peerId => !compatibilityContext.isRoomMode()
      && compatibilityContext.watchingHosts?.get(peerId)?.state === 'CONNECTED',
    getViewersCount: () => compatibilityContext.connectedViewers.size,
    showToast: (msg, type, dur) => compatibilityContext.showToast(msg, type, dur),
    getDisplayName: () => compatibilityContext.getLocalUserDisplayName()
  });
}

export function handleIncomingP2PMessage(compatibilityContext, data, sourceConn) {
  if (!data || typeof data !== 'object') return;
  const msgId = data.msgId || data.message?.id;
  if (msgId && compatibilityContext.isDuplicateMessage(msgId)) return;

  compatibilityContext.p2pDispatcher.dispatch(data, sourceConn, { checkDuplicates: false });
}

export function setupIncomingDataConnection(compatibilityContext, conn) {
  if (!conn) return;
  if (conn._smg_incoming_bound) return;
  conn._smg_incoming_bound = true;
  conn._smg_direct_signaling_bound = true;

  // Limite de espectadores simultâneos
  if (compatibilityContext.connectedViewers.size >= compatibilityContext.maxViewers && !compatibilityContext.connectedViewers.has(conn.peer)) {
    console.warn(`Rejeitando conexão de ${conn.peer}: limite de ${compatibilityContext.maxViewers} espectadores atingido.`);
    conn.on('open', () => {
      conn.send({ type: 'STREAM_REJECTED', reason: `Limite de ${compatibilityContext.maxViewers} espectadores atingido.` });
      setTimeout(() => conn.close(), 500);
    });
    compatibilityContext.showToast(`Conexão de ${conn.peer.slice(0, 6)} recusada: sala cheia.`, 'info');
    return;
  }

  conn.on('open', () => {
    console.log(`Espectador conectado: ${conn.peer}`);
    compatibilityContext.connectedViewers.set(conn.peer, conn);
    if (compatibilityContext.roomManager) {
      compatibilityContext.roomManager.registerConnection(conn.peer, conn);
    }
    compatibilityContext.updateViewerCountUI();

    if (compatibilityContext.isRoomMode()) {
      // No modo de sala, o controle de acesso e admissão é exclusivo do RoomManager.
      // A mídia só é transmitida se o participante já estiver explicitamente autorizado na sala.
      if (compatibilityContext.roomManager && compatibilityContext.roomManager.isPeerAuthorized(conn.peer)) {
        compatibilityContext.authenticatedViewers.add(conn.peer);
        if (compatibilityContext.isCurrentlyStreaming()) {
          compatibilityContext.initiateMediaCallToViewer(conn.peer);
          conn.send({ type: 'STREAM_STATUS', isStreaming: true });
        } else {
          conn.send({ type: 'STREAM_STATUS', isStreaming: false });
        }
      }
      // Se não estiver autorizado (pendente/sem PIN), NÃO adiciona a authenticatedViewers
      // e NÃO dispara chamada de vídeo. O fluxo de admissão da sala ocorrerá via RoomManager.
    } else {
      // Modo streamer clássico
      const hostPin = compatibilityContext.getStoredRoomPin();
      if (hostPin) {
        // Sala protegida: envia desafio de PIN e não inicia chamada de mídia antes da senha
        conn.send({ type: 'PIN_REQUIRED' });
      } else {
        // Sala aberta: autoriza imediatamente
        compatibilityContext.authenticatedViewers.add(conn.peer);
        if (compatibilityContext.isCurrentlyStreaming()) {
          compatibilityContext.initiateMediaCallToViewer(conn.peer);
          conn.send({ type: 'STREAM_STATUS', isStreaming: true });
        } else {
          conn.send({ type: 'STREAM_STATUS', isStreaming: false });
        }
      }
    }

    // Sincroniza configurações atuais com o novo espectador conectado
    conn.send({
      type: 'STREAM_CONFIG_UPDATED',
      preset: compatibilityContext.qualityPresetSelect ? compatibilityContext.qualityPresetSelect.value : null,
      bitrate: compatibilityContext.customBitrateBps,
      fps: compatibilityContext.selectedProfile.fps,
      height: compatibilityContext.selectedProfile.height,
      audioMode: compatibilityContext.audioModeSelect ? compatibilityContext.audioModeSelect.value : 'system'
    });
    conn.send({
      type: 'COOP_CONFIG',
      enabled: compatibilityContext.getCoopState().isCoopEnabled
    });
  });

  conn.on('data', (data) => {
    if (!data || typeof data !== 'object') return;

    if (compatibilityContext.roomManager && compatibilityContext.roomManager.handleRoomMessage(conn.peer, data, conn)) {
      if (compatibilityContext.roomManager.isPeerAuthorized(conn.peer) && conn.peer === compatibilityContext.roomManager.masterPeerId) {
        if (data.type === 'ROOM_SYNC_ALL' && Array.isArray(data.members)) {
          data.members.forEach((m) => {
            if (m && m.peerId && m.peerId !== compatibilityContext.myId) {
              if (m.isStreaming && !compatibilityContext.watchingHosts.has(m.peerId)) {
                compatibilityContext.watchFriend(m.peerId);
              }
              if (compatibilityContext.roomManager.members.has(m.peerId) && !compatibilityContext.connectedViewers.has(m.peerId) && !compatibilityContext.watchingHosts.has(m.peerId)) {
                if (m.peerId !== compatibilityContext.roomManager.masterPeerId && !compatibilityContext.roomManager.meshConnections.has(m.peerId) && !compatibilityContext.roomManager.pendingConnections.has(m.peerId)) {
                  if (compatibilityContext.myId < m.peerId) {
                    const peerConn = compatibilityContext.peer.connect(m.peerId, { reliable: true });
                    compatibilityContext.setupIncomingDataConnection(peerConn);
                    peerConn.on('open', () => {
                      try {
                        peerConn.send({ type: 'ROOM_MEMBER_AUTH', roomId: compatibilityContext.roomManager.roomId, roomKey: compatibilityContext.roomManager.roomKey });
                      } catch (_) {}
                    });
                  }
                }
              }
              if (compatibilityContext.voiceManager && compatibilityContext.voiceManager.isInVoice && compatibilityContext.voiceManager.localStream && !compatibilityContext.activeVoiceCalls.has(m.peerId) && compatibilityContext.peer && !compatibilityContext.peer.destroyed) {
                const call = compatibilityContext.peer.call(m.peerId, compatibilityContext.voiceManager.localStream, {
                  metadata: { type: 'VOICE_CHAT', name: compatibilityContext.roomManager.userName, role: 'member' }
                });
                compatibilityContext.setupVoiceMediaCall(call, m.peerId);
              }
            }
          });
        }
      }
      return;
    }

    if (data.type === 'REQUEST_STREAM') {
      if (compatibilityContext.isRoomMode()) {
        if (!compatibilityContext.roomManager || !compatibilityContext.roomManager.isPeerAuthorized(conn.peer)) {
          console.warn(`[Security] REQUEST_STREAM recusado para participante não autorizado: ${conn.peer}`);
          conn.send({ type: 'ROOM_PIN_REQUIRED', error: 'Autenticação necessária na sala.' });
          return;
        }
        compatibilityContext.authenticatedViewers.add(conn.peer);
        if (compatibilityContext.isCurrentlyStreaming()) {
          compatibilityContext.initiateMediaCallToViewer(conn.peer);
          conn.send({ type: 'STREAM_STATUS', isStreaming: true });
        } else {
          conn.send({ type: 'STREAM_STATUS', isStreaming: false });
        }
        return;
      }

      // Modo streamer clássico
      const hostPin = compatibilityContext.getStoredRoomPin();
      if (hostPin) {
        const providedPin = data.pin ? String(data.pin).trim() : '';
        if (providedPin !== hostPin) {
          conn.send({ type: 'PIN_REQUIRED', error: 'PIN incorreto. Tente novamente.' });
          return;
        }
        // PIN correto!
        compatibilityContext.authenticatedViewers.add(conn.peer);
        conn.send({ type: 'PIN_ACCEPTED' });
        compatibilityContext.showToast(`Amigo (${conn.peer.slice(0, 6)}) autenticou com PIN.`, 'success');
        if (compatibilityContext.isCurrentlyStreaming()) {
          compatibilityContext.initiateMediaCallToViewer(conn.peer);
          conn.send({ type: 'STREAM_STATUS', isStreaming: true });
        } else {
          conn.send({ type: 'STREAM_STATUS', isStreaming: false });
        }
      } else {
        compatibilityContext.authenticatedViewers.add(conn.peer);
        compatibilityContext.showToast(`Amigo (${conn.peer.slice(0, 6)}) solicitou o stream.`, 'info');
        if (compatibilityContext.isCurrentlyStreaming()) {
          compatibilityContext.initiateMediaCallToViewer(conn.peer);
        }
      }
      return;
    }

    // Bloqueia chat, voz, co-op e stream direto se o peer não estiver autorizado
    if (!compatibilityContext.isPeerAuthorizedForMedia(conn.peer)) {
      if (compatibilityContext.isRoomMode()) {
        conn.send({ type: 'ROOM_PIN_REQUIRED', error: 'Autenticação necessária na sala.' });
      } else {
        conn.send({ type: 'PIN_REQUIRED', error: 'Autenticação necessária com PIN.' });
      }
      return;
    }

    if (compatibilityContext.handleDirectStreamSignaling(data, conn)) {
      return;
    }

    if (data.type === 'STREAM_STATUS') {
      if (data.isStreaming && !compatibilityContext.watchingHosts.has(conn.peer) && (compatibilityContext.isRoomMode() ? compatibilityContext.roomManager?.isPeerAuthorized(conn.peer) : compatibilityContext.isPeerAuthorizedForMedia(conn.peer))) {
        compatibilityContext.watchFriend(conn.peer);
      } else if (compatibilityContext.watchingHosts.has(conn.peer)) {
        if (!data.isStreaming) {
          compatibilityContext.updateCardStatus(conn.peer, 'Amigo conectado! Aguardando ele iniciar o jogo...');
        } else {
          compatibilityContext.updateCardStatus(conn.peer, 'Sincronizando stream em tempo real...');
        }
      }
      return;
    }

    if (data.type === 'STREAM_STOPPED') {
      if (compatibilityContext.isRoomMode()) {
        compatibilityContext.disconnectHost(conn.peer);
        return;
      }
      if (compatibilityContext.watchingHosts.has(conn.peer)) {
        compatibilityContext.showToast('O amigo pausou a transmissão.', 'info');
        compatibilityContext.setCardStreamPaused(conn.peer, true, 'Transmissão pausada pelo streamer.');
        const directPc = compatibilityContext.directViewerPeerConnections.get(conn.peer);
        if (directPc) {
          try { directPc.close(); } catch (e) {}
          compatibilityContext.directViewerPeerConnections.delete(conn.peer);
          compatibilityContext.directPendingCandidates.delete(conn.peer);
        }
        compatibilityContext.stopStatsMonitor(conn.peer);
      }
      return;
    }

    // Sinalização da Árvore P2P Relay (Tree Mesh)
    if (data.type === 'RELAY_FORWARD_REQUEST') {
      const { targetPeerId, hostPeerId } = data;
      if (conn.peer !== hostPeerId) return;
      if (data.stop) {
        compatibilityContext.pendingRelayRequests = compatibilityContext.pendingRelayRequests
          .filter(request => request.targetPeerId !== targetPeerId || request.hostPeerId !== hostPeerId);
        const relayCall = compatibilityContext.activeMediaCalls.get(targetPeerId);
        if (relayCall?.metadata?.hostPeerId === hostPeerId) {
          compatibilityContext.activeMediaCalls.delete(targetPeerId);
          try { relayCall.close(); } catch (_) {}
        }
        return;
      }
      console.log(`[RelayTree] Solicitado retransmitir stream de ${hostPeerId} para ${targetPeerId}`);

      const streamToRelay = compatibilityContext.savedRemoteStreams.get(hostPeerId) || compatibilityContext.watchingHosts.get(hostPeerId)?.call?.remoteStream;
      if (streamToRelay && compatibilityContext.peer && !compatibilityContext.peer.destroyed) {
        console.log(`[RelayTree] Iniciando chamada de relay para ${targetPeerId}`);
        const relayCall = compatibilityContext.peer.call(targetPeerId, streamToRelay, {
          metadata: { type: 'RELAY_STREAM', hostPeerId }
        });
        if (relayCall) {
          compatibilityContext.activeMediaCalls.set(targetPeerId, relayCall);
          if (relayCall.peerConnection) {
            compatibilityContext.applyTransceiverOptimizations(relayCall.peerConnection);
          }
        }
      } else {
        console.log(`[RelayTree] Stream de ${hostPeerId} ainda não recebida. Enfileirando solicitação para ${targetPeerId}`);
        compatibilityContext.pendingRelayRequests.push({ targetPeerId, hostPeerId });
      }
      return;
    }

    if (data.type === 'RELAY_UPSTREAM_ASSIGNED') {
      const { parentPeerId, hostPeerId } = data;
      if (conn.peer !== hostPeerId) return;
      console.log(`[RelayTree] Atribuído nó pai de relay: ${parentPeerId} para assistir ${hostPeerId}`);
      if (!compatibilityContext.watchingHosts.has(hostPeerId)) {
        compatibilityContext.createPlaceholderCard(hostPeerId, `Amigo ${hostPeerId.slice(0, 6)}`);
        compatibilityContext.watchingHosts.set(hostPeerId, {
          state: 'CONNECTING',
          conn: compatibilityContext.roomManager?.meshConnections?.get(hostPeerId) || null,
          call: null,
          timeoutTimer: null,
          isRelayed: true,
          relayParentPeerId: parentPeerId
        });
      } else {
        const watcher = compatibilityContext.watchingHosts.get(hostPeerId);
        watcher.isRelayed = parentPeerId !== hostPeerId;
        watcher.relayParentPeerId = watcher.isRelayed ? parentPeerId : null;
      }
      return;
    }

    if (data.type === 'CHAT_MESSAGE' || data.type === 'VOICE_STATE_UPDATE' || data.type === 'VOICE_SIGNAL' ||
        data.type === 'TACTICAL_PING' || data.type === 'TACTICAL_LASER' || data.type === 'EMOJI_REACTION' || data.type === 'SOUNDBOARD_PLAY' ||
        (data.type && data.type.startsWith('WHITEBOARD_'))) {
      compatibilityContext.handleIncomingP2PMessage(data, conn);
      return;
    }

    if (data.type && (data.type.startsWith('COOP_') || data.type.startsWith('INPUT_'))) {
      compatibilityContext.handleHostCoopMessage(conn.peer, data, conn);
    }
  });

  conn.on('close', () => {
    if (compatibilityContext.activeNativeViewerPeers.has(conn.peer)) {
      const sessionId = compatibilityContext.activeNativeCaptureProvider?.session?.sessionId;
      if (sessionId && compatibilityContext.isDesktopApp()) {
        compatibilityContext.closeNativeViewerPeer(sessionId, conn.peer).catch(() => {});
      }
      compatibilityContext.activeNativeViewerPeers.delete(conn.peer);
      compatibilityContext.activeDirectSignaling.delete(conn.peer);
    }
    if (compatibilityContext.roomManager) {
      compatibilityContext.roomManager.removeMember(conn.peer);
    }
    // Notifica módulo Co-op caso este espectador fosse o Player 2
    compatibilityContext.handleHostCoopMessage(conn.peer, { type: 'COOP_RELEASE' }, conn);
    compatibilityContext.connectedViewers.delete(conn.peer);
    compatibilityContext.authenticatedViewers.delete(conn.peer);
    compatibilityContext.stopStatsMonitor(conn.peer);
    compatibilityContext.updateViewerCountUI();
  });

  conn.on('error', (err) => {
    console.error(`Erro na DataConnection com ${conn.peer}:`, err);
    if (compatibilityContext.activeNativeViewerPeers.has(conn.peer)) {
      const sessionId = compatibilityContext.activeNativeCaptureProvider?.session?.sessionId;
      if (sessionId && compatibilityContext.isDesktopApp()) {
        compatibilityContext.closeNativeViewerPeer(sessionId, conn.peer).catch(() => {});
      }
      compatibilityContext.activeNativeViewerPeers.delete(conn.peer);
      compatibilityContext.activeDirectSignaling.delete(conn.peer);
    }
    if (compatibilityContext.roomManager) {
      compatibilityContext.roomManager.removeMember(conn.peer);
    }
    compatibilityContext.handleHostCoopMessage(conn.peer, { type: 'COOP_RELEASE' }, conn);
    compatibilityContext.connectedViewers.delete(conn.peer);
    compatibilityContext.authenticatedViewers.delete(conn.peer);
    compatibilityContext.stopStatsMonitor(conn.peer);
    compatibilityContext.updateViewerCountUI();
  });
}
