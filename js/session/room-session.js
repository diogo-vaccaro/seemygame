import { bindCaptureSettings, bindQualityCapabilities, isNativeCaptureProvider, readCaptureSettings } from '../capture/settings.js';
import { createInitialCodecTransform } from '../streaming/codecs.js';
import { createQualityController } from '../streaming/adaptation.js';
import { captureVideoConstraints, videoScaleForProfile } from '../streaming/quality.js';
import { bindStreamingQuality } from '../streaming/settings-controller.js';
import { initGreenRoomLobby as mountGreenRoomLobby } from '../app/green-room.js';
import { getClientSessionId } from '../app/session-identity.js';
import { handleReloadKeypress, showReloadConfirmationModal, hideReloadConfirmationModal } from '../app/session-lifecycle.js';
import { createStatsMonitorScope } from '../stats.js';
import { NativeCaptureProvider } from '../capture.js';
import { requestBrowserDisplayMedia } from '../browser-capture.js';
import { bindSourcePicker } from '../capture/source-picker.js';
import { installNativeCaptureBridge } from '../native-webrtc.js';
import { sendSessionMessage } from '../protocol/transport.js';
import { 
  getPeerConfig, 
  fetchIceServersFromApi,
  TERMS_VERSION 
} from '../config.js';
import { 
  hookPeerConnectionSdp, 
  applyTransceiverOptimizations,
  applySenderOptimizationsWhenReady
} from '../webrtc.js';
import { 
  RoomManager, 
  sanitizeRoomId, 
  getRoomMasterPeerId 
} from '../room.js';
import { 
  RelayManager 
} from '../relay.js';
import { VoiceManager } from '../voice.js';
import { ChatManager } from '../chat.js';
import { 
  DiscordUIController 
} from '../discord-ui.js';
import { 
  getAudioDevices, 
  populateDeviceSelect, 
  playTestTone, 
  isAudioOutputSupported,
  getSavedAudioPreferences,
  saveAudioPreference,
  watchDeviceChanges
} from '../audio-devices.js';
import { initTuningAudioDeviceControls } from '../app/tuning-controller.js';
import { 
  showToast, 
  initTermsModal, 
  addOrUpdateVideoCard, 
  removeVideoCard,
  createPlaceholderCard,
  hideCardLoading,
  showCoopPromptModal,
  updateCoopUI
} from '../ui.js';
import { globalBus } from '../core/event-bus.js';
import { createSessionContext } from '../core/session-context.js';
import { bindSessionMessageHandlers } from '../protocol/session-handlers.js';
import { toggleCoopCardControl } from '../coop/card-action.js';
import { bindRoomIdentity } from './room-identity.js';
import { bindRoomSettings } from './room-settings.js';
import { bindRoomVoiceState } from './room-voice-state.js';
import { createCoordinatorReconnect } from './coordinator-reconnect.js';
import { streamerMode } from '../room/streamer-mode.js';
import { roomToolsController } from '../room/room-tools.js';
import { registerSessionFeatures } from '../plugins/session-composition.js';
import { createCoopController } from '../coop/controller.js';

