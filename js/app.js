import { 
  PEER_CONFIG, 
  getPeerConfig,
  fetchIceServersFromApi,
  QUALITY_PROFILES, 
  DEFAULT_PROFILE, 
  DEFAULT_BITRATE_BPS,
  MAX_VIEWERS_DEFAULT,
  ROOM_MODES,
  TERMS_VERSION,
  getPendingIceServersPromise
} from './config.js';
import { 
  hookPeerConnectionSdp, 
  applyTransceiverOptimizations, 
  applySenderOptimizations,
  swapStreamAudioTrack
} from './webrtc.js';
import { initAudioAnalyser, stopAudioAnalyser, applyMicrophoneProcessing } from './audio.js';
import { startStatsMonitor, stopStatsMonitor } from './stats.js';
import { 
  showToast, 
  initTermsModal, 
  createPlaceholderCard, 
  updateCardStatus, 
  hideCardLoading, 
  setCardStreamPaused,
  removeVideoCard, 
  addOrUpdateVideoCard,
  showCoopPromptModal,
  updateCoopUI,
  isValidPeerId
} from './ui.js';
import {
  handleHostCoopMessage,
  handleViewerCoopMessage,
  requestCoopControl,
  releaseCoopControl,
  revokePlayer2,
  setCoopEnabled,
  setMaxCoopPlayers,
  setPartyModeEnabled,
  getCoopState,
  registerCoopPromptHandler,
  registerCoopStateChangeHandler,
  initCompanionAgentConnection,
  setupGamepadTesterModal
} from './coop.js';
import {
  isDesktopApp,
  getCapturableWindows,
  getCapturableSources,
  getNativeCaptureCapabilities,
  setHighPriority,
  createNativeViewerPeer,
  addNativeViewerIceCandidate,
  closeNativeViewerPeer,
  listenNativeCaptureBridge
} from './desktop.js';
import { NativeCaptureProvider } from './capture.js';
import { requestBrowserDisplayMedia } from './browser-capture.js';
import { chatManager } from './chat.js';
import { voiceManager } from './voice.js';
import { DiscordUIController } from './discord-ui.js';
import {
  getAudioDevices,
  populateDeviceSelect,
  playTestTone,
  watchDeviceChanges,
  getSavedAudioPreferences,
  saveAudioPreference,
  isAudioOutputSupported
} from './audio-devices.js';
import { clipRecorder } from './clipping.js';
import { tacticalPingManager } from './ping.js';
import { floatingReactionsManager } from './reactions.js';
import { soundboardManager } from './soundboard.js';
import { adaptiveBitrateController } from './abr.js';
import {
  AUDIO_MEME_EFFECTS,
  getAudioContext,
  decodeAudioFromBlob,
  trimAudioBuffer,
  applyMemeEffect,
  audioBufferToWavBlob,
  wavBlobToBase64,
  base64ToWavBlob,
  playAudioBuffer
} from './audio-meme.js';
import { whiteboardManager, WHITEBOARD_TOOLS, WHITEBOARD_COLORS } from './whiteboard.js';
import { RoomManager, sanitizeRoomId, getRoomMasterPeerId } from './room.js';

// Estado da Aplicação
export let roomManager = null;
let isRoomMasterAttempt = true;

export function isRoomMode() {
  return typeof window !== 'undefined' && window.location ? window.location.pathname.endsWith('room.html') : false;
}

export function getRoomInfoFromUrl() {
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

  return { roomId: sanitizeRoomId(roomId), roomPin: pin };
}

let selectedProfile = DEFAULT_PROFILE;
let customBitrateBps = DEFAULT_BITRATE_BPS;
let maxViewers = MAX_VIEWERS_DEFAULT;
let currentRoomMode = ROOM_MODES.PUBLIC;

let peer = null;
let myId = null;
let localStream = null;
let isStartingStream = false;
let capturedSystemAudioTrack = null;
let capturedMicStream = null;
let activeMicProcessor = null;
let activeNativeCaptureProvider = null;

// Conexões ativas
const connectedViewers = new Map(); // PeerId -> DataConnection
const activeMediaCalls = new Map(); // PeerId -> MediaConnection
const activeVoiceCalls = new Map(); // PeerId -> MediaConnection (Voz)
const watchingHosts = new Map();    // HostId -> { state: 'CONNECTING'|'CONNECTED'|'CANCELLED'|'CLOSED', conn, call, timeoutTimer }
export let discordUI = null;

// Stream direto GStreamer / webrtcbin (Alternativa 1)
const directViewerPeerConnections = new Map(); // HostId -> RTCPeerConnection (no espectador)
const directPendingCandidates = new Map();     // HostId -> Array de candidatos ICE (no espectador)
const directClipStartTimers = new Map();       // HostId -> timerId de debounce para início do clipping
const activeNativeViewerPeers = new Set();     // ViewerId -> Set de peers com ponte ativa no Rust (no transmissor)
const activeDirectSignaling = new Set();       // ViewerId -> Set de peers em negociação (no transmissor)
const processingDirectOffers = new Set();      // ViewerId -> Set de peers com oferta sendo processada (no transmissor)
const lastShownQualityPerHost = new Map();     // HostId -> string da última qualidade notificada
let unlistenNativeBridge = null;

// Reconexão exponencial
let reconnectAttempts = 0;
let reconnectTimer = null;

// Elementos DOM
const copyBadge = document.getElementById('copy-badge');
const shareLinkBtn = document.getElementById('share-link-btn');
const streamBtn = document.getElementById('stream-btn');
const connectBtn = document.getElementById('connect-btn');
const targetInput = document.getElementById('target-id');
const qualityPresetSelect = document.getElementById('quality-preset');
const bitrateSlider = document.getElementById('bitrate-slider');
const bitrateDisplay = document.getElementById('bitrate-display');
const audioModeSelect = document.getElementById('audio-mode-select');
const audioTipBanner = document.getElementById('audio-tip-banner');
const closeBannerBtn = document.getElementById('close-banner-btn');
const viewerCountBadge = document.getElementById('viewer-count');
const coopModeSelect = document.getElementById('coop-mode-select');
const videoCodecSelect = document.getElementById('video-codec-select');
const h264EncoderSelect = document.getElementById('h264-encoder-select');
const h264EncoderGroup = document.getElementById('h264-encoder-group');
const captureCursorToggle = document.getElementById('capture-cursor-toggle');

try {
  const savedCodec = localStorage.getItem('seemygame_video_codec');
  if (savedCodec && videoCodecSelect) {
    videoCodecSelect.value = savedCodec;
  }
  const savedEncoder = localStorage.getItem('seemygame_h264_encoder');
  if (savedEncoder && h264EncoderSelect) {
    h264EncoderSelect.value = savedEncoder;
  }
  const savedCursor = localStorage.getItem('seemygame_capture_cursor');
  if (savedCursor !== null && captureCursorToggle) {
    captureCursorToggle.checked = savedCursor === 'true';
  }
} catch (e) {}

function syncH264EncoderVisibility() {
  if (h264EncoderGroup && videoCodecSelect) {
    h264EncoderGroup.style.display = videoCodecSelect.value === 'h264' ? 'block' : 'none';
  }
}

if (videoCodecSelect) {
  let activeConfirmedCodec = localStorage.getItem('seemygame_video_codec') || 'h264';
  videoCodecSelect.value = activeConfirmedCodec;

  videoCodecSelect.addEventListener('change', async (e) => {
    const targetCodec = e.target.value;
    const isLiveNative = isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId;

    if (isLiveNative) {
      try {
        await activeNativeCaptureProvider.reconfigure({ videoCodec: targetCodec });
        activeConfirmedCodec = targetCodec;
      } catch (err) {
        console.warn('Falha ao reconfigurar codec nativo:', err);
        videoCodecSelect.value = activeConfirmedCodec;
        syncH264EncoderVisibility();
        const msg = err?.message || 'A troca de codec de vídeo durante a transmissão requer reiniciar a transmissão.';
        showToast(`⚠️ ${msg}`, 'error', 6000);
        return;
      }
    } else {
      activeConfirmedCodec = targetCodec;
    }

    syncH264EncoderVisibility();
    try { localStorage.setItem('seemygame_video_codec', activeConfirmedCodec); } catch (err) {}

    const isCurrentlyStreaming = Boolean(localStream || (isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId));
    if (isCurrentlyStreaming) {
      const codecMsg = { type: 'STREAM_CONFIG_UPDATED', videoCodec: activeConfirmedCodec };
      connectedViewers.forEach((conn) => {
        try { conn.send(codecMsg); } catch (err) {}
      });
      if (roomManager) {
        roomManager.broadcast(codecMsg);
      }
    }
    showToast(`Codec de vídeo alterado: ${activeConfirmedCodec.toUpperCase()}`, 'info');
  });
  syncH264EncoderVisibility();
}

if (h264EncoderSelect) {
  h264EncoderSelect.addEventListener('change', (e) => {
    try { localStorage.setItem('seemygame_h264_encoder', e.target.value); } catch (err) {}
    if (isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId) {
      activeNativeCaptureProvider.reconfigure({ h264Encoder: e.target.value }).catch((err) => {
        console.warn('Falha ao reconfigurar encoder H.264 nativo:', err);
      });
    }
    const encoderLabels = { auto: 'Automático', cpu: 'CPU Software (x264)', nvenc: 'NVIDIA NVENC', mf: 'Media Foundation' };
    showToast(`Encoder H.264 alterado: ${encoderLabels[e.target.value] || e.target.value}`, 'info');
  });
}

if (captureCursorToggle) {
  captureCursorToggle.addEventListener('change', (e) => {
    try { localStorage.setItem('seemygame_capture_cursor', String(e.target.checked)); } catch (err) {}
    if (isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId) {
      activeNativeCaptureProvider.reconfigure({ showCursor: e.target.checked }).catch((err) => {
        console.warn('Falha ao alternar cursor na captura nativa:', err);
      });
    }
    showToast(e.target.checked ? '🖱️ Cursor visível na transmissão' : '🚫 Cursor oculto na transmissão', 'info');
  });
}

// Espectadores autorizados (após verificação de PIN se houver)
export const authenticatedViewers = new Set();
let currentPinTargetId = null;

// Elementos DOM para ID Fixo Permanente
const editIdBtn = document.getElementById('edit-id-btn');
const customIdModal = document.getElementById('custom-id-modal');
const customIdInput = document.getElementById('custom-id-input');
const customIdError = document.getElementById('custom-id-error');
const customIdSaveBtn = document.getElementById('custom-id-save-btn');
const customIdResetBtn = document.getElementById('custom-id-reset-btn');
const customIdCancelBtn = document.getElementById('custom-id-cancel-btn');
const roomPinInput = document.getElementById('room-pin-input');

// Elementos DOM para Modal de Desafio de PIN do Espectador
const pinPromptModal = document.getElementById('pin-prompt-modal');
const viewerPinInput = document.getElementById('viewer-pin-input');
const viewerPinError = document.getElementById('viewer-pin-error');
const viewerPinSubmitBtn = document.getElementById('viewer-pin-submit-btn');
const viewerPinCancelBtn = document.getElementById('viewer-pin-cancel-btn');

export function getCustomStreamerId() {
  try {
    if (typeof localStorage !== 'undefined') {
      const id = localStorage.getItem('seemygame_custom_id');
      if (id && isValidPeerId(id.trim())) {
        return id.trim();
      }
    }
  } catch (e) {}
  return null;
}

export function setCustomStreamerId(newId) {
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
  if (isValidPeerId(trimmed) && trimmed.length >= 3 && trimmed.length <= 30) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('seemygame_custom_id', trimmed);
    }
    return true;
  }
  return false;
}

export function getStoredRoomPin() {
  try {
    if (typeof localStorage !== 'undefined') {
      const pin = localStorage.getItem('seemygame_streamer_pin');
      return pin ? String(pin).trim() : '';
    }
  } catch (e) {}
  return '';
}

export function setStoredRoomPin(newPin) {
  if (typeof localStorage === 'undefined') return;
  if (!newPin) {
    localStorage.removeItem('seemygame_streamer_pin');
  } else {
    localStorage.setItem('seemygame_streamer_pin', String(newPin).trim());
  }
}

export function getClientSessionId() {
  if (typeof sessionStorage === 'undefined') {
    return 'sess_' + Math.random().toString(36).slice(2, 10);
  }
  let sid = sessionStorage.getItem('seemygame_client_session_id');
  if (!sid) {
    sid = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem('seemygame_client_session_id', sid);
  }
  return sid;
}

export function isCurrentlyStreaming() {
  const hasBrowserMedia = Boolean(localStream && (localStream.active !== false) && (typeof localStream.getVideoTracks !== 'function' || localStream.getVideoTracks().length > 0));
  const hasNativeCapture = Boolean(isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId);
  const hasRoomStreaming = Boolean(roomManager && roomManager.localStreamingState?.isStreaming);
  return hasBrowserMedia || hasNativeCapture || hasRoomStreaming;
}

export function isPeerAuthorizedForMedia(peerId) {
  if (!peerId) return false;
  if (isRoomMode()) {
    return Boolean(roomManager && roomManager.isPeerAuthorized(peerId));
  }
  if (!connectedViewers.has(peerId)) return false;
  const hostPin = getStoredRoomPin();
  if (!hostPin) return true;
  return authenticatedViewers.has(peerId);
}

export function promptViewerPin(targetId, errorMsg = null) {
  currentPinTargetId = targetId;
  if (pinPromptModal) {
    pinPromptModal.style.display = 'flex';
    if (viewerPinInput) {
      viewerPinInput.value = '';
      viewerPinInput.focus();
    }
    if (viewerPinError) {
      if (errorMsg) {
        viewerPinError.textContent = errorMsg;
        viewerPinError.style.display = 'block';
      } else {
        viewerPinError.textContent = '';
        viewerPinError.style.display = 'none';
      }
    }
  }
}

export function hideViewerPinModal() {
  if (pinPromptModal) {
    pinPromptModal.style.display = 'none';
  }
  if (viewerPinError) {
    viewerPinError.textContent = '';
    viewerPinError.style.display = 'none';
  }
  currentPinTargetId = null;
}

export function submitViewerPin(pin) {
  const trimmed = pin ? String(pin).trim() : '';
  if (!trimmed) {
    if (viewerPinError) {
      viewerPinError.textContent = 'Por favor, digite o PIN da sala.';
      viewerPinError.style.display = 'block';
    }
    return;
  }

  if (isRoomMode() && roomManager && !roomManager.isMaster) {
    let masterConn = roomManager.pendingConnections.get(roomManager.masterPeerId) ||
                     roomManager.meshConnections.get(roomManager.masterPeerId) ||
                     connectedViewers.get(roomManager.masterPeerId);
    if (!masterConn || !masterConn.open) {
      if (peer && !peer.destroyed) {
        masterConn = peer.connect(roomManager.masterPeerId, { reliable: true });
        setupIncomingDataConnection(masterConn);
        masterConn.on('open', () => {
          masterConn.send({
            type: 'ROOM_JOIN_REQUEST',
            name: roomManager.userName,
            pin: trimmed,
            isMuted: voiceManager?.isMuted || false,
            isDeafened: voiceManager?.isDeafened || false,
            isStreaming: false
          });
        });
      }
      return;
    }
    masterConn.send({
      type: 'ROOM_JOIN_REQUEST',
      name: roomManager.userName,
      pin: trimmed,
      isMuted: voiceManager?.isMuted || false,
      isDeafened: voiceManager?.isDeafened || false,
      isStreaming: false
    });
    return;
  }

  if (currentPinTargetId) {
    const hostData = watchingHosts.get(currentPinTargetId);
    if (hostData && hostData.conn && hostData.conn.open) {
      hostData.conn.send({ type: 'REQUEST_STREAM', pin: trimmed });
    }
  }
}

function updateViewerCountUI() {
  if (viewerCountBadge) {
    const count = connectedViewers.size;
    viewerCountBadge.innerHTML = `<span>👥</span> <strong>${count}</strong> ${count === 1 ? 'espectador' : 'espectadores'}`;
  }
}

// ==========================================
// CONFIGURAÇÕES E LISTENERS CO-OP (PLAYER 2)
// ==========================================

export function applyCoopModeChange(val) {
  const isEnabled = (val !== 'disabled');
  setCoopEnabled(isEnabled);
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
    setMaxCoopPlayers(maxPlayers);
    setPartyModeEnabled(partyMode);
  }

  showToast(toastMsg, 'info');

  const coopMsg = {
    type: 'COOP_CONFIG',
    enabled: isEnabled,
    maxPlayers: isEnabled ? maxPlayers : 0,
    partyMode
  };

  connectedViewers.forEach((conn) => {
    try { conn.send(coopMsg); } catch (e) {}
  });

  if (roomManager) {
    roomManager.broadcast(coopMsg);
  }
}

if (coopModeSelect) {
  coopModeSelect.addEventListener('change', (e) => {
    applyCoopModeChange(e.target.value);
  });
}

// Configura callbacks de autorização e de atualização de interface do Co-op
registerCoopPromptHandler(({ peerId, approve, deny }) => {
  showCoopPromptModal(peerId, approve, deny);
});

registerCoopStateChangeHandler((state) => {
  updateCoopUI(state);
});

// Tecla Escape como killswitch / botão de pânico rápido no streamer para revogar Player 2
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const state = getCoopState();
    if (state.activePlayer2PeerId) {
      revokePlayer2();
      showToast('🛑 Controle do Player 2 revogado via tecla Escape!', 'info');
    }
  }
});

// ==========================================
// CONTROLES DE TUNING & PRESETS
// ==========================================

let pendingNativeReconfig = null;
let isNativeReconfiguring = false;

async function queueNativeReconfigure(params) {
  if (!activeNativeCaptureProvider?.session?.sessionId) return;
  pendingNativeReconfig = params;
  if (isNativeReconfiguring) return;
  isNativeReconfiguring = true;
  while (pendingNativeReconfig) {
    const nextParams = pendingNativeReconfig;
    pendingNativeReconfig = null;
    try {
      await activeNativeCaptureProvider.reconfigure(nextParams);
    } catch (err) {
      console.warn('Falha ao reconfigurar captura nativa dinamicamente:', err);
    }
  }
  isNativeReconfiguring = false;
}

export function applyLiveBitrateChange(isAutomatic = false) {
  let scaleFactor = 1;
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack.getSettings === 'function') {
      const settings = videoTrack.getSettings();
      const nativeHeight = settings.height || 1080;
      const targetHeight = selectedProfile.height || 1080;
      if (nativeHeight > targetHeight) {
        scaleFactor = Number((nativeHeight / targetHeight).toFixed(2));
      }
    } else if (selectedProfile.height && selectedProfile.height < 1080) {
      scaleFactor = Number((1080 / selectedProfile.height).toFixed(2));
    }

    activeMediaCalls.forEach((call) => {
      if (call && call.peerConnection) {
        applySenderOptimizations(call.peerConnection, customBitrateBps, selectedProfile.fps, scaleFactor);
      }
    });
  }

  const isCurrentlyStreaming = Boolean(localStream || (isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId));

  // Se a captura nativa desktop estiver ativa, reconfigura o pipeline GStreamer a quente de forma serializada
  if (isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId) {
    queueNativeReconfigure({
      bitrateKbps: Math.round(customBitrateBps / 1000),
      width: selectedProfile.width,
      height: selectedProfile.height,
      fps: selectedProfile.fps,
      h264Encoder: h264EncoderSelect ? h264EncoderSelect.value : undefined,
      showCursor: captureCursorToggle ? captureCursorToggle.checked : undefined
    });
  }

  // Atualiza estado local da sala apenas se estiver realmente transmitindo (evita anunciar falso stream para espectadores)
  if (roomManager && isCurrentlyStreaming) {
    roomManager.setLocalStreaming(true, {
      title: 'Jogo / Tela',
      preset: selectedProfile.id,
      fps: selectedProfile.fps,
      height: selectedProfile.height,
      bitrate: customBitrateBps,
      audioMode: audioModeSelect ? audioModeSelect.value : 'system'
    });
  }

  // Notifica todos os espectadores se estiver transmitindo
  if (isCurrentlyStreaming) {
    const configMsg = {
      type: 'STREAM_CONFIG_UPDATED',
      preset: qualityPresetSelect ? qualityPresetSelect.value : null,
      bitrate: customBitrateBps,
      fps: selectedProfile.fps,
      height: selectedProfile.height,
      isAutomatic
    };

    connectedViewers.forEach((conn) => {
      try { conn.send(configMsg); } catch (e) {}
    });

    if (roomManager) {
      roomManager.broadcast(configMsg);
    }
  }
}

if (qualityPresetSelect) {
  qualityPresetSelect.addEventListener('change', (e) => {
    selectedProfile = QUALITY_PROFILES[e.target.value] || QUALITY_PROFILES.balanced;
    customBitrateBps = selectedProfile.bitrate;
    if (bitrateSlider) bitrateSlider.value = Math.round(customBitrateBps / 1000);
    if (bitrateDisplay) bitrateDisplay.innerText = `${(customBitrateBps / 1000000).toFixed(1)} Mbps`;
    
    showToast(`Perfil selecionado: ${selectedProfile.label}`, 'info');

    // Aplica constraints dinamicamente na trilha de vídeo existente
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
        videoTrack.applyConstraints({
          width: { ideal: selectedProfile.width },
          height: { ideal: selectedProfile.height },
          frameRate: { ideal: selectedProfile.fps }
        }).catch((err) => {
          console.warn('Falha ao aplicar restrições dinâmicas na trilha de vídeo:', err);
        });
      }
    }

    applyLiveBitrateChange();
  });
}

