import { sendSessionMessage } from '../protocol/transport.js';
import { 
  getPeerConfig, 
  fetchIceServersFromApi,
  TERMS_VERSION 
} from '../config.js';
import { 
  hookPeerConnectionSdp, 
  applyTransceiverOptimizations 
} from '../webrtc.js';
import { createStatsMonitorScope } from '../stats.js';
import { 
  showToast, 
  initTermsModal, 
  createPlaceholderCard, 
  updateCardStatus, 
  hideCardLoading, 
  setCardStreamPaused, 
  removeVideoCard, 
  addOrUpdateVideoCard,
  updateCoopUI,
  isValidPeerId 
} from '../ui.js';
import { createCoopController } from '../coop/controller.js';
import { toggleCoopCardControl } from '../coop/card-action.js';
import { ChatManager } from '../chat.js';
import { VoiceManager } from '../voice.js';
import { DiscordUIController } from '../discord-ui.js';
import { globalBus } from '../core/event-bus.js';
import { p2pDispatcher } from '../core/message-dispatcher.js';
import { createSessionContext } from '../core/session-context.js';
import { bindSessionMessageHandlers } from '../protocol/session-handlers.js';
import { registerSessionFeatures } from '../plugins/session-composition.js';
import {
  PROTOCOL_TYPES,
  AdmissionGate
} from '../protocol/index.js';

/** Creates a runtime whose state and resource lifetime belong to one session. */
export function createViewerSession(options = {}) {
const statsScope = createStatsMonitorScope();
const { startStatsMonitor, stopStatsMonitor, getLastMetrics } = statsScope;
const coopController = options.coopController || createCoopController({ sendMessage: (conn, data) => sendSessionMessage(viewerState.session, conn, data) });
const {  
  handleViewerCoopMessage, 
  requestCoopControl, 
  releaseCoopControl, 
  getCoopState, 
  registerCoopStateChangeHandler,
  setupGamepadTesterModal
 } = coopController;
const chatManager = options.chatManager || new ChatManager();
let audioScope = null;
const voiceManager = options.voiceManager || new VoiceManager({ audioContextProvider: () => audioScope?.getContext() });
const instanceKey = Symbol('viewer-entry');

const isViewerPage = true;

const isHost = false;

const viewerState = {
  peer: null,
  targetHostId: null,
  activeCall: null,
  activeConn: null,
  statsMonitorActive: false,
  remoteStream: null,
  session: null,
  isPinRequired: false,
  isAuthenticated: false,
  messageHandlers: null
};

const watchingHosts = new Map();
let peerInitialization = null;
let readyPeer = null;
let pendingPinHostId = null;

function promptViewerPin(targetId, errorMsg = null) {
  pendingPinHostId = targetId;
  viewerState.targetHostId = targetId;
  const modal = document.getElementById('pin-prompt-modal');
  const input = document.getElementById('viewer-pin-input');
  const errorEl = document.getElementById('viewer-pin-error');
  if (modal) {
    modal.style.display = 'flex';
    if (input) {
      input.value = '';
      input.focus?.();
    }
    if (errorEl) {
      if (errorMsg) {
        errorEl.textContent = errorMsg;
        errorEl.style.display = 'block';
      } else {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      }
    }
  }
}

function hideViewerPinModal() {
  pendingPinHostId = null;
  const modal = document.getElementById('pin-prompt-modal');
  const errorEl = document.getElementById('viewer-pin-error');
  if (modal) modal.style.display = 'none';
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }
}

function submitViewerPin(pin) {
  const trimmed = pin ? String(pin).trim() : '';
  const errorEl = document.getElementById('viewer-pin-error');
  if (!trimmed) {
    if (errorEl) {
      errorEl.textContent = 'Por favor, digite o PIN da sala.';
      errorEl.style.display = 'block';
    }
    return false;
  }

  const target = pendingPinHostId || viewerState.targetHostId;
  const conn = watchingHosts.get(target)?.conn || (target && viewerState.activeConn?.peer === target ? viewerState.activeConn : null);
  if (conn?.open) {
    sendSessionMessage(viewerState.session, conn, {
      type: PROTOCOL_TYPES.MEDIA.REQUEST_STREAM,
      pin: trimmed
    });
    return true;
  }
  return false;
}