/** Creates a runtime whose state and resource lifetime belong to one session. */
export function createRoomSession(options = {}) {
const statsScope = createStatsMonitorScope();
const { startStatsMonitor, stopStatsMonitor, getLastMetrics } = statsScope;
const coopController = options.coopController || createCoopController({ sendMessage: (conn, data) => sendSessionMessage(roomState.session, conn, data) });
const {  setupGamepadTesterModal  } = coopController;
const chatManager = options.chatManager || new ChatManager();
let audioScope = null;
const voiceManager = options.voiceManager || new VoiceManager({ audioContextProvider: () => audioScope?.getContext() });
const instanceKey = Symbol('room-entry');
let activeRuntime = null;
const navigateHome = options.navigateHome || (() => window.location.assign('index.html'));

const isRoomPage = true;

const roomState = {
  peer: null,
  roomManager: null,
  relayManager: null,
  discordUI: null,
  currentRoomId: 'general',
  currentPin: null,
  userName: 'Gamer',
  isTreeRelayEnabled: true,
  session: null,
  coordinatorConn: null,
  localStream: null,
  captureProvider: null,
  remoteStreams: new Map(),
  screenCalls: new Map(),
  pendingVoiceChannelId: null,
  messageHandlers: null
};

function getRoomInfoFromUrl() {
  if (typeof window === 'undefined' || !window.location) {
    return { roomId: 'general', roomPin: null, roomKey: null };
  }
  const hash = window.location.hash || '';
  const search = window.location.search || '';
  const full = `${search}&${hash.replace(/^#/, '')}`;

  const match = hash.match(/room=([a-zA-Z0-9_-]+)/) || search.match(/room=([a-zA-Z0-9_-]+)/);
  const roomId = match ? sanitizeRoomId(match[1]) : 'general';

  const pinMatch = full.match(/pin=([0-9]{4,8})/);
  const roomPin = pinMatch ? pinMatch[1] : null;

  const keyMatch = full.match(/key=([A-Za-z0-9_-]{16,128})/);
  const roomKey = keyMatch ? keyMatch[1] : null;

  return { roomId, roomPin, roomKey };
}

async function initGreenRoomLobby(onProceed) {
  const session = roomState.session;
  return mountGreenRoomLobby({
    getRoomInfoFromUrl,
    getAudioDevices,
    populateDeviceSelect,
    playTestTone,
    isAudioOutputSupported,
    getSavedAudioPreferences,
    saveAudioPreference,
    watchDeviceChanges,
    voiceManager,
    getAudioContext: () => session?.audioScope.getContext(),
    registerCleanup: callback => session?.registerCleanup(callback),
    onProceed: () => {
      if (session?.isDisposed) return;
      const name = document.getElementById('green-room-user-name')?.value.trim();
      if (name) roomState.userName = name.slice(0, 30);
      return onProceed?.();
    }
  });
}

async function setupRoomSession(peerId, session = roomState.session) {
  const { roomId, roomPin, roomKey } = getRoomInfoFromUrl();
  roomState.currentRoomId = roomId;
  roomState.currentPin = roomPin;
  roomState.currentKey = roomKey;

  const coordinatorId = getRoomMasterPeerId(roomId, roomKey);
  const isMaster = peerId === coordinatorId;
  if (typeof sessionStorage !== 'undefined') {
    if (isMaster) {
      sessionStorage.setItem('seemygame_room_master_' + roomId, 'true');
    } else {
      sessionStorage.removeItem('seemygame_room_master_' + roomId);
    }
  }
  const savedName = typeof localStorage !== 'undefined' ? localStorage.getItem('seemygame_user_name') : null;
  if (!savedName && roomState.userName === 'Gamer') {
    roomState.userName = isMaster ? 'Host' : `Amigo ${peerId.slice(-4)}`;
  }

  // Instancia o RoomManager para a sala indicada com o contrato real de objeto de opções
  const rm = new RoomManager({
    roomId,
    userName: roomState.userName,
    clientSessionId: getClientSessionId(),
    roomPin,
    roomKey,
    onStateChange: state => {
      if (session?.isDisposed) return;
      roomState.discordUI?.updateRoomPresence(state.members);
      roomState.discordUI?.syncStageView(state.streamersCount > 0);
    }
  });
  roomState.roomManager = rm;
  bindRoomVoiceState(session, { roomManager: rm, voiceManager });
  const syncVoice = () => roomState.messageHandlers?.syncVoicePeers();
  const onChannels = () => {
    if (roomState.pendingVoiceChannelId && !rm.voiceChannels.has(roomState.pendingVoiceChannelId)) {
      leaveRoomVoice(rm, session, { preserveControls: true });
    }
    roomState.discordUI?.renderRoomChannels();
  };
  const onChannelRemoved = () => leaveRoomVoice(rm, session, { preserveControls: true });
  const onChannelError = ({ message }) => showToast(message, 'error');
  rm.on('membersUpdated', syncVoice);
  rm.on('voiceChannelsUpdated', onChannels);
  rm.on('voiceChannelRemoved', onChannelRemoved);
  rm.on('voiceChannelError', onChannelError);
  session.registerCleanup(() => { rm.off('membersUpdated', syncVoice); rm.off('voiceChannelsUpdated', onChannels); rm.off('voiceChannelRemoved', onChannelRemoved); rm.off('voiceChannelError', onChannelError); });
  const submitPinBtn = document.getElementById('viewer-pin-submit-btn');
  const cancelPinBtn = document.getElementById('viewer-pin-cancel-btn');
  const pinInput = document.getElementById('viewer-pin-input');
  const submitPin = () => {
    const pin = String(pinInput?.value || '').trim();
    if (!/^[0-9]{4,8}$/.test(pin)) {
      const error = document.getElementById('viewer-pin-error');
      if (error) { error.textContent = 'Digite um PIN de 4 a 8 números.'; error.style.display = 'block'; }
      return;
    }
    roomState.currentPin = pin;
    joinCoordinator(pin);
  };
  if (submitPinBtn) {
    submitPinBtn.addEventListener('click', submitPin);
    session?.registerCleanup(() => submitPinBtn.removeEventListener('click', submitPin));
  }
  if (pinInput) {
    const onPinKey = (event) => { if (event.key === 'Enter') { event.preventDefault(); submitPin(); } };
    pinInput.addEventListener('keydown', onPinKey);
    session?.registerCleanup(() => pinInput.removeEventListener('keydown', onPinKey));
  }
  if (cancelPinBtn) {
    const onCancel = () => { const modal = document.getElementById('pin-prompt-modal'); if (modal) modal.style.display = 'none'; };
    cancelPinBtn.addEventListener('click', onCancel);
    session?.registerCleanup(() => cancelPinBtn.removeEventListener('click', onCancel));
  }

  // Instancia RelayManager para escalabilidade em árvore
  roomState.relayManager = new RelayManager({
    originPeerId: isMaster ? peerId : null,
    maxDirectViewers: 8
  });

  rm.on('membersUpdated', () => {
    if (!rm.isMaster && rm.isPeerAuthorized(rm.masterPeerId)) {
      roomState.identityUI?.update('ready');
    }
    if (!roomState.localStream || !roomState.peer) return;
    for (const [memberId, connection] of rm.meshConnections) {
      sendRoomStream(memberId, connection, rm, session);
    }
  });
  // Conecta eventos do RoomManager à UI e ao barramento da sessão
  rm.on('streamPublished', ({ peerId: streamerPeerId, details, member }) => {
    if (streamerPeerId !== rm.myPeerId) {
      showToast(`🎮 ${member?.name || 'Um amigo'} começou a transmitir!`, 'info', 4000);
      const streamerName = member?.name || `Amigo ${streamerPeerId.slice(-4)}`;
      if (!document.getElementById(`card-${streamerPeerId}`)) {
        createPlaceholderCard(streamerPeerId, `Carregando transmissão de ${streamerName}...`, () => {
          removeVideoCard(streamerPeerId);
        });
      }
      const conn = rm.meshConnections.get(streamerPeerId);
      if (conn && conn.open) {
        try {
          sendSessionMessage(session, conn, { type: 'REQUEST_STREAM' });
        } catch (_) {}
      }
      (session?.eventBus || globalBus).emit('room:streamPublished', { peerId: streamerPeerId, details, member });
    }
  });

  rm.on('streamUnpublished', ({ peerId: streamerPeerId, member }) => {
    if (streamerPeerId !== rm.myPeerId) {
      showToast(`Transmissão de ${member?.name || streamerPeerId.slice(0, 6)} encerrada.`, 'info');
      removeVideoCard(streamerPeerId);
      (session?.eventBus || globalBus).emit('room:streamUnpublished', { peerId: streamerPeerId, member });
      session?.eventBus.emit('stream:stopped', { sourceId: streamerPeerId });
    }
  });

  rm.on('pinRequired', ({ error }) => {
    const promptModal = document.getElementById('pin-prompt-modal');
    const errEl = document.getElementById('viewer-pin-error');
    if (promptModal) promptModal.style.display = 'flex';
    if (errEl && error) {
      errEl.textContent = error;
      errEl.style.display = 'block';
    }
    (session?.eventBus || globalBus).emit('room:pinRequired', { error });
  });

  rm.on('pinAccepted', () => {
    const promptModal = document.getElementById('pin-prompt-modal');
    if (promptModal) promptModal.style.display = 'none';
    showToast('Entrada na sala autorizada!', 'success');
    roomState.identityUI?.update('ready');
    (session?.eventBus || globalBus).emit('room:pinAccepted');
  });

  const onJoinRejected = ({ error }) => {
    showToast(error || 'Não foi possível entrar na sala.', 'error');
    roomState.identityUI?.update('error');
    (session?.eventBus || globalBus).emit('room:joinRejected', { error });
  };
  rm.on('joinRejected', onJoinRejected);
  session?.registerCleanup(() => rm.off('joinRejected', onJoinRejected));

  rm.on('memberLeft', (member) => {
    if (member && member.peerId) {
      closeRoomScreenCalls(member.peerId, session);
      // ROOM_MEMBER_LEFT can remove the map entry before DataConnection's
      // close event, so that event's current-connection guard may ignore it.
      if (member.peerId === rm.masterPeerId && !rm.isMaster && rm.isInRoom && !session?.isDisposed) {
        const conn = roomState.coordinatorConn;
        roomState.coordinatorConn = null;
        try { conn?.close(); } catch (_) {}
        roomState.scheduleCoordinatorReconnect?.();
      }
      removeVideoCard(member.peerId);
      (session?.eventBus || globalBus).emit('room:memberLeft', member);
    }
  });

  const connectingMeshPeers = new Set();
  const connectMeshMembers = () => {
    if (!roomState.peer || roomState.peer.destroyed || !rm.isInRoom || rm.isMaster) return;
    for (const member of rm.members.values()) {
      if (member.peerId === rm.myPeerId || member.peerId === rm.masterPeerId || member.isMaster) continue;
      if (rm.myPeerId.localeCompare(member.peerId) >= 0) continue;
      if (connectingMeshPeers.has(member.peerId)) continue;
      if (rm.meshConnections.has(member.peerId) || rm.pendingConnections.has(member.peerId)) continue;

      connectingMeshPeers.add(member.peerId);
      const conn = roomState.peer.connect(member.peerId, { reliable: true, metadata: { type: 'ROOM_MESH', roomId } });
      if (conn) {
        const cleanup = () => connectingMeshPeers.delete(member.peerId);
        conn.once('open', cleanup);
        conn.once('close', cleanup);
        conn.once('error', cleanup);
        attachRoomDataConnection(conn, rm, session, { authenticateMember: true });
      } else {
        connectingMeshPeers.delete(member.peerId);
      }
    }
  };
  rm.on('membersUpdated', connectMeshMembers);

  const joinCoordinator = (pin = roomPin) => {
    if (rm.isMaster || !roomState.peer || roomState.peer.destroyed) return null;
    if (roomState.coordinatorConn && roomState.coordinatorConn.open) {
      try { roomState.coordinatorConn.close(); } catch (_) {}
    }
    const conn = roomState.peer.connect(rm.masterPeerId, {
      reliable: true,
      metadata: { type: 'ROOM_JOIN', roomId: rm.roomId }
    });
    roomState.coordinatorConn = conn;
    let initialOpenTimer = setTimeout(() => {
      if (!session?.isDisposed && rm.isInRoom && !rm.isMaster && (!conn?.open || !rm.authenticatedPeers.has(rm.masterPeerId))) {
        console.warn(`[Room] Conexão com coordenador (${rm.masterPeerId}) não abriu em 6s. Agendando reconexão...`);
        try { conn?.close(); } catch (_) {}
        scheduleCoordinatorReconnect();
      }
    }, 6000);
    const clearInitialTimer = () => { if (initialOpenTimer) { clearTimeout(initialOpenTimer); initialOpenTimer = null; } };
    session?.registerCleanup(clearInitialTimer);

    attachRoomDataConnection(conn, rm, session, {
      requestAdmission: true,
      pin,
      onOpen: clearInitialTimer,
      onClose: clearInitialTimer,
      onError: clearInitialTimer
    });

    return conn;
  };
  roomState.requestRoomJoin = joinCoordinator;

  const scheduleCoordinatorReconnect = createCoordinatorReconnect(session, {
    roomManager: rm,
    getConnection: () => roomState.coordinatorConn,
    connect: () => joinCoordinator(roomState.currentPin || roomPin),
    onConnected: () => { if (roomState.localStream) rm.setLocalStreaming(true, { ...rm.localStreamingState }); }
  });
  roomState.scheduleCoordinatorReconnect = scheduleCoordinatorReconnect;

  // Vincula controlador de UI Discord
  if (typeof DiscordUIController !== 'undefined') {
    roomState.discordUI = new DiscordUIController({
      chatManager,
      voiceManager,
      roomManager: rm,
      soundboardManager: roomState.session?.pluginManager.get('soundboard')?.manager,
      onOpenTuning: async () => {
        const modal = document.getElementById('tuning-modal');
        if (modal) modal.style.display = 'flex';
        const controls = roomState.tuningAudioControls || (await roomState.tuningControlsPromise);
        if (controls) {
          if (typeof controls.syncVolumeUI === 'function') {
            controls.syncVolumeUI();
          }
          await controls.refreshDevices(true).catch(() => {});
        }
      },
      onSendMessage: (text) => {
        if (chatManager) {
          const msg = chatManager.createMessage({
            senderId: rm.myPeerId || peerId,
            senderName: rm.userName || roomState.userName,
            role: rm.isMaster ? 'host' : 'viewer',
            text,
            channel: chatManager.getActiveChannel()
          });
          const storedMessage = msg && chatManager.addMessage(msg);
          if (storedMessage) {
            rm.broadcast({ type: 'CHAT_MESSAGE', message: storedMessage });
          }
        }
      },
      onJoinVoice: channelId => {
        return joinRoomVoice(rm, session, channelId);
      },
      onLeaveVoice: () => {
        leaveRoomVoice(rm, session);
      },
      onCreateVoiceChannel: name => rm.createVoiceChannel(name),
      onOpenWhiteboard: () => roomState.features?.whiteboardUI?.open(),
      onPlaySound: (soundId) => {
        if (!rm.voiceChannelId || !voiceManager.isInVoice) return;
        roomState.session?.pluginManager.get('soundboard')?.manager.playSound(soundId);
        rm.broadcast({ type: 'SOUNDBOARD_PLAY', soundId, senderName: roomState.userName, voiceChannelId: rm.voiceChannelId });
      },
      onPlayCustomSound: (sound) => {
        if (!rm.voiceChannelId || !voiceManager.isInVoice) return;
        roomState.features?.soundboard?.manager.playCustomSound(sound);
        rm.broadcast({ ...sound, type: 'SOUNDBOARD_PLAY_CUSTOM', senderName: rm.userName, voiceChannelId: rm.voiceChannelId });
      },
      onSendReaction: (emoji) => {
        const data = { type: 'EMOJI_REACTION', emoji, senderName: roomState.userName };
        roomState.session?.pluginManager.get('reactions')?.manager.spawnReaction(data);
        rm.broadcast(data);
      },
      onToggleStream: () => roomState.sourcePicker?.toggle(),
      onLeaveRoom: () => {
        activeRuntime?.leave();
      }
    });
    roomState.discordUI.init();
  }

  // Inicia o processo de ingresso na sala P2P
  const joined = await rm.join(peerId, isMaster);
  if (joined !== false) {
    roomState.peer.on('connection', (conn) => {
      attachRoomDataConnection(conn, rm, session);
    });
    roomState.peer.on('call', (call) => handleRoomMediaCall(call, rm, session));
    if (isMaster) {
      connectMeshMembers();
      roomState.identityUI?.update('ready');
      showToast(`Você entrou na sala #${roomId}!`, 'success');
    } else {
      roomState.identityUI?.update('connecting');
      joinCoordinator(roomPin);
      showToast(`Conectando à sala #${roomId}...`, 'info');
    }
    (session?.eventBus || globalBus).emit('room:joined', { roomId, peerId });
  }
}

function attachRoomDataConnection(conn, rm, session, { requestAdmission = false, authenticateMember = false, pin = null, onOpen = null, onClose = null, onError = null } = {}) {
  if (!conn?.peer || !rm.registerConnection(conn.peer, conn)) { try { conn?.close(); } catch (_) {} return false; }
  const isCurrent = () => !session?.isDisposed && (rm.meshConnections.get(conn.peer) === conn || rm.pendingConnections.get(conn.peer) === conn);
  conn.on('open', () => {
    onOpen?.();
    if (!isCurrent()) return;
    if (requestAdmission) {
      sendSessionMessage(roomState.session, conn, {
        type: 'ROOM_JOIN_REQUEST',
        roomId: rm.roomId,
        roomKey: rm.roomKey,
        pin,
        name: rm.userName,
        clientSessionId: rm.clientSessionId,
        voiceChannelId: rm.voiceChannelId,
        isMuted: voiceManager.isMuted,
        isDeafened: voiceManager.isDeafened,
        isSpeaking: Boolean(voiceManager.isInVoice && !voiceManager.isMuted && voiceManager.localVad.isSpeaking),
        isStreaming: Boolean(roomState.localStream),
        streamDetails: roomState.localStream ? { ...rm.localStreamingState } : null
      });
    } else if (authenticateMember) {
      sendSessionMessage(roomState.session, conn, { type: 'ROOM_MEMBER_AUTH', roomId: rm.roomId, roomKey: rm.roomKey });
    }
  });
  conn.on('data', (message) => {
    if (!isCurrent()) return;
    const handled = rm.handleRoomMessage(conn.peer, message, conn);
    if (!handled && rm.isPeerAuthorized(conn.peer)) {
      if (message?.type === 'REQUEST_STREAM') {
        if (roomState.localStream && conn.open) {
          const existingCall = roomState.screenCalls.get(conn.peer);
          const pc = existingCall?.peerConnection;
          const isStuckOrFailed = existingCall && (
            !pc ||
            pc.connectionState === 'failed' ||
            pc.connectionState === 'closed' ||
            pc.iceConnectionState === 'failed' ||
            pc.iceConnectionState === 'disconnected'
          );
          if (isStuckOrFailed) {
            console.warn(`[Room] REQUEST_STREAM recebido para chamada em estado '${pc?.connectionState || pc?.iceConnectionState}'. Reiniciando chamada com ${conn.peer}...`);
            try { existingCall.close(); } catch (_) {}
            roomState.screenCalls.delete(conn.peer);
          }
          sendRoomStream(conn.peer, conn, rm, session);
        }
        return;
      }
      session?.dispatcher.dispatch(message, conn, roomState.peer);
    }
  });
  conn.on('close', () => {
    onClose?.();
    if (!isCurrent()) return;
    const isMasterConn = roomState.coordinatorConn === conn;
    if (isMasterConn) {
      roomState.coordinatorConn = null;
      if (!session?.isDisposed && rm.isInRoom && !rm.isMaster) {
        roomState.scheduleCoordinatorReconnect?.();
      }
    }
    rm.removeMember(conn.peer);
  });
  conn.on('error', (error) => {
    onError?.(error);
    console.warn(`[Room] Conexão com ${conn.peer} falhou:`, error);
    if (conn === roomState.coordinatorConn && !session?.isDisposed && rm.isInRoom && !rm.isMaster) {
      roomState.scheduleCoordinatorReconnect?.();
    }
  });
  return true;
}

function handleRoomMediaCall(call, rm, session) {
  if (!call || !rm.isPeerAuthorized(call.peer)) {
    try { call?.close?.(); } catch (_) {}
    return;
  }
  if (call.metadata?.type === 'VOICE_CHAT') {
    roomState.messageHandlers?.answerVoiceCall(call);
    return;
  }
  // PeerJS applies the remote offer asynchronously. Intercept createAnswer before answering.
  const pc = call.peerConnection;
  if (pc?.createAnswer) {
    const createAnswer = pc.createAnswer.bind(pc);
    pc.createAnswer = (...args) => {
      applyTransceiverOptimizations(pc);
      return createAnswer(...args);
    };
  }
  call.answer();
  const previousCall = roomState.remoteStreams.get(call.peer)?.call;
  if (previousCall) {
    releaseRoomRemoteStream(call.peer, previousCall, session);
    try { previousCall.close(); } catch (_) {}
  }
  roomState.remoteStreams.set(call.peer, { call, stream: null });
  call.on('stream', (stream) => {
    if (session?.isDisposed || !rm.isPeerAuthorized(call.peer) || roomState.remoteStreams.get(call.peer)?.call !== call) return;
    roomState.remoteStreams.set(call.peer, { call, stream });
    startStatsMonitor(call.peer, call.peerConnection, false);
    const member = rm.members.get(call.peer);
    hideCardLoading(call.peer);
    addOrUpdateVideoCard({ session, audioScope: roomState.session?.audioScope, peerId: call.peer, stream, label: member?.name || `Amigo ${call.peer.slice(-4)}`, isLocal: false,
      onClipClick: sourceId => roomState.features?.clipEditor?.exportClip(sourceId),
      onCoopClick: peerId => toggleCoopCardControl(coopController, peerId, rm.meshConnections.get(peerId)) });
    session?.eventBus.emit('stream:received', { hostId: call.peer, stream });
  });
  if (pc) {
    pc.addEventListener?.('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState;
      console.log(`[Room Media Receiver] ICE com ${call.peer}: ${state}`);
      if (state === 'failed') {
        const conn = rm.meshConnections.get(call.peer);
        if (conn && conn.open) {
          console.warn(`[Room Media Receiver] ICE falhou com ${call.peer}. Solicitando novo stream...`);
          try { sendSessionMessage(session, conn, { type: 'REQUEST_STREAM' }); } catch (_) {}
        }
      }
    });
  }
  let unregisterCleanup;
  const release = () => { unregisterCleanup?.(); releaseRoomRemoteStream(call.peer, call, session); };
  unregisterCleanup = session?.registerCleanup(() => { release(); try { call.close(); } catch (_) {} });
  call.on('close', release);
  call.on('error', () => { release(); try { call.close(); } catch (_) {} });
}