let bitrateSliderDebounceTimer = null;

if (bitrateSlider) {
  bitrateSlider.addEventListener('input', (e) => {
    const kbps = parseInt(e.target.value, 10);
    customBitrateBps = kbps * 1000;
    if (bitrateDisplay) bitrateDisplay.innerText = `${(kbps / 1000).toFixed(1)} Mbps`;
    if (bitrateSliderDebounceTimer) clearTimeout(bitrateSliderDebounceTimer);
    bitrateSliderDebounceTimer = setTimeout(() => {
      bitrateSliderDebounceTimer = null;
      applyLiveBitrateChange();
    }, 250);
  });

  bitrateSlider.addEventListener('change', () => {
    if (bitrateSliderDebounceTimer) {
      clearTimeout(bitrateSliderDebounceTimer);
      bitrateSliderDebounceTimer = null;
    }
    applyLiveBitrateChange();
  });
}

// Sincroniza capacidades do sistema para opções de áudio
export async function syncAudioModeCapabilities() {
  if (!audioModeSelect) return;
  const processOption = audioModeSelect.querySelector('option[value="process"]');
  if (!processOption) return;

  if (isDesktopApp()) {
    try {
      const caps = await getNativeCaptureCapabilities();
      if (!caps.supports_process_audio) {
        processOption.disabled = true;
        processOption.text = 'Áudio da Janela (Requer Windows 11 / Build 22000+)';
        if (audioModeSelect.value === 'process') {
          audioModeSelect.value = 'system';
        }
      }
    } catch (_) {}
  } else {
    // No navegador web em Windows 10, captura de áudio por janela isolada é rejeitada pelo Chromium
    processOption.disabled = true;
    processOption.text = 'Áudio da Janela (Requer App Desktop Windows 11+)';
    if (audioModeSelect.value === 'process') {
      audioModeSelect.value = 'system';
    }
  }
}

// Hot Swapping dinâmico de fonte de áudio ao vivo sem desconectar espectadores
if (audioModeSelect) {
  let activeConfirmedAudioMode = audioModeSelect.value || 'system';

  audioModeSelect.addEventListener('change', async (e) => {
    const previousMode = activeConfirmedAudioMode;
    let newMode = e.target.value;
    const isLiveNative = isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId;

    if (newMode === 'process') {
      if (isDesktopApp()) {
        try {
          const caps = await getNativeCaptureCapabilities();
          if (!caps.supports_process_audio) {
            showToast('Áudio por processo requer Windows 11+. Alternando para áudio do jogo (sistema).', 'info', 4500);
            newMode = 'system';
            audioModeSelect.value = 'system';
          }
        } catch (_) {}
      } else {
        showToast('Áudio da janela isolada requer Windows 11. Alternando para áudio do jogo (sistema).', 'info', 4500);
        newMode = 'system';
        audioModeSelect.value = 'system';
      }
    }

    // Se captura nativa desktop estiver ativa, reconfigura no backend primeiro e valida
    if (isLiveNative) {
      try {
        await activeNativeCaptureProvider.reconfigure({ audioMode: newMode });
        activeConfirmedAudioMode = newMode;
      } catch (err) {
        console.warn('Falha ao reconfigurar modo de áudio nativo:', err);
        audioModeSelect.value = previousMode;
        const msg = err?.message || 'Ativar áudio nativo durante uma transmissão iniciada sem áudio requer reiniciar a transmissão.';
        showToast(`⚠️ ${msg}`, 'error', 6000);
        return;
      }
    } else {
      activeConfirmedAudioMode = newMode;
    }

    if (localStream) {
      try {
        let newAudioTrack = null;

        if (newMode === 'mic') {
          if (!capturedMicStream || !capturedMicStream.getAudioTracks()[0] || capturedMicStream.getAudioTracks()[0].readyState !== 'live') {
            capturedMicStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              }
            });
          }
          if (activeMicProcessor) {
            activeMicProcessor.destroy();
            activeMicProcessor = null;
          }
          activeMicProcessor = applyMicrophoneProcessing(capturedMicStream);
          newAudioTrack = activeMicProcessor.processedStream.getAudioTracks()[0] || capturedMicStream.getAudioTracks()[0] || null;

          localStream.getAudioTracks().forEach(t => {
            if (t !== capturedSystemAudioTrack) {
              t.stop();
            }
            localStream.removeTrack(t);
          });

          if (newAudioTrack) {
            localStream.addTrack(newAudioTrack);
            showToast('🎙️ Microfone com filtro e Noise Gate ativado!', 'success');
          }
        } else if (newMode === 'none') {
          if (activeMicProcessor) {
            activeMicProcessor.destroy();
            activeMicProcessor = null;
          }
          localStream.getAudioTracks().forEach(t => {
            if (t !== capturedSystemAudioTrack) {
              t.stop();
            }
            localStream.removeTrack(t);
          });
          newAudioTrack = null;
          showToast('🔇 Áudio desativado (apenas vídeo).', 'info');
        } else if (newMode === 'process') {
          if (activeMicProcessor) {
            activeMicProcessor.destroy();
            activeMicProcessor = null;
          }
          if (isDesktopApp() && activeNativeCaptureProvider) {
            showToast('🎮 Áudio isolado da janela/processo ativado!', 'success');
          } else if (capturedSystemAudioTrack && capturedSystemAudioTrack.readyState === 'live') {
            localStream.getAudioTracks().forEach(t => {
              if (t !== capturedSystemAudioTrack) {
                t.stop();
              }
              localStream.removeTrack(t);
            });
            localStream.addTrack(capturedSystemAudioTrack);
            newAudioTrack = capturedSystemAudioTrack;
            showToast('🔊 Áudio do aplicativo/jogo ativado!', 'success');
          } else {
            showToast('ℹ️ No navegador, o áudio deve ser compartilhado pela janela ao iniciar.', 'info', 6000);
          }
        }

        // Hot Swapping de áudio no WebRTC para cada chamada ativa
        activeMediaCalls.forEach((call) => {
          if (call && call.peerConnection) {
            swapStreamAudioTrack(call.peerConnection, newAudioTrack);
          }
        });

        // Atualiza VU Meter local
        if (newAudioTrack) {
          initAudioAnalyser(localStream, 'local-me');
        } else {
          stopAudioAnalyser('local-me');
        }
      } catch (err) {
        console.error('Erro ao trocar modo de áudio:', err);
        audioModeSelect.value = previousMode;
        activeConfirmedAudioMode = previousMode;
        showToast(`Erro ao mudar fonte de áudio: ${err.message}`, 'error');
        return;
      }
    }

    const isCurrentlyStreaming = Boolean(localStream || (isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId));

    // Atualiza estado local da sala apenas se estiver transmitindo
    if (roomManager && isCurrentlyStreaming) {
      roomManager.setLocalStreaming(true, { audioMode: activeConfirmedAudioMode });
    }

    // Notifica todos os espectadores se estiver transmitindo
    if (isCurrentlyStreaming) {
      const audioMsg = {
        type: 'STREAM_CONFIG_UPDATED',
        audioMode: activeConfirmedAudioMode,
        hasAudio: activeConfirmedAudioMode !== 'none'
      };

      connectedViewers.forEach((conn) => {
        try { conn.send(audioMsg); } catch (e) {}
      });

      if (roomManager) {
        roomManager.broadcast(audioMsg);
      }
    }

    if (!localStream) {
      const label = e.target.options[e.target.selectedIndex] ? e.target.options[e.target.selectedIndex].text : activeConfirmedAudioMode;
      showToast(`Fonte de áudio: ${label}`, 'info');
    }
  });
}

if (closeBannerBtn && audioTipBanner) {
  closeBannerBtn.addEventListener('click', () => {
    audioTipBanner.style.display = 'none';
  });
}

// ==========================================
// INICIALIZAÇÃO DO PEERJS & SINALIZAÇÃO
// ==========================================

export let customIdRetryAttempts = 0;
export const MAX_CUSTOM_ID_RETRIES = 3;
let customIdRetryTimer = null;

export function getCustomIdRetryAttempts() {
  return customIdRetryAttempts;
}

export function setCustomIdRetryAttempts(val) {
  customIdRetryAttempts = Number(val) || 0;
}

let isConfirmedReload = false;

export function setConfirmedReload(val) {
  isConfirmedReload = Boolean(val);
}

export function handlePageUnload() {
  if (customIdRetryTimer) {
    clearTimeout(customIdRetryTimer);
    customIdRetryTimer = null;
  }
  if (roomManager && roomManager.isInRoom) {
    try {
      roomManager.leave();
    } catch (e) {}
  }
  if (peer && !peer.destroyed) {
    try {
      peer.destroy();
    } catch (e) {}
  }
}

export function isReloadConfirmationPending() {
  const modal = document.getElementById('reload-confirm-modal');
  return Boolean(modal && modal.style.display !== 'none');
}

export function showReloadConfirmationModal() {
  let modal = document.getElementById('reload-confirm-modal');
  if (!modal && typeof document !== 'undefined') {
    modal = document.createElement('div');
    modal.id = 'reload-confirm-modal';
    modal.className = 'modal-overlay';
    modal.style.zIndex = '10002';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 460px; background: #141520; border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 14px; padding: 24px; box-shadow: 0 24px 48px rgba(0, 0, 0, 0.8);">
        <h3 id="reload-confirm-title" style="color: #fbbf24; margin: 0 0 12px 0; font-size: 1.25rem; display: flex; align-items: center; gap: 8px;">
          <span>⚠️</span> Recarregar a Sala?
        </h3>
        <p id="reload-confirm-desc" style="color: var(--text-muted); font-size: 13.5px; line-height: 1.55; margin: 0 0 16px 0;">
          Você está em uma sessão ativa na sala. Recarregar agora interromperá conexões e transmissões temporariamente.
        </p>
        <div id="reload-confirm-warnings" style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 8px; padding: 12px; font-size: 12.5px; line-height: 1.5; color: #fde68a; margin-bottom: 20px; display: none;"></div>
        <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="reload-confirm-cancel-btn" class="btn-secondary" style="padding: 9px 18px; font-size: 13px; border-radius: 8px; cursor: pointer;">
            Continuar na Sala
          </button>
          <button id="reload-confirm-ok-btn" style="background: #ef4444; color: #fff; border: none; border-radius: 8px; padding: 9px 20px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.2s;">
            Recarregar
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  if (!modal) return;

  const warningsEl = modal.querySelector('#reload-confirm-warnings');
  const cancelBtn = modal.querySelector('#reload-confirm-cancel-btn');
  const okBtn = modal.querySelector('#reload-confirm-ok-btn');

  const isStreaming = Boolean(localStream || activeNativeCaptureProvider?.session?.sessionId || (roomManager && roomManager.localStreamingState?.isStreaming));
  const isInVoice = Boolean(voiceManager && voiceManager.isInVoice);
  const isHost = Boolean(isRoomMode() && roomManager && roomManager.isMaster);

  const warnings = [];
  if (isStreaming) {
    warnings.push('🎮 Sua transmissão de tela ao vivo será encerrada para todos os espectadores.');
  }
  if (isInVoice) {
    warnings.push('🎙️ Você será desconectado do canal de voz da sala.');
  }
  if (isHost) {
    warnings.push('👑 Você continuará sendo o Host da sala ao reconectar.');
  }

  if (warningsEl) {
    if (warnings.length > 0) {
      warningsEl.innerHTML = warnings.map(w => `<div style="margin-bottom: 4px;">${w}</div>`).join('');
      warningsEl.style.display = 'block';
    } else {
      warningsEl.style.display = 'none';
    }
  }

  const handleModalKeys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideReloadConfirmationModal();
    }
  };

  if (cancelBtn) {
    cancelBtn.onclick = () => hideReloadConfirmationModal();
    cancelBtn.focus?.();
  }

  if (okBtn) {
    okBtn.onclick = () => {
      isConfirmedReload = true;
      hideReloadConfirmationModal();
      handlePageUnload();
      if (typeof window !== 'undefined' && window.location) {
        window.location.reload();
      }
    };
  }

  window.addEventListener('keydown', handleModalKeys);
  modal._smg_removeKeyHandler = () => window.removeEventListener('keydown', handleModalKeys);
  modal.style.display = 'flex';
}

export function hideReloadConfirmationModal() {
  const modal = document.getElementById('reload-confirm-modal');
  if (modal) {
    modal.style.display = 'none';
    if (typeof modal._smg_removeKeyHandler === 'function') {
      modal._smg_removeKeyHandler();
      modal._smg_removeKeyHandler = null;
    }
  }
}

