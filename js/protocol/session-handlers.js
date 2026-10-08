import { handleHostCoopMessage, handleViewerCoopMessage } from '../coop.js';
import { PROTOCOL_TYPES } from './messages.js';

export function bindSessionMessageHandlers(session, {
  role,
  coopController = null,
  chatManager,
  voiceManager,
  isAuthorizedPeer = () => true,
  getPeer = () => null,
  getLocalPeerId = () => null,
  getChatIdentity = () => null,
  isTrustedChatRelayPeer = () => false,
  getDataConnections = () => [],
  getPeerRole = () => null,
  broadcast = null,
  showToast = () => {},
  getVideoCard = () => null,
  getVoiceChannelId = null,
  getPeerVoiceChannelId = () => null,
  getVoicePeerIds = () => []
} = {}) {
  const dispatcher = session.dispatcher;
  const relay = (data, sourceConn) => {
    if (typeof broadcast === 'function') broadcast(data, sourceConn?.peer);
  };
  const unsubs = [];
  const register = (type, handler, description) => {
    unsubs.push(dispatcher.register(type, handler, { description }));
  };

  register('CHAT_MESSAGE', (data, sourceConn) => {
    if (!data.message || !chatManager) return;
    const transportPeerId = sourceConn?.peer;
    if (!transportPeerId) return;
    const trustedRelay = role === 'viewer' && isTrustedChatRelayPeer(transportPeerId);
    const forwarded = trustedRelay && data.relayedBy === transportPeerId;
    const verifiedSenderId = forwarded ? data.message.senderId : transportPeerId;
    if (typeof verifiedSenderId !== 'string' || !verifiedSenderId || verifiedSenderId.length > 64) return;
    const identity = getChatIdentity(verifiedSenderId);
    const message = { ...data.message };
    message.senderId = verifiedSenderId;
    message.senderName = identity?.name || (forwarded ? message.senderName :
      (trustedRelay ? 'Streamer' : `Amigo ${verifiedSenderId.slice(-4)}`));
    message.role = identity?.role || (forwarded && ['viewer', 'player2'].includes(message.role) ? message.role :
      (trustedRelay && !forwarded ? 'host' : 'viewer'));
    if (!['host', 'viewer', 'player2'].includes(message.role)) message.role = 'viewer';
    message.isSystem = false;
    const stored = chatManager.addMessage(message);
    if (stored) {
      session.eventBus.emit('chat:message-received', stored);
      // Only the Streamer forwards chat. Room members communicate directly;
      // forwarding there would erase authorship at the next untrusted hop.
      if (role === 'streamer') relay({ ...data, message: stored, relayedBy: getLocalPeerId() }, sourceConn);
    }
  }, 'Session chat receive and relay');

  register('VOICE_STATE_UPDATE', (data, sourceConn) => {
    const transportPeerId = sourceConn?.peer;
    const trustedRelay = role === 'viewer' && isTrustedChatRelayPeer(transportPeerId) && data.relayedBy === transportPeerId;
    const peerId = data.peerId || transportPeerId;
    if (session.isDisposed || !transportPeerId || !isAuthorizedPeer(transportPeerId) ||
        (!trustedRelay && peerId !== transportPeerId)) return;
    voiceManager?.updateParticipantState(peerId, {
      isSpeaking: data.isSpeaking,
      isMuted: data.isMuted,
      isDeafened: data.isDeafened
    });
    session.eventBus.emit('voice:state-updated', data);
    if (role === 'streamer') relay({ ...data, peerId, relayedBy: getLocalPeerId() }, sourceConn);
  }, 'Session voice state receive and relay');

  const activeVoiceCalls = new Map();
  const pendingVoiceCalls = new Map();
  const negotiationTimers = new Map();
  const negotiationTimeoutMs = 5000;
  const maxVoiceRetries = 2;
  const sameVoiceChannel = peerId => !getVoiceChannelId || Boolean(getVoiceChannelId() && getVoiceChannelId() === getPeerVoiceChannelId(peerId));
  const replaceVoiceTrack = ({ newTrack }) => {
    if (session.isDisposed || !voiceManager?.isInVoice || !newTrack) return;
    for (const call of activeVoiceCalls.values()) {
      for (const sender of call.peerConnection?.getSenders?.() || []) {
        if (sender.track?.kind !== 'audio') continue;
        Promise.resolve().then(() => {
          if (session.isDisposed || activeVoiceCalls.get(call.peer) !== call || !voiceManager.isInVoice) return;
          return sender.replaceTrack(newTrack);
        }).catch(error => {
          session.eventBus.emit('system:error', { sourceEvent: 'voice:replace-track', error });
          if (activeVoiceCalls.get(call.peer) === call) removeVoicePeer(call.peer);
        });
      }
    }
  };
  voiceManager?.on?.('audioInputTrackChange', replaceVoiceTrack);
  session.registerCleanup(() => voiceManager?.off?.('audioInputTrackChange', replaceVoiceTrack));
  const voicePeers = new Set();
  const connectVoiceTo = (peerId, attempt = 0) => {
    const localPeerId = getLocalPeerId();
    if (!peerId || !localPeerId || localPeerId.localeCompare(peerId) >= 0) return null;
    if (session.isDisposed || (!voicePeers.has(peerId) && !getVoiceChannelId) || !isAuthorizedPeer(peerId) || !sameVoiceChannel(peerId)) return null;
    if (!voiceManager?.isInVoice || !voiceManager.localStream || activeVoiceCalls.has(peerId)) return null;
    const peer = getPeer();
    if (!peer || peer.destroyed) return null;
    const call = peer.call(peerId, voiceManager.localStream, {
      metadata: { type: 'VOICE_CHAT', name: voiceManager.myName, role: voiceManager.myRole,
        ...(getVoiceChannelId ? { voiceChannelId: getVoiceChannelId() } : {}) }
    });
    bindVoiceCall(call);
    // An unanswered PeerJS offer can remain open locally after the recipient
    // rejects it. Bound that wait and retry only while channel/authority agree.
    if (call && getVoiceChannelId && activeVoiceCalls.get(peerId) === call) {
      const channelId = getVoiceChannelId();
      negotiationTimers.set(call, setTimeout(() => {
        negotiationTimers.delete(call);
        if (activeVoiceCalls.get(peerId) !== call) return;
        removeVoicePeer(peerId);
        if (attempt < maxVoiceRetries && channelId === getVoiceChannelId()) connectVoiceTo(peerId, attempt + 1);
      }, negotiationTimeoutMs));
    }
    return call;
  };
  const clearNegotiationTimer = call => {
    clearTimeout(negotiationTimers.get(call));
    negotiationTimers.delete(call);
  };
  const clearPendingVoiceCall = (peerId, close = true) => {
    const pending = pendingVoiceCalls.get(peerId);
    if (!pending) return;
    pendingVoiceCalls.delete(peerId);
    clearTimeout(pending.timer);
    if (close) { try { pending.call.close(); } catch (_) {} }
  };
  const removeVoicePeer = (peerId) => {
    clearPendingVoiceCall(peerId);
    const call = activeVoiceCalls.get(peerId);
    activeVoiceCalls.delete(peerId);
    clearNegotiationTimer(call);
    try { call?.close?.(); } catch (_) {}
    voiceManager?.removeRemoteParticipant(peerId);
  };
  const bindVoiceCall = (call) => {
    if (!call || !voiceManager) return;
    const peerId = call.peer;
    const previous = activeVoiceCalls.get(peerId);
    if (previous && previous !== call) {
      activeVoiceCalls.delete(peerId);
      clearNegotiationTimer(previous);
      try { previous.close(); } catch (_) {}
    }
    activeVoiceCalls.set(peerId, call);
    call.on('stream', (stream) => {
      if (session.isDisposed || activeVoiceCalls.get(peerId) !== call || !voiceManager.isInVoice || !sameVoiceChannel(peerId) ||
          (getVoiceChannelId && call.metadata?.voiceChannelId !== getVoiceChannelId())) return;
      clearNegotiationTimer(call);
      voiceManager.addRemoteParticipant(peerId, {
        name: call.metadata?.name || 'Jogador',
        role: call.metadata?.role || 'member',
        stream
      });
    });
    const cleanup = () => {
      clearNegotiationTimer(call);
      if (activeVoiceCalls.get(peerId) !== call) return;
      activeVoiceCalls.delete(peerId);
      voiceManager.removeRemoteParticipant(peerId);
    };
    call.on('close', cleanup);
    call.on('error', cleanup);
  };
  session.registerCleanup(() => {
    for (const peerId of new Set([...activeVoiceCalls.keys(), ...pendingVoiceCalls.keys()])) removeVoicePeer(peerId);
    activeVoiceCalls.clear();
    voicePeers.clear();
  });
  const syncVoicePeers = () => {
    if (!getVoiceChannelId || session.isDisposed) return;
    for (const id of [...activeVoiceCalls.keys()]) if (!isAuthorizedPeer(id) || !sameVoiceChannel(id)) removeVoicePeer(id);
    for (const [id, { call }] of [...pendingVoiceCalls]) {
      if (!isAuthorizedPeer(id) || !voiceManager.isInVoice || !voiceManager.localStream || call.metadata?.voiceChannelId !== getVoiceChannelId()) clearPendingVoiceCall(id);
      else if (sameVoiceChannel(id)) {
        clearPendingVoiceCall(id, false);
        call.answer(voiceManager.localStream);
        bindVoiceCall(call);
      }
    }
    for (const id of getVoicePeerIds()) if (sameVoiceChannel(id)) connectVoiceTo(id);
  };

  const resolvePeerRole = (peerId) => {
    if (!peerId) return null;
    if (typeof getPeerRole === 'function') {
      const r = getPeerRole(peerId);
      if (r) return r;
    }
    const connections = typeof getDataConnections === 'function' ? getDataConnections() : [];
    for (const conn of connections) {
      if (conn?.peer === peerId) {
        return conn?.metadata?.role || conn?.role || null;
      }
    }
    return null;
  };

  const isReadonlyViewer = (connOrPeerId) => {
    if (!connOrPeerId) return false;
    if (typeof connOrPeerId === 'string') {
      const role = resolvePeerRole(connOrPeerId);
      return role === 'readonly-viewer' || role === 'readonly';
    }
    const r = connOrPeerId?.metadata?.role || connOrPeerId?.role || resolvePeerRole(connOrPeerId?.peer);
    return r === 'readonly-viewer' || r === 'readonly';
  };

  register('VOICE_SIGNAL', (data, sourceConn) => {
    const peerId = data.peerId || sourceConn?.peer;
    if (!peerId || !isAuthorizedPeer(peerId) || (sourceConn?.peer && peerId !== sourceConn.peer)) return;
    if (isReadonlyViewer(sourceConn) && (data.action === 'VOICE_JOINED' || data.action === 'HOST_VOICE_ACTIVE')) {
      console.warn(`[Protocol] Sinais de voz rejeitados de espectador somente-leitura: ${peerId}`);
      return;
    }
    if (data.action === 'LEAVE') {
      voicePeers.delete(peerId);
      removeVoicePeer(peerId);
    } else if (data.action === 'HOST_VOICE_ACTIVE' || data.action === 'VOICE_JOINED') {
      voicePeers.add(peerId);
      if (peerId !== getLocalPeerId()) connectVoiceTo(peerId);
      showToast(data.action === 'HOST_VOICE_ACTIVE'
        ? 'O Streamer está na sala de voz!'
        : `${data.name || 'Um amigo'} entrou na sala de voz!`, 'info');
    }
    session.eventBus.emit('voice:signal', data);
    if (role !== 'room') relay(data, sourceConn);
  }, 'Session voice signaling');

  const coopTypes = [
    'COOP_REQUEST', 'COOP_RESPONSE', 'COOP_CAPABILITIES', 'COOP_CONFIG',
    'COOP_SLOTS_UPDATE', 'COOP_RELEASE', 'COOP_REVOKE', 'COOP_INPUT',
    'COOP_PEER_DISCONNECTED', 'COOP_TARGET', 'GAMEPAD_RUMBLE'
  ];
  const playerCommands = new Set(['COOP_RESPONSE', 'COOP_CAPABILITIES', 'COOP_CONFIG', 'COOP_SLOTS_UPDATE', 'COOP_REVOKE', 'GAMEPAD_RUMBLE']);
  for (const type of coopTypes) {
    register(type, (data, sourceConn) => {
      if (session.isDisposed || !sourceConn?.peer || !isAuthorizedPeer(sourceConn.peer)) return;
      if (role === 'room' && playerCommands.has(type) || role === 'viewer') {
        const selectedHost = coopController?.getCoopState?.().activeHostPeerId;
        if (type !== 'COOP_CONFIG' && type !== 'COOP_SLOTS_UPDATE' && selectedHost && selectedHost !== sourceConn.peer) return;
        (coopController?.handleViewerCoopMessage || handleViewerCoopMessage)(data, sourceConn.peer, getVideoCard(sourceConn.peer), sourceConn);
      } else if (role === 'streamer' || role === 'room') {
        if (isReadonlyViewer(sourceConn)) {
          if (type === 'COOP_REQUEST') {
            try { sourceConn.send?.({ type: 'COOP_DENY', reason: 'readonly_not_permitted' }); } catch (_) {}
          }
          return;
        }
        if (sourceConn?.peer) (coopController?.handleHostCoopMessage || handleHostCoopMessage)(sourceConn.peer, data, sourceConn);
      }
    }, `Session Co-op: ${type}`);
  }

  // Inputs vão apenas ao host escolhido; sua autorização por peer/slot fica
  // no controlador Co-op. Não os retransmita aos outros membros da sala.
  if (role === 'streamer' || role === 'room') {
    const { INPUT_KEY, INPUT_MOUSE, INPUT_GAMEPAD, INPUT_RESET } = PROTOCOL_TYPES.COOP;
    for (const type of [INPUT_KEY, INPUT_MOUSE, INPUT_GAMEPAD, INPUT_RESET]) {
      register(type, (data, sourceConn) => {
        if (session.isDisposed || !sourceConn?.peer) return;
        if (isReadonlyViewer(sourceConn)) return;
        (coopController?.handleHostCoopMessage || handleHostCoopMessage)(sourceConn.peer, data, sourceConn);
      }, `Session Co-op input: ${type}`);
    }
  }

  session.registerCleanup(() => unsubs.splice(0).forEach((unsubscribe) => unsubscribe()));

  return {
    bindVoiceCall,
    connectVoiceTo,
    syncVoicePeers,
    closeVoiceCalls() { for (const id of new Set([...activeVoiceCalls.keys(), ...pendingVoiceCalls.keys()])) removeVoicePeer(id); },
    answerVoiceCall(call) {
      if (!call || !voiceManager) return false;
      if (typeof isAuthorizedPeer === 'function' && !isAuthorizedPeer(call.peer)) {
        console.warn(`[Voice] Chamada de voz rejeitada de peer não autorizado: ${call.peer}`);
        try { call.close(); } catch (_) {}
        return false;
      }
      const peerRole = resolvePeerRole(call.peer) || call.metadata?.role;
      if (peerRole === 'readonly-viewer' || peerRole === 'readonly' || isReadonlyViewer(call.peer)) {
        console.warn(`[Voice] Chamada de áudio rejeitada de peer somente-leitura: ${call.peer}`);
        try { call.close(); } catch (_) {}
        return false;
      }
      const stream = voiceManager.isInVoice ? voiceManager.localStream : null;
      if (!stream || session.isDisposed ||
          (getVoiceChannelId && call.metadata?.voiceChannelId !== getVoiceChannelId())) {
        try { call.close(); } catch (_) {}
        return false;
      }
      if (!sameVoiceChannel(call.peer)) {
        // Data presence and the media offer travel independently. Wait for
        // verified matching presence; do not answer or expose audio meanwhile.
        clearPendingVoiceCall(call.peer);
        const pending = { call, timer: setTimeout(() => clearPendingVoiceCall(call.peer), negotiationTimeoutMs) };
        pendingVoiceCalls.set(call.peer, pending);
        const release = () => { if (pendingVoiceCalls.get(call.peer) === pending) clearPendingVoiceCall(call.peer, false); };
        call.on('close', release);
        call.on('error', release);
        return false;
      }
      call.answer(stream);
      bindVoiceCall(call);
      return true;
    },
    activeVoiceCalls,
    getDataConnections
  };
}