function releaseRoomRemoteStream(peerId, call, session) {
  const entry = roomState.remoteStreams.get(peerId);
  if (entry?.call !== call) return;
  roomState.remoteStreams.delete(peerId);
  entry.stream?.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
  stopStatsMonitor(peerId);
  removeVideoCard(peerId);
  session?.eventBus.emit('stream:stopped', { sourceId: peerId });
}

function closeRoomScreenCalls(peerId, session) {
  const outgoing = roomState.screenCalls.get(peerId);
  try { outgoing?.close(); } catch (_) {}
  if (roomState.screenCalls.get(peerId) === outgoing) {
    roomState.screenCalls.delete(peerId);
    stopStatsMonitor(`send-${peerId}`);
  }
  const incoming = roomState.remoteStreams.get(peerId)?.call;
  if (incoming) {
    releaseRoomRemoteStream(peerId, incoming, session);
    try { incoming.close(); } catch (_) {}
  }
}

function sendRoomStream(memberId, conn, rm, session) {
  if (!roomState.localStream || session?.isDisposed || !conn?.open || !rm.isPeerAuthorized(memberId)) return;
  if (roomState.features?.nativeMedia.broadcastTo(conn)) return;
  const existingCall = roomState.screenCalls.get(memberId);
  if (existingCall) {
    const pc = existingCall.peerConnection;
    if (pc?.connectionState === 'closed' || pc?.connectionState === 'failed' || pc?.iceConnectionState === 'failed') {
      try { existingCall.close(); } catch (_) {}
      roomState.screenCalls.delete(memberId);
    } else {
      return;
    }
  }
  const settings = roomState.captureSettings || readCaptureSettings();
  const call = roomState.peer?.call(memberId, roomState.localStream, {
    metadata: { type: 'ROOM_STREAM', name: rm.userName },
    sdpTransform:createInitialCodecTransform(()=>settings.videoCodec||'auto')
  });
  if (!call) return;
  roomState.screenCalls.set(memberId, call);
  hookPeerConnectionSdp(call.peerConnection, () => settings.bitrateKbps * 1000);
  applyTransceiverOptimizations(call.peerConnection, 'ultra-low', settings.videoCodec || 'h264');
  const stopTuning = applySenderOptimizationsWhenReady(
    call.peerConnection,
    () => settings.bitrateKbps * 1000,
    () => settings.fps,
    () => {
      const track = roomState.localStream?.getVideoTracks?.()[0];
      return isNativeCaptureProvider(roomState.captureProvider) ? 1 : videoScaleForProfile(track?.getSettings?.(), roomState.captureSettings || settings);
    },
    () => (roomState.captureSettings || settings).degradationPreference || 'maintain-resolution'
  );
  const quality = createQualityController(call.peerConnection, () => roomState.captureSettings || settings);
  startStatsMonitor(`send-${memberId}`, call.peerConnection, true, sample => quality.process(sample), {
    cardId: 'local-me',
    context: () => ({
      requestedFps: (roomState.captureSettings || settings).fps,
      requestedCodec: settings.videoCodec,
      iceConnectionState: call.peerConnection?.iceConnectionState
    })
  });
  let unregisterCleanup;
  const release = () => {
    stopTuning();
    quality.dispose();
    unregisterCleanup?.();
    if (roomState.screenCalls.get(memberId) === call) {
      stopStatsMonitor(`send-${memberId}`);
      roomState.screenCalls.delete(memberId);
    }
  };
  const pc = call.peerConnection;
  if (pc) {
    const onIceState = () => {
      const state = pc.iceConnectionState;
      console.log(`[Room Media Sender] ICE com ${memberId}: ${state}`);
      if (state === 'failed') {
        console.warn(`[Room Media Sender] ICE falhou com ${memberId}.`);
        try { pc.restartIce?.(); } catch (_) {}
      }
    };
    const onConnState = () => {
      const state = pc.connectionState;
      console.log(`[Room Media Sender] Conexão com ${memberId}: ${state}`);
      if (state === 'failed' || state === 'closed') {
        release();
      }
    };
    pc.addEventListener?.('iceconnectionstatechange', onIceState);
    pc.addEventListener?.('connectionstatechange', onConnState);
  }
  unregisterCleanup = session?.registerCleanup(() => { release(); try { call.close(); } catch (_) {} });
  call.on('close', release);
  call.on('error', release);
}