export function handleReloadKeypress(e) {
  if (!e) return false;
  const isF5 = e.key === 'F5' || e.code === 'F5';
  const isCtrlR = (e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR');
  if (!isF5 && !isCtrlR) return false;

  const isStreaming = Boolean(localStream || activeNativeCaptureProvider?.session?.sessionId || (roomManager && roomManager.localStreamingState?.isStreaming));
  const isInVoice = Boolean(voiceManager && voiceManager.isInVoice);
  const isConnected = Boolean(connectedViewers.size > 0 || watchingHosts.size > 0 || (roomManager && roomManager.members.size > 1));
  const isRoom = isRoomMode();

  if (isStreaming || isInVoice || isConnected || isRoom) {
    e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    showReloadConfirmationModal();
    return true;
  }
  return false;
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', handleReloadKeypress, true);

  window.addEventListener('beforeunload', (e) => {
    if (isConfirmedReload) {
      handlePageUnload();
      return;
    }
    const isStreaming = Boolean(localStream || activeNativeCaptureProvider?.session?.sessionId || (roomManager && roomManager.localStreamingState?.isStreaming));
    if (isStreaming) {
      e.preventDefault();
      e.returnValue = 'Você está com uma transmissão de tela ativa. Deseja realmente sair ou recarregar?';
      return e.returnValue;
    }
    handlePageUnload();
  });

  window.addEventListener('pagehide', handlePageUnload);
}

export function resetPeer() {
  if (customIdRetryTimer) {
    clearTimeout(customIdRetryTimer);
    customIdRetryTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  customIdRetryAttempts = 0;
  if (peer) {
    try {
      peer.destroy();
    } catch (e) {}
    peer = null;
  }
}

export function setupRoomSession(id) {
  const { roomId, roomPin } = getRoomInfoFromUrl();
  const masterId = getRoomMasterPeerId(roomId);
  const isMaster = (id === masterId);
  const clientSessionId = getClientSessionId();

  const customUserName = (typeof localStorage !== 'undefined' ? localStorage.getItem('seemygame_user_name') : null);
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

  if (!roomManager) {
    roomManager = new RoomManager({
      roomId,
      userName,
      clientSessionId,
      roomPin,
      onStateChange: (state) => {
        if (discordUI) {
          discordUI.updateRoomPresence(state.members);
          discordUI.syncStageView(state.streamersCount > 0);
        }
        if (viewerCountBadge) {
          viewerCountBadge.innerHTML = `<span>👥</span> <strong>${state.membersCount}</strong> online`;
        }
      }
    });
    if (typeof window !== 'undefined') {
      window.roomManager = roomManager;
    }

    roomManager.on('streamPublished', ({ peerId, details, member }) => {
      if (peerId !== myId) {
        showToast(`🎮 ${member?.name || 'Um amigo'} começou a transmitir!`, 'info', 4000);
        if (!watchingHosts.has(peerId)) {
          watchFriend(peerId);
        }
      }
    });

    roomManager.on('streamUnpublished', ({ peerId, member }) => {
      if (peerId !== myId) {
        showToast(`Transmissão de ${member?.name || peerId.slice(0, 6)} encerrada.`, 'info');
        disconnectHost(peerId);
      }
    });

    roomManager.on('pinRequired', ({ error }) => {
      promptViewerPin(masterId, error || 'Esta sala requer PIN para entrada.');
    });

    roomManager.on('pinAccepted', () => {
      hideViewerPinModal();
      showToast('Entrada na sala autorizada!', 'success');
    });

    roomManager.on('joinRejected', ({ error }) => {
      if (pinPromptModal && pinPromptModal.style.display === 'flex' && viewerPinError) {
        viewerPinError.textContent = error || 'Acesso recusado pelo coordenador da sala.';
        viewerPinError.style.display = 'block';
      } else {
        showToast(error || 'Não foi possível ingressar na sala.', 'error');
      }
    });

    roomManager.on('memberJoined', (member) => {
      if (member && member.peerId && member.peerId !== myId) {
        // Conexão de voz P2P automática se o usuário local já estiver no canal de voz
        if (voiceManager && voiceManager.isInVoice && voiceManager.localStream && !activeVoiceCalls.has(member.peerId) && peer && !peer.destroyed) {
          const call = peer.call(member.peerId, voiceManager.localStream, {
            metadata: {
              type: 'VOICE_CHAT',
              name: roomManager.userName,
              role: roomManager.isMaster ? 'host' : 'member'
            }
          });
          setupVoiceMediaCall(call, member.peerId);
        }

        if (isCurrentlyStreaming() && isPeerAuthorizedForMedia(member.peerId)) {
          authenticatedViewers.add(member.peerId);
          let conn = connectedViewers.get(member.peerId) || roomManager.meshConnections.get(member.peerId);
          if (!conn && peer && !peer.destroyed) {
            conn = peer.connect(member.peerId, { reliable: true });
            connectedViewers.set(member.peerId, conn);
            setupIncomingDataConnection(conn);
          }
          initiateMediaCallToViewer(member.peerId);
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

    roomManager.on('memberLeft', (member) => {
      if (member && member.peerId) {
        authenticatedViewers.delete(member.peerId);
        activeDirectSignaling.delete(member.peerId);
        if (activeNativeViewerPeers.has(member.peerId)) {
          const sessionId = activeNativeCaptureProvider?.session?.sessionId;
          if (sessionId && isDesktopApp()) {
            closeNativeViewerPeer(sessionId, member.peerId).catch(() => {});
          }
          activeNativeViewerPeers.delete(member.peerId);
        }
        const call = activeMediaCalls.get(member.peerId);
        if (call) {
          try { call.close(); } catch (_) {}
          activeMediaCalls.delete(member.peerId);
        }
        connectedViewers.delete(member.peerId);
        stopStatsMonitor(member.peerId);
        updateViewerCountUI();
      }
    });
  }

  if (!discordUI) {
    initDiscordFeatures();
  }

  roomManager.join(id, isMaster);

  // Auto-conecta na sala de voz da sala P2P
  setTimeout(async () => {
    try {
      if (voiceManager && !voiceManager.isInVoice) {
        const stream = await voiceManager.joinVoice({
          peerId: id,
          name: userName,
          role: isMaster ? 'host' : 'member'
        });
        showToast('Conectado ao canal de voz da sala!', 'success');

        roomManager.members.forEach((m) => {
          if (m.peerId !== id && !activeVoiceCalls.has(m.peerId)) {
            const call = peer.call(m.peerId, stream, {
              metadata: { type: 'VOICE_CHAT', name: userName, role: isMaster ? 'host' : 'member' }
            });
            setupVoiceMediaCall(call, m.peerId);
          }
        });
      }
    } catch (e) {
      console.info('[Room] Entrada na sala de voz aguardando interação do microfone.');
    }
  }, 400);

  // Se não for master, conecta ao master da sala para solicitar entrada
  if (!isMaster && peer) {
    const masterConn = peer.connect(masterId, { reliable: true });
    masterConn.on('open', () => {
      masterConn.send({
        type: 'ROOM_JOIN_REQUEST',
        name: userName,
        clientSessionId,
        pin: roomPin,
        isMuted: voiceManager.isMuted,
        isDeafened: voiceManager.isDeafened,
        isStreaming: isCurrentlyStreaming()
      });
    });
    setupIncomingDataConnection(masterConn);
  }

  const roomBadge = document.getElementById('room-header-badge');
  if (roomBadge) roomBadge.textContent = `Sala: #${roomId}${isMaster ? ' (Host)' : ''}`;

  const sidebarRoomName = document.getElementById('sidebar-room-name');
  if (sidebarRoomName) sidebarRoomName.textContent = `🔊 #${roomId}`;

  const localUserNameElem = document.getElementById('local-user-name');
  if (localUserNameElem) localUserNameElem.textContent = userName;

  const localAvatarElem = document.getElementById('local-avatar');
  if (localAvatarElem) localAvatarElem.textContent = (userName || 'V').charAt(0).toUpperCase();

  if (copyBadge) {
    copyBadge.innerHTML = `<span>📋</span> Sala: <strong>#${roomId}</strong>`;
  }

  if (shareLinkBtn) {
    shareLinkBtn.style.display = 'inline-flex';
    shareLinkBtn.onclick = async () => {
      const pinParam = (roomManager && roomManager.roomPin) ? `&pin=${encodeURIComponent(roomManager.roomPin)}` : '';
      const shareUrl = `${window.location.origin}${window.location.pathname}#room=${encodeURIComponent(roomId)}${pinParam}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        showToast(pinParam ? 'Link da sala (com PIN) copiado!' : 'Link da sala copiado!', 'success');
      } catch (err) {
        showToast(`Link: ${shareUrl}`, 'info');
      }
    };
  }
}

export function initPeer() {
  if (typeof Peer === 'undefined') {
    showToast('Erro: Biblioteca PeerJS não carregada.', 'error');
    return null;
  }

  const pendingIce = getPendingIceServersPromise();
  if (pendingIce) {
    pendingIce.finally(() => {
      initPeer();
    });
    return null;
  }

  if (peer && !peer.destroyed && !peer.disconnected) {
    return peer;
  }

  const inRoom = isRoomMode();
  const isHost = typeof window !== 'undefined' && window.location ? !window.location.pathname.endsWith('viewer.html') : true;
  const config = getPeerConfig();

  let customId = null;
  if (inRoom) {
    const { roomId } = getRoomInfoFromUrl();
    customId = isRoomMasterAttempt ? getRoomMasterPeerId(roomId) : null;
  } else if (isHost) {
    customId = getCustomStreamerId();
  }

  try {
    if (customId) {
      peer = new Peer(customId, config);
    } else {
      peer = new Peer(config);
    }
  } catch (err) {
    console.error('Falha ao inicializar PeerJS:', err);
    peer = new Peer(config);
  }

  peer.on('open', (id) => {
    myId = id;
    reconnectAttempts = 0;
    customIdRetryAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (customIdRetryTimer) {
      clearTimeout(customIdRetryTimer);
      customIdRetryTimer = null;
    }

    if (inRoom) {
      setupRoomSession(id);
    }

    if (typeof sessionStorage !== 'undefined' && isHost && !inRoom) {
      const fixedId = getCustomStreamerId();
      if (fixedId && fixedId === id) {
        sessionStorage.setItem('seemygame_last_id', id);
      }
    }

    if (copyBadge) {
      copyBadge.innerHTML = `<span>📋</span> Seu ID: <strong>${id}</strong>`;
      copyBadge.setAttribute('role', 'button');
      copyBadge.setAttribute('tabindex', '0');
    }
    if (shareLinkBtn) shareLinkBtn.style.display = 'inline-flex';
    if (streamBtn) streamBtn.disabled = false;
    if (connectBtn) connectBtn.disabled = false;
    showToast('Engine P2P conectada em alta fluidez!', 'success');

    // Copiar ID com suporte a teclado e tratamento assíncrono
    const copyIdAction = async () => {
      try {
        await navigator.clipboard.writeText(id);
        const prev = copyBadge.innerHTML;
        copyBadge.innerHTML = `<span>✓</span> <strong>ID Copiado!</strong>`;
        showToast('Seu ID foi copiado!', 'success');
        setTimeout(() => { copyBadge.innerHTML = prev; }, 2500);
      } catch (err) {
        showToast(`ID: ${id}`, 'info');
      }
    };

    if (copyBadge) {
      copyBadge.onclick = copyIdAction;
      copyBadge.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          copyIdAction();
        }
      };
    }

    // Copiar Link direto para a página do espectador (apenas fora do modo sala)
    if (shareLinkBtn && !inRoom) {
      shareLinkBtn.onclick = async () => {
        let basePath = window.location.pathname;
        if (basePath.endsWith('.html')) {
          basePath = basePath.substring(0, basePath.lastIndexOf('/') + 1);
        } else if (!basePath.endsWith('/')) {
          basePath += '/';
        }
        const shareUrl = `${window.location.origin}${basePath}viewer.html#watch=${id}`;
        try {
          await navigator.clipboard.writeText(shareUrl);
          showToast('Link de convite copiado!', 'success');
        } catch (err) {
          showToast(`Link de convite: ${shareUrl}`, 'info');
        }
      };
    }

    checkAutoWatchUrl();
  });

  // 1. Recebe conexões de controle (DataConnection)
  peer.on('connection', (conn) => {
    setupIncomingDataConnection(conn);
  });

  // 2. Recebe chamadas de mídia (MediaConnection)
  peer.on('call', (call) => {
    handleIncomingMediaCall(call);
  });

  // 3. Queda de sinalização e reconexão automática com backoff exponencial
  peer.on('disconnected', () => {
    console.warn('PeerJS desconectado do servidor de sinalização.');
    showToast('Conexão de sinalização perdida. Tentando reconectar...', 'info');

    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reconnectAttempts < 5) {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 16000);
      reconnectAttempts++;
      reconnectTimer = setTimeout(() => {
        if (peer && !peer.destroyed && peer.disconnected) {
          console.log(`Tentativa de reconexão PeerJS #${reconnectAttempts}...`);
          try {
            peer.reconnect();
          } catch (e) {
            console.warn('Erro ao chamar peer.reconnect():', e);
          }
        }
      }, delay);
    } else {
      showToast('Não foi possível reconectar à sinalização. Atualize a página.', 'error');
    }
  });

  peer.on('close', () => {
    console.warn('PeerJS destruído/encerrado.');
    showToast('Sessão P2P encerrada.', 'info');
    if (streamBtn) streamBtn.disabled = true;
    if (connectBtn) connectBtn.disabled = true;
  });

  peer.on('error', (err) => {
    console.error('PeerJS Error:', err);
    if (err.type === 'peer-unavailable') {
      showToast('ID do amigo não encontrado ou offline.', 'error');
      // Identifica o host pendente no Map sem depender do targetInput
      for (const [hostId, hostData] of watchingHosts.entries()) {
        if (hostData && hostData.state === 'CONNECTING') {
          disconnectHost(hostId);
          break;
        }
      }
    } else if (err.type === 'unavailable-id') {
      const inRoom = isRoomMode();
      if (inRoom && isRoomMasterAttempt) {
        const { roomId } = getRoomInfoFromUrl();
        const wasMaster = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('seemygame_room_master_' + roomId) === 'true';
        if (wasMaster && customIdRetryAttempts < MAX_CUSTOM_ID_RETRIES) {
          customIdRetryAttempts++;
          const delay = Math.min(1000 * customIdRetryAttempts, 3000);
          console.warn(`[Room] ID de coordenador retido pelo servidor de sinalização após recarga. Tentando reconectar ${customIdRetryAttempts}/${MAX_CUSTOM_ID_RETRIES} em ${delay}ms...`);
          showToast(`Aguardando liberação do ID de Host da sala... (${customIdRetryAttempts}/${MAX_CUSTOM_ID_RETRIES})`, 'info', delay);
          if (peer) {
            try { peer.destroy(); } catch (e) {}
            peer = null;
          }
          customIdRetryTimer = setTimeout(() => initPeer(), delay);
          return;
        }

        console.log('[Room] Master da sala já existe. Conectando como membro regular da sala...');
        isRoomMasterAttempt = false;
        if (peer) {
          try { peer.destroy(); } catch (e) {}
          peer = null;
        }
        setTimeout(() => initPeer(), 100);
        return;
      }

      const isHost = typeof window !== 'undefined' && window.location ? !window.location.pathname.endsWith('viewer.html') : true;
      const takenId = (isHost ? getCustomStreamerId() : null) || myId;

      const isSelfSession = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('seemygame_last_id') === takenId;
      const isReload = typeof performance !== 'undefined' && (performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload' || performance.navigation?.type === 1);

      // Se o erro ocorreu durante o reload da página ou sessão recente do próprio streamer,
      // a conexão anterior no servidor PeerJS ainda pode estar em processo de liberação (grace period).
      if (isHost && takenId && (isSelfSession || isReload) && customIdRetryAttempts < MAX_CUSTOM_ID_RETRIES) {
        customIdRetryAttempts++;
        const delay = Math.min(1000 + 1000 * customIdRetryAttempts, 5000);
        console.warn(`[PeerJS] ID "${takenId}" ainda retido pelo servidor de sinalização. Tentativa de recuperação ${customIdRetryAttempts}/${MAX_CUSTOM_ID_RETRIES} em ${delay}ms...`);

        if (copyBadge) {
          copyBadge.innerHTML = `<span>⏳</span> Liberando ID <strong>${takenId}</strong>... (${customIdRetryAttempts}/${MAX_CUSTOM_ID_RETRIES})`;
        }
        if (customIdModal) {
          customIdModal.style.display = 'none';
        }
        showToast(`Aguardando liberação do ID "${takenId}" da sessão anterior... (${customIdRetryAttempts}/${MAX_CUSTOM_ID_RETRIES})`, 'info', delay);

        if (peer) {
          try { peer.destroy(); } catch (e) {}
          peer = null;
        }

        if (customIdRetryTimer) clearTimeout(customIdRetryTimer);
        customIdRetryTimer = setTimeout(() => {
          initPeer();
        }, delay);
        return;
      }

      customIdRetryAttempts = 0;
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('seemygame_last_id');
      }
      showToast(`O ID "${takenId}" já está em uso por outro streamer. Escolha outro ID fixo.`, 'error', 7000);
      if (copyBadge) {
        copyBadge.innerHTML = `<span>⚠️</span> ID <strong>${takenId}</strong> em uso (clique para tentar)`;
        copyBadge.style.cursor = 'pointer';
        copyBadge.onclick = () => {
          showToast(`Tentando reconectar com ID "${takenId}"...`, 'info');
          resetPeer();
          initPeer();
        };
      }
      if (customIdModal) {
        if (customIdInput) {
          customIdInput.value = takenId || '';
        }
        customIdModal.style.display = 'flex';
        if (customIdError) {
          customIdError.textContent = `O ID "${takenId}" já está em uso no momento. Por favor escolha outro ou tente novamente.`;
          customIdError.style.display = 'block';
        }
      }
    } else {
      showToast(`Erro P2P: ${err.type || err.message}`, 'error');
    }
  });

  return peer;
}

// ==========================================
// DISCORD VOICE & CHAT P2P INTEGRATION
// ==========================================

export function broadcastDataMessage(payload, excludePeerId = null) {
  if (isRoomMode() && roomManager) {
    roomManager.broadcast(payload, excludePeerId);
  }

  const hostPin = getStoredRoomPin();
  // Transmissor envia para todos os espectadores conectados e autorizados
  connectedViewers.forEach((conn, peerId) => {
    if (peerId !== excludePeerId && conn && conn.open !== false) {
      if (hostPin && !authenticatedViewers.has(peerId)) return;
      try {
        conn.send(payload);
      } catch (e) {}
    }
  });

  // Espectador envia para o host
  watchingHosts.forEach((hostData) => {
    if (hostData.conn && hostData.conn.open !== false) {
      try {
        hostData.conn.send(payload);
      } catch (e) {}
    }
  });
}

export function setupVoiceMediaCall(call, remotePeerId) {
  if (!call) return;
  activeVoiceCalls.set(remotePeerId, call);

  call.on('stream', (remoteAudioStream) => {
    const member = roomManager?.members?.get(remotePeerId);
    voiceManager.addRemoteParticipant(remotePeerId, {
      name: member?.name || call.metadata?.name || 'Amigo',
      role: member?.role || call.metadata?.role || (call.metadata?.isMaster ? 'host' : 'member'),
      stream: remoteAudioStream
    });
  });

  call.on('close', () => {
    voiceManager.removeRemoteParticipant(remotePeerId);
    activeVoiceCalls.delete(remotePeerId);
  });

  call.on('error', (err) => {
    console.error(`Erro na chamada de voz com ${remotePeerId}:`, err);
    voiceManager.removeRemoteParticipant(remotePeerId);
    activeVoiceCalls.delete(remotePeerId);
  });
}

export function handleIncomingVoiceCall(call) {
  const remotePeerId = call.peer;
  const isAuthorized = isPeerAuthorizedForMedia(remotePeerId) || watchingHosts.has(remotePeerId);
  if (!isAuthorized) {
    console.warn(`Chamada de voz não autorizada rejeitada de: ${remotePeerId}`);
    try { call.close(); } catch (e) {}
    return;
  }

  const streamToAnswer = voiceManager.localStream || new MediaStream();
  call.answer(streamToAnswer);
  setupVoiceMediaCall(call, remotePeerId);
}

export const seenMessageIds = new Set();
export function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  if (seenMessageIds.has(msgId)) return true;
  if (seenMessageIds.size > 2000) {
    const first = seenMessageIds.values().next().value;
    seenMessageIds.delete(first);
  }
  seenMessageIds.add(msgId);
  return false;
}

export function handleIncomingP2PMessage(data, sourceConn) {
  if (!data || typeof data !== 'object') return;
  const msgId = data.msgId || data.message?.id;
  if (msgId && isDuplicateMessage(msgId)) return;

  if (data.type === 'CHAT_MESSAGE') {
    if (data.message) {
      chatManager.addMessage(data.message);
      if (connectedViewers.size > 0) {
        broadcastDataMessage(data, sourceConn?.peer);
      }
    }
    return;
  }

  if (data.type === 'VOICE_STATE_UPDATE') {
    voiceManager.updateParticipantState(data.peerId, {
      isSpeaking: data.isSpeaking,
      isMuted: data.isMuted,
      isDeafened: data.isDeafened,
    });
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'VOICE_SIGNAL') {
    if (data.action === 'LEAVE') {
      voiceManager.removeRemoteParticipant(data.peerId);
      const call = activeVoiceCalls.get(data.peerId);
      if (call) {
        try { call.close(); } catch (e) {}
        activeVoiceCalls.delete(data.peerId);
      }
    } else if (data.action === 'HOST_VOICE_ACTIVE' || data.action === 'VOICE_JOINED') {
      if (sourceConn?.peer && data.peerId && data.peerId !== sourceConn.peer) {
        console.warn(`[VOICE_SIGNAL] Rejeitando peerId forjado: ${data.peerId} vindo de ${sourceConn.peer}`);
        return;
      }
      if (data.action === 'HOST_VOICE_ACTIVE') {
        showToast('O Streamer está na sala de voz!', 'info');
      } else {
        showToast(`${data.name || 'Um amigo'} entrou na sala de voz!`, 'info');
      }
      if (voiceManager.isInVoice && voiceManager.localStream && peer && !peer.destroyed && !activeVoiceCalls.has(data.peerId)) {
        const call = peer.call(data.peerId, voiceManager.localStream, {
          metadata: { type: 'VOICE_CHAT', name: voiceManager.myName, role: voiceManager.myRole },
        });
        setupVoiceMediaCall(call, data.peerId);
      }
    }
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'TACTICAL_PING') {
    if (data.ping) {
      tacticalPingManager.addPing(data.ping);
      if (connectedViewers.size > 0) {
        broadcastDataMessage(data, sourceConn?.peer);
      }
    }
    return;
  }

  if (data.type === 'TACTICAL_LASER') {
    if (data.point) {
      tacticalPingManager.addLaserPoint(data.point);
      if (connectedViewers.size > 0) {
        broadcastDataMessage(data, sourceConn?.peer);
      }
    }
    return;
  }

  if (data.type === 'EMOJI_REACTION') {
    floatingReactionsManager.spawnReaction({
      emoji: data.emoji,
      xPercent: data.xPercent,
      senderName: data.senderName
    });
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'SOUNDBOARD_PLAY') {
    soundboardManager.playSound(data.soundId);
    showToast(`🔊 ${data.senderName || 'Alguém'} tocou um som no soundboard!`, 'info', 2500);
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'SOUNDBOARD_PLAY_CUSTOM') {
    if (data.audioBase64) {
      try {
        const wavBlob = base64ToWavBlob(data.audioBase64);
        const ctx = getAudioContext();
        if (ctx) {
          decodeAudioFromBlob(wavBlob, ctx).then(buf => {
            if (buf) playAudioBuffer(buf, ctx);
          }).catch(() => {});
        }
      } catch (err) {
        console.warn('[AudioMeme] Erro ao reproduzir som customizado P2P:', err);
      }
    }
    const effectLabel = data.effectName ? ` (${data.effectName})` : '';
    showToast(`🎙️ ${data.senderName || 'Alguém'} disparou um áudio meme${effectLabel}!`, 'info', 3000);
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'WHITEBOARD_ELEMENT_ADD') {
    whiteboardManager.addElement(data.element, false);
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'WHITEBOARD_ELEMENT_DELETE') {
    whiteboardManager.removeElement(data.elementId, false);
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'WHITEBOARD_CLEAR') {
    whiteboardManager.clear(false);
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'WHITEBOARD_CURSOR') {
    whiteboardManager.updateRemoteCursor(sourceConn?.peer || 'remote-peer', {
      x: data.x,
      y: data.y,
      userName: data.userName,
      color: data.color
    });
    if (connectedViewers.size > 0) {
      broadcastDataMessage(data, sourceConn?.peer);
    }
    return;
  }

  if (data.type === 'WHITEBOARD_REQUEST_SYNC') {
    if (sourceConn && sourceConn.open) {
      sourceConn.send({
        type: 'WHITEBOARD_SYNC',
        elements: whiteboardManager.elements
      });
    }
    return;
  }

  if (data.type === 'WHITEBOARD_SYNC') {
    whiteboardManager.setElements(data.elements);
    return;
  }
}

export let tuningAudioControls = null;

export async function initTuningAudioDeviceControls() {
  const micSelect = document.getElementById('tuning-mic-select');
  const speakerSelect = document.getElementById('tuning-speaker-select');
  const testSpeakerBtn = document.getElementById('tuning-test-speaker-btn');
  const speakerNote = document.getElementById('tuning-speaker-note');

  if (!micSelect && !speakerSelect) return null;

  const supportsOutput = isAudioOutputSupported();
  if (speakerNote) {
    if (!supportsOutput) {
      speakerNote.textContent = 'Seleção de saída não suportada neste navegador (usando padrão do sistema).';
    } else {
      speakerNote.textContent = '';
    }
  }
  if (speakerSelect && !supportsOutput) {
    speakerSelect.disabled = true;
  }
  if (testSpeakerBtn && !supportsOutput) {
    testSpeakerBtn.disabled = true;
  }

  async function refreshDevices(requestPermission = false) {
    const { microphones, speakers } = await getAudioDevices(requestPermission);
    const prefs = getSavedAudioPreferences();

    if (micSelect) {
      const currentMicId = micSelect.value || prefs.inputId || (voiceManager?.selectedMicId) || '';
      populateDeviceSelect(micSelect, microphones, currentMicId, 'Microfone Padrão do Sistema');
    }

    if (speakerSelect && supportsOutput) {
      const currentSpeakerId = speakerSelect.value || prefs.outputId || (voiceManager?.selectedSpeakerId) || '';
      populateDeviceSelect(speakerSelect, speakers, currentSpeakerId, 'Alto-falante Padrão do Sistema');
    }
  }

  // Preenche inicialmente os selects de áudio
  await refreshDevices(false);

  // Monitora alterações físicas de dispositivos (conectar/desconectar fones)
  watchDeviceChanges(() => {
    refreshDevices(false).catch(() => {});
  });

  if (micSelect) {
    micSelect.addEventListener('change', async () => {
      const deviceId = micSelect.value;
      saveAudioPreference('input', deviceId);
      if (voiceManager) {
        await voiceManager.setAudioInputDevice(deviceId).catch((err) => {
          console.warn('[AudioDevices] Falha ao alternar microfone no voiceManager:', err);
        });
      }
    });
  }

  if (speakerSelect && supportsOutput) {
    speakerSelect.addEventListener('change', async () => {
      const deviceId = speakerSelect.value;
      saveAudioPreference('output', deviceId);
      if (voiceManager) {
        await voiceManager.setAudioOutputDevice(deviceId).catch((err) => {
          console.warn('[AudioDevices] Falha ao alternar saída no voiceManager:', err);
        });
      }
    });
  }

  if (testSpeakerBtn) {
    testSpeakerBtn.addEventListener('click', async () => {
      const selectedSinkId = speakerSelect ? speakerSelect.value : '';
      const originalText = testSpeakerBtn.innerHTML;
      testSpeakerBtn.disabled = true;
      testSpeakerBtn.innerHTML = '🔊 Testando...';
      try {
        await playTestTone(selectedSinkId);
      } catch (e) {
        console.warn('[AudioDevices] Erro ao reproduzir tom de teste:', e);
      } finally {
        testSpeakerBtn.disabled = false;
        testSpeakerBtn.innerHTML = originalText;
      }
    });
  }

  return { refreshDevices };
}

export function initDiscordFeatures() {
  if (typeof document === 'undefined') return;

  discordUI = new DiscordUIController({
    onSendMessage: (text) => {
      const isHost = !window.location.pathname.endsWith('viewer.html');
      const coopState = getCoopState();
      const role = isHost ? 'host' : (coopState.isPlayer2 ? 'player2' : 'viewer');
      const senderName = isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : `Amigo ${myId ? myId.slice(0, 4) : ''}`);

      const msg = chatManager.createMessage({
        senderId: myId,
        senderName,
        role,
        text,
        channel: chatManager.getActiveChannel(),
      });

      if (!msg) return;
      chatManager.addMessage(msg);
      broadcastDataMessage({ type: 'CHAT_MESSAGE', message: msg });
    },
    onPlaySound: (soundId) => {
      if (!soundboardManager.canPlay()) {
        showToast('Aguarde um instante antes de disparar outro som.', 'info');
        return;
      }
      soundboardManager.playSound(soundId);
      const isHost = !window.location.pathname.endsWith('viewer.html');
      const coopState = getCoopState();
      const senderName = isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : `Amigo ${myId ? myId.slice(0, 4) : ''}`);
      broadcastDataMessage({
        type: 'SOUNDBOARD_PLAY',
        soundId,
        senderName
      });
    },
    onSendReaction: (emoji) => {
      if (!floatingReactionsManager.canSend()) return;
      const isHost = !window.location.pathname.endsWith('viewer.html');
      const coopState = getCoopState();
      const senderName = isRoomMode() && roomManager?.userName
        ? roomManager.userName
        : (isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : (myId ? `Amigo ${myId.slice(0, 4)}` : 'Espectador')));
      const xPercent = Math.random() * 70 + 15;

      floatingReactionsManager.spawnReaction({ emoji, xPercent, senderName });
      broadcastDataMessage({
        type: 'EMOJI_REACTION',
        emoji,
        xPercent,
        senderName
      });
    },
    onJoinVoice: async () => {
      try {
        const isHost = !window.location.pathname.endsWith('viewer.html');
        const coopState = getCoopState();
        const role = isRoomMode() && roomManager
          ? (roomManager.isMaster ? 'host' : 'member')
          : (isHost ? 'host' : (coopState.isPlayer2 ? 'player2' : 'viewer'));
        const name = isRoomMode() && roomManager
          ? roomManager.userName
          : (isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : `Amigo ${myId ? myId.slice(0, 4) : ''}`));

        const stream = await voiceManager.joinVoice({
          peerId: myId,
          name,
          role,
        });

        showToast('Conectado à sala de voz!', 'success');

        if (isRoomMode() && roomManager) {
          roomManager.setLocalVoiceState({
            isMuted: voiceManager.isMuted,
            isDeafened: voiceManager.isDeafened,
            isSpeaking: false
          });

          broadcastDataMessage({
            type: 'VOICE_SIGNAL',
            action: 'VOICE_JOINED',
            peerId: myId,
            name,
            role
          });

          roomManager.members.forEach((m) => {
            if (m.peerId && m.peerId !== myId && !activeVoiceCalls.has(m.peerId) && peer && !peer.destroyed) {
              const call = peer.call(m.peerId, stream, {
                metadata: { type: 'VOICE_CHAT', name, role }
              });
              setupVoiceMediaCall(call, m.peerId);
            }
          });

          activeVoiceCalls.forEach((call) => {
            try {
              if (call?.peerConnection) {
                const sender = call.peerConnection.getSenders()?.find(s => s.track?.kind === 'audio' || !s.track);
                const newAudioTrack = stream.getAudioTracks()[0];
                if (sender && newAudioTrack) {
                  sender.replaceTrack(newAudioTrack).catch(() => {});
                }
              }
            } catch (_) {}
          });
        } else {
          if (!isHost) {
            watchingHosts.forEach((hostData, hostId) => {
              if (hostData.state === 'CONNECTED' && peer && !activeVoiceCalls.has(hostId)) {
                const call = peer.call(hostId, stream, {
                  metadata: { type: 'VOICE_CHAT', name, role },
                });
                setupVoiceMediaCall(call, hostId);
              }
            });
          } else {
            broadcastDataMessage({ type: 'VOICE_SIGNAL', action: 'HOST_VOICE_ACTIVE', peerId: myId, name, role });
          }
        }
      } catch (err) {
        console.warn('[Voice] Falha ao acessar microfone:', err);
        showToast('Não foi possível acessar o microfone.', 'error');
      }
    },
    onLeaveVoice: () => {
      activeVoiceCalls.forEach((call) => {
        try { call.close(); } catch (e) {}
      });
      activeVoiceCalls.clear();

      voiceManager.leaveVoice();
      broadcastDataMessage({ type: 'VOICE_SIGNAL', action: 'LEAVE', peerId: myId });
      showToast('Você saiu da sala de voz.', 'info');
    },
    onToggleMic: (isMuted) => {
      if (roomManager) {
        roomManager.setLocalVoiceState({ isMuted });
      }
    },
    onToggleDeaf: (isDeafened) => {
      if (roomManager) {
        roomManager.setLocalVoiceState({ isDeafened });
      }
    },
    onToggleStream: () => {
      handleStreamBtnClick();
    },
    onOpenTuning: async () => {
      const modal = document.getElementById('tuning-modal');
      if (modal) modal.style.display = 'flex';
      if (tuningAudioControls) {
        await tuningAudioControls.refreshDevices(true).catch(() => {});
      }
    },
    onOpenWhiteboard: () => {
      const wbModal = document.getElementById('whiteboard-modal');
      if (wbModal) wbModal.style.display = 'flex';
    },
    onLeaveRoom: () => {
      if (roomManager) roomManager.leave();
      window.location.href = 'index.html';
    }
  });


  const closeTuningBtn = document.getElementById('close-tuning-modal-btn');
  const saveTuningBtn = document.getElementById('save-tuning-btn');
  const tuningModal = document.getElementById('tuning-modal');

  if (closeTuningBtn && tuningModal) {
    closeTuningBtn.addEventListener('click', () => { tuningModal.style.display = 'none'; });
  }
  if (saveTuningBtn && tuningModal) {
    saveTuningBtn.addEventListener('click', async () => {
      const micSelect = document.getElementById('tuning-mic-select');
      const speakerSelect = document.getElementById('tuning-speaker-select');
      if (micSelect) {
        saveAudioPreference('input', micSelect.value);
        if (voiceManager) await voiceManager.setAudioInputDevice(micSelect.value).catch(() => {});
      }
      if (speakerSelect && isAudioOutputSupported()) {
        saveAudioPreference('output', speakerSelect.value);
        if (voiceManager) await voiceManager.setAudioOutputDevice(speakerSelect.value).catch(() => {});
      }
      if (videoCodecSelect) {
        try { localStorage.setItem('seemygame_video_codec', videoCodecSelect.value); } catch (e) {}
      }
      if (h264EncoderSelect) {
        try { localStorage.setItem('seemygame_h264_encoder', h264EncoderSelect.value); } catch (e) {}
      }
      if (captureCursorToggle) {
        try { localStorage.setItem('seemygame_capture_cursor', String(captureCursorToggle.checked)); } catch (e) {}
      }
      if (coopModeSelect) {
        applyCoopModeChange(coopModeSelect.value);
      }

      // Reconfigura a transmissão ativa consolidando todas as opções do modal
      if (localStream || (isDesktopApp() && activeNativeCaptureProvider)) {
        applyLiveBitrateChange();
      }

      tuningModal.style.display = 'none';
      showToast('Configurações atualizadas com sucesso!', 'success');
    });
  }

  initTuningAudioDeviceControls().then((controls) => {
    tuningAudioControls = controls;
  }).catch(() => {});

  discordUI.init();

  voiceManager.on('speakingChange', ({ peerId, isSpeaking }) => {
    if (peerId === myId) {
      broadcastDataMessage({ type: 'VOICE_STATE_UPDATE', peerId: myId, isSpeaking });
    }
  });

  voiceManager.on('voiceStateChange', (state) => {
    broadcastDataMessage({
      type: 'VOICE_STATE_UPDATE',
      peerId: myId,
      isMuted: state.isMuted,
      isDeafened: state.isDeafened,
    });
  });
}