function getTargetStreamerId() {
  if (typeof window === 'undefined' || !window.location) return null;
  const hash = window.location.hash || '';
  const match = hash.match(/watch=([a-zA-Z0-9_-]+)/);
  if (match && match[1]) return match[1];

  const params = new URLSearchParams(window.location.search);
  return params.get('streamer') || null;
}

async function connectToStreamer(streamerId, pin = null, session = viewerState.session) {
  if (!streamerId || !isValidPeerId(streamerId)) {
    showToast('ID do streamer inválido.', 'error');
    return false;
  }

  viewerState.targetHostId = streamerId;
  createPlaceholderCard(streamerId, `Streamer: ${streamerId.slice(0, 8)}`);
  updateCardStatus(streamerId, 'Conectando ao Streamer...');

  const peer = peerInitialization || !viewerState.peer || viewerState.peer.destroyed
    ? await initViewerPeer(session) : viewerState.peer;
  if (session?.isDisposed) return false;

  const conn = peer.connect(streamerId, {
    reliable: true,
    metadata: { role: 'viewer', pin: pin || '' }
  });

  const previous = watchingHosts.get(streamerId);
  viewerState.activeConn = conn;
  watchingHosts.set(streamerId, {
    state: 'CONNECTING',
    conn,
    call: null
  });
  try { previous?.call?.close(); previous?.conn?.close(); } catch (_) {}
  const isCurrent = () => !session?.isDisposed && watchingHosts.get(streamerId)?.conn === conn;

  conn.on('open', () => {
    if (!isCurrent()) return;
    updateCardStatus(streamerId, 'Conectado! Aguardando vídeo...');
    const hostEntry = watchingHosts.get(streamerId);
    if (hostEntry) hostEntry.state = 'CONNECTED';

    // Notifica o host sobre a conexão e solicita transmissão
    sendSessionMessage(viewerState.session, conn, {
      type: PROTOCOL_TYPES.MEDIA.REQUEST_STREAM,
      peerId: peer.id,
      pin: pin || ''
    });

    (session?.eventBus || globalBus).emit('viewer:connected', { streamerId });
  });

  conn.on('data', (data) => {
    if (!isCurrent()) return;
    if (data && typeof data === 'object') {
      if (data.type === PROTOCOL_TYPES.ADMISSION.PIN_REQUIRED) {
        const entry = watchingHosts.get(streamerId);
        entry.isAuthenticated = false; entry.requiresPin = true; entry.pinError = data.error;
        viewerState.isPinRequired = true;
        viewerState.isAuthenticated = false;
        if (!pendingPinHostId || pendingPinHostId === streamerId) promptViewerPin(streamerId, data.error);
        (session?.eventBus || globalBus).emit('pin:required', { streamerId, error: data.error });
        return;
      }
      if (data.type === PROTOCOL_TYPES.ADMISSION.PIN_ACCEPTED) {
        const entry = watchingHosts.get(streamerId);
        entry.isAuthenticated = true; entry.requiresPin = false;
        if (pendingPinHostId === streamerId) hideViewerPinModal();
        const next = [...watchingHosts].find(([, host]) => host.requiresPin);
        viewerState.isPinRequired = Boolean(next);
        viewerState.isAuthenticated = Boolean(watchingHosts.get(viewerState.activeConn?.peer)?.isAuthenticated);
        if (!pendingPinHostId && next) promptViewerPin(next[0], next[1].pinError);
        showToast('PIN aceito! Conectando à transmissão...', 'success');
        (session?.eventBus || globalBus).emit('pin:accepted', { streamerId });
        return;
      }
      if (data.type === PROTOCOL_TYPES.MEDIA.STREAM_STATUS) {
        if (data.isStreaming) {
          updateCardStatus(streamerId, 'Sincronizando stream em tempo real...');
        } else {
          updateCardStatus(streamerId, 'Streamer conectado! Aguardando início da transmissão...');
        }
        (session?.eventBus || globalBus).emit('stream:status', data);
        return;
      }
    }

    (session?.dispatcher || p2pDispatcher).dispatch(data, conn, viewerState.peer);
  });

  conn.on('close', () => {
    if (watchingHosts.get(streamerId)?.conn !== conn) return;
    const call = watchingHosts.get(streamerId).call;
    try { call?.close(); } catch (_) {}
    if (viewerState.activeCall === call) viewerState.activeCall = null;
    if (viewerState.activeConn === conn) viewerState.activeConn = null;
    updateCardStatus(streamerId, 'Desconectado do streamer.');
    removeVideoCard(streamerId);
    watchingHosts.delete(streamerId);
    if (pendingPinHostId === streamerId) hideViewerPinModal();
    const next = [...watchingHosts].find(([, host]) => host.requiresPin);
    viewerState.isAuthenticated = Boolean(watchingHosts.get(viewerState.activeConn?.peer)?.isAuthenticated);
    viewerState.isPinRequired = Boolean(next);
    if (!pendingPinHostId && next) promptViewerPin(next[0], next[1].pinError);
    (session?.eventBus || globalBus).emit('viewer:disconnected', { streamerId });
  });

  conn.on('error', (err) => {
    if (!isCurrent()) return;
    console.error(`[Viewer] Erro na conexão com ${streamerId}:`, err);
    updateCardStatus(streamerId, 'Erro na conexão P2P.');
    showToast(`Erro ao conectar com ${streamerId.slice(0, 6)}`, 'error');
  });

  return true;
}

