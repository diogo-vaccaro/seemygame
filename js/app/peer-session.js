/** peer-session: commands receive explicit compatibility ports; no page initialization. */
export function setupRoomSession(compatibilityContext, id) {
  const { roomId, roomPin } = compatibilityContext.getRoomInfoFromUrl();
  const masterId = compatibilityContext.getRoomMasterPeerId(roomId);
  const isMaster = (id === masterId);
  const clientSessionId = compatibilityContext.getClientSessionId();

  let customUserName = null;
  try { customUserName = localStorage.getItem('seemygame_user_name'); } catch (_) {}
  const userName = (typeof customUserName === 'string' && customUserName.trim())
    ? customUserName.trim().slice(0, 30)
    : (isMaster ? 'Host' : `Amigo ${id.slice(-4)}`);

  if (typeof sessionStorage !== 'undefined') {
    if (isMaster) {
      sessionStorage.setItem('seemygame_room_master_' + roomId, 'true');
    } else {
      sessionStorage.removeItem('seemygame_room_master_' + roomId);
    }
  }

  if (!compatibilityContext.roomManager) {
    compatibilityContext.roomManager = new compatibilityContext.RoomManager({
      roomId,
      userName,
      clientSessionId,
      roomPin,
      onStateChange: (state) => {
        if (compatibilityContext.discordUI) {
          compatibilityContext.discordUI.updateRoomPresence(state.members);
          compatibilityContext.discordUI.syncStageView(state.streamersCount > 0);
        }
        if (compatibilityContext.viewerCountBadge) {
          compatibilityContext.viewerCountBadge.innerHTML = `<span>👥</span> <strong>${state.membersCount}</strong> online`;
        }
      }
    });
    if (typeof window !== 'undefined') {
      window.roomManager = compatibilityContext.roomManager;
    }

    compatibilityContext.roomManager.on('streamPublished', ({ peerId, details, member }) => {
      if (peerId !== compatibilityContext.myId) {
        compatibilityContext.showToast(`🎮 ${member?.name || 'Um amigo'} começou a transmitir!`, 'info', 4000);
        if (!compatibilityContext.watchingHosts.has(peerId)) {
          compatibilityContext.watchFriend(peerId);
        }
      }
    });

    compatibilityContext.roomManager.on('streamUnpublished', ({ peerId, member }) => {
      if (peerId !== compatibilityContext.myId) {
        compatibilityContext.showToast(`Transmissão de ${member?.name || peerId.slice(0, 6)} encerrada.`, 'info');
        compatibilityContext.disconnectHost(peerId);
      }
    });

    compatibilityContext.roomManager.on('pinRequired', ({ error }) => {
      compatibilityContext.promptViewerPin(masterId, error || 'Esta sala requer PIN para entrada.');
    });

    compatibilityContext.roomManager.on('pinAccepted', () => {
      compatibilityContext.hideViewerPinModal();
      compatibilityContext.showToast('Entrada na sala autorizada!', 'success');
    });

    compatibilityContext.roomManager.on('joinRejected', ({ error }) => {
      if (compatibilityContext.pinPromptModal && compatibilityContext.pinPromptModal.style.display === 'flex' && compatibilityContext.viewerPinError) {
        compatibilityContext.viewerPinError.textContent = error || 'Acesso recusado pelo coordenador da sala.';
        compatibilityContext.viewerPinError.style.display = 'block';
      } else {
        compatibilityContext.showToast(error || 'Não foi possível ingressar na sala.', 'error');
      }
    });

    compatibilityContext.roomManager.on('memberJoined', (member) => {
      if (member && member.peerId && member.peerId !== compatibilityContext.myId) {
        // Conexão de voz P2P automática se o usuário local já estiver no canal de voz
        if (compatibilityContext.voiceManager && compatibilityContext.voiceManager.isInVoice && compatibilityContext.voiceManager.localStream && !compatibilityContext.activeVoiceCalls.has(member.peerId) && compatibilityContext.peer && !compatibilityContext.peer.destroyed) {
          const call = compatibilityContext.peer.call(member.peerId, compatibilityContext.voiceManager.localStream, {
            metadata: {
              type: 'VOICE_CHAT',
              name: compatibilityContext.roomManager.userName,
              role: compatibilityContext.roomManager.isMaster ? 'host' : 'member'
            }
          });
          compatibilityContext.setupVoiceMediaCall(call, member.peerId);
        }

        if (compatibilityContext.isCurrentlyStreaming() && compatibilityContext.isPeerAuthorizedForMedia(member.peerId)) {
          compatibilityContext.authenticatedViewers.add(member.peerId);
          let conn = compatibilityContext.connectedViewers.get(member.peerId) || compatibilityContext.roomManager.meshConnections.get(member.peerId);
          if (!conn && compatibilityContext.peer && !compatibilityContext.peer.destroyed) {
            conn = compatibilityContext.peer.connect(member.peerId, { reliable: true });
            compatibilityContext.connectedViewers.set(member.peerId, conn);
            compatibilityContext.setupIncomingDataConnection(conn);
          }
          compatibilityContext.initiateMediaCallToViewer(member.peerId);
          if (conn && conn.open) {
            conn.send({ type: 'STREAM_STATUS', isStreaming: true });
          } else if (conn) {
            const sendStatus = () => {
              try { conn.send({ type: 'STREAM_STATUS', isStreaming: true }); } catch (_) {}
            };
            if (typeof conn.once === 'function') conn.once('open', sendStatus);
            else if (typeof conn.on === 'function') conn.on('open', sendStatus);
          }
        }
      }
    });

    compatibilityContext.roomManager.on('memberLeft', (member) => {
      if (member && member.peerId) {
        compatibilityContext.authenticatedViewers.delete(member.peerId);
        compatibilityContext.activeDirectSignaling.delete(member.peerId);
        if (compatibilityContext.activeNativeViewerPeers.has(member.peerId)) {
          const sessionId = compatibilityContext.activeNativeCaptureProvider?.session?.sessionId;
          if (sessionId && compatibilityContext.isDesktopApp()) {
            compatibilityContext.closeNativeViewerPeer(sessionId, member.peerId).catch(() => {});
          }
          compatibilityContext.activeNativeViewerPeers.delete(member.peerId);
        }
        const call = compatibilityContext.activeMediaCalls.get(member.peerId);
        if (call) {
          try { call.close(); } catch (_) {}
          compatibilityContext.activeMediaCalls.delete(member.peerId);
        }
        compatibilityContext.connectedViewers.delete(member.peerId);
        compatibilityContext.stopStatsMonitor(member.peerId);
        compatibilityContext.updateViewerCountUI();

        // Failover automático na árvore de relay caso o membro fosse pai de outros nós
        if (compatibilityContext.roomRelayManager) {
          const failovers = compatibilityContext.roomRelayManager.unregisterViewer(member.peerId);
          failovers.forEach(({ childPeerId, newParentPeerId, role }) => {
            console.log(`[RelayTree] Failover para ${childPeerId}: novo destino = ${newParentPeerId} (${role})`);
            if (role === 'direct') {
              compatibilityContext.initiateMediaCallToViewer(childPeerId);
            } else if (newParentPeerId) {
              const parentConn = compatibilityContext.roomManager?.meshConnections?.get(newParentPeerId);
              if (parentConn && parentConn.open) {
                parentConn.send({
                  type: 'RELAY_FORWARD_REQUEST',
                  targetPeerId: childPeerId,
                  hostPeerId: compatibilityContext.peer.id
                });
              }
            }
          });
        }
      }
    });
  }

  if (!compatibilityContext.discordUI) {
    compatibilityContext.initDiscordFeatures();
  }

  compatibilityContext.roomManager.join(id, isMaster);

  // Auto-conecta na sala de voz da sala P2P
  setTimeout(async () => {
    try {
      if (compatibilityContext.voiceManager && !compatibilityContext.voiceManager.isInVoice) {
        const stream = await compatibilityContext.voiceManager.joinVoice({
          peerId: id,
          name: userName,
          role: isMaster ? 'host' : 'member'
        });
        compatibilityContext.showToast('Conectado ao canal de voz da sala!', 'success');

        compatibilityContext.roomManager.members.forEach((m) => {
          if (m.peerId !== id && !compatibilityContext.activeVoiceCalls.has(m.peerId)) {
            const call = compatibilityContext.peer.call(m.peerId, stream, {
              metadata: { type: 'VOICE_CHAT', name: userName, role: isMaster ? 'host' : 'member' }
            });
            compatibilityContext.setupVoiceMediaCall(call, m.peerId);
          }
        });
      }
    } catch (e) {
      console.info('[Room] Entrada na sala de voz aguardando interação do microfone.');
    }
  }, 400);

  // Se não for master, conecta ao master da sala para solicitar entrada
  if (!isMaster && compatibilityContext.peer) {
    const masterConn = compatibilityContext.peer.connect(masterId, { reliable: true });
    masterConn.on('open', () => {
      masterConn.send({
        type: 'ROOM_JOIN_REQUEST',
        name: userName,
        clientSessionId,
        pin: roomPin,
        isMuted: compatibilityContext.voiceManager.isMuted,
        isDeafened: compatibilityContext.voiceManager.isDeafened,
        isStreaming: compatibilityContext.isCurrentlyStreaming()
      });
    });
    compatibilityContext.setupIncomingDataConnection(masterConn);
  }

  const roomBadge = document.getElementById('room-header-badge');
  if (roomBadge) roomBadge.textContent = `Sala: #${roomId}${isMaster ? ' (Host)' : ''}`;

  const sidebarRoomName = document.getElementById('sidebar-room-name');
  if (sidebarRoomName) sidebarRoomName.textContent = `🔊 #${roomId}`;

  const localUserNameElem = document.getElementById('local-user-name');
  if (localUserNameElem) localUserNameElem.textContent = userName;

  const localAvatarElem = document.getElementById('local-avatar');
  if (localAvatarElem) localAvatarElem.textContent = (userName || 'V').charAt(0).toUpperCase();

  if (compatibilityContext.copyBadge) {
    compatibilityContext.copyBadge.innerHTML = `<span>📋</span> Sala: <strong>#${roomId}</strong>`;
  }

  if (compatibilityContext.shareLinkBtn) {
    compatibilityContext.shareLinkBtn.style.display = 'inline-flex';
    compatibilityContext.shareLinkBtn.onclick = async () => {
      const pinParam = (compatibilityContext.roomManager && compatibilityContext.roomManager.roomPin) ? `&pin=${encodeURIComponent(compatibilityContext.roomManager.roomPin)}` : '';
      const shareUrl = `${window.location.origin}${window.location.pathname}#room=${encodeURIComponent(roomId)}${pinParam}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        compatibilityContext.showToast(pinParam ? 'Link da sala (com PIN) copiado!' : 'Link da sala copiado!', 'success');
      } catch (err) {
        compatibilityContext.showToast(`Link: ${shareUrl}`, 'info');
      }
    };
  }
}

export function initPeer(compatibilityContext) {
  if (typeof Peer === 'undefined') {
    compatibilityContext.showToast('Erro: Biblioteca PeerJS não carregada.', 'error');
    return null;
  }

  const pendingIce = compatibilityContext.getPendingIceServersPromise();
  if (pendingIce) {
    // Preserve the pending result so callers can await the actual Peer.
    return pendingIce.then(() => compatibilityContext.initPeer(), () => compatibilityContext.initPeer());
  }

  if (compatibilityContext.peer && !compatibilityContext.peer.destroyed) {
    return compatibilityContext.peer;
  }

  const inRoom = compatibilityContext.isRoomMode();
  const isHost = typeof window !== 'undefined' && window.location ? !window.location.pathname.endsWith('viewer.html') : true;
  const config = compatibilityContext.getPeerConfig();

  let customId = null;
  if (inRoom) {
    const { roomId } = compatibilityContext.getRoomInfoFromUrl();
    customId = compatibilityContext.isRoomMasterAttempt ? compatibilityContext.getRoomMasterPeerId(roomId) : null;
  } else if (isHost) {
    customId = compatibilityContext.getCustomStreamerId();
  }

  try {
    if (customId) {
      compatibilityContext.peer = new Peer(customId, config);
    } else {
      compatibilityContext.peer = new Peer(config);
    }
  } catch (err) {
    console.error('Falha ao inicializar PeerJS:', err);
    compatibilityContext.peer = new Peer(config);
  }

  compatibilityContext.peer.on('open', (id) => {
    compatibilityContext.myId = id;
    compatibilityContext.reconnectAttempts = 0;
    compatibilityContext.customIdRetryAttempts = 0;
    if (compatibilityContext.reconnectTimer) {
      clearTimeout(compatibilityContext.reconnectTimer);
      compatibilityContext.reconnectTimer = null;
    }
    if (compatibilityContext.customIdRetryTimer) {
      clearTimeout(compatibilityContext.customIdRetryTimer);
      compatibilityContext.customIdRetryTimer = null;
    }

    if (inRoom) {
      compatibilityContext.setupRoomSession(id);
    }

    if (typeof sessionStorage !== 'undefined' && isHost && !inRoom) {
      const fixedId = compatibilityContext.getCustomStreamerId();
      if (fixedId && fixedId === id) {
        sessionStorage.setItem('seemygame_last_id', id);
      }
    }

    if (compatibilityContext.copyBadge) {
      compatibilityContext.copyBadge.innerHTML = `<span>📋</span> Seu ID: <strong>${id}</strong>`;
      compatibilityContext.copyBadge.setAttribute('role', 'button');
      compatibilityContext.copyBadge.setAttribute('tabindex', '0');
    }
    if (compatibilityContext.shareLinkBtn) compatibilityContext.shareLinkBtn.style.display = 'inline-flex';
    if (compatibilityContext.streamBtn) compatibilityContext.streamBtn.disabled = false;
    if (compatibilityContext.connectBtn) compatibilityContext.connectBtn.disabled = false;
    compatibilityContext.showToast('Engine P2P conectada em alta fluidez!', 'success');

    // Copiar ID com suporte a teclado e tratamento assíncrono
    const copyIdAction = async () => {
      try {
        await navigator.clipboard.writeText(id);
        const prev = compatibilityContext.copyBadge.innerHTML;
        compatibilityContext.copyBadge.innerHTML = `<span>✓</span> <strong>ID Copiado!</strong>`;
        compatibilityContext.showToast('Seu ID foi copiado!', 'success');
        setTimeout(() => { compatibilityContext.copyBadge.innerHTML = prev; }, 2500);
      } catch (err) {
        compatibilityContext.showToast(`ID: ${id}`, 'info');
      }
    };

    if (compatibilityContext.copyBadge) {
      compatibilityContext.copyBadge.onclick = copyIdAction;
      compatibilityContext.copyBadge.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          copyIdAction();
        }
      };
    }

    // Copiar Link direto para a página do espectador (apenas fora do modo sala)
    if (compatibilityContext.shareLinkBtn && !inRoom) {
      compatibilityContext.shareLinkBtn.onclick = async () => {
        let basePath = window.location.pathname;
        if (basePath.endsWith('.html')) {
          basePath = basePath.substring(0, basePath.lastIndexOf('/') + 1);
        } else if (!basePath.endsWith('/')) {
          basePath += '/';
        }
        const shareUrl = `${window.location.origin}${basePath}viewer.html#watch=${id}`;
        try {
          await navigator.clipboard.writeText(shareUrl);
          compatibilityContext.showToast('Link de convite copiado!', 'success');
        } catch (err) {
          compatibilityContext.showToast(`Link de convite: ${shareUrl}`, 'info');
        }
      };
    }

    compatibilityContext.checkAutoWatchUrl();
  });

  // 1. Recebe conexões de controle (DataConnection)
  compatibilityContext.peer.on('connection', (conn) => {
    compatibilityContext.setupIncomingDataConnection(conn);
  });

  // 2. Recebe chamadas de mídia (MediaConnection)
  compatibilityContext.peer.on('call', (call) => {
    compatibilityContext.handleIncomingMediaCall(call);
  });

  // 3. Queda de sinalização e reconexão automática com backoff exponencial
  compatibilityContext.peer.on('disconnected', () => {
    console.warn('PeerJS desconectado do servidor de sinalização.');
    compatibilityContext.showToast('Conexão de sinalização perdida. Tentando reconectar...', 'info');

    if (compatibilityContext.reconnectTimer) clearTimeout(compatibilityContext.reconnectTimer);
    if (compatibilityContext.reconnectAttempts < 5) {
      const delay = Math.min(1000 * Math.pow(2, compatibilityContext.reconnectAttempts), 16000);
      compatibilityContext.reconnectAttempts++;
      compatibilityContext.reconnectTimer = setTimeout(() => {
        if (compatibilityContext.peer && !compatibilityContext.peer.destroyed && compatibilityContext.peer.disconnected) {
          console.log(`Tentativa de reconexão PeerJS #${compatibilityContext.reconnectAttempts}...`);
          try {
            compatibilityContext.peer.reconnect();
          } catch (e) {
            console.warn('Erro ao chamar peer.reconnect():', e);
          }
        }
      }, delay);
    } else {
      compatibilityContext.showToast('Não foi possível reconectar à sinalização. Atualize a página.', 'error');
    }
  });

  compatibilityContext.peer.on('close', () => {
    console.warn('PeerJS destruído/encerrado.');
    compatibilityContext.showToast('Sessão P2P encerrada.', 'info');
    if (compatibilityContext.streamBtn) compatibilityContext.streamBtn.disabled = true;
    if (compatibilityContext.connectBtn) compatibilityContext.connectBtn.disabled = true;
  });

  compatibilityContext.peer.on('error', (err) => {
    console.error('PeerJS Error:', err);
    if (err.type === 'peer-unavailable') {
      compatibilityContext.showToast('ID do amigo não encontrado ou offline.', 'error');
      // Identifica o host pendente no Map sem depender do targetInput
      for (const [hostId, hostData] of compatibilityContext.watchingHosts.entries()) {
        if (hostData && hostData.state === 'CONNECTING') {
          compatibilityContext.disconnectHost(hostId);
          break;
        }
      }
    } else if (err.type === 'unavailable-id') {
      const inRoom = compatibilityContext.isRoomMode();
      if (inRoom && compatibilityContext.isRoomMasterAttempt) {
        const { roomId } = compatibilityContext.getRoomInfoFromUrl();
        const wasMaster = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('seemygame_room_master_' + roomId) === 'true';
        if (wasMaster && compatibilityContext.customIdRetryAttempts < compatibilityContext.MAX_CUSTOM_ID_RETRIES) {
          compatibilityContext.customIdRetryAttempts++;
          const delay = Math.min(1000 * compatibilityContext.customIdRetryAttempts, 3000);
          console.warn(`[Room] ID de coordenador retido pelo servidor de sinalização após recarga. Tentando reconectar ${compatibilityContext.customIdRetryAttempts}/${compatibilityContext.MAX_CUSTOM_ID_RETRIES} em ${delay}ms...`);
          compatibilityContext.showToast(`Aguardando liberação do ID de Host da sala... (${compatibilityContext.customIdRetryAttempts}/${compatibilityContext.MAX_CUSTOM_ID_RETRIES})`, 'info', delay);
          if (compatibilityContext.peer) {
            try { compatibilityContext.peer.destroy(); } catch (e) {}
            compatibilityContext.peer = null;
          }
          compatibilityContext.customIdRetryTimer = setTimeout(() => compatibilityContext.initPeer(), delay);
          return;
        }

        console.log('[Room] Master da sala já existe. Conectando como membro regular da sala...');
        compatibilityContext.isRoomMasterAttempt = false;
        if (compatibilityContext.peer) {
          try { compatibilityContext.peer.destroy(); } catch (e) {}
          compatibilityContext.peer = null;
        }
        compatibilityContext.initPeer();
        return;
      }

      const isHost = typeof window !== 'undefined' && window.location ? !window.location.pathname.endsWith('viewer.html') : true;
      const takenId = (isHost ? compatibilityContext.getCustomStreamerId() : null) || compatibilityContext.myId;

      const isSelfSession = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('seemygame_last_id') === takenId;
      const isReload = typeof performance !== 'undefined' && (performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload' || performance.navigation?.type === 1);

      // Se o erro ocorreu durante o reload da página ou sessão recente do próprio streamer,
      // a conexão anterior no servidor PeerJS ainda pode estar em processo de liberação (grace period).
      if (isHost && takenId && (isSelfSession || isReload) && compatibilityContext.customIdRetryAttempts < compatibilityContext.MAX_CUSTOM_ID_RETRIES) {
        compatibilityContext.customIdRetryAttempts++;
        const delay = Math.min(1000 + 1000 * compatibilityContext.customIdRetryAttempts, 5000);
        console.warn(`[PeerJS] ID "${takenId}" ainda retido pelo servidor de sinalização. Tentativa de recuperação ${compatibilityContext.customIdRetryAttempts}/${compatibilityContext.MAX_CUSTOM_ID_RETRIES} em ${delay}ms...`);

        if (compatibilityContext.copyBadge) {
          compatibilityContext.copyBadge.innerHTML = `<span>⏳</span> Liberando ID <strong>${takenId}</strong>... (${compatibilityContext.customIdRetryAttempts}/${compatibilityContext.MAX_CUSTOM_ID_RETRIES})`;
        }
        if (compatibilityContext.customIdModal) {
          compatibilityContext.customIdModal.style.display = 'none';
        }
        compatibilityContext.showToast(`Aguardando liberação do ID "${takenId}" da sessão anterior... (${compatibilityContext.customIdRetryAttempts}/${compatibilityContext.MAX_CUSTOM_ID_RETRIES})`, 'info', delay);

        if (compatibilityContext.peer) {
          try { compatibilityContext.peer.destroy(); } catch (e) {}
          compatibilityContext.peer = null;
        }

        if (compatibilityContext.customIdRetryTimer) clearTimeout(compatibilityContext.customIdRetryTimer);
        compatibilityContext.customIdRetryTimer = setTimeout(() => {
          compatibilityContext.initPeer();
        }, delay);
        return;
      }

      compatibilityContext.customIdRetryAttempts = 0;
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('seemygame_last_id');
      }
      compatibilityContext.showToast(`O ID "${takenId}" já está em uso por outro streamer. Escolha outro ID fixo.`, 'error', 7000);
      if (compatibilityContext.copyBadge) {
        compatibilityContext.copyBadge.innerHTML = `<span>⚠️</span> ID <strong>${takenId}</strong> em uso (clique para tentar)`;
        compatibilityContext.copyBadge.style.cursor = 'pointer';
        compatibilityContext.copyBadge.onclick = () => {
          compatibilityContext.showToast(`Tentando reconectar com ID "${takenId}"...`, 'info');
          compatibilityContext.resetPeer();
          compatibilityContext.initPeer();
        };
      }
      if (compatibilityContext.customIdModal) {
        if (compatibilityContext.customIdInput) {
          compatibilityContext.customIdInput.value = takenId || '';
        }
        compatibilityContext.customIdModal.style.display = 'flex';
        if (compatibilityContext.customIdError) {
          compatibilityContext.customIdError.textContent = `O ID "${takenId}" já está em uso no momento. Por favor escolha outro ou tente novamente.`;
          compatibilityContext.customIdError.style.display = 'block';
        }
      }
    } else {
      compatibilityContext.showToast(`Erro P2P: ${err.type || err.message}`, 'error');
    }
  });

  return compatibilityContext.peer;
}