// Controle: Transmissor recebe pedido de espectador
function setupIncomingDataConnection(conn) {
  if (!conn) return;
  if (conn._smg_incoming_bound) return;
  conn._smg_incoming_bound = true;
  conn._smg_direct_signaling_bound = true;

  // Limite de espectadores simultâneos
  if (connectedViewers.size >= maxViewers && !connectedViewers.has(conn.peer)) {
    console.warn(`Rejeitando conexão de ${conn.peer}: limite de ${maxViewers} espectadores atingido.`);
    conn.on('open', () => {
      conn.send({ type: 'STREAM_REJECTED', reason: `Limite de ${maxViewers} espectadores atingido.` });
      setTimeout(() => conn.close(), 500);
    });
    showToast(`Conexão de ${conn.peer.slice(0, 6)} recusada: sala cheia.`, 'info');
    return;
  }

  conn.on('open', () => {
    console.log(`Espectador conectado: ${conn.peer}`);
    connectedViewers.set(conn.peer, conn);
    if (roomManager) {
      roomManager.registerConnection(conn.peer, conn);
    }
    updateViewerCountUI();

    if (isRoomMode()) {
      // No modo de sala, o controle de acesso e admissão é exclusivo do RoomManager.
      // A mídia só é transmitida se o participante já estiver explicitamente autorizado na sala.
      if (roomManager && roomManager.isPeerAuthorized(conn.peer)) {
        authenticatedViewers.add(conn.peer);
        if (isCurrentlyStreaming()) {
          initiateMediaCallToViewer(conn.peer);
          conn.send({ type: 'STREAM_STATUS', isStreaming: true });
        } else {
          conn.send({ type: 'STREAM_STATUS', isStreaming: false });
        }
      }
      // Se não estiver autorizado (pendente/sem PIN), NÃO adiciona a authenticatedViewers
      // e NÃO dispara chamada de vídeo. O fluxo de admissão da sala ocorrerá via RoomManager.
    } else {
      // Modo streamer clássico
      const hostPin = getStoredRoomPin();
      if (hostPin) {
        // Sala protegida: envia desafio de PIN e não inicia chamada de mídia antes da senha
        conn.send({ type: 'PIN_REQUIRED' });
      } else {
        // Sala aberta: autoriza imediatamente
        authenticatedViewers.add(conn.peer);
        if (isCurrentlyStreaming()) {
          initiateMediaCallToViewer(conn.peer);
          conn.send({ type: 'STREAM_STATUS', isStreaming: true });
        } else {
          conn.send({ type: 'STREAM_STATUS', isStreaming: false });
        }
      }
    }

    // Sincroniza configurações atuais com o novo espectador conectado
    conn.send({
      type: 'STREAM_CONFIG_UPDATED',
      preset: qualityPresetSelect ? qualityPresetSelect.value : null,
      bitrate: customBitrateBps,
      fps: selectedProfile.fps,
      height: selectedProfile.height,
      audioMode: audioModeSelect ? audioModeSelect.value : 'system'
    });
    conn.send({
      type: 'COOP_CONFIG',
      enabled: getCoopState().isCoopEnabled
    });
  });

  conn.on('data', (data) => {
    if (!data || typeof data !== 'object') return;

    if (roomManager && roomManager.handleRoomMessage(conn.peer, data, conn)) {
      if (roomManager.isPeerAuthorized(conn.peer) && conn.peer === roomManager.masterPeerId) {
        if (data.type === 'ROOM_SYNC_ALL' && Array.isArray(data.members)) {
          data.members.forEach((m) => {
            if (m && m.peerId && m.peerId !== myId) {
              if (m.isStreaming && !watchingHosts.has(m.peerId)) {
                watchFriend(m.peerId);
              }
              if (roomManager.members.has(m.peerId) && !connectedViewers.has(m.peerId) && !watchingHosts.has(m.peerId)) {
                const peerConn = peer.connect(m.peerId, { reliable: true });
                setupIncomingDataConnection(peerConn);
              }
              if (voiceManager && voiceManager.isInVoice && voiceManager.localStream && !activeVoiceCalls.has(m.peerId) && peer && !peer.destroyed) {
                const call = peer.call(m.peerId, voiceManager.localStream, {
                  metadata: { type: 'VOICE_CHAT', name: roomManager.userName, role: 'member' }
                });
                setupVoiceMediaCall(call, m.peerId);
              }
            }
          });
        }
      }
      return;
    }

    if (data.type === 'REQUEST_STREAM') {
      if (isRoomMode()) {
        if (!roomManager || !roomManager.isPeerAuthorized(conn.peer)) {
          console.warn(`[Security] REQUEST_STREAM recusado para participante não autorizado: ${conn.peer}`);
          conn.send({ type: 'ROOM_PIN_REQUIRED', error: 'Autenticação necessária na sala.' });
          return;
        }
        authenticatedViewers.add(conn.peer);
        if (isCurrentlyStreaming()) {
          initiateMediaCallToViewer(conn.peer);
          conn.send({ type: 'STREAM_STATUS', isStreaming: true });
        } else {
          conn.send({ type: 'STREAM_STATUS', isStreaming: false });
        }
        return;
      }

      // Modo streamer clássico
      const hostPin = getStoredRoomPin();
      if (hostPin) {
        const providedPin = data.pin ? String(data.pin).trim() : '';
        if (providedPin !== hostPin) {
          conn.send({ type: 'PIN_REQUIRED', error: 'PIN incorreto. Tente novamente.' });
          return;
        }
        // PIN correto!
        authenticatedViewers.add(conn.peer);
        conn.send({ type: 'PIN_ACCEPTED' });
        showToast(`Amigo (${conn.peer.slice(0, 6)}) autenticou com PIN.`, 'success');
        if (isCurrentlyStreaming()) {
          initiateMediaCallToViewer(conn.peer);
          conn.send({ type: 'STREAM_STATUS', isStreaming: true });
        } else {
          conn.send({ type: 'STREAM_STATUS', isStreaming: false });
        }
      } else {
        authenticatedViewers.add(conn.peer);
        showToast(`Amigo (${conn.peer.slice(0, 6)}) solicitou o stream.`, 'info');
        if (isCurrentlyStreaming()) {
          initiateMediaCallToViewer(conn.peer);
        }
      }
      return;
    }

    // Bloqueia chat, voz, co-op e stream direto se o peer não estiver autorizado
    if (!isPeerAuthorizedForMedia(conn.peer)) {
      if (isRoomMode()) {
        conn.send({ type: 'ROOM_PIN_REQUIRED', error: 'Autenticação necessária na sala.' });
      } else {
        conn.send({ type: 'PIN_REQUIRED', error: 'Autenticação necessária com PIN.' });
      }
      return;
    }

    if (handleDirectStreamSignaling(data, conn)) {
      return;
    }

    if (data.type === 'STREAM_STATUS') {
      if (data.isStreaming && !watchingHosts.has(conn.peer) && (isRoomMode() ? roomManager?.isPeerAuthorized(conn.peer) : isPeerAuthorizedForMedia(conn.peer))) {
        watchFriend(conn.peer);
      } else if (watchingHosts.has(conn.peer)) {
        if (!data.isStreaming) {
          updateCardStatus(conn.peer, 'Amigo conectado! Aguardando ele iniciar o jogo...');
        } else {
          updateCardStatus(conn.peer, 'Sincronizando stream em tempo real...');
        }
      }
      return;
    }

    if (data.type === 'STREAM_STOPPED') {
      if (watchingHosts.has(conn.peer)) {
        showToast('O amigo pausou a transmissão.', 'info');
        setCardStreamPaused(conn.peer, true, 'Transmissão pausada pelo streamer.');
        const directPc = directViewerPeerConnections.get(conn.peer);
        if (directPc) {
          try { directPc.close(); } catch (e) {}
          directViewerPeerConnections.delete(conn.peer);
          directPendingCandidates.delete(conn.peer);
        }
        stopStatsMonitor(conn.peer);
      }
      return;
    }

    if (data.type === 'CHAT_MESSAGE' || data.type === 'VOICE_STATE_UPDATE' || data.type === 'VOICE_SIGNAL' ||
        data.type === 'TACTICAL_PING' || data.type === 'TACTICAL_LASER' || data.type === 'EMOJI_REACTION' || data.type === 'SOUNDBOARD_PLAY') {
      handleIncomingP2PMessage(data, conn);
      return;
    }

    if (data.type && (data.type.startsWith('COOP_') || data.type.startsWith('INPUT_'))) {
      handleHostCoopMessage(conn.peer, data, conn);
    }
  });

  conn.on('close', () => {
    if (activeNativeViewerPeers.has(conn.peer)) {
      const sessionId = activeNativeCaptureProvider?.session?.sessionId;
      if (sessionId && isDesktopApp()) {
        closeNativeViewerPeer(sessionId, conn.peer).catch(() => {});
      }
      activeNativeViewerPeers.delete(conn.peer);
      activeDirectSignaling.delete(conn.peer);
    }
    if (roomManager) {
      roomManager.removeMember(conn.peer);
    }
    // Notifica módulo Co-op caso este espectador fosse o Player 2
    handleHostCoopMessage(conn.peer, { type: 'COOP_RELEASE' }, conn);
    connectedViewers.delete(conn.peer);
    authenticatedViewers.delete(conn.peer);
    stopStatsMonitor(conn.peer);
    updateViewerCountUI();
  });

  conn.on('error', (err) => {
    console.error(`Erro na DataConnection com ${conn.peer}:`, err);
    if (activeNativeViewerPeers.has(conn.peer)) {
      const sessionId = activeNativeCaptureProvider?.session?.sessionId;
      if (sessionId && isDesktopApp()) {
        closeNativeViewerPeer(sessionId, conn.peer).catch(() => {});
      }
      activeNativeViewerPeers.delete(conn.peer);
      activeDirectSignaling.delete(conn.peer);
    }
    if (roomManager) {
      roomManager.removeMember(conn.peer);
    }
    handleHostCoopMessage(conn.peer, { type: 'COOP_RELEASE' }, conn);
    connectedViewers.delete(conn.peer);
    authenticatedViewers.delete(conn.peer);
    stopStatsMonitor(conn.peer);
    updateViewerCountUI();
  });
}

// ==========================================
// STREAM DIRETO GSTREAMER (ALTERNATIVA 1)
// ==========================================

function waitForDirectIceGathering(peerConnection, timeoutMs = 1500) {
  if (!peerConnection || peerConnection.iceGatheringState === 'complete') return Promise.resolve();
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
    const timer = setTimeout(finish, timeoutMs);
    peerConnection.addEventListener('icegatheringstatechange', onChange);
  });
}

async function handleStartDirectStream(data, conn) {
  const hostId = conn.peer;
  console.log(`[DirectStream] Recebido START_DIRECT_STREAM de ${hostId}`);

  // Limpa chamadas ou conexões anteriores com esse host
  const prevDirect = directViewerPeerConnections.get(hostId);
  if (prevDirect) {
    if (['connecting', 'connected'].includes(prevDirect.connectionState)) {
      console.log(`[DirectStream] RTCPeerConnection já ativa para ${hostId}, ignorando START_DIRECT_STREAM duplicado.`);
      return;
    }
    try { prevDirect.close(); } catch (e) {}
    directViewerPeerConnections.delete(hostId);
  }
  const prevCall = activeMediaCalls.get(hostId);
  if (prevCall) {
    try { prevCall.close(); } catch (e) {}
    activeMediaCalls.delete(hostId);
  }
  const hostCall = watchingHosts.get(hostId)?.call;
  if (hostCall) {
    try { hostCall.close(); } catch (e) {}
    if (watchingHosts.get(hostId)) watchingHosts.get(hostId).call = null;
  }

  const hostData = watchingHosts.get(hostId);
  if (hostData) {
    hostData.state = 'CONNECTED';
    if (hostData.timeoutTimer) {
      clearTimeout(hostData.timeoutTimer);
      hostData.timeoutTimer = null;
    }
  } else {
    watchingHosts.set(hostId, {
      state: 'CONNECTED',
      conn: conn || (roomManager && roomManager.meshConnections.get(hostId)) || null,
      call: null,
      timeoutTimer: null
    });
  }

  const peerConfig = getPeerConfig();
  const iceServers = peerConfig?.config?.iceServers || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const pc = new RTCPeerConnection({ iceServers });
  directViewerPeerConnections.set(hostId, pc);
  directPendingCandidates.set(hostId, []);

  const videoTargetMs = 25;
  const videoTargetSec = 0;
  const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
  if (videoTransceiver?.receiver) {
    if ('jitterBufferTarget' in videoTransceiver.receiver) videoTransceiver.receiver.jitterBufferTarget = videoTargetMs;
    if ('playoutDelayHint' in videoTransceiver.receiver) videoTransceiver.receiver.playoutDelayHint = videoTargetSec;
  }
  if (data.hasAudio) {
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    if (audioTransceiver?.receiver) {
      if ('jitterBufferTarget' in audioTransceiver.receiver) audioTransceiver.receiver.jitterBufferTarget = 20;
      if ('playoutDelayHint' in audioTransceiver.receiver) audioTransceiver.receiver.playoutDelayHint = 0;
    }
  }

  const remoteStream = new MediaStream();
  let cardInitialized = false;

  pc.ontrack = (event) => {
    console.log(`[DirectStream] Trilha recebida de ${hostId}: kind=${event.track?.kind}`);
    const track = event.track;
    if (track) {
      if (track.kind === 'video') {
        track.contentHint = 'motion';
      }
      if (!remoteStream.getTracks().includes(track)) {
        remoteStream.addTrack(track);
      }
    }
    if (event.receiver) {
      try {
        const target = event.track?.kind === 'video' ? 25 : 20;
        if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = target;
        if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = 0;
      } catch (_) {}
    }

    hideCardLoading(hostId);
    setCardStreamPaused(hostId, false);

    if (discordUI) {
      discordUI.syncStageView(true);
    }

    if (directClipStartTimers.has(hostId)) {
      clearTimeout(directClipStartTimers.get(hostId));
    }
    const clipTimer = setTimeout(() => {
      directClipStartTimers.delete(hostId);
      if (!clipRecorder.isRecordingFor(hostId)) {
        clipRecorder.start(remoteStream, hostId);
      }
    }, 150);
    directClipStartTimers.set(hostId, clipTimer);

    const reactionsDock = document.getElementById('reactions-dock');
    if (reactionsDock) reactionsDock.style.display = 'flex';

    if (!cardInitialized) {
      cardInitialized = true;
      addOrUpdateVideoCard({
        stream: remoteStream,
        peerId: hostId,
        label: `🎮 Tela de ${hostId.slice(0, 6)}`,
        isLocal: false,
        onDisconnect: () => disconnectHost(hostId),
        onCoopClick: (hId) => {
          const state = getCoopState();
          if (state.isPlayer2) {
            releaseCoopControl();
          } else {
            requestCoopControl(hId, conn || watchingHosts.get(hId)?.conn);
          }
        }
      });

      applyTransceiverOptimizations(pc, 'smooth');
      startStatsMonitor(hostId, pc, false);
      showToast(`Transmissão direta de ${hostId.slice(0, 6)} conectada em alta fluidez!`, 'success');
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && event.candidate.candidate) {
      try {
        conn.send({
          type: 'DIRECT_STREAM_ICE_CANDIDATE',
          candidate: event.candidate.candidate,
          mlineIndex: event.candidate.sdpMLineIndex ?? 0
        });
      } catch (e) {}
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[DirectStream] ConnectionState com ${hostId}: ${pc.connectionState}`);
    if (['failed', 'closed'].includes(pc.connectionState)) {
      stopStatsMonitor(hostId);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForDirectIceGathering(pc, 1500);

    const localSdp = pc.localDescription?.sdp || offer.sdp;
    conn.send({
      type: 'DIRECT_STREAM_OFFER',
      sessionId: data.sessionId,
      sdp: localSdp
    });
  } catch (err) {
    console.error('[DirectStream] Falha ao gerar oferta SDP do espectador:', err);
    showToast('Erro ao iniciar recepção do stream direto', 'error');
  }
}

async function handleDirectStreamOffer(data, conn) {
  const viewerId = conn.peer;
  console.log(`[DirectStream] Recebido DIRECT_STREAM_OFFER de ${viewerId} (${data.sdp?.length} bytes)`);
  if (!activeNativeCaptureProvider?.session?.sessionId) {
    console.warn('[DirectStream] Host não possui sessão nativa ativa para responder oferta.');
    activeDirectSignaling.delete(viewerId);
    return;
  }
  if (processingDirectOffers.has(viewerId)) {
    console.warn(`[DirectStream] Ignorando oferta duplicada já em processamento para espectador: ${viewerId}`);
    return;
  }
  processingDirectOffers.add(viewerId);
  const sessionId = activeNativeCaptureProvider.session.sessionId;
  try {
    const peerConfig = getPeerConfig();
    const iceServers = peerConfig?.config?.iceServers || [];
    const iceUris = [];
    for (const s of iceServers) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls || s.url];
      for (const u of urls) {
        if (!u) continue;
        if (u.startsWith('turn:') || u.startsWith('turns:')) {
          if (s.username && s.credential) {
            const proto = u.startsWith('turns:') ? 'turns' : 'turn';
            const hostPort = u.replace(/^turns?:/, '').replace(/^\/\//, '');
            iceUris.push(`${proto}://${encodeURIComponent(s.username)}:${encodeURIComponent(s.credential)}@${hostPort}`);
          } else {
            iceUris.push(u);
          }
        } else {
          iceUris.push(u);
        }
      }
    }
    const answer = await createNativeViewerPeer(sessionId, viewerId, data.sdp, iceUris.length ? iceUris : null);
    activeNativeViewerPeers.add(viewerId);
    activeDirectSignaling.delete(viewerId);
    console.log(`[DirectStream] Resposta SDP gerada para ${viewerId} (${answer?.sdp?.length} bytes)`);
    conn.send({
      type: 'DIRECT_STREAM_ANSWER',
      sdp: answer.sdp
    });
  } catch (err) {
    activeDirectSignaling.delete(viewerId);
    console.error(`[DirectStream] Erro ao criar peer nativo para espectador ${viewerId}:`, err);
  } finally {
    processingDirectOffers.delete(viewerId);
  }
}