async function joinRoomVoice(rm, session, channelId = 'voice-1') {
  if (!rm || !rm.voiceChannels.has(channelId) || session?.isDisposed) return;
  if (voiceManager.isInVoice && rm.voiceChannelId === channelId) return;
  leaveRoomVoice(rm, session, { preserveControls: true });
  const epoch = roomState.voiceJoinEpoch;
  roomState.pendingVoiceChannelId = channelId;
  try {
    const stream = await voiceManager.joinVoice({ peerId: rm.myPeerId, name: rm.userName, role: rm.isMaster ? 'host' : 'member' });
    if (session?.isDisposed || epoch !== roomState.voiceJoinEpoch || !stream || !voiceManager.isInVoice) return;
    if (!rm.setLocalVoiceChannel(channelId)) {
      leaveRoomVoice(rm, session, { preserveControls: true });
      return;
    }
    roomState.discordUI?.renderRoomChannels();
    rm.broadcast({ type: 'VOICE_SIGNAL', action: 'VOICE_JOINED', voiceChannelId: channelId, peerId: rm.myPeerId, name: rm.userName, role: rm.isMaster ? 'host' : 'member' });
    for (const [memberId, conn] of rm.meshConnections) {
      if (!conn.open || !rm.isPeerAuthorized(memberId)) continue;
      const handlers = session?.messageHandlers || roomState.messageHandlers;
      handlers?.connectVoiceTo(memberId);
    }
  } catch (error) {
    if (!session?.isDisposed && epoch === roomState.voiceJoinEpoch) showToast('Não foi possível acessar o microfone.', 'error');
  } finally {
    if (epoch === roomState.voiceJoinEpoch) roomState.pendingVoiceChannelId = null;
  }
}