export function broadcastDataMessage(compatibilityContext, payload, excludePeerId = null) {
  if (compatibilityContext.isRoomMode() && compatibilityContext.roomManager) {
    compatibilityContext.roomManager.broadcast(payload, excludePeerId);
    return;
  }

  const hostPin = compatibilityContext.getStoredRoomPin();
  // Transmissor envia para todos os espectadores conectados e autorizados
  compatibilityContext.connectedViewers.forEach((conn, peerId) => {
    if (peerId !== excludePeerId && conn && conn.open !== false) {
      if (hostPin && !compatibilityContext.authenticatedViewers.has(peerId)) return;
      try {
        conn.send(payload);
      } catch (e) {}
    }
  });

  // Espectador envia para o host
  compatibilityContext.watchingHosts.forEach((hostData) => {
    if (hostData.conn && hostData.conn.open !== false) {
      try {
        hostData.conn.send(payload);
      } catch (e) {}
    }
  });
}

export function setupVoiceMediaCall(compatibilityContext, call, remotePeerId) {
  if (!call) return;
  compatibilityContext.activeVoiceCalls.set(remotePeerId, call);

  call.on('stream', (remoteAudioStream) => {
    const member = compatibilityContext.roomManager?.members?.get(remotePeerId);
    compatibilityContext.voiceManager.addRemoteParticipant(remotePeerId, {
      name: member?.name || call.metadata?.name || 'Amigo',
      role: member?.role || call.metadata?.role || (call.metadata?.isMaster ? 'host' : 'member'),
      stream: remoteAudioStream
    });
  });

  call.on('close', () => {
    compatibilityContext.voiceManager.removeRemoteParticipant(remotePeerId);
    compatibilityContext.activeVoiceCalls.delete(remotePeerId);
  });

  call.on('error', (err) => {
    console.error(`Erro na chamada de voz com ${remotePeerId}:`, err);
    compatibilityContext.voiceManager.removeRemoteParticipant(remotePeerId);
    compatibilityContext.activeVoiceCalls.delete(remotePeerId);
  });
}

export function handleIncomingVoiceCall(compatibilityContext, call) {
  const remotePeerId = call.peer;
  const isAuthorized = compatibilityContext.isPeerAuthorizedForMedia(remotePeerId) || compatibilityContext.watchingHosts.has(remotePeerId);
  if (!isAuthorized) {
    console.warn(`Chamada de voz não autorizada rejeitada de: ${remotePeerId}`);
    try { call.close(); } catch (e) {}
    return;
  }

  const streamToAnswer = compatibilityContext.voiceManager.localStream || new MediaStream();
  call.answer(streamToAnswer);
  compatibilityContext.setupVoiceMediaCall(call, remotePeerId);
}