async function initViewerPeer(session = viewerState.session) {
  if (peerInitialization) return peerInitialization;
  if (readyPeer && readyPeer === viewerState.peer && !readyPeer.destroyed) return readyPeer;
  let initializedPeer = null;
  const pending = createViewerPeer(session).then(peer => {
    initializedPeer = peer;
    if (!session?.isDisposed && viewerState.peer === peer) readyPeer = peer;
    return peer;
  });
  peerInitialization = pending;
  session?.registerCleanup(() => {
    if (peerInitialization === pending) peerInitialization = null;
    if (initializedPeer && readyPeer === initializedPeer) readyPeer = null;
  });
  try { return await pending; }
  finally { if (peerInitialization === pending) peerInitialization = null; }
}

async function createViewerPeer(session) {
  if (typeof Peer === 'undefined') {
    throw new Error('PeerJS não está carregado no escopo global.');
  }

  await fetchIceServersFromApi().catch(() => {});
  if (session?.isDisposed) throw new DOMException("Session disposed", "AbortError");
  const config = getPeerConfig();

  return new Promise((resolve, reject) => {
    const peer = new Peer(config);
    viewerState.peer = peer;
    session?.registerCleanup(() => peer.destroy());
    session?.signal.addEventListener('abort', () => reject(new DOMException('Session disposed', 'AbortError')), { once: true });

    peer.on('open', (id) => {
      if (session?.isDisposed) { peer.destroy(); return; }
      console.log(`[Viewer] Peer conectado com ID: ${id}`);
      resolve(peer);
    });

    peer.on('call', (call) => {
      const callerId = call?.peer;
      const isAuthorized = Boolean(
        callerId && (
          !session?.isDisposed && watchingHosts.get(callerId)?.conn?.open
        )
      );

      if (!isAuthorized) {
        console.warn(`[Viewer] Chamada de mídia rejeitada de peer não autorizado: ${callerId}`);
        try { call.close(); } catch (_) {}
        return;
      }

      if (call.metadata?.type === 'VOICE_CHAT') {
        viewerState.messageHandlers?.answerVoiceCall(call);
      } else {
        handleIncomingStreamCall(call, session);
      }
    });

    peer.on('error', (err) => {
      console.error('[Viewer] Erro no Peer:', err);
      reject(err);
    });
  });
}