function leaveRoomVoice(rm, session, { preserveControls = false } = {}) {
  const { isDeafened } = voiceManager.getLocalVoiceState();
  const isManuallyMuted = voiceManager.isManuallyMuted;
  roomState.voiceJoinEpoch = (roomState.voiceJoinEpoch || 0) + 1;
  roomState.pendingVoiceChannelId = null;
  const handlers = session?.messageHandlers || roomState.messageHandlers;
  handlers?.closeVoiceCalls();
  voiceManager.leaveVoice();
  if (preserveControls) {
    voiceManager.setMuted(isManuallyMuted);
    voiceManager.setDeafened(isDeafened);
  }
  rm?.setLocalVoiceChannel(null);
  rm?.broadcast({ type: 'VOICE_SIGNAL', action: 'LEAVE', peerId: rm.myPeerId });
  roomState.discordUI?.renderRoomChannels();
}

async function startRoomCapture(rm, session, captureOptions = {}) {
  if (!rm || session?.isDisposed || roomState.isStartingStream || roomState.localStream) return null;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    showToast('Captura de tela não está disponível neste navegador.', 'error');
    return;
  }
  roomState.isStartingStream = true;
  captureOptions = { ...readCaptureSettings(), ...captureOptions };
  const epoch = roomState.captureEpoch = (roomState.captureEpoch || 0) + 1;
  let stream = null;
  let unregisterPendingCapture;
  try {
    if (captureOptions.sourceId) {
      bindCaptureSettings(session, () => roomState.captureProvider, showToast);
      installNativeCaptureBridge();
      const provider = new NativeCaptureProvider();
      provider.uiAudioMode = captureOptions.audioMode;
      roomState.captureProvider = provider;
      session?.registerCleanup(() => provider.stop());
      const result = await provider.start({ fps: 60, width: 1920, height: 1080, bitrateKbps: 7500, ...captureOptions });
      stream = result.stream;
    } else stream = await requestBrowserDisplayMedia({ ...captureOptions, video: captureVideoConstraints(captureOptions) });
    // Own the display immediately, including while microphone permission is pending.
    unregisterPendingCapture = session?.registerCleanup(stream);
    if (session?.isDisposed || epoch !== roomState.captureEpoch) { stream.getTracks().forEach(track => track.stop()); return null; }
    if (captureOptions.audioMode === 'mic') {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphone.getAudioTracks().forEach(track => stream.addTrack(track));
    }
    if (session?.isDisposed || epoch !== roomState.captureEpoch) { stream.getTracks().forEach(track => track.stop()); return null; }
    roomState.localStream = stream;
    roomState.captureSettings = { ...readCaptureSettings(), ...captureOptions };
    stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => stopRoomCapture(rm, session), { once: true }));
    addOrUpdateVideoCard({ session, audioScope: roomState.session?.audioScope, peerId: 'local-me', stream, label: `${rm.userName} (Ao Vivo)`, isLocal: true, onClipClick: sourceId => roomState.features?.clipEditor?.exportClip(sourceId) });
    roomState.discordUI?.setStreamingState(true);
    rm.setLocalStreaming(true, { sourceType: 'display', title: 'Compartilhamento de tela' });
    for (const [memberId, conn] of rm.meshConnections) {
      sendRoomStream(memberId, conn, rm, session);
    }
    session?.eventBus.emit('stream:started', { stream, sourceId: 'local-me' });
  } catch (error) {
    console.error('[Room] Falha ao iniciar captura:', error);
    if (stream) {
      try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
    }
    if (roomState.captureProvider) {
      try { roomState.captureProvider.stop(); } catch (_) {}
      roomState.captureProvider = null;
    }
    showToast('Não foi possível iniciar o compartilhamento.', 'error');
  } finally { unregisterPendingCapture?.(); roomState.isStartingStream = false; }
}

