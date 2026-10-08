/** session-identity: commands receive explicit compatibility ports; no page initialization. */
export function setTreeRelayEnabled(compatibilityContext, enabled) {
  compatibilityContext.isTreeRelayEnabled = Boolean(enabled);
  if (!compatibilityContext.isTreeRelayEnabled) {
    compatibilityContext.roomRelayManager = null;
  }
}

export function isRoomMode(compatibilityContext) {
  return typeof window !== 'undefined' && window.location ? window.location.pathname.endsWith('room.html') : false;
}

export function getRoomInfoFromUrl(compatibilityContext) {
  if (typeof window === 'undefined' || !window.location) return { roomId: 'general', roomPin: null };
  const hash = window.location.hash || '';
  const search = window.location.search || '';

  let roomId = 'general';
  let pin = null;

  if (hash.includes('room=')) {
    roomId = hash.split('room=')[1].split('&')[0];
  } else if (search.includes('room=')) {
    const params = new URLSearchParams(search);
    roomId = params.get('room') || 'general';
  } else if (hash.includes('watch=')) {
    roomId = `watch-${hash.split('watch=')[1].split('&')[0]}`;
  }

  if (hash.includes('pin=')) {
    pin = hash.split('pin=')[1].split('&')[0];
  }

  return { roomId: compatibilityContext.sanitizeRoomId(roomId), roomPin: pin };
}

export function getCustomStreamerId(compatibilityContext) {
  try {
    if (typeof localStorage !== 'undefined') {
      const id = localStorage.getItem('seemygame_custom_id');
      if (id && compatibilityContext.isValidPeerId(id.trim())) {
        return id.trim();
      }
    }
  } catch (e) {}
  return null;
}

export function setCustomStreamerId(compatibilityContext, newId) {
  if (!newId) {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('seemygame_custom_id');
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('seemygame_last_id');
    }
    return true;
  }
  const trimmed = String(newId).trim();
  if (compatibilityContext.isValidPeerId(trimmed) && trimmed.length >= 3 && trimmed.length <= 30) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('seemygame_custom_id', trimmed);
    }
    return true;
  }
  return false;
}

export function getStoredRoomPin(compatibilityContext) {
  try {
    if (typeof localStorage !== 'undefined') {
      const pin = localStorage.getItem('seemygame_streamer_pin');
      return pin ? String(pin).trim() : '';
    }
  } catch (e) {}
  return '';
}

export function setStoredRoomPin(compatibilityContext, newPin) {
  if (typeof localStorage === 'undefined') return;
  if (!newPin) {
    localStorage.removeItem('seemygame_streamer_pin');
  } else {
    localStorage.setItem('seemygame_streamer_pin', String(newPin).trim());
  }
}

export function getClientSessionId(compatibilityContext) {
  let sid = null;
  try { sid = sessionStorage.getItem('seemygame_client_session_id'); } catch (_) {}
  if (!sid) {
    sid = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    try { sessionStorage.setItem('seemygame_client_session_id', sid); } catch (_) {}
  }
  return sid;
}

export function isCurrentlyStreaming(compatibilityContext) {
  const hasBrowserMedia = Boolean(compatibilityContext.localStream && (compatibilityContext.localStream.active !== false) && (typeof compatibilityContext.localStream.getVideoTracks !== 'function' || compatibilityContext.localStream.getVideoTracks().length > 0));
  const hasNativeCapture = Boolean(compatibilityContext.isDesktopApp() && compatibilityContext.activeNativeCaptureProvider?.session?.sessionId);
  const hasRoomStreaming = Boolean(compatibilityContext.roomManager && compatibilityContext.roomManager.localStreamingState?.isStreaming);
  return hasBrowserMedia || hasNativeCapture || hasRoomStreaming;
}

export function getLocalUserDisplayName(compatibilityContext) {
  // 1. Apelido salvo nas preferências do usuário ou modal de entrada
  let savedName = null;
  try { savedName = localStorage.getItem('seemygame_user_name'); } catch (_) {}
  if (savedName && savedName.trim()) {
    return savedName.trim().slice(0, 30);
  }

  // 2. Apelido atribuído na sala (caso o usuário tenha inserido ao entrar)
  if (compatibilityContext.isRoomMode() && compatibilityContext.roomManager?.userName && compatibilityContext.roomManager.userName.trim()) {
    const rName = compatibilityContext.roomManager.userName.trim();
    if (rName !== 'Host' && !rName.startsWith('Amigo ') && rName !== 'Streamer') {
      return rName.slice(0, 30);
    }
  }

  // 3. Fallback amigável sem roles técnicas: "Amigo XXXX" ou "Amigo"
  if (compatibilityContext.myId && typeof compatibilityContext.myId === 'string') {
    return `Amigo ${compatibilityContext.myId.slice(-4)}`;
  }
  return 'Amigo';
}

export function isPeerAuthorizedForMedia(compatibilityContext, peerId) {
  if (!peerId) return false;
  if (compatibilityContext.isRoomMode()) {
    return Boolean(compatibilityContext.roomManager && compatibilityContext.roomManager.isPeerAuthorized(peerId));
  }
  if (!compatibilityContext.connectedViewers.has(peerId)) return false;
  const hostPin = compatibilityContext.getStoredRoomPin();
  if (!hostPin) return true;
  return compatibilityContext.authenticatedViewers.has(peerId);
}