function handleIncomingStreamCall(call, session = viewerState.session) {
  hookPeerConnectionSdp(call.peerConnection);
  call.answer(); // Responde sem enviar stream local
  viewerState.activeCall = call;

  const hostId = call.peer;
  const hostEntry = watchingHosts.get(hostId) || { state: 'CONNECTED', conn: viewerState.activeConn };
  const previousCall = hostEntry.call;
  hostEntry.call = call;
  watchingHosts.set(hostId, hostEntry);
  try { previousCall?.close(); } catch (_) {}
  const isCurrent = () => !session?.isDisposed && watchingHosts.get(hostId)?.call === call;

  call.on('stream', (remoteStream) => {
    if (!isCurrent()) return;
    viewerState.remoteStream = remoteStream;
    const onCoopClick = (targetId) => {
      const conn = watchingHosts.get(targetId)?.conn || viewerState.activeConn;
      toggleCoopCardControl(coopController, targetId, conn);
    };
    addOrUpdateVideoCard({ session, audioScope: viewerState.session?.audioScope,
      peerId: hostId,
      stream: remoteStream,
      label: `Ao Vivo: ${hostId.slice(0, 8)}`,
      isLocal: false,
      onCoopClick,
      onClipClick: sourceId => viewerState.features?.clipEditor?.exportClip(sourceId)
    });
    hideCardLoading(hostId);

    // Inicia monitoramento de estatísticas no HUD
    if (call.peerConnection) {
      startStatsMonitor(hostId, call.peerConnection, false, (stats) => {
        updateStatsHud(stats);
      });
      viewerState.statsMonitorActive = true;
    }

    (session?.eventBus || globalBus).emit('stream:received', { hostId, stream: remoteStream });
  });

  call.on('close', () => {
    if (!isCurrent()) return;
    hostEntry.call = null;
    if (viewerState.activeCall === call) viewerState.activeCall = null;
    stopStatsMonitor(hostId);
    viewerState.statsMonitorActive = false;
    removeVideoCard(hostId);
    session?.eventBus.emit('stream:stopped', { sourceId: hostId });
  });
}

function updateStatsHud(stats) {
  if (!stats) return;
  const fpsEl = document.getElementById('stat-fps');
  const bitrateEl = document.getElementById('stat-bitrate');
  const rttEl = document.getElementById('stat-rtt');
  const lossEl = document.getElementById('stat-loss');

  if (fpsEl && stats.fps != null) fpsEl.textContent = `${Math.round(stats.fps)} FPS`;

  const bitrateVal = stats.bitrateMbps != null
    ? Number(stats.bitrateMbps).toFixed(1)
    : (stats.bitrateKbps != null ? (stats.bitrateKbps / 1000).toFixed(1) : null);
  if (bitrateEl && bitrateVal != null) bitrateEl.textContent = `${bitrateVal} Mbps`;

  const rttVal = stats.rtt != null ? stats.rtt : (stats.rttMs != null ? stats.rttMs : null);
  if (rttEl && rttVal != null) rttEl.textContent = `${Math.round(rttVal)} ms`;

  const lossVal = stats.packetLossRate != null
    ? stats.packetLossRate * 100
    : (stats.packetLossRatio != null ? stats.packetLossRatio * 100 : null);
  if (lossEl && lossVal != null) lossEl.textContent = `${Number(lossVal).toFixed(1)}%`;
}