async function handleDirectStreamAnswer(data, conn) {
  const hostId = conn.peer;
  console.log(`[DirectStream] Recebido DIRECT_STREAM_ANSWER de ${hostId} (${data.sdp?.length} bytes)`);
  const pc = directViewerPeerConnections.get(hostId);
  if (!pc) {
    console.warn(`[DirectStream] Nenhuma RTCPeerConnection encontrada para host ${hostId}`);
    return;
  }
  if (pc.signalingState !== 'have-local-offer') {
    console.log(`[DirectStream] Ignorando DIRECT_STREAM_ANSWER para ${hostId} (signalingState atual: ${pc.signalingState})`);
    return;
  }
  try {
    await pc.setRemoteDescription({
      type: 'answer',
      sdp: data.sdp
    });

    try {
      const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
      const hasAudio = transceivers.some(t => 
        (t.receiver?.track?.kind === 'audio') || 
        (t.sender?.track?.kind === 'audio') || 
        (t.mid && t.mid.toLowerCase().includes('audio'))
      );
      for (const t of transceivers) {
        if (t?.receiver) {
          const isAudio = (t.receiver?.track?.kind === 'audio') || (t.sender?.track?.kind === 'audio') || (t.mid && t.mid.toLowerCase().includes('audio'));
          const targetMs = 0;
          const targetSec = 0;
          if ('jitterBufferTarget' in t.receiver) t.receiver.jitterBufferTarget = targetMs;
          if ('playoutDelayHint' in t.receiver) t.receiver.playoutDelayHint = targetSec;
        }
      }
    } catch (_) {}

    const pending = directPendingCandidates.get(hostId) || [];
    directPendingCandidates.delete(hostId);
    for (const cand of pending) {
      try {
        await pc.addIceCandidate(cand);
      } catch (e) {
        console.warn('[DirectStream] Erro ao aplicar candidato ICE retido:', e);
      }
    }
  } catch (err) {
    console.error(`[DirectStream] Falha ao aplicar remoteDescription da resposta de ${hostId}:`, err);
  }
}

async function handleDirectStreamIceCandidate(data, conn) {
  const peerId = conn.peer;
  if (isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId) {
    // No Host: repassa candidato do espectador para a ponte Rust
    const sessionId = activeNativeCaptureProvider.session.sessionId;
    try {
      await addNativeViewerIceCandidate(sessionId, peerId, data.mlineIndex, data.candidate);
    } catch (err) {
      console.warn(`[DirectStream] Falha ao adicionar candidato ICE do espectador ${peerId}:`, err);
    }
  } else {
    // No Espectador: repassa candidato recebido do Host para RTCPeerConnection
    const pc = directViewerPeerConnections.get(peerId);
    if (!pc) return;
    const candidateInit = {
      candidate: data.candidate,
      sdpMid: null,
      sdpMLineIndex: Number(data.mlineIndex ?? 0)
    };
    if (pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(candidateInit);
      } catch (e) {
        console.warn('[DirectStream] Erro ao adicionar candidato ICE do host:', e);
      }
    } else {
      const pending = directPendingCandidates.get(peerId);
      if (pending) {
        pending.push(candidateInit);
      }
    }
  }
}

function handleDirectStreamSignaling(data, conn) {
  if (!data || typeof data !== 'object') return false;
  switch (data.type) {
    case 'START_DIRECT_STREAM':
      handleStartDirectStream(data, conn);
      return true;
    case 'DIRECT_STREAM_OFFER':
      handleDirectStreamOffer(data, conn);
      return true;
    case 'DIRECT_STREAM_ANSWER':
      handleDirectStreamAnswer(data, conn);
      return true;
    case 'DIRECT_STREAM_ICE_CANDIDATE':
      handleDirectStreamIceCandidate(data, conn);
      return true;
    default:
      return false;
  }
}

export async function setupNativeBridgeListener() {
  if (!isDesktopApp() || unlistenNativeBridge) return;
  unlistenNativeBridge = await listenNativeCaptureBridge((event) => {
    if (!event) return;
    const viewerId = event.peerId || event.peer_id;
    if (!viewerId) return; // ignora candidatos da ponte local
    if (event.event !== 'ice-candidate' || !event.candidate) return;
    console.log(`[DirectStream Bridge] Candidato ICE para espectador ${viewerId}: ${event.candidate}`);
    const conn = connectedViewers.get(viewerId) || (roomManager && roomManager.meshConnections.get(viewerId));
    if (conn && conn.open) {
      try {
        conn.send({
          type: 'DIRECT_STREAM_ICE_CANDIDATE',
          candidate: event.candidate,
          mlineIndex: Number(event.mlineIndex ?? event.mline_index ?? 0)
        });
      } catch (e) {}
    }
  });
}