function stopRoomCapture(rm, session) {
  roomState.captureEpoch = (roomState.captureEpoch || 0) + 1;
  if (roomState.captureProvider) { const provider = roomState.captureProvider; roomState.captureProvider = null; const pending = provider.stop(); session?.registerCleanup(() => pending); }
  if (!roomState.localStream) return;
  roomState.localStream.getTracks?.().forEach((track) => { try { track.stop(); } catch (_) {} });
  [...roomState.screenCalls.values()].forEach((call) => { try { call.close(); } catch (_) {} });
  roomState.screenCalls.clear();
  roomState.localStream = null;
  roomState.captureSettings = null;
  removeVideoCard('local-me');
  roomState.discordUI?.setStreamingState(false);
  rm.setLocalStreaming(false);
  session?.eventBus.emit('stream:stopped', { sourceId: 'local-me' });
}

async function initRoomPeer(customId = null, session = roomState.session) {
  if (typeof Peer === 'undefined') {
    throw new Error('PeerJS não está carregado no escopo global.');
  }

  await fetchIceServersFromApi().catch(() => {});
  if (session?.isDisposed) throw new DOMException("Session disposed", "AbortError");
  const config = getPeerConfig();
  const { roomId, roomKey } = getRoomInfoFromUrl();
  const coordinatorId = getRoomMasterPeerId(roomId, roomKey);
  const wasMaster = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('seemygame_room_master_' + roomId) === 'true';

  let masterRetries = 0;
  const MAX_MASTER_RETRIES = 3;

  const createPeer = (id, retryAsGuest) => new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, config) : new Peer(config);
    roomState.peer = peer;
    session?.registerCleanup(() => peer.destroy());
    session?.signal.addEventListener('abort', () => reject(new DOMException('Session disposed', 'AbortError')), { once: true });
    let settled = false;
    peer.on('open', (openedId) => {
      if (session?.isDisposed) { peer.destroy(); return; }
      if (peer !== roomState.peer) return;
      settled = true;
      console.log(`[Room] Peer registrado com ID: ${openedId}`);
      roomState.identityUI?.update('ready');
      resolve(peer);
    });
    peer.on('disconnected', () => {
      if (peer !== roomState.peer || session?.isDisposed) return;
      roomState.identityUI?.update('connecting');
      if (!peer.destroyed) { try { peer.reconnect(); } catch (_) {} }
    });
    peer.on('close', () => {
      if (peer === roomState.peer && !session?.isDisposed) roomState.identityUI?.update('error');
    });
    peer.on('error', (err) => {
      if (peer !== roomState.peer || session?.isDisposed) return;
      if (err?.type === 'unavailable-id' && !settled) {
        if (wasMaster && id === coordinatorId && masterRetries < MAX_MASTER_RETRIES && !session?.isDisposed) {
          masterRetries++;
          settled = true;
          try { peer.destroy(); } catch (_) {}
          const delay = Math.min(800 * masterRetries, 2500);
          console.warn(`[Room] ID de Master retido após refresh. Tentando reconectar ${masterRetries}/${MAX_MASTER_RETRIES} em ${delay}ms...`);
          setTimeout(() => {
            if (session?.isDisposed) return;
            createPeer(coordinatorId, retryAsGuest).then(resolve, reject);
          }, delay);
          return;
        }
        if (retryAsGuest && !settled) {
          settled = true;
          try { peer.destroy(); } catch (_) {}
          createPeer(null, false).then(resolve, reject);
          return;
        }
      }
      if (settled) {
        // A failed media/data call does not mean the signaling server is offline.
        if (peer.disconnected || peer.destroyed || ['network', 'server-error', 'socket-error', 'socket-closed'].includes(err?.type)) {
          roomState.identityUI?.update('error');
        }
        return;
      }
      settled = true;
      console.error('[Room] Erro no Peer:', err);
      showToast('Erro de conexão ao servidor de sinalização.', 'error');
      roomState.identityUI?.update('error');
      reject(err);
    });
  });

  if (customId) return createPeer(customId, false);
  return createPeer(coordinatorId, true);
}