export function promptViewerPin(compatibilityContext, targetId, errorMsg = null) {
  compatibilityContext.currentPinTargetId = targetId;
  if (compatibilityContext.pinPromptModal) {
    compatibilityContext.pinPromptModal.style.display = 'flex';
    if (compatibilityContext.viewerPinInput) {
      compatibilityContext.viewerPinInput.value = '';
      compatibilityContext.viewerPinInput.focus();
    }
    if (compatibilityContext.viewerPinError) {
      if (errorMsg) {
        compatibilityContext.viewerPinError.textContent = errorMsg;
        compatibilityContext.viewerPinError.style.display = 'block';
      } else {
        compatibilityContext.viewerPinError.textContent = '';
        compatibilityContext.viewerPinError.style.display = 'none';
      }
    }
  }
}

export function hideViewerPinModal(compatibilityContext) {
  if (compatibilityContext.pinPromptModal) {
    compatibilityContext.pinPromptModal.style.display = 'none';
  }
  if (compatibilityContext.viewerPinError) {
    compatibilityContext.viewerPinError.textContent = '';
    compatibilityContext.viewerPinError.style.display = 'none';
  }
  compatibilityContext.currentPinTargetId = null;
}

export function submitViewerPin(compatibilityContext, pin) {
  const trimmed = pin ? String(pin).trim() : '';
  if (!trimmed) {
    if (compatibilityContext.viewerPinError) {
      compatibilityContext.viewerPinError.textContent = 'Por favor, digite o PIN da sala.';
      compatibilityContext.viewerPinError.style.display = 'block';
    }
    return;
  }

  if (compatibilityContext.isRoomMode() && compatibilityContext.roomManager && !compatibilityContext.roomManager.isMaster) {
    let masterConn = compatibilityContext.roomManager.pendingConnections.get(compatibilityContext.roomManager.masterPeerId) ||
                     compatibilityContext.roomManager.meshConnections.get(compatibilityContext.roomManager.masterPeerId) ||
                     compatibilityContext.connectedViewers.get(compatibilityContext.roomManager.masterPeerId);
    if (!masterConn || !masterConn.open) {
      if (compatibilityContext.peer && !compatibilityContext.peer.destroyed) {
        masterConn = compatibilityContext.peer.connect(compatibilityContext.roomManager.masterPeerId, { reliable: true });
        compatibilityContext.setupIncomingDataConnection(masterConn);
        masterConn.on('open', () => {
          masterConn.send({
            type: 'ROOM_JOIN_REQUEST',
            name: compatibilityContext.roomManager.userName,
            pin: trimmed,
            isMuted: compatibilityContext.voiceManager?.isMuted || false,
            isDeafened: compatibilityContext.voiceManager?.isDeafened || false,
            isStreaming: false
          });
        });
      }
      return;
    }
    masterConn.send({
      type: 'ROOM_JOIN_REQUEST',
      name: compatibilityContext.roomManager.userName,
      pin: trimmed,
      isMuted: compatibilityContext.voiceManager?.isMuted || false,
      isDeafened: compatibilityContext.voiceManager?.isDeafened || false,
      isStreaming: false
    });
    return;
  }

  if (compatibilityContext.currentPinTargetId) {
    const hostData = compatibilityContext.watchingHosts.get(compatibilityContext.currentPinTargetId);
    if (hostData && hostData.conn && hostData.conn.open) {
      hostData.conn.send({ type: 'REQUEST_STREAM', pin: trimmed });
    }
  }
}

export function updateViewerCountUI(compatibilityContext) {
  if (compatibilityContext.viewerCountBadge) {
    const count = compatibilityContext.connectedViewers.size;
    compatibilityContext.viewerCountBadge.innerHTML = `<span>👥</span> <strong>${count}</strong> ${count === 1 ? 'espectador' : 'espectadores'}`;
  }
}

export function applyCoopModeChange(compatibilityContext, val) {
  const isEnabled = (val !== 'disabled');
  compatibilityContext.setCoopEnabled(isEnabled);
  let maxPlayers = 1;
  let partyMode = false;
  let toastMsg = '🔒 Co-op desativado.';

  if (isEnabled) {
    if (val === 'party_4p') {
      maxPlayers = 4;
      partyMode = true;
      toastMsg = '🎉 Modo Party / Torneio ativado (4 jogadores remotos nos slots P1 a P4).';
    } else if (val === 'enabled_4p') {
      maxPlayers = 4;
      partyMode = false;
      toastMsg = '🎮 Modo Co-op 4 Players ativado (Host P1 + até 3 amigos nos controles P2, P3, P4).';
    } else if (val === 'enabled_2p' || val === 'enabled') {
      maxPlayers = 1;
      partyMode = false;
      toastMsg = '🎮 Modo Co-op ativado (Player 2 habilitado).';
    }
    compatibilityContext.setMaxCoopPlayers(maxPlayers);
    compatibilityContext.setPartyModeEnabled(partyMode);
  }

  compatibilityContext.showToast(toastMsg, 'info');

  const coopMsg = {
    type: 'COOP_CONFIG',
    enabled: isEnabled,
    maxPlayers: isEnabled ? maxPlayers : 0,
    partyMode
  };

  compatibilityContext.connectedViewers.forEach((conn) => {
    try { conn.send(coopMsg); } catch (e) {}
  });

  if (compatibilityContext.roomManager) {
    compatibilityContext.roomManager.broadcast(coopMsg);
  }
}