// Transmissor envia o vídeo com foco em alta fluidez (Idempotente)
export function initiateMediaCallToViewer(viewerPeerId) {
  const isNativeActive = Boolean(isDesktopApp() && activeNativeCaptureProvider?.session?.sessionId);
  if ((!localStream && !isNativeActive) || !peer) return;

  // Barreira central de autorização: nunca inicia chamada ou negociação direta para peer não autorizado
  if (!isPeerAuthorizedForMedia(viewerPeerId)) {
    console.warn(`[Security] initiateMediaCallToViewer bloqueado para peer não autorizado: ${viewerPeerId}`);
    return;
  }

  // Alternativa 1: se captura nativa estiver ativa no desktop, transmite diretamente via GStreamer webrtcbin
  if (isNativeActive) {
    const sessionId = activeNativeCaptureProvider.session.sessionId;
    if (activeNativeViewerPeers.has(viewerPeerId) || activeDirectSignaling.has(viewerPeerId)) {
      console.log(`Stream direto nativo já ativo ou em negociação para: ${viewerPeerId}`);
      return;
    }
    const conn = connectedViewers.get(viewerPeerId) || (roomManager && roomManager.meshConnections.get(viewerPeerId));
    if (conn) {
      if (conn.open) {
        console.log(`Iniciando stream direto GStreamer para espectador: ${viewerPeerId}`);
        activeDirectSignaling.add(viewerPeerId);
        conn.send({
          type: 'START_DIRECT_STREAM',
          sessionId,
          hasAudio: Boolean(activeNativeCaptureProvider.session.audioRtpPort || activeNativeCaptureProvider.session.audio_rtp_port)
        });
      } else {
        console.log(`Aguardando abertura de canal de dados para stream direto com: ${viewerPeerId}`);
        activeDirectSignaling.add(viewerPeerId);
        const onOpen = () => {
          console.log(`Canal de dados aberto. Enviando START_DIRECT_STREAM para: ${viewerPeerId}`);
          try {
            conn.send({
              type: 'START_DIRECT_STREAM',
              sessionId,
              hasAudio: Boolean(activeNativeCaptureProvider.session.audioRtpPort || activeNativeCaptureProvider.session.audio_rtp_port)
            });
          } catch (e) {
            activeDirectSignaling.delete(viewerPeerId);
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

  if (!localStream) return;

  // Garante que não criamos chamadas duplicadas para o mesmo espectador
  const existingCall = activeMediaCalls.get(viewerPeerId);
  if (existingCall && existingCall.open !== false && !existingCall._closed) {
    console.log(`Chamada de mídia já ativa ou em andamento para: ${viewerPeerId}`);
    return;
  }

  console.log(`Iniciando chamada com foco em alta fluidez para: ${viewerPeerId}`);
  const call = peer.call(viewerPeerId, localStream);
  
  if (call) {
    activeMediaCalls.set(viewerPeerId, call);

    if (call.peerConnection) {
      hookPeerConnectionSdp(call.peerConnection, () => customBitrateBps);
      applyTransceiverOptimizations(call.peerConnection);

      startStatsMonitor(viewerPeerId, call.peerConnection, true, (sample) => {
        if (adaptiveBitrateController.isEnabled) {
          adaptiveBitrateController.processSample({
            packetLossRate: sample.packetLossRate || 0,
            rttMs: sample.rtt || 0,
            qualityLimitationReason: sample.qualityReason || sample.qualityLimitationReason,
            encodeTimeMs: sample.encodeTimeMs
          }, viewerPeerId);
        }
      });

      setTimeout(() => {
        let scaleFactor = 1;
        const videoTrack = localStream?.getVideoTracks()[0];
        if (videoTrack && typeof videoTrack.getSettings === 'function') {
          const settings = videoTrack.getSettings();
          const nativeHeight = settings.height || 1080;
          const targetHeight = selectedProfile.height || 1080;
          if (nativeHeight > targetHeight) {
            scaleFactor = Number((nativeHeight / targetHeight).toFixed(2));
          }
        } else if (selectedProfile.height && selectedProfile.height < 1080) {
          scaleFactor = Number((1080 / selectedProfile.height).toFixed(2));
        }
        applySenderOptimizations(call.peerConnection, customBitrateBps, selectedProfile.fps, scaleFactor);
      }, 300);
    }

    call.on('close', () => {
      call._closed = true;
      if (activeMediaCalls.get(viewerPeerId) === call) {
        activeMediaCalls.delete(viewerPeerId);
        stopStatsMonitor(viewerPeerId);
      }
    });

    call.on('error', (err) => {
      console.error(`Erro na chamada com ${viewerPeerId}:`, err);
      call._closed = true;
      if (activeMediaCalls.get(viewerPeerId) === call) {
        activeMediaCalls.delete(viewerPeerId);
        stopStatsMonitor(viewerPeerId);
      }
    });
  }
}

// Espectador recebe o stream do amigo (Rejeita chamadas não solicitadas)
function handleIncomingMediaCall(call) {
  console.log(`Recebendo chamada de mídia de: ${call.peer}`);

  // Descarta se stream direto já está ativo para este peer
  if (directViewerPeerConnections.has(call.peer)) {
    console.log(`Chamada legada descartada: stream direto ativo com ${call.peer}`);
    try { call.close(); } catch (e) {}
    return;
  }

  // Se for chamada de áudio da Sala de Voz
  if (call.metadata?.type === 'VOICE_CHAT') {
    handleIncomingVoiceCall(call);
    return;
  }

  // Rejeição de chamadas não solicitadas: só aceita se o host estiver cadastrado em watchingHosts ou na sala (roomManager)
  if (!watchingHosts.has(call.peer) && !(roomManager && roomManager.members.has(call.peer))) {
    console.warn(`Chamada de mídia não solicitada rejeitada de: ${call.peer}`);
    try {
      call.close();
    } catch (e) {}
    return;
  }

  if (!watchingHosts.has(call.peer) && roomManager && roomManager.members.has(call.peer)) {
    watchingHosts.set(call.peer, {
      state: 'CONNECTED',
      conn: roomManager.meshConnections.get(call.peer) || null,
      call: call,
      timeoutTimer: null
    });
  }

  // Se já existe uma chamada antiga desse host, fecha a anterior antes de aceitar a nova
  const existingCall = activeMediaCalls.get(call.peer);
  if (existingCall && existingCall !== call) {
    try { existingCall.close(); } catch (e) {}
  }

  call.answer();

  if (call.peerConnection) {
    hookPeerConnectionSdp(call.peerConnection, () => customBitrateBps);
    applyTransceiverOptimizations(call.peerConnection);
  }

  call.on('stream', (remoteStream) => {
    console.log(`Stream remoto recebido de ${call.peer}`);
    
    hideCardLoading(call.peer);
    setCardStreamPaused(call.peer, false);

    if (discordUI) {
      discordUI.syncStageView(true);
    }

    clipRecorder.start(remoteStream, call.peer);
    const reactionsDock = document.getElementById('reactions-dock');
    if (reactionsDock) reactionsDock.style.display = 'flex';

    const hostConn = watchingHosts.get(call.peer)?.conn;

    addOrUpdateVideoCard({
      stream: remoteStream,
      peerId: call.peer,
      label: `🎮 Tela de ${call.peer.slice(0, 6)}`,
      isLocal: false,
      onDisconnect: () => disconnectHost(call.peer),
      onCoopClick: (hostId) => {
        const state = getCoopState();
        if (state.isPlayer2) {
          releaseCoopControl();
        } else {
          requestCoopControl(hostId, hostConn || watchingHosts.get(hostId)?.conn);
        }
      }
    });
    
    if (call.peerConnection) {
      applyTransceiverOptimizations(call.peerConnection);
      startStatsMonitor(call.peer, call.peerConnection, false);
    }

    showToast(`Transmissão de ${call.peer.slice(0, 6)} conectada em alta fluidez!`, 'success');
  });

  call.on('close', () => {
    clipRecorder.stop(call.peer);
    const reactionsDock = document.getElementById('reactions-dock');
    if (reactionsDock && watchingHosts.size === 0) reactionsDock.style.display = 'none';

    const hostData = watchingHosts.get(call.peer);
    if (hostData && hostData.conn && hostData.conn.open === true) {
      // Streamer apenas pausou a transmissão ou alternou fonte; mantém o card pausado sem desmontar
      setCardStreamPaused(call.peer, true, 'Transmissão pausada pelo streamer.');
      stopStatsMonitor(call.peer);
    } else {
      showToast(`Transmissão de ${call.peer.slice(0, 6)} encerrada.`, 'info');
      removeVideoCard(call.peer);
      stopStatsMonitor(call.peer);
    }
    if (activeMediaCalls.get(call.peer) === call) {
      activeMediaCalls.delete(call.peer);
    }
  });

  call.on('error', (err) => {
    console.error('Erro no stream recebido:', err);
    showToast(`Erro no stream: ${err.message}`, 'error');
    removeVideoCard(call.peer);
    stopStatsMonitor(call.peer);
    if (activeMediaCalls.get(call.peer) === call) {
      activeMediaCalls.delete(call.peer);
    }
  });

  activeMediaCalls.set(call.peer, call);
}

// ==========================================
// CONECTAR COMO ESPECTADOR
// ==========================================

export function watchFriend(rawTargetId) {
  let targetId = rawTargetId ? String(rawTargetId).trim() : '';
  
  if (targetId.includes('#watch=')) {
    targetId = targetId.split('#watch=')[1].split('&')[0];
  } else if (targetId.includes('watch=')) {
    const urlParams = new URLSearchParams(targetId.split('?')[1] || targetId);
    targetId = urlParams.get('watch') || targetId;
  }

  // Validação estrita de formato e tamanho
  if (!isValidPeerId(targetId)) {
    return showToast('Por favor, insira um ID válido.', 'error');
  }

  if (targetId === myId) {
    return showToast('Você não pode assistir ao seu próprio ID.', 'error');
  }

  // Bloqueio contra conexão repetida
  const existingHost = watchingHosts.get(targetId);
  if (existingHost && (existingHost.state === 'CONNECTING' || existingHost.state === 'CONNECTED')) {
    return showToast(`Você já está conectado ou conectando a ${targetId.slice(0, 6)}.`, 'info');
  }

  showToast(`Conectando a ${targetId.slice(0, 6)}...`, 'info');
  createPlaceholderCard(targetId, `Conectando a ${targetId.slice(0, 6)}...`, () => disconnectHost(targetId));

  const hostEntry = {
    state: 'CONNECTING',
    conn: null,
    call: null,
    timeoutTimer: null
  };
  watchingHosts.set(targetId, hostEntry);

  if (!peer) {
    initPeer();
  }

  const existingConn = (roomManager && (roomManager.meshConnections.get(targetId) || roomManager.pendingConnections.get(targetId))) || connectedViewers.get(targetId);
  const conn = (existingConn && !existingConn.destroyed) ? existingConn : peer.connect(targetId, { reliable: true });
  hostEntry.conn = conn;

  // Timeout de conexão pendente (15s)
  hostEntry.timeoutTimer = setTimeout(() => {
    if (hostEntry.state === 'CONNECTING') {
      showToast(`Tempo de conexão esgotado ao tentar conectar com ${targetId.slice(0, 6)}.`, 'error');
      disconnectHost(targetId);
    }
  }, 15000);

  const handleOpen = () => {
    // Se foi cancelado antes do open, aborta imediatamente
    if (hostEntry.state === 'CANCELLED') {
      conn.close();
      return;
    }

    hostEntry.state = 'CONNECTED';
    if (hostEntry.timeoutTimer) {
      clearTimeout(hostEntry.timeoutTimer);
      hostEntry.timeoutTimer = null;
    }

    try {
      conn.send({ type: 'REQUEST_STREAM' });
      showToast(`Conectado a ${targetId.slice(0, 6)}! Aguardando stream...`, 'info');
    } catch (e) {
      console.warn(`[watchFriend] Falha ao enviar REQUEST_STREAM para ${targetId}:`, e);
    }
  };

  if (conn.open) {
    handleOpen();
  } else {
    conn.on('open', handleOpen);
  }

  if (conn._smg_watch_bound) {
    return;
  }
  conn._smg_watch_bound = true;

  conn.on('data', (data) => {
    if (!data || typeof data !== 'object') return;

    if (!conn._smg_direct_signaling_bound && handleDirectStreamSignaling(data, conn)) {
      return;
    }

    if (data.type === 'PIN_REQUIRED') {
      promptViewerPin(targetId, data.error);
      return;
    }

    if (data.type === 'PIN_ACCEPTED') {
      hideViewerPinModal();
      showToast('PIN correto! Conectando à transmissão...', 'success');
      return;
    }

    if (data.type === 'CHAT_MESSAGE' || data.type === 'VOICE_STATE_UPDATE' || data.type === 'VOICE_SIGNAL' ||
        data.type === 'TACTICAL_PING' || data.type === 'TACTICAL_LASER' || data.type === 'EMOJI_REACTION' || data.type === 'SOUNDBOARD_PLAY') {
      handleIncomingP2PMessage(data, conn);
      return;
    }

    if (data.type === 'STREAM_STATUS') {
      if (!data.isStreaming) {
        updateCardStatus(targetId, 'Amigo conectado! Aguardando ele iniciar o jogo...');
        showToast('Amigo está online, aguardando início da transmissão.', 'info');
      } else {
        updateCardStatus(targetId, 'Sincronizando stream em tempo real...');
      }
    } else if (data.type === 'STREAM_STOPPED') {
      showToast('O amigo pausou a transmissão.', 'info');
      setCardStreamPaused(targetId, true, 'Transmissão pausada pelo streamer.');
      const directPc = directViewerPeerConnections.get(targetId);
      if (directPc) {
        try { directPc.close(); } catch (e) {}
        directViewerPeerConnections.delete(targetId);
        directPendingCandidates.delete(targetId);
      }
      stopStatsMonitor(targetId);
    } else if (data.type === 'STREAM_REJECTED') {
      showToast(`Conexão recusada: ${data.reason || 'Sala cheia'}`, 'error');
      disconnectHost(targetId);
    } else if (data.type && data.type.startsWith('COOP_')) {
      const card = document.getElementById(`card-${targetId}`);
      handleViewerCoopMessage(data, targetId, card);
    } else if (data.type === 'STREAM_CONFIG_UPDATED') {
      if (data.audioMode) {
        const audioLabels = {
          system: 'Áudio do Jogo',
          mic: 'Microfone do Transmissor',
          none: 'Apenas Vídeo (Mudo)'
        };
        const label = audioLabels[data.audioMode] || data.audioMode;
        showToast(`Fonte de áudio da transmissão: ${label}`, 'info');
      }
      // Ajustes automáticos do ABR são transparentes e não devem floodar o espectador com toasts
      if (!data.isAutomatic && (data.preset || data.bitrate)) {
        const mbps = data.bitrate ? `${(data.bitrate / 1000000).toFixed(1)} Mbps` : '';
        const res = data.height ? `${data.height}p` : '';
        const info = [res, mbps].filter(Boolean).join(' • ');
        const prevInfo = lastShownQualityPerHost.get(targetId);
        if (info && info !== prevInfo) {
          lastShownQualityPerHost.set(targetId, info);
          showToast(`Qualidade ajustada pelo streamer: ${info}`, 'info');
        }
      }
    }
  });

  conn.on('close', () => {
    const directPc = directViewerPeerConnections.get(targetId);
    if (directPc) {
      try { directPc.close(); } catch (e) {}
      directViewerPeerConnections.delete(targetId);
      directPendingCandidates.delete(targetId);
    }
    const coopState = getCoopState();
    if (coopState.isPlayer2 && coopState.activeHostPeerId === targetId) {
      releaseCoopControl();
    }
    showToast(`Conexão com ${targetId.slice(0, 6)} encerrada.`, 'info');
    removeVideoCard(targetId);
    watchingHosts.delete(targetId);
    stopStatsMonitor(targetId);
  });

  conn.on('error', (err) => {
    console.error(`Erro de conexão com host ${targetId}:`, err);
    showToast(`Falha ao conectar: ${err.message || 'Amigo indisponível'}`, 'error');
    disconnectHost(targetId);
  });
}

export function disconnectHost(peerId) {
  if (currentPinTargetId === peerId) {
    hideViewerPinModal();
  }

  // Se o espectador era Player 2 deste host, libera os controles
  const coopState = getCoopState();
  if (coopState.isPlayer2 && coopState.activeHostPeerId === peerId) {
    releaseCoopControl();
  }

  const hostData = watchingHosts.get(peerId);
  if (hostData) {
    hostData.state = 'CANCELLED';
    if (hostData.timeoutTimer) {
      clearTimeout(hostData.timeoutTimer);
      hostData.timeoutTimer = null;
    }
    if (hostData.conn && !(isRoomMode() && roomManager && roomManager.meshConnections.get(peerId) === hostData.conn)) {
      try {
        hostData.conn.close();
      } catch (e) {}
    }
  }

  const directPc = directViewerPeerConnections.get(peerId);
  if (directPc) {
    try {
      directPc.close();
    } catch (e) {}
    directViewerPeerConnections.delete(peerId);
    directPendingCandidates.delete(peerId);
  }

  const mediaCall = activeMediaCalls.get(peerId);
  if (mediaCall) {
    try {
      mediaCall.close();
    } catch (e) {}
    activeMediaCalls.delete(peerId);
  }

  watchingHosts.delete(peerId);
  clipRecorder.stop(peerId);
  removeVideoCard(peerId);
  stopStatsMonitor(peerId);
  showToast(`Desconectado de ${peerId.slice(0, 6)}.`, 'info');
}

// Expõe globalmente para compatibilidade
window.disconnectHost = disconnectHost;

if (connectBtn && targetInput) {
  connectBtn.addEventListener('click', () => {
    const val = targetInput.value;
    if (val) {
      watchFriend(val);
      targetInput.value = '';
    } else {
      showToast('Insira o ID ou link de um amigo.', 'error');
    }
  });

  targetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      connectBtn.click();
    }
  });
}

// ==========================================
// INICIAR E ENCERRAR TRANSMISSÃO LOCAL
// ==========================================

export async function startLocalStream(options = {}) {
  // Prevenção de condições de corrida (duplo clique durante permissão do navegador)
  if (isStartingStream) return;

  if (localStream) {
    stopLocalStream();
    return;
  }

  isStartingStream = true;
  if (streamBtn) streamBtn.disabled = true;

  const audioMode = audioModeSelect ? audioModeSelect.value : 'system';

  // Restrições de vídeo com Alvo de 60 FPS
  const videoConstraints = {
    width: { ideal: selectedProfile.width, max: 1920 },
    height: { ideal: selectedProfile.height, max: 1080 },
    frameRate: { ideal: 60, max: 60 },
    cursor: (captureCursorToggle && !captureCursorToggle.checked) ? 'never' : 'always'
  };

  let capturedDisplayStream = null;
  let capturedMicStream = null;

  try {
    let effectiveAudioMode = audioMode;
    if (effectiveAudioMode === 'process') {
      if (isDesktopApp()) {
        try {
          const caps = await getNativeCaptureCapabilities();
          if (!caps.supports_process_audio) {
            showToast('Áudio por processo requer Windows 11+. Transmitindo com áudio do jogo (sistema).', 'info', 4500);
            effectiveAudioMode = 'system';
            if (audioModeSelect) audioModeSelect.value = 'system';
          }
        } catch (_) {}
      } else {
        showToast('Áudio da janela isolada requer Windows 11. Transmitindo com áudio do jogo (sistema).', 'info', 4500);
        effectiveAudioMode = 'system';
        if (audioModeSelect) audioModeSelect.value = 'system';
      }
    }
    const wantSystemAudio = (effectiveAudioMode === 'system' || effectiveAudioMode === 'process');

    if (isDesktopApp() && (options.sourceId || options.sourceType)) {
      showToast('Iniciando captura nativa Direct3D 11...', 'info', 2500);
      const nativeProvider = new NativeCaptureProvider();
      const chosenCodec = videoCodecSelect ? videoCodecSelect.value : (options.videoCodec || null);
      const chosenEncoder = h264EncoderSelect ? h264EncoderSelect.value : (options.h264Encoder || null);
      const chosenCursor = captureCursorToggle ? captureCursorToggle.checked : (options.showCursor !== false);
      const result = await nativeProvider.start({
        sourceId: options.sourceId,
        sourceType: options.sourceType || 'window',
        audioMode: wantSystemAudio ? effectiveAudioMode : 'none',
        videoCodec: chosenCodec,
        h264Encoder: chosenEncoder,
        showCursor: chosenCursor,
        width: selectedProfile.width,
        height: selectedProfile.height,
        fps: selectedProfile.fps || 60,
        bitrateKbps: Math.round(customBitrateBps / 1000) || 8000
      });
      capturedDisplayStream = result.stream;
      activeNativeCaptureProvider = nativeProvider;
    } else {
      try {
        capturedDisplayStream = await requestBrowserDisplayMedia({
          video: videoConstraints,
          audioMode: effectiveAudioMode,
          displaySurface: options.displaySurface,
          monitorTypeSurfaces: options.monitorTypeSurfaces
        });
        console.log('[Capture Browser] Trilhas capturadas:', {
          video: capturedDisplayStream.getVideoTracks().map(t => ({ id: t.id, label: t.label, enabled: t.enabled, readyState: t.readyState, settings: t.getSettings?.() })),
          audio: capturedDisplayStream.getAudioTracks().map(t => ({ id: t.id, label: t.label, enabled: t.enabled, readyState: t.readyState, settings: t.getSettings?.() }))
        });
      } catch (captureErr) {
        // Se o usuário cancelou o seletor do navegador
        if (captureErr.name === 'NotAllowedError') {
          return;
        }

        throw captureErr;
      }
    }

    localStream = capturedDisplayStream;
    const replayPref = typeof localStorage !== 'undefined' ? localStorage.getItem('seemygame_replay_enabled') : null;
    const shouldRecordReplay = options.replayEnabled !== undefined
      ? options.replayEnabled
      : (replayPref !== 'false');
    if (shouldRecordReplay) {
      clipRecorder.start(localStream, 'local');
    }
    if (wantSystemAudio) {
      if (localStream.getAudioTracks().length > 0) {
        capturedSystemAudioTrack = localStream.getAudioTracks()[0];
      } else if (!isDesktopApp()) {
        showToast('Aviso: Nenhuma trilha de áudio capturada. Se estiver compartilhando janela/tela, marque "Compartilhar áudio" no seletor do navegador.', 'info', 6000);
      }
    }

    // Se selecionou Microfone, captura e anexa a trilha de voz com filtro High-Pass e Noise Gate
    if (audioMode === 'mic') {
      try {
        capturedMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        if (activeMicProcessor) {
          activeMicProcessor.destroy();
          activeMicProcessor = null;
        }
        activeMicProcessor = applyMicrophoneProcessing(capturedMicStream);
        const micTrack = activeMicProcessor.processedStream.getAudioTracks()[0] || capturedMicStream.getAudioTracks()[0];
        if (micTrack) {
          localStream.addTrack(micTrack);
        }
      } catch (micErr) {
        console.warn('Microfone não concedido:', micErr);
        showToast('Aviso: Permissão do microfone não concedida.', 'info');
      }
    }

    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = 'motion';
    }

    const hasAudio = localStream.getAudioTracks().length > 0;
    if (hasAudio) {
      const label = audioMode === 'mic' ? 'Microfone' : 'Áudio do jogo (sistema)';
      showToast(`${label} capturado com sucesso!`, 'success');
    } else if (wantSystemAudio) {
      showToast('O navegador entregou apenas vídeo. Para incluir som, reinicie o compartilhamento e verifique a opção de áudio no seletor.', 'info', 6000);
    } else {
      showToast('Transmissão iniciada (modo sem áudio).', 'info');
    }

    addOrUpdateVideoCard({
      stream: localStream,
      peerId: 'local-me',
      label: 'Minha Transmissão (Você)',
      isLocal: true,
      onDisconnect: () => stopLocalStream(),
      onPanicClick: () => revokePlayer2()
    });

    const reactionsDock = document.getElementById('reactions-dock');
    if (reactionsDock) reactionsDock.style.display = 'flex';

    // Inicia escuta para Companion Agent Windows (jogos PC nativos)
    initCompanionAgentConnection();
    
    if (streamBtn) {
      streamBtn.innerHTML = '<span>🛑</span> Parar Transmissão';
      streamBtn.classList.add('btn-stop');
    }

    if (discordUI) {
      discordUI.setStreamingState(true);
      discordUI.syncStageView(true);
    }

    if (roomManager) {
      roomManager.setLocalStreaming(true, {
        title: 'Jogo / Tela',
        preset: selectedProfile.id,
        fps: selectedProfile.fps,
        height: selectedProfile.height,
        audioMode: audioModeSelect ? audioModeSelect.value : 'system'
      });
      roomManager.meshConnections.forEach((conn, viewerId) => {
        if (roomManager.isPeerAuthorized(viewerId)) {
          if (conn && conn.open) {
            try { conn.send({ type: 'STREAM_STATUS', isStreaming: true }); } catch (_) {}
          }
          initiateMediaCallToViewer(viewerId);
        }
      });
    }

    // Notifica e chama todos os espectadores autorizados fora da malha da sala
    connectedViewers.forEach((conn, viewerId) => {
      const alreadyInRoomMesh = Boolean(roomManager && roomManager.meshConnections.has(viewerId));
      if (!alreadyInRoomMesh && isPeerAuthorizedForMedia(viewerId)) {
        if (conn && conn.open) {
          try { conn.send({ type: 'STREAM_STATUS', isStreaming: true }); } catch (_) {}
        }
        initiateMediaCallToViewer(viewerId);
      }
    });

    showToast(`Transmissão ativa em alta fluidez (${(customBitrateBps / 1000000).toFixed(1)} Mbps)!`, 'success');

    videoTrack.onended = () => {
      stopLocalStream();
    };

  } catch (err) {
    console.error('Erro ao capturar tela:', err);
    // Limpeza de streams parciais em caso de erro
    if (capturedDisplayStream) {
      capturedDisplayStream.getTracks().forEach(t => t.stop());
    }
    if (capturedMicStream) {
      capturedMicStream.getTracks().forEach(t => t.stop());
    }
    localStream = null;

    if (err.name !== 'NotAllowedError') {
      const errMsg = String(err?.message || '').toLowerCase();
      if (errMsg.includes('could not start audio source') || errMsg.includes('audio source')) {
        showToast('⚠️ O navegador não conseguiu capturar o áudio desta janela/tela. Para transmitir com som, selecione "Tela inteira" com "Compartilhar áudio" ou use o modo "Apenas Vídeo" / App Desktop.', 'error', 9000);
      } else {
        showToast(`Erro ao iniciar stream: ${err.message}`, 'error');
      }
    }
  } finally {
    isStartingStream = false;
    if (streamBtn) {
      streamBtn.disabled = false;
    }
  }
}

export function stopLocalStream() {
  clipRecorder.stop('local');
  if (activeNativeCaptureProvider) {
    const sessionId = activeNativeCaptureProvider.session?.sessionId;
    if (sessionId && isDesktopApp()) {
      for (const viewerId of activeNativeViewerPeers) {
        closeNativeViewerPeer(sessionId, viewerId).catch(() => {});
      }
      activeNativeViewerPeers.clear();
      activeDirectSignaling.clear();
    }
    activeNativeCaptureProvider.stop().catch(() => {});
    activeNativeCaptureProvider = null;
  }
  if (localStream) {
    const stream = localStream;
    localStream = null;
    stream.getTracks().forEach(track => track.stop());
  }

  if (capturedSystemAudioTrack) {
    try { capturedSystemAudioTrack.stop(); } catch (e) {}
    capturedSystemAudioTrack = null;
  }
  if (capturedMicStream) {
    try { capturedMicStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    capturedMicStream = null;
  }
  if (activeMicProcessor) {
    activeMicProcessor.destroy();
    activeMicProcessor = null;
  }

  // Revoga Player 2 se houver algum conectado
  const coopState = getCoopState();
  if (coopState.activePlayer2PeerId) {
    revokePlayer2();
  }

  // Fecha explicitamente todas as chamadas de mídia ativas dos espectadores
  activeMediaCalls.forEach((call, viewerId) => {
    try {
      call.close();
    } catch (e) {}
    stopStatsMonitor(viewerId);
  });
  activeMediaCalls.clear();

  removeVideoCard('local-me');
  stopStatsMonitor('local-me');

  if (streamBtn) {
    streamBtn.innerHTML = '<span>🚀</span> Transmitir Jogo';
    streamBtn.classList.remove('btn-stop');
  }

  if (discordUI) {
    discordUI.setStreamingState(false);
    if (watchingHosts.size === 0) {
      discordUI.syncStageView(false);
    }
  }

  if (roomManager) {
    roomManager.setLocalStreaming(false);
  }

  connectedViewers.forEach((conn) => {
    conn.send({ type: 'STREAM_STOPPED' });
  });

  updateViewerCountUI();
  showToast('Transmissão encerrada.', 'info');
}

/**
 * Inicialização e controle dos recursos do Desktop App (Tauri / Rust)
 */
export async function initDesktopSupport() {
  if (!isDesktopApp()) return null;

  const desktopBadge = document.getElementById('desktop-badge');
  if (desktopBadge) {
    desktopBadge.style.display = 'inline-flex';
  }

  // Eleva a prioridade de processo imediatamente para alta prioridade de GPU
  await setHighPriority();

  // Escuta candidatos ICE da ponte Rust para espectadores
  await setupNativeBridgeListener();

  // Sincroniza capacidades de áudio (desabilita áudio de janela isolada no Windows 10)
  await syncAudioModeCapabilities();

  const desktopPickerModal = document.getElementById('desktop-picker-modal');
  const desktopWindowsList = document.getElementById('desktop-windows-list');
  const pickerRefreshBtn = document.getElementById('picker-refresh-btn');
  const pickerCancelBtn = document.getElementById('picker-cancel-btn');
  const pickerScreenFallbackBtn = document.getElementById('picker-screen-fallback-btn');

  async function refreshWindowsList() {
    if (!desktopWindowsList) return;
    desktopWindowsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px;">🔍 Buscando jogos e janelas ativas no Windows...</div>';

    const pickerNativeStatus = document.getElementById('picker-native-status');
    try {
      const caps = await getNativeCaptureCapabilities();
      if (caps && (caps.available || caps.provider === 'native') && pickerNativeStatus) {
        pickerNativeStatus.innerHTML = 'Captura Nativa Ativa: Windows Graphics Capture';
      }
    } catch (e) {}

    let sources = await getCapturableSources();
    if (!sources || sources.length === 0) {
      sources = await getCapturableWindows();
    }

    if (!sources || sources.length === 0) {
      desktopWindowsList.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 20px;">
          Nenhum jogo em janela detectado no momento.<br>
          <small>Você pode iniciar a transmissão de tela inteira abaixo.</small>
        </div>
      `;
      return;
    }

    desktopWindowsList.innerHTML = '';

    const monitors = sources.filter(s => s.sourceType === 'monitor' || s.source_type === 'monitor');
    const windows = sources.filter(s => s.sourceType !== 'monitor' && s.source_type !== 'monitor');

    if (monitors.length > 0) {
      const monHeader = document.createElement('div');
      monHeader.style.padding = '8px 4px 4px 4px';
      monHeader.style.fontWeight = 'bold';
      monHeader.style.color = 'var(--text-muted, #9ca3af)';
      monHeader.textContent = 'Telas Inteiras / Monitores';
      desktopWindowsList.appendChild(monHeader);

      monitors.forEach(mon => {
        const item = document.createElement('div');
        item.className = 'window-item';
        item.innerHTML = `
          <div class="window-info">
            <span class="window-title" title="${mon.title}">🖥️ ${mon.title}</span>
          </div>
          <button class="window-action-btn">Transmitir</button>
        `;
        item.addEventListener('click', () => {
          if (desktopPickerModal) desktopPickerModal.style.display = 'none';
          startLocalStream({ sourceId: mon.sourceId || mon.id, sourceType: 'monitor' });
        });
        desktopWindowsList.appendChild(item);
      });
    }

    if (windows.length > 0) {
      const winHeader = document.createElement('div');
      winHeader.style.padding = '8px 4px 4px 4px';
      winHeader.style.fontWeight = 'bold';
      winHeader.style.color = 'var(--text-muted, #9ca3af)';
      winHeader.textContent = 'Jogos e Janelas Ativas';
      desktopWindowsList.appendChild(winHeader);

      windows.forEach(win => {
        const item = document.createElement('div');
        item.className = 'window-item';
        item.innerHTML = `
          <div class="window-info">
            <span class="window-title" title="${win.title}">🎮 ${win.title}</span>
            <span class="window-process">${win.processName || win.process_name || 'Processo Windows'}</span>
          </div>
          <button class="window-action-btn">Transmitir</button>
        `;
        item.addEventListener('click', () => {
          if (desktopPickerModal) desktopPickerModal.style.display = 'none';
          startLocalStream({ sourceId: win.sourceId || win.id, sourceType: 'window' });
        });
        desktopWindowsList.appendChild(item);
      });
    }
  }

  if (pickerRefreshBtn) {
    pickerRefreshBtn.addEventListener('click', refreshWindowsList);
  }

  if (pickerCancelBtn && desktopPickerModal) {
    pickerCancelBtn.addEventListener('click', () => {
      desktopPickerModal.style.display = 'none';
    });
  }

  if (pickerScreenFallbackBtn && desktopPickerModal) {
    pickerScreenFallbackBtn.addEventListener('click', async () => {
      desktopPickerModal.style.display = 'none';
      try {
        let sources = await getCapturableSources().catch(() => []);
        if (!sources || sources.length === 0) sources = await getCapturableWindows().catch(() => []);
        const mon = sources?.find(s => s.sourceType === 'monitor' || s.source_type === 'monitor');
        if (mon) {
          startLocalStream({ sourceId: mon.sourceId || mon.id, sourceType: 'monitor' });
          return;
        }
      } catch (_) {}
      startLocalStream();
    });
  }

  return { refreshWindowsList };
}

export function handleStreamBtnClick() {
  if (localStream) {
    stopLocalStream();
    return;
  }

  if (isDesktopApp()) {
    const desktopPickerModal = document.getElementById('desktop-picker-modal');
    if (desktopPickerModal) {
      desktopPickerModal.style.display = 'flex';
      const refreshBtn = document.getElementById('picker-refresh-btn');
      if (refreshBtn) refreshBtn.click();
      return;
    }
  }

  startLocalStream();
}

if (streamBtn) {
  streamBtn.addEventListener('click', handleStreamBtnClick);
}

// Auto-conexão por URL
function checkAutoWatchUrl() {
  if (window.location.pathname.endsWith('streamer.html')) return;

  const hash = window.location.hash;
  let targetId = null;

  if (hash.includes('watch=')) {
    targetId = hash.split('watch=')[1].split('&')[0];
  } else {
    const params = new URLSearchParams(window.location.search);
    targetId = params.get('watch');
  }

  if (targetId && targetId !== myId) {
    if (targetInput) targetInput.value = targetId;
    showToast(`ID detectado: ${targetId.slice(0, 6)}. Conectando...`, 'info');
    watchFriend(targetId);
  }
}

// ==========================================
// INICIALIZAÇÃO DE ID FIXO E PIN
// ==========================================

export function initFixedIdAndPinControls() {
  // 1. PIN na barra de tuning do Streamer ou Modal de Configuração da Sala
  if (roomPinInput) {
    if (isRoomMode()) {
      const { roomPin } = getRoomInfoFromUrl();
      const currentRoomPin = roomManager ? roomManager.roomPin : roomPin;
      if (currentRoomPin) roomPinInput.value = currentRoomPin;

      roomPinInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (roomManager) {
          roomManager.setRoomPin(val);
        }
      });

      roomPinInput.addEventListener('change', (e) => {
        const val = e.target.value.trim();
        if (val) {
          showToast('🔒 PIN da sala atualizado. Novos membros precisarão da senha para entrar.', 'info');
        } else {
          showToast('🔓 PIN removido. A sala agora é aberta a todos.', 'info');
        }
      });
    } else {
      const savedPin = getStoredRoomPin();
      if (savedPin) roomPinInput.value = savedPin;

      roomPinInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        setStoredRoomPin(val);
      });

      roomPinInput.addEventListener('change', (e) => {
        const val = e.target.value.trim();
        if (val) {
          showToast('🔒 PIN da sala salvo. Novos espectadores precisarão da senha.', 'info');
        } else {
          showToast('🔓 PIN removido. Sala agora é aberta ao público.', 'info');
        }
      });
    }
  }

  // 2. Modal de ID Fixo Permanente
  if (editIdBtn && customIdModal) {
    editIdBtn.addEventListener('click', () => {
      if (customIdInput) {
        customIdInput.value = getCustomStreamerId() || '';
      }
      if (customIdError) {
        customIdError.textContent = '';
        customIdError.style.display = 'none';
      }
      customIdModal.style.display = 'flex';
      if (customIdInput) customIdInput.focus();
    });
  }

  if (customIdCancelBtn && customIdModal) {
    customIdCancelBtn.addEventListener('click', () => {
      customIdModal.style.display = 'none';
    });
  }

  if (customIdResetBtn && customIdModal) {
    customIdResetBtn.addEventListener('click', () => {
      setCustomStreamerId(null);
      customIdModal.style.display = 'none';
      showToast('ID fixo removido. Gerando novo ID aleatório...', 'info');
      resetPeer();
      initPeer();
    });
  }

  if (customIdSaveBtn && customIdModal) {
    const handleSaveCustomId = () => {
      const rawVal = customIdInput ? customIdInput.value.trim() : '';
      if (!rawVal || rawVal.length < 3 || rawVal.length > 30 || !isValidPeerId(rawVal)) {
        if (customIdError) {
          customIdError.textContent = 'O ID deve ter entre 3 e 30 caracteres (letras, números, hífen ou underline).';
          customIdError.style.display = 'block';
        }
        return;
      }

      setCustomStreamerId(rawVal);
      customIdModal.style.display = 'none';
      showToast(`ID Fixo "${rawVal}" salvo com sucesso! Reiniciando sessão P2P...`, 'success');
      resetPeer();
      initPeer();
    };

    customIdSaveBtn.addEventListener('click', handleSaveCustomId);
    if (customIdInput) {
      customIdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          handleSaveCustomId();
        }
      });
    }
  }

  // 3. Modal de Desafio de PIN do Espectador
  if (viewerPinSubmitBtn) {
    viewerPinSubmitBtn.addEventListener('click', () => {
      const val = viewerPinInput ? viewerPinInput.value.trim() : '';
      submitViewerPin(val);
    });
  }

  if (viewerPinInput) {
    viewerPinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = viewerPinInput ? viewerPinInput.value.trim() : '';
        submitViewerPin(val);
      }
    });
  }

  if (viewerPinCancelBtn) {
    viewerPinCancelBtn.addEventListener('click', () => {
      if (currentPinTargetId) {
        disconnectHost(currentPinTargetId);
      }
      hideViewerPinModal();
    });
  }
}

// ==========================================
// RECURSOS GAMER PROFISSIONAIS (CLIPPING, PING, REAÇÕES, SOUNDBOARD, ABR, FACECAM, PIP)
// ==========================================

export let facecamStream = null;
let isTogglingFacecam = false;

export async function toggleFacecam() {
  if (isTogglingFacecam) return;
  isTogglingFacecam = true;

  try {
    const container = document.getElementById('facecam-container');
    const videoEl = document.getElementById('facecam-video');
    const toggleBtn = document.getElementById('toggle-facecam-btn');
    if (!container || !videoEl) return;

    if (facecamStream) {
      facecamStream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
      facecamStream = null;
      videoEl.srcObject = null;
      container.style.display = 'none';
      if (toggleBtn) {
        toggleBtn.classList.remove('active');
        toggleBtn.innerHTML = '<span>📷</span> Ligar Câmera';
        toggleBtn.title = 'Ativar câmera webcam flutuante';
      }
      showToast('📷 Facecam desativada.', 'info');
    } else {
      try {
        facecamStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
          audio: false
        });
        videoEl.srcObject = facecamStream;
        container.style.display = 'flex';
        if (toggleBtn) {
          toggleBtn.classList.add('active');
          toggleBtn.innerHTML = '<span>🛑</span> Desligar Facecam';
          toggleBtn.title = 'Desativar câmera webcam flutuante';
        }
        facecamStream.getVideoTracks().forEach(t => {
          t.onended = () => {
            if (facecamStream) {
              toggleFacecam();
            }
          };
        });
        showToast('📷 Facecam ativada!', 'success');
      } catch (err) {
        console.warn('Erro ao ativar facecam:', err);
        showToast('Não foi possível acessar a câmera para a Facecam.', 'error');
      }
    }
  } finally {
    isTogglingFacecam = false;
  }
}

let tacticalPingAbortController = null;

export function initTacticalPing() {
  const canvas = document.getElementById('ping-canvas');
  if (!canvas) return;

  tacticalPingManager.setCanvas(canvas);

  if (tacticalPingAbortController) {
    tacticalPingAbortController.abort();
  }
  tacticalPingAbortController = new AbortController();
  const { signal } = tacticalPingAbortController;

  const resize = () => {
    const parent = canvas.parentElement;
    if (parent) {
      const w = parent.clientWidth || 1280;
      const h = parent.clientHeight || 720;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }
  };
  resize();
  window.addEventListener('resize', resize, { signal });
  if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    signal.addEventListener('abort', () => ro.disconnect());
  }

  let currentPingMode = 'ping';
  const pingModeBtn = document.getElementById('ping-mode-btn');
  const dangerModeBtn = document.getElementById('danger-mode-btn');
  const laserModeBtn = document.getElementById('laser-mode-btn');

  const updateModeButtons = (mode) => {
    currentPingMode = mode;
    if (pingModeBtn) pingModeBtn.classList.toggle('active', mode === 'ping');
    if (dangerModeBtn) dangerModeBtn.classList.toggle('active', mode === 'danger');
    if (laserModeBtn) laserModeBtn.classList.toggle('active', mode === 'laser');
    if (canvas) {
      canvas.style.cursor = 'crosshair';
    }
  };

  if (pingModeBtn) {
    pingModeBtn.addEventListener('click', () => updateModeButtons('ping'), { signal });
  }
  if (dangerModeBtn) {
    dangerModeBtn.addEventListener('click', () => updateModeButtons('danger'), { signal });
  }
  if (laserModeBtn) {
    laserModeBtn.addEventListener('click', () => updateModeButtons('laser'), { signal });
  }

  let isPointerDown = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (getCoopState().isPlayer2) return;

    if (typeof document !== 'undefined') {
      const clickedEl = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
      if (clickedEl && (
        clickedEl.closest('.video-card-header') ||
        clickedEl.closest('.card-controls') ||
        clickedEl.closest('.card-btn') ||
        clickedEl.closest('.reactions-dock') ||
        clickedEl.closest('.bottom-control-dock') ||
        clickedEl.closest('.facecam-overlay') ||
        clickedEl.closest('.audio-unmute-overlay') ||
        clickedEl.closest('button') ||
        clickedEl.closest('header') ||
        clickedEl.closest('nav') ||
        clickedEl.closest('aside')
      )) {
        return;
      }
    }

    isPointerDown = true;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / (rect.height || 1)));

    const isHost = !window.location.pathname.endsWith('viewer.html');
    const coopState = getCoopState();
    const senderName = isRoomMode() && roomManager?.userName
      ? roomManager.userName
      : (isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : (myId ? `Amigo ${myId.slice(0, 4)}` : 'Espectador')));

    const isLaser = currentPingMode === 'laser' || e.shiftKey || e.button === 2;

    if (isLaser) {
      const color = isHost ? '#10b981' : '#00ffff';
      tacticalPingManager.startLaserTrail({ color });
      tacticalPingManager.addLaserPoint({ x, y, color });
      broadcastDataMessage({ type: 'TACTICAL_LASER', point: { x, y, color } });
    } else {
      const ping = { x, y, type: currentPingMode, senderName };
      tacticalPingManager.addPing(ping);
      broadcastDataMessage({ type: 'TACTICAL_PING', ping });
    }
  }, { signal });

  canvas.addEventListener('pointermove', (e) => {
    if (!isPointerDown) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / (rect.height || 1)));

    if (tacticalPingManager.isDrawingLaser) {
      const isHost = !window.location.pathname.endsWith('viewer.html');
      const color = isHost ? '#10b981' : '#00ffff';
      tacticalPingManager.addLaserPoint({ x, y, color });
      broadcastDataMessage({ type: 'TACTICAL_LASER', point: { x, y, color } });
    }
  }, { signal });

  const stopDrawing = () => {
    if (isPointerDown) {
      isPointerDown = false;
      if (tacticalPingManager.isDrawingLaser) {
        tacticalPingManager.stopLaserTrail();
      }
    }
  };

  canvas.addEventListener('pointerup', stopDrawing, { signal });
  canvas.addEventListener('pointercancel', stopDrawing, { signal });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
}

let floatingReactionsAbortController = null;

export function initFloatingReactions() {
  const overlay = document.getElementById('reactions-overlay');
  if (overlay) {
    floatingReactionsManager.setContainer(overlay);
  }

  const dock = document.getElementById('reactions-dock');
  if (dock) {
    if (floatingReactionsAbortController) {
      floatingReactionsAbortController.abort();
    }
    floatingReactionsAbortController = new AbortController();
    const { signal } = floatingReactionsAbortController;

    dock.querySelectorAll('.reaction-dock-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const emoji = btn.dataset.emoji;
        if (!emoji || !floatingReactionsManager.canSend()) return;

        const isHost = !window.location.pathname.endsWith('viewer.html');
        const coopState = getCoopState();
        const senderName = isRoomMode() && roomManager?.userName
          ? roomManager.userName
          : (isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : (myId ? `Amigo ${myId.slice(0, 4)}` : 'Espectador')));
        const xPercent = Math.random() * 70 + 15;

        floatingReactionsManager.spawnReaction({ emoji, xPercent, senderName });
        broadcastDataMessage({
          type: 'EMOJI_REACTION',
          emoji,
          xPercent,
          senderName
        });
      }, { signal });
    });
  }
}

export function initAdaptiveBitrate() {
  adaptiveBitrateController.setTargetBitrate(customBitrateBps);

  adaptiveBitrateController.onBitrateChange = (newBitrateBps) => {
    customBitrateBps = newBitrateBps;
    if (bitrateSlider) bitrateSlider.value = Math.round(customBitrateBps / 1000);
    if (bitrateDisplay) bitrateDisplay.innerText = `${(customBitrateBps / 1000000).toFixed(1)} Mbps`;
    applyLiveBitrateChange(true);

    const abrToggleBtn = document.getElementById('abr-toggle-btn');
    if (abrToggleBtn) {
      abrToggleBtn.innerHTML = `<span>⚡</span> ABR: ${(newBitrateBps / 1000000).toFixed(1)}M`;
    }
  };

  const abrToggleBtn = document.getElementById('abr-toggle-btn');
  if (abrToggleBtn) {
    abrToggleBtn.addEventListener('click', () => {
      const isCurrentlyActive = abrToggleBtn.classList.contains('active');
      const newState = !isCurrentlyActive;
      abrToggleBtn.classList.toggle('active', newState);
      adaptiveBitrateController.setEnabled(newState);
      if (!newState) {
        abrToggleBtn.innerHTML = '<span>⚡</span> ABR (Auto)';
      }
      showToast(newState ? '⚡ ABR Automático ativado (otimização dinâmica contra perdas).' : '⚡ ABR desativado (taxa de bitrate fixa).', 'info');
    });
  }
}

export function initFacecam() {
  const toggleBtn = document.getElementById('toggle-facecam-btn');
  const closeBtn = document.getElementById('facecam-close-btn');
  const container = document.getElementById('facecam-container');
  const header = container?.querySelector('.facecam-header');

  if (toggleBtn && !toggleBtn.dataset.facecamBound) {
    toggleBtn.dataset.facecamBound = 'true';
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleFacecam();
    });
  }
  if (closeBtn && !closeBtn.dataset.facecamBound) {
    closeBtn.dataset.facecamBound = 'true';
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleFacecam();
    });
  }

  if (container && header) {
    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = container.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      const onMouseMove = (ev) => {
        if (!isDragging) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        container.style.position = 'fixed';
        container.style.left = `${Math.max(10, Math.min(window.innerWidth - 200, startLeft + dx))}px`;
        container.style.top = `${Math.max(10, Math.min(window.innerHeight - 150, startTop + dy))}px`;
        container.style.right = 'auto';
        container.style.bottom = 'auto';
      };

      const onMouseUp = () => {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

let currentPreviewController = null;
let activeClipBlob = null;
let activeAudioBuffer = null;
let activeEffectId = 'none';

export function closeClipPostModal() {
  if (currentPreviewController) {
    try { currentPreviewController.stop(); } catch {}
    currentPreviewController = null;
  }
  const modal = document.getElementById('clip-post-modal');
  if (modal) {
    modal.style.display = 'none';
  }
  const previewVideo = document.getElementById('clip-preview-video');
  if (previewVideo) {
    try { previewVideo.pause(); } catch {}
    if (previewVideo._blobUrl) {
      try { URL.revokeObjectURL(previewVideo._blobUrl); } catch {}
      previewVideo._blobUrl = null;
    }
    previewVideo.src = '';
  }
}

export async function openClipPostModal(clipBlob) {
  const modal = document.getElementById('clip-post-modal');
  if (!modal) return;

  activeClipBlob = clipBlob;
  activeAudioBuffer = null;
  activeEffectId = 'none';
  modal.style.display = 'flex';

  const previewVideo = document.getElementById('clip-preview-video');
  if (previewVideo && clipBlob) {
    try {
      if (previewVideo._blobUrl) {
        try { URL.revokeObjectURL(previewVideo._blobUrl); } catch (_) {}
      }
      const url = URL.createObjectURL(clipBlob);
      previewVideo.src = url;
      previewVideo._blobUrl = url;
      previewVideo.load();
    } catch (e) {
      console.warn('Falha ao definir preview de vídeo do clip:', e);
    }
  }

  const closeBtn = document.getElementById('clip-post-close-btn');
  const downloadVideoBtn = document.getElementById('clip-download-video-btn');
  const statusPill = document.getElementById('clip-audio-status');
  const startSlider = document.getElementById('clip-trim-start-slider');
  const endSlider = document.getElementById('clip-trim-end-slider');
  const startVal = document.getElementById('clip-trim-start-val');
  const endVal = document.getElementById('clip-trim-end-val');
  const durationVal = document.getElementById('clip-trim-duration-val');
  const effectsGrid = document.getElementById('clip-effects-grid');
  const previewBtn = document.getElementById('clip-preview-audio-btn');
  const downloadWavBtn = document.getElementById('clip-download-wav-btn');
  const broadcastVoiceBtn = document.getElementById('clip-broadcast-voice-btn');

  if (closeBtn) {
    closeBtn.onclick = () => closeClipPostModal();
  }

  // Seção 1: Download do Vídeo Original
  if (downloadVideoBtn) {
    downloadVideoBtn.onclick = () => {
      if (!activeClipBlob) return;
      try {
        const url = URL.createObjectURL(activeClipBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = activeClipBlob.fileName || `SeeMyGame-Clip-${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1500);
      } catch (err) {
        console.warn('Falha no download manual do vídeo:', err);
      }
    };
  }

  // Renderiza a grade de efeitos sonoros engraçados
  if (effectsGrid) {
    effectsGrid.innerHTML = '';
    AUDIO_MEME_EFFECTS.forEach(eff => {
      const chip = document.createElement('div');
      chip.className = `clip-effect-chip ${eff.id === activeEffectId ? 'active' : ''}`;
      chip.dataset.effectId = eff.id;
      chip.title = eff.desc;
      chip.innerHTML = `
        <span class="icon">${eff.icon}</span>
        <span class="name">${eff.name}</span>
        <span class="desc">${eff.desc}</span>
      `;
      chip.onclick = () => {
        activeEffectId = eff.id;
        effectsGrid.querySelectorAll('.clip-effect-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (currentPreviewController && previewBtn) {
          currentPreviewController.stop();
          currentPreviewController = null;
          previewBtn.innerHTML = '<span>🎧</span> Ouvir Prévia';
        }
      };
      effectsGrid.appendChild(chip);
    });
  }

  // Atualização dos sliders de trimming
  const updateTrimLabels = () => {
    let start = parseFloat(startSlider?.value) || 0;
    let end = parseFloat(endSlider?.value) || 3;
    if (start >= end) {
      start = Math.max(0, end - 0.2);
      if (startSlider) startSlider.value = start;
    }
    const dur = Math.max(0.1, end - start);
    if (startVal) startVal.textContent = `${start.toFixed(1)}s`;
    if (endVal) endVal.textContent = `${end.toFixed(1)}s`;
    if (durationVal) durationVal.textContent = `${dur.toFixed(1)}s`;
  };

  if (startSlider) startSlider.oninput = updateTrimLabels;
  if (endSlider) endSlider.oninput = updateTrimLabels;

  // Botões de atalho rápido (presets de range)
  const presetBtns = modal.querySelectorAll('.btn-preset-quick');
  presetBtns.forEach(btn => {
    btn.onclick = () => {
      const maxDur = activeAudioBuffer?.duration || 30;
      const type = btn.dataset.presetRange;
      if (type === 'first3') {
        if (startSlider) startSlider.value = 0;
        if (endSlider) endSlider.value = Math.min(3, maxDur);
      } else if (type === 'last3') {
        if (startSlider) startSlider.value = Math.max(0, maxDur - 3);
        if (endSlider) endSlider.value = maxDur;
      } else if (type === 'last5') {
        if (startSlider) startSlider.value = Math.max(0, maxDur - 5);
        if (endSlider) endSlider.value = maxDur;
      } else if (type === 'all') {
        if (startSlider) startSlider.value = 0;
        if (endSlider) endSlider.value = maxDur;
      }
      updateTrimLabels();
    };
  });

  // Decodifica a trilha de áudio do Blob
  if (statusPill) {
    statusPill.textContent = '⏳ Decodificando áudio...';
    statusPill.classList.remove('ready');
  }

  const audioCtx = getAudioContext();
  try {
    activeAudioBuffer = await decodeAudioFromBlob(clipBlob, audioCtx);
  } catch (err) {
    console.warn('[AudioMeme] Erro ao decodificar áudio:', err);
    activeAudioBuffer = null;
  }

  if (activeAudioBuffer) {
    const totalDuration = activeAudioBuffer.duration || (activeAudioBuffer.length / activeAudioBuffer.sampleRate);
    if (statusPill) {
      statusPill.textContent = '✓ Pronto para recortar';
      statusPill.classList.add('ready');
    }
    if (startSlider) {
      startSlider.max = totalDuration.toFixed(1);
      startSlider.value = Math.max(0, totalDuration - 3.0).toFixed(1);
    }
    if (endSlider) {
      endSlider.max = totalDuration.toFixed(1);
      endSlider.value = totalDuration.toFixed(1);
    }
    updateTrimLabels();
  } else {
    if (statusPill) {
      statusPill.textContent = 'Trilha de áudio silenciosa ou ausente';
      statusPill.classList.remove('ready');
    }
  }

  // Ouvir Prévia
  if (previewBtn) {
    previewBtn.onclick = async () => {
      if (currentPreviewController) {
        currentPreviewController.stop();
        currentPreviewController = null;
        previewBtn.innerHTML = '<span>🎧</span> Ouvir Prévia';
        return;
      }

      if (!activeAudioBuffer) {
        showToast('Nenhuma trilha de áudio disponível no clipe.', 'warning');
        return;
      }

      const prevText = previewBtn.innerHTML;
      previewBtn.innerHTML = '<span>⏳</span> Processando...';
      try {
        const startSec = parseFloat(startSlider?.value) || 0;
        const endSec = parseFloat(endSlider?.value) || activeAudioBuffer.duration;
        const trimmed = trimAudioBuffer(activeAudioBuffer, startSec, endSec, audioCtx);
        const processed = await applyMemeEffect(trimmed, activeEffectId, audioCtx);
        currentPreviewController = playAudioBuffer(processed, audioCtx);
        previewBtn.innerHTML = '<span>⏹️</span> Parar Prévia';

        const playDurationMs = (processed.duration || (processed.length / processed.sampleRate)) * 1000;
        setTimeout(() => {
          if (currentPreviewController) {
            currentPreviewController = null;
            previewBtn.innerHTML = '<span>🎧</span> Ouvir Prévia';
          }
        }, playDurationMs + 200);
      } catch (err) {
        console.error('Erro ao tocar prévia:', err);
        showToast('Erro ao reproduzir prévia do áudio meme.', 'error');
        previewBtn.innerHTML = prevText;
      }
    };
  }

  // Baixar Áudio (.wav)
  if (downloadWavBtn) {
    downloadWavBtn.onclick = async () => {
      if (!activeAudioBuffer) {
        showToast('Nenhuma trilha de áudio disponível para exportar.', 'warning');
        return;
      }

      const prevText = downloadWavBtn.innerHTML;
      downloadWavBtn.disabled = true;
      downloadWavBtn.innerHTML = '<span>⏳</span> Exportando WAV...';
      try {
        const startSec = parseFloat(startSlider?.value) || 0;
        const endSec = parseFloat(endSlider?.value) || activeAudioBuffer.duration;
        const trimmed = trimAudioBuffer(activeAudioBuffer, startSec, endSec, audioCtx);
        const processed = await applyMemeEffect(trimmed, activeEffectId, audioCtx);
        const wavBlob = audioBufferToWavBlob(processed);

        const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `SeeMyGame-Meme-${activeEffectId}-${dateStr}.wav`;

        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1500);

        showToast(`Áudio meme salvo: ${fileName}!`, 'success');
      } catch (err) {
        console.error('Erro ao baixar WAV:', err);
        showToast('Erro ao converter áudio em WAV.', 'error');
      } finally {
        downloadWavBtn.disabled = false;
        downloadWavBtn.innerHTML = prevText;
      }
    };
  }

  // Tocar na Sala de Voz
  if (broadcastVoiceBtn) {
    broadcastVoiceBtn.onclick = async () => {
      if (!activeAudioBuffer) {
        showToast('Nenhum áudio disponível para transmitir.', 'warning');
        return;
      }

      const prevText = broadcastVoiceBtn.innerHTML;
      broadcastVoiceBtn.disabled = true;
      broadcastVoiceBtn.innerHTML = '<span>⏳</span> Transmitindo...';
      try {
        const startSec = parseFloat(startSlider?.value) || 0;
        const endSec = parseFloat(endSlider?.value) || activeAudioBuffer.duration;
        const trimmed = trimAudioBuffer(activeAudioBuffer, startSec, endSec, audioCtx);
        const processed = await applyMemeEffect(trimmed, activeEffectId, audioCtx);
        const wavBlob = audioBufferToWavBlob(processed);
        const base64 = await wavBlobToBase64(wavBlob);

        const isHost = !window.location.pathname.endsWith('viewer.html');
        const coopState = getCoopState();
        const senderName = isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : `Amigo ${myId ? myId.slice(0, 4) : ''}`);
        const effectObj = AUDIO_MEME_EFFECTS.find(e => e.id === activeEffectId);
        const effectName = effectObj ? `${effectObj.icon} ${effectObj.name}` : 'Meme';

        broadcastDataMessage({
          type: 'SOUNDBOARD_PLAY_CUSTOM',
          audioBase64: base64,
          effectName,
          senderName
        });

        // Reproduz localmente para o próprio usuário escutar também
        playAudioBuffer(processed, audioCtx);

        showToast(`Áudio meme (${effectName}) transmitido para a sala de voz!`, 'success');
      } catch (err) {
        console.error('Erro ao transmitir áudio meme:', err);
        showToast('Erro ao transmitir áudio para a sala de voz.', 'error');
      } finally {
        broadcastVoiceBtn.disabled = false;
        broadcastVoiceBtn.innerHTML = prevText;
      }
    };
  }
}