function setupTuningModal(session = roomState.session) {
  if (typeof document === 'undefined') return;
  const modal = document.getElementById('tuning-modal');
  if (!modal) return;
  if (modal.dataset.tuningMounted === 'true') return;
  modal.dataset.tuningMounted = 'true';

  const closeBtn = document.getElementById('close-tuning-modal-btn');
  const saveBtn = document.getElementById('save-tuning-btn');
  const controller = new AbortController();

  const tuningContext = {
    isAudioOutputSupported,
    getAudioDevices,
    populateDeviceSelect,
    playTestTone,
    getSavedAudioPreferences,
    saveAudioPreference,
    watchDeviceChanges,
    voiceManager
  };

  const tuningPromise = initTuningAudioDeviceControls(tuningContext).then((controls) => {
    roomState.tuningAudioControls = controls;
    return controls;
  }).catch((err) => {
    console.warn('[Room] Falha ao inicializar controles de áudio do tuning:', err);
    return null;
  });
  roomState.tuningControlsPromise = tuningPromise;

  session?.registerCleanup(() => {
    controller.abort();
    modal.style.display = 'none';
    delete modal.dataset.tuningMounted;
    if (roomState.tuningAudioControls?.destroy) {
      try { roomState.tuningAudioControls.destroy(); } catch (_) {}
    }
    roomState.tuningAudioControls = null;
    roomState.tuningControlsPromise = null;
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.style.display = 'none';
    }, { signal: controller.signal });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  }, { signal: controller.signal });

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const micSelect = document.getElementById('tuning-mic-select');
      const speakerSelect = document.getElementById('tuning-speaker-select');
      if (micSelect) {
        saveAudioPreference('input', micSelect.value);
        if (voiceManager) {
          await voiceManager.setAudioInputDevice(micSelect.value).catch((err) => {
            console.warn('[Room] Falha ao definir microfone no voiceManager:', err);
          });
        }
      }
      if (speakerSelect && isAudioOutputSupported()) {
        saveAudioPreference('output', speakerSelect.value);
        if (voiceManager) {
          await voiceManager.setAudioOutputDevice(speakerSelect.value).catch((err) => {
            console.warn('[Room] Falha ao definir saída de som no voiceManager:', err);
          });
        }
      }
      const codecSelect = document.getElementById('video-codec-select');
      if (codecSelect) {
        try { localStorage.setItem('seemygame_video_codec', codecSelect.value); } catch (_) {}
      }
      const h264Select = document.getElementById('h264-encoder-select');
      if (h264Select) {
        try { localStorage.setItem('seemygame_h264_encoder', h264Select.value); } catch (_) {}
      }
      const cursorToggle = document.getElementById('capture-cursor-toggle');
      if (cursorToggle) {
        try { localStorage.setItem('seemygame_capture_cursor', String(cursorToggle.checked)); } catch (_) {}
      }
      modal.style.display = 'none';
      showToast('Configurações atualizadas com sucesso!', 'success');
    }, { signal: controller.signal });
  }
}