async function initViewerApp(options = {}) {
  const session = createSessionContext({
    role: 'viewer',
    exclusiveKey: instanceKey,
    eventBus: options.eventBus,
    messageDispatcher: options.messageDispatcher,
    pluginManager: options.pluginManager,
    initialState: viewerState
  });
  viewerState.session = session;
  session.getPeerId = () => viewerState.peer?.id;
  audioScope = session.audioScope;
  session.services = { chatManager, voiceManager, coopController, statsScope };
  session.registerCleanup(() => statsScope.dispose());
  session.registerCleanup(() => voiceManager.leaveVoice());
  session.registerCleanup(() => coopController.dispose());

  const features = registerSessionFeatures(session, {
    includeClipping: true,
    getConnections: () => [...watchingHosts.values()].map(host => host.conn).filter(conn => conn?.open),
    isAuthorizedPeer: id => Boolean(watchingHosts.get(id)?.conn?.open),
    role: 'viewer',
    showToast,
    chatManager,
    getPeerId: () => viewerState.peer?.id || 'viewer',
    getRole: () => getCoopState().isPlayer2 ? 'player2' : 'viewer',
    getDisplayName: () => 'Espectador',
    broadcastDataMessage: (data) => {
      if (viewerState.activeConn?.open) sendSessionMessage(viewerState.session, viewerState.activeConn, data);
    }
  });
  viewerState.features = features;
  session.registerCleanup(() => { if (viewerState.features === features) viewerState.features = null; });
  const messageHandlers = bindSessionMessageHandlers(session, { coopController,
    role: 'viewer',
    chatManager,
    voiceManager,
    isAuthorizedPeer: id => Boolean(watchingHosts.get(id)?.conn?.open),
    isTrustedChatRelayPeer: id =>
      (id === viewerState.targetHostId && viewerState.activeConn?.peer === id && viewerState.activeConn.open) ||
      Boolean(watchingHosts.get(id)?.conn?.open),
    getPeer: () => viewerState.peer,
    getLocalPeerId: () => viewerState.peer?.id,
    showToast,
    broadcast: (data) => {
      if (viewerState.activeConn?.open) sendSessionMessage(viewerState.session, viewerState.activeConn, data);
    },
    getVideoCard: (peerId) => document.getElementById(`card-${peerId}`)
  });
  viewerState.messageHandlers = messageHandlers;
  session.registerCleanup(() => {
    if (viewerState.messageHandlers === messageHandlers) viewerState.messageHandlers = null;
  });

  // Configura modal de teste e calibração de controle físico
  setupGamepadTesterModal();

  // Registra manipuladores Co-op do Jogador 2
  const unregisterCoop = registerCoopStateChangeHandler((state) => {
    updateCoopUI(state);
  });
  if (typeof unregisterCoop === 'function') {
    session.registerCleanup(unregisterCoop);
  }

  // Vincula controles do modal de PIN se existirem na página
  const pinSubmitBtn = document.getElementById('viewer-pin-submit-btn');
  const pinCancelBtn = document.getElementById('viewer-pin-cancel-btn');
  const pinInput = document.getElementById('viewer-pin-input');
  if (pinSubmitBtn && pinInput) {
    const onSubmitClick = () => submitViewerPin(pinInput.value);
    const onInputKeyDown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitViewerPin(pinInput.value);
      }
    };
    pinSubmitBtn.addEventListener('click', onSubmitClick);
    pinInput.addEventListener('keydown', onInputKeyDown);
    session.registerCleanup(() => {
      pinSubmitBtn.removeEventListener('click', onSubmitClick);
      pinInput.removeEventListener('keydown', onInputKeyDown);
    });
  }
  if (pinCancelBtn) {
    const onCancelClick = () => hideViewerPinModal();
    pinCancelBtn.addEventListener('click', onCancelClick);
    session.registerCleanup(() => pinCancelBtn.removeEventListener('click', onCancelClick));
  }

  // Vincula campo de busca e botão de conexão de streamer se existirem
  const targetInput = document.getElementById('target-id');
  const connectBtn = document.getElementById('connect-btn');
  if (targetInput && connectBtn) {
    const onTargetInput = () => {
      const val = targetInput.value.trim();
      connectBtn.disabled = !isValidPeerId(val);
    };
    const onConnectClick = () => {
      const val = targetInput.value.trim();
      if (val) connectToStreamer(val, null, session);
    };
    targetInput.addEventListener('input', onTargetInput);
    connectBtn.addEventListener('click', onConnectClick);
    session.registerCleanup(() => {
      targetInput.removeEventListener('input', onTargetInput);
      connectBtn.removeEventListener('click', onConnectClick);
    });
  }

  // Instancia controlador da interface Discord (Chat, Voz, Emojis, Sons)
  if (typeof DiscordUIController !== 'undefined') {
    const discordUI = new DiscordUIController({
      chatManager,
      voiceManager,
      soundboardManager: features.soundboard?.manager,
      onSendMessage: (text) => {
        const msg = chatManager.createMessage({
          senderId: viewerState.peer?.id || 'viewer',
          senderName: 'Espectador',
          role: 'viewer',
          text,
          channel: chatManager.getActiveChannel()
        });
        const stored = msg && chatManager.addMessage(msg);
        if (stored && viewerState.activeConn && viewerState.activeConn.open) {
          sendSessionMessage(viewerState.session, viewerState.activeConn, {
            type: PROTOCOL_TYPES.COMMUNICATION.CHAT_MESSAGE,
            message: stored
          });
        }
      },
      onJoinVoice: async () => {
        try {
          const stream = await voiceManager.joinVoice({ peerId: viewerState.peer?.id, name: 'Espectador', role: 'viewer' });
          if (!stream || !voiceManager.isInVoice || session.isDisposed) return;
          if (viewerState.activeConn?.open) {
            sendSessionMessage(viewerState.session, viewerState.activeConn, { type: 'VOICE_SIGNAL', action: 'VOICE_JOINED', peerId: viewerState.peer?.id, name: 'Espectador', role: 'viewer' });
          }
          if (stream && viewerState.targetHostId) messageHandlers.connectVoiceTo(viewerState.targetHostId);
        } catch (error) {
          showToast('Não foi possível acessar o microfone.', 'error');
        }
      },
      onLeaveVoice: () => {
        messageHandlers.activeVoiceCalls.forEach((call) => { try { call.close(); } catch (_) {} });
        messageHandlers.activeVoiceCalls.clear();
        voiceManager.leaveVoice();
        if (viewerState.activeConn?.open) sendSessionMessage(viewerState.session, viewerState.activeConn, { type: 'VOICE_SIGNAL', action: 'LEAVE', peerId: viewerState.peer?.id });
      },
      onPlaySound: (soundId) => {
        features.soundboard?.manager.playSound(soundId);
        viewerState.activeConn?.open && sendSessionMessage(viewerState.session, viewerState.activeConn, { type: 'SOUNDBOARD_PLAY', soundId, senderName: 'Espectador' });
      },
      onSendReaction: (emoji) => {
        const data = { type: 'EMOJI_REACTION', emoji, senderName: 'Espectador' };
        features.reactions?.manager.spawnReaction(data);
        if (viewerState.activeConn?.open) sendSessionMessage(viewerState.session, viewerState.activeConn, data);
      },
      onOpenWhiteboard: () => {
        features.whiteboardUI?.open();
      },
      onPlayCustomSound: (sound) => {
        features.soundboard?.manager.playCustomSound(sound);
        const data = { type: 'SOUNDBOARD_PLAY_CUSTOM', ...sound, senderName: 'Espectador' };
        if (viewerState.activeConn?.open) sendSessionMessage(viewerState.session, viewerState.activeConn, data);
      }
    });
    discordUI.init();
    session.registerCleanup(() => discordUI.destroy());
  }

  const targetStreamer = options.targetStreamerId || getTargetStreamerId();
  if (targetStreamer) {
    session.registerCleanup(initTermsModal(() => connectToStreamer(targetStreamer, options.pin || null, session)));
  } else {
    session.registerCleanup(initTermsModal());
  }

  return {
    isViewer: true,
    session,
    dispose: () => {
      if (session.isDisposed) return;
      if (viewerState.activeCall) {
        try { viewerState.activeCall.close(); } catch (e) {}
      }
      if (viewerState.activeConn) {
        try { viewerState.activeConn.close(); } catch (e) {}
      }
      if (viewerState.peer && !viewerState.peer.destroyed) {
        try { viewerState.peer.destroy(); } catch (e) {}
      }
      viewerState.peer = null;
      viewerState.activeCall = null;
      viewerState.activeConn = null;
      viewerState.remoteStream = null;
      hideViewerPinModal();
      watchingHosts.clear();
      if (viewerState.session === session) viewerState.session = null;
      session.dispose();
    },
    connect: (streamerId, pin = null) => connectToStreamer(streamerId, pin, session),
    requestCoop: (hId) => requestCoopControl(hId, viewerState.activeConn),
    releaseCoop: (hId) => releaseCoopControl(hId, viewerState.activeConn),
    submitPin: (pin) => submitViewerPin(pin),
    promptPin: (id, err) => promptViewerPin(id, err),
    hidePin: () => hideViewerPinModal(),
    state: viewerState
  };
}
return {
get isViewerPage() { return isViewerPage; },
get isHost() { return isHost; },
get viewerState() { return viewerState; },
get watchingHosts() { return watchingHosts; },
promptViewerPin,
hideViewerPinModal,
submitViewerPin,
getTargetStreamerId,
connectToStreamer,
initViewerPeer,
initViewerApp
};
}