export function initWhiteboard() {
  const toggleBtn = document.getElementById('toggle-whiteboard-btn');
  const modal = document.getElementById('whiteboard-modal');
  const canvas = document.getElementById('whiteboard-canvas');
  if (!modal || !canvas) return;

  // Conecta callbacks P2P do WhiteboardManager
  whiteboardManager.onElementCreated = (element) => {
    broadcastDataMessage({ type: 'WHITEBOARD_ELEMENT_ADD', element });
  };
  whiteboardManager.onElementDeleted = (element) => {
    broadcastDataMessage({ type: 'WHITEBOARD_ELEMENT_DELETE', elementId: element.id });
  };
  whiteboardManager.onBoardCleared = () => {
    broadcastDataMessage({ type: 'WHITEBOARD_CLEAR' });
  };

  let lastCursorSend = 0;
  whiteboardManager.onCursorMoved = ({ x, y }) => {
    const now = Date.now();
    if (now - lastCursorSend > 50) {
      lastCursorSend = now;
      const isHost = !window.location.pathname.endsWith('viewer.html');
      const coopState = getCoopState();
      const senderName = isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : `Amigo ${myId ? myId.slice(0, 4) : ''}`);
      broadcastDataMessage({
        type: 'WHITEBOARD_CURSOR',
        x,
        y,
        userName: senderName,
        color: whiteboardManager.currentColor
      });
    }
  };

  const resizeCanvas = () => {
    if (typeof window === 'undefined') return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      whiteboardManager.render();
    }
  };

  window.addEventListener('resize', resizeCanvas);

  const openWhiteboard = () => {
    modal.style.display = 'flex';
    resizeCanvas();
    whiteboardManager.setCanvas(canvas);
    whiteboardManager.render();
    // Solicita sincronização com peers na sala
    broadcastDataMessage({ type: 'WHITEBOARD_REQUEST_SYNC' });
  };

  const closeWhiteboard = () => {
    modal.style.display = 'none';
  };

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (modal.style.display === 'flex') {
        closeWhiteboard();
      } else {
        openWhiteboard();
      }
    });
  }

  // Fechar
  const closeBtn = document.getElementById('wb-close-btn');
  if (closeBtn) closeBtn.onclick = closeWhiteboard;

  // Botões de Ferramentas
  const toolBtns = modal.querySelectorAll('.wb-tool-btn');
  toolBtns.forEach(btn => {
    btn.onclick = () => {
      toolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      whiteboardManager.setTool(btn.dataset.tool);
    };
  });

  // Paleta de Cores
  const colorDots = modal.querySelectorAll('.wb-color-dot');
  colorDots.forEach(dot => {
    dot.onclick = () => {
      colorDots.forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      whiteboardManager.setColor(dot.dataset.color);
    };
  });

  // Espessura
  const widthBtns = modal.querySelectorAll('#wb-width-group .wb-opt-btn');
  widthBtns.forEach(btn => {
    btn.onclick = () => {
      widthBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      whiteboardManager.setStrokeWidth(Number(btn.dataset.width));
    };
  });

  // Preenchimento
  const fillBtns = modal.querySelectorAll('#wb-fill-group .wb-opt-btn');
  fillBtns.forEach(btn => {
    btn.onclick = () => {
      fillBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      whiteboardManager.setFill(btn.dataset.fill);
    };
  });

  // Estilo Rascunho / Preciso
  const roughBtns = modal.querySelectorAll('#wb-rough-group .wb-opt-btn');
  roughBtns.forEach(btn => {
    btn.onclick = () => {
      roughBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      whiteboardManager.setRough(btn.dataset.rough === 'true');
    };
  });

  // Modo de Fundo
  const bgBtns = modal.querySelectorAll('#wb-bg-group .wb-opt-btn');
  bgBtns.forEach(btn => {
    btn.onclick = () => {
      bgBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.bg;
      whiteboardManager.setBackgroundMode(mode);
      if (mode === 'transparent') {
        modal.style.background = 'transparent';
      } else if (mode === 'light') {
        modal.style.background = '#f8fafc';
      } else {
        modal.style.background = '#12131c';
      }
    };
  });

  // Desfazer / Refazer
  const undoBtn = document.getElementById('wb-undo-btn');
  if (undoBtn) {
    undoBtn.onclick = () => {
      if (whiteboardManager.undo()) {
        broadcastDataMessage({ type: 'WHITEBOARD_SYNC', elements: whiteboardManager.elements });
      }
    };
  }

  const redoBtn = document.getElementById('wb-redo-btn');
  if (redoBtn) {
    redoBtn.onclick = () => {
      if (whiteboardManager.redo()) {
        broadcastDataMessage({ type: 'WHITEBOARD_SYNC', elements: whiteboardManager.elements });
      }
    };
  }

  // Limpar
  const clearBtn = document.getElementById('wb-clear-btn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (confirm('Deseja realmente limpar toda a lousa?')) {
        whiteboardManager.clear(true);
      }
    };
  }

  // Exportar PNG
  const exportBtn = document.getElementById('wb-export-btn');
  if (exportBtn) {
    exportBtn.onclick = async () => {
      try {
        const blob = await whiteboardManager.exportToBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `SeeMyGame-Lousa-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1500);
        showToast('Lousa exportada com sucesso em PNG!', 'success');
      } catch (err) {
        console.error('Erro ao exportar lousa:', err);
        showToast('Erro ao exportar imagem da lousa.', 'error');
      }
    };
  }

  // Compartilhar no Chat
  const chatBtn = document.getElementById('wb-chat-btn');
  if (chatBtn) {
    chatBtn.onclick = () => {
      const isHost = !window.location.pathname.endsWith('viewer.html');
      const coopState = getCoopState();
      const role = isHost ? 'host' : (coopState.isPlayer2 ? 'player2' : 'viewer');
      const senderName = isHost ? 'Streamer' : (coopState.isPlayer2 ? 'Player 2' : `Amigo ${myId ? myId.slice(0, 4) : ''}`);

      const msg = chatManager.createMessage({
        senderId: myId,
        senderName,
        role,
        text: '🎨 Compartilhou um esquema na Lousa Interativa! Abra a lousa no botão acima para ver.',
        channel: chatManager.getActiveChannel(),
      });

      if (msg) {
        chatManager.addMessage(msg);
        broadcastDataMessage({ type: 'CHAT_MESSAGE', message: msg });
        showToast('Aviso enviado para o chat da sala!', 'info');
      }
    };
  }

  // Atalhos de Teclado
  window.addEventListener('keydown', (e) => {
    if (modal.style.display !== 'flex') return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

    if (e.key === 'Escape') {
      closeWhiteboard();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) {
        if (whiteboardManager.redo()) broadcastDataMessage({ type: 'WHITEBOARD_SYNC', elements: whiteboardManager.elements });
      } else {
        if (whiteboardManager.undo()) broadcastDataMessage({ type: 'WHITEBOARD_SYNC', elements: whiteboardManager.elements });
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      if (whiteboardManager.redo()) broadcastDataMessage({ type: 'WHITEBOARD_SYNC', elements: whiteboardManager.elements });
      return;
    }

    const toolMap = {
      p: 'pencil',
      r: 'rectangle',
      d: 'diamond',
      c: 'circle',
      a: 'arrow',
      l: 'line',
      t: 'text',
      e: 'eraser'
    };
    const key = e.key.toLowerCase();
    if (toolMap[key]) {
      whiteboardManager.setTool(toolMap[key]);
      toolBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.tool === toolMap[key]);
      });
    }
  });
}

export function initGamerFeatures() {
  initTacticalPing();
  initFloatingReactions();
  initAdaptiveBitrate();
  initFacecam();
  initWhiteboard();
  setupGamepadTesterModal();

  // Botão de Clipping instantâneo ("Clipa isso! - 30s")
  const clipBtn = document.getElementById('clip-btn');
  if (clipBtn) {
    clipBtn.addEventListener('click', async () => {
      if (!clipRecorder.isRecording) {
        showToast('Nenhuma transmissão ativa para clipar.', 'warning');
        return;
      }
      const prevHtml = clipBtn.innerHTML;
      clipBtn.innerHTML = '<span>⏳</span> Gravando Clip...';
      clipBtn.disabled = true;
      clipBtn.classList.add('saving');
      try {
        const result = await clipRecorder.exportClip();
        if (result) {
          showToast(`🎬 Clip salvo com sucesso: ${result.fileName || 'vídeo.webm'}!`, 'success');
          openClipPostModal(result);
        } else {
          showToast('Aguarde alguns segundos de gravação antes de clipar.', 'info');
        }
      } catch (err) {
        console.error('Erro ao gerar clip:', err);
        showToast('Erro ao exportar clip.', 'error');
      } finally {
        clipBtn.innerHTML = prevHtml;
        clipBtn.disabled = false;
        clipBtn.classList.remove('saving');
      }
    });
  }

  // Botão de Picture-in-Picture nativo
  const pipBtn = document.getElementById('pip-btn');
  if (pipBtn) {
    pipBtn.addEventListener('click', async () => {
      try {
        const videoEl = document.querySelector('#video-grid video:not(#facecam-video)') || document.querySelector('video');
        if (!videoEl) {
          showToast('Nenhum vídeo em reprodução para Picture-in-Picture.', 'warning');
          return;
        }
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled && typeof videoEl.requestPictureInPicture === 'function') {
          await videoEl.requestPictureInPicture();
          showToast('📺 Picture-in-Picture ativado!', 'info');
        } else {
          showToast('Picture-in-Picture não suportado neste navegador.', 'warning');
        }
      } catch (err) {
        console.warn('Erro ao alternar Picture-in-Picture:', err);
        showToast('Não foi possível ativar Picture-in-Picture.', 'error');
      }
    });
  }

  // Atalho de teclado para Clipping (C)
  window.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
      return;
    }
    if (e.key === 'c' || e.key === 'C') {
      const clipBtnEl = document.getElementById('clip-btn');
      if (clipBtnEl && clipBtnEl.style.display !== 'none') {
        clipBtnEl.click();
      }
    }
  });
}

// Inicializa controles de ID, PIN e Gamer Features se os elementos já existirem no DOM
if (typeof document !== 'undefined') {
  initFixedIdAndPinControls();
  initGamerFeatures();
}

// ==========================================
// INICIALIZAÇÃO GERAL
// ==========================================

function initAppDom() {
  const acceptedVersion = typeof localStorage !== 'undefined' ? localStorage.getItem('seemygame_terms_version') : null;
  const legacyAccepted = typeof localStorage !== 'undefined' ? localStorage.getItem('seemygame_terms_accepted') === 'true' : false;

  // Pré-busca credenciais TURN da API serverless em segundo plano se disponível
  fetchIceServersFromApi().catch(() => {});

  // Sincroniza capacidades de áudio com a plataforma (Web / Desktop)
  syncAudioModeCapabilities().catch(() => {});

  // Inicializa suporte e prioridade nativa se estiver rodando em Desktop Tauri
  initDesktopSupport().catch((err) => console.warn('[Desktop Init]', err));

  // Inicializa recursos Discord (Chat e Voz P2P)
  initDiscordFeatures();

  // Inicializa controles de ID fixo e PIN
  initFixedIdAndPinControls();

  // Inicializa recursos Gamer (Clipping, Pings, Reações, ABR, PiP, Facecam)
  initGamerFeatures();

  initTermsModal(() => {
    if (isRoomMode()) {
      initGreenRoomLobby();
    } else {
      initPeer();
    }
  });

  // Só conecta à sinalização se os termos já tiverem sido aceitos
  if (acceptedVersion === TERMS_VERSION || (legacyAccepted && !acceptedVersion)) {
    if (isRoomMode()) {
      initGreenRoomLobby();
    } else {
      initPeer();
    }
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initAppDom);
  } else {
    initAppDom();
  }
}

// ==========================================
// ATALHOS DE TECLADO GAMER (F = Fullscreen, M = Mute)
// ==========================================

window.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
    return;
  }

  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    const video = document.querySelector('.video-card:not(#card-local-me) video') || 
                  document.querySelector('video');
    if (video) {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (video.requestFullscreen) {
          video.requestFullscreen().catch(err => console.warn(err));
        } else if (video.webkitRequestFullscreen) {
          video.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(err => console.warn(err));
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    }
  } else if (e.key === 'm' || e.key === 'M') {
    const video = document.querySelector('.video-card:not(#card-local-me) video') || 
                  document.querySelector('video');
    if (video) {
      video.muted = !video.muted;
      showToast(video.muted ? '🔇 Áudio mutado' : '🔊 Áudio desmutado', 'info', 2000);
      document.querySelectorAll('.volume-slider').forEach(s => {
        s.value = video.muted ? '0' : '1';
      });
      document.querySelectorAll('.overlay-btn').forEach(btn => {
        if (btn.innerHTML.includes('🔊') || btn.innerHTML.includes('🔇')) {
          btn.innerHTML = video.muted ? '🔇' : '🔊';
        }
      });
    }
  }

  // Push-to-Talk (PTT) Hotkey (CapsLock ou ControlRight)
  if (voiceManager.isInVoice && voiceManager.voiceMode === 'ptt' && (e.code === 'CapsLock' || e.code === 'ControlRight')) {
    e.preventDefault();
    if (!voiceManager.isPttActive) {
      voiceManager.setPttActive(true);
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (voiceManager.isInVoice && voiceManager.voiceMode === 'ptt' && (e.code === 'CapsLock' || e.code === 'ControlRight')) {
    e.preventDefault();
    voiceManager.setPttActive(false);
  }
});

export async function initGreenRoomLobby() {
  const greenRoomModal = document.getElementById('green-room-modal');
  if (greenRoomModal) {
    greenRoomModal.style.display = 'flex';
  }
  const info = getRoomInfoFromUrl();
  const idLabel = document.getElementById('green-room-id-label');
  if (idLabel && info?.roomId) {
    idLabel.textContent = `#${info.roomId}`;
  }

  const joinBtn = document.getElementById('green-room-join-btn');
  const nameInput = document.getElementById('green-room-user-name');
  if (nameInput) {
    const savedName = (typeof localStorage !== 'undefined' ? localStorage.getItem('seemygame_user_name') : null);
    if (savedName && !nameInput.value) nameInput.value = savedName;
  }
  if (joinBtn) {
    joinBtn.onclick = () => {
      if (nameInput && nameInput.value.trim() && typeof localStorage !== 'undefined') {
        localStorage.setItem('seemygame_user_name', nameInput.value.trim());
      }
      if (greenRoomModal) {
        greenRoomModal.style.display = 'none';
      }
      if (!peer || peer.destroyed || peer.disconnected) {
        initPeer();
      } else if (roomManager && !roomManager.isInRoom) {
        setupRoomSession(peer.id);
      }
    };
  }

  const micSelect = document.getElementById('green-room-mic-select');
  const speakerSelect = document.getElementById('green-room-speaker-select');

  if (navigator?.mediaDevices?.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (micSelect) {
        micSelect.innerHTML = '<option value="">Microfone Padrão</option>';
        devices.filter(d => d.kind === 'audioinput').forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Microfone (${d.deviceId.slice(0, 6)})`;
          micSelect.appendChild(opt);
        });
      }
      if (speakerSelect) {
        speakerSelect.innerHTML = '<option value="">Alto-falante Padrão</option>';
        devices.filter(d => d.kind === 'audiooutput').forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Alto-falante (${d.deviceId.slice(0, 6)})`;
          speakerSelect.appendChild(opt);
        });
      }
    } catch (err) {
      console.warn('[GreenRoom] Erro ao enumerar dispositivos:', err);
    }
  }
}