async function initRoomApp(options = {}) {
  const session = createSessionContext({
    role: 'room',
    exclusiveKey: instanceKey,
    eventBus: options.eventBus,
    messageDispatcher: options.messageDispatcher,
    pluginManager: options.pluginManager,
    initialState: roomState
  });
  roomState.session = session;
  session.getPeerId = () => roomState.peer?.id;
  roomState.identityUI = bindRoomIdentity(session, {
    getRoomInfo: () => ({ ...getRoomInfoFromUrl(), roomId: roomState.roomManager?.roomId || getRoomInfoFromUrl().roomId,
      roomPin: roomState.roomManager ? roomState.roomManager.roomPin : roomState.currentPin, roomKey: roomState.roomManager?.roomKey || getRoomInfoFromUrl().roomKey }),
    showToast
  });
  session.registerCleanup(() => { roomState.identityUI = null; });
  bindRoomSettings(session, {
    getRoomManager: () => roomState.roomManager,
    showToast,
    applySettings: ({ roomId, roomPin, url }) => {
      const rm = roomState.roomManager;
      if (!rm?.isMaster) return;
      if (roomId !== rm.roomId) {
        window.history.replaceState(null, '', url);
        window.location.reload();
        return;
      }
      rm.setRoomPin(roomPin);
      roomState.currentPin = roomPin;
      window.history.replaceState(null, '', url);
      roomState.identityUI?.update('ready');
      showToast('Ajustes da sala atualizados. O convite já usa o novo PIN.', 'success');
    }
  });
  audioScope = session.audioScope;
  session.services = { chatManager, voiceManager, coopController, statsScope };
  session.registerCleanup(coopController.registerCoopPromptHandler(prompt => showCoopPromptModal(prompt)));
  session.registerCleanup(coopController.registerCoopStateChangeHandler(state => updateCoopUI(state)));
  bindQualityCapabilities(session);
  bindCaptureSettings(session, () => roomState.captureProvider, showToast);
  bindStreamingQuality(session, { getStream: () => roomState.localStream, getProvider: () => roomState.captureProvider, getCalls: () => roomState.screenCalls.values(), onSettings: settings => { roomState.captureSettings = settings; }, showToast });
  session.registerCleanup(() => statsScope.dispose());
  installNativeCaptureBridge();
  roomState.sourcePicker = bindSourcePicker(session, {
    start: options => startRoomCapture(roomState.roomManager, session, options),
    stop: () => stopRoomCapture(roomState.roomManager, session), isStreaming: () => Boolean(roomState.localStream), showToast
  });
  session.registerCleanup(() => voiceManager.leaveVoice());
  session.registerCleanup(() => coopController.dispose());

  const features = registerSessionFeatures(session, {
    role: 'room',
    getConnections: () => roomState.roomManager?.meshConnections.values() || [],
    includeClipping: true,
    getCaptureProvider: () => roomState.captureProvider,
    isAuthorizedPeer: id => roomState.roomManager?.isPeerAuthorized(id),
    showToast,
    chatManager,
    getPeerId: () => roomState.peer?.id || 'room-member',
    getRole: () => roomState.roomManager?.isMaster ? 'host' : 'viewer',
    getDisplayName: () => roomState.userName,
    broadcastDataMessage: (data, excludePeerId) => {
      const rm = roomState.roomManager;
      if (['SOUNDBOARD_PLAY', 'SOUNDBOARD_PLAY_CUSTOM'].includes(data.type)) {
        if (!rm?.voiceChannelId || !voiceManager.isInVoice) return false;
        data = { ...data, voiceChannelId: rm.voiceChannelId };
      }
      return rm?.broadcast(data, excludePeerId);
    },
    canReceiveSound: (data, conn) => {
      const rm = roomState.roomManager;
      return Boolean(rm?.voiceChannelId && voiceManager.isInVoice && !voiceManager.isDeafened &&
        rm.isPeerAuthorized(conn?.peer) && data.voiceChannelId === rm.voiceChannelId &&
        rm.members.get(conn?.peer)?.voiceChannelId === rm.voiceChannelId);
    }
  });
  roomState.features = features;
  const messageHandlers = bindSessionMessageHandlers(session, { coopController,
    role: 'room',
    getVoiceChannelId: () => roomState.roomManager?.voiceChannelId ?? null,
    getPeerVoiceChannelId: id => roomState.roomManager?.members.get(id)?.voiceChannelId ?? null,
    getVoicePeerIds: () => roomState.roomManager?.members.keys() || [],
    chatManager,
    voiceManager,
    getVideoCard: peerId => document.getElementById(`card-${peerId}`),
    getChatIdentity: id => {
      const member = roomState.roomManager?.members.get(id);
      return member ? { name: member.name, role: member.isMaster ? 'host' : 'viewer' } : null;
    },
    getPeer: () => roomState.peer,
    isAuthorizedPeer: id => roomState.roomManager?.isPeerAuthorized(id),
    getLocalPeerId: () => roomState.peer?.id,
    showToast,
    broadcast: (data, excludePeerId) => roomState.roomManager?.broadcast(data, excludePeerId)
  });
  roomState.messageHandlers = messageHandlers;
  if (session) session.messageHandlers = messageHandlers;
  session?.registerCleanup(() => {
    if (session?.messageHandlers === messageHandlers) session.messageHandlers = null;
    if (roomState.messageHandlers === messageHandlers) roomState.messageHandlers = null;
    if (roomState.features === features) roomState.features = null;
    if (roomState.requestRoomJoin) roomState.requestRoomJoin = null;
  });

  // Configura modais de calibração de controle e configurações
  setupTuningModal(session);
  setupGamepadTesterModal();

  // Inicializa Modo Streamer e Ferramentas da Sala
  streamerMode.init({
    toggleBtn: document.getElementById('streamer-mode-btn'),
    roomHeaderBadge: document.getElementById('room-header-badge'),
    shareRoomCodeDisplay: document.getElementById('share-room-code-display')
  });

  roomToolsController.bindSession({
    session,
    broadcast: (data, excludePeerId) => roomState.roomManager?.broadcast(data, excludePeerId),
    chatManager,
    getPeerId: () => roomState.peer?.id || 'room-member',
    getDisplayName: () => roomState.userName,
    getActiveVideoStream: () => roomState.localStream,
    getVoiceStreams: () => ({
      localMic: voiceManager.localStream,
      participants: null
    })
  });
  roomToolsController.bindDOM();
  session.registerCleanup(() => {
    roomToolsController.dispose();
    streamerMode.destroy();
  });

  const startRoomFlow = () => {
    initGreenRoomLobby(async () => {
      try {
        const peer = await initRoomPeer(options.customId || null);
        await setupRoomSession(peer.id, session);
      } catch (err) {
        console.error('[Room] Falha ao inicializar peer da sala:', err);
      }
    });
  };

  session.registerCleanup(initTermsModal(startRoomFlow));

  const runtime = {
    isRoom: true,
    session,
    dispose: () => {
      if (session.isDisposed) return;
      if (roomState.roomManager) {
        stopRoomCapture(roomState.roomManager, session);
        leaveRoomVoice(roomState.roomManager, session);
        try { roomState.roomManager.leave(); } catch (e) {}
      }
      if (roomState.discordUI) {
        try { roomState.discordUI.destroy(); } catch (e) {}
      }
      if (roomState.peer && !roomState.peer.destroyed) {
        try { roomState.peer.destroy(); } catch (e) {}
      }
      roomState.peer = null;
      roomState.roomManager = null;
      roomState.relayManager = null;
      roomState.discordUI = null;
      roomState.coordinatorConn = null;
      roomState.screenCalls.clear();
      if (roomState.session === session) roomState.session = null;
      session.dispose();
      roomState.remoteStreams.clear();
    },
    startCapture: options => startRoomCapture(roomState.roomManager, session, options),
    stopCapture: () => stopRoomCapture(roomState.roomManager, session),
    joinVoice: channelId => joinRoomVoice(roomState.roomManager, session, channelId),
    leaveVoice: () => leaveRoomVoice(roomState.roomManager, session),
    state: roomState,
    getRoomInfo: getRoomInfoFromUrl
  };
  runtime.leave = () => {
    runtime.dispose();
    if (typeof options.navigateHome === 'function') options.navigateHome();
    else navigateHome();
  };
  activeRuntime = runtime;
  const reloadPorts = {
    get roomManager() { return roomState.roomManager; },
    get localStream() { return roomState.localStream; },
    get activeNativeCaptureProvider() { return roomState.captureProvider; },
    connectedViewers: new Map(),
    watchingHosts: roomState.remoteStreams,
    voiceManager,
    isRoomMode: () => true,
    showReloadConfirmationModal: () => showReloadConfirmationModal(reloadPorts),
    hideReloadConfirmationModal: () => hideReloadConfirmationModal(reloadPorts),
    handlePageUnload: () => runtime.dispose()
  };
  session.addEventListener(window, 'keydown', event => handleReloadKeypress(reloadPorts, event));
  session.addEventListener(window, 'beforeunload', () => runtime.dispose());
  session.addEventListener(window, 'pagehide', () => runtime.dispose());
  session.registerCleanup(() => hideReloadConfirmationModal(reloadPorts));
  return runtime;
}
return {
get isRoomPage() { return isRoomPage; },
get roomState() { return roomState; },
getRoomInfoFromUrl,
initGreenRoomLobby,
setupRoomSession,
initRoomPeer,
setupTuningModal,
joinRoomVoice,
leaveRoomVoice,
initRoomApp
};
}