export function bootstrapApp() {
  const termsModal = document.getElementById('terms-modal');
  const checkAge = document.getElementById('check-age');
  const checkTerms = document.getElementById('check-terms');
  const acceptBtn = document.getElementById('accept-btn');

  const accepted = localStorage.getItem('seemygame_terms_accepted') === 'true' ||
                   localStorage.getItem('seemygame_terms_version') === TERMS_VERSION;

  if (termsModal && accepted) {
    termsModal.style.display = 'none';
    if (isRoomMode()) {
      initGreenRoomLobby();
    }
  }

  function sync() {
    if (acceptBtn && checkAge && checkTerms) {
      const ok = Boolean(checkAge.checked && checkTerms.checked);
      acceptBtn.disabled = !ok;
      acceptBtn.setAttribute('aria-disabled', String(!ok));
      if (ok) {
        acceptBtn.removeAttribute('disabled');
        acceptBtn.classList.remove('disabled');
      } else {
        acceptBtn.setAttribute('disabled', 'true');
        acceptBtn.classList.add('disabled');
      }
    }
  }

  if (checkAge && checkTerms) {
    ['change', 'input', 'click'].forEach(evt => {
      checkAge.addEventListener(evt, sync);
      checkTerms.addEventListener(evt, sync);
    });
    sync();
  }

  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      if (checkAge && checkTerms && checkAge.checked && checkTerms.checked) {
        try {
          localStorage.setItem('seemygame_terms_version', TERMS_VERSION);
          localStorage.setItem('seemygame_terms_accepted', 'true');
        } catch (e) {}
        if (termsModal) termsModal.style.display = 'none';
        if (isRoomMode()) {
          initGreenRoomLobby();
        }
      }
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bootstrapApp());
  } else {
    bootstrapApp();
  }
}



