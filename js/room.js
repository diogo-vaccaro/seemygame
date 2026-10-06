import { isValidPeerId } from './shared/peer-id.js';
import { PinAttemptLimiter } from './protocol/pin-attempt-limiter.js';
import { sanitizeRoomId } from './room/room-id.js';
import { ROOM_PREFIX, MASTER_SUFFIX, MAX_ROOM_MEMBERS, MAX_PENDING_ROOM_CONNECTIONS, MAX_ROOM_MESSAGE_BYTES, ROOM_HEARTBEAT_INTERVAL_MS, ROOM_MEMBER_TIMEOUT_MS, sanitizeText, hashRoomKey, getRoomMasterPeerId, isWithinMessageLimit } from './room/shared.js';
export * from './room/shared.js';
import { withRoomManagerAdmission } from './room/admission.js';
import { withRoomManagerMessageHandlers } from './room/message-handlers.js';
import { withRoomManagerPresence } from './room/presence.js';
import { withRoomVoiceChannels, DEFAULT_VOICE_CHANNELS } from './room/voice-channels.js';
export class RoomManager extends withRoomVoiceChannels(withRoomManagerPresence(withRoomManagerMessageHandlers(withRoomManagerAdmission(class {})))) {
constructor({ roomId = 'general', userName = null, clientSessionId = null, roomPin = null, roomKey = null, onStateChange } = {}) {
    super();
    this.roomId = sanitizeRoomId(roomId);
    this.clientSessionId = clientSessionId || null;
    this.userName = typeof userName === 'string' && userName.trim() ? sanitizeText(userName).trim().slice(0, 30) : null;
    this.roomPin = roomPin ? String(roomPin).trim() : null;
    this.roomKey = typeof roomKey === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(roomKey) ? roomKey : null;
    this.onStateChange = onStateChange || (() => {});

    this.isMaster = false;
    this.masterPeerId = getRoomMasterPeerId(this.roomId, this.roomKey);
    this.isInRoom = false;
    this.myPeerId = null;
    this.voiceChannelId = null;
    this.voiceChannels = new Map(DEFAULT_VOICE_CHANNELS.map(c => [c.id, { ...c }]));
    this.voiceChannelsRevision = 0;

    // Estado local da transmissão
    this.localStreamingState = {
      isStreaming: false,
      provider: 'browser',
      sourceType: null,
      title: 'Jogo / Tela',
      preset: 'ultra',
      fps: 60,
      height: 1080,
      audioMode: 'system'
    };

    // Mapa de membros: peerId -> { peerId, name, isMaster, isMuted, isSpeaking, isDeafened, isStreaming, streamDetails, joinedAt }
    this.members = new Map();

    // Conexões de dados ativas na malha: peerId -> DataConnection
    this.meshConnections = new Map();

    // Conexões pendentes de autenticação de PIN: peerId -> DataConnection
    this.pendingConnections = new Map();

    // Peers autenticados: Set de peerIds
    this.authenticatedPeers = new Set();
    this.pinAttemptLimiter = new PinAttemptLimiter();

    this.heartbeatIntervalMs = ROOM_HEARTBEAT_INTERVAL_MS;
    this.memberTimeoutMs = ROOM_MEMBER_TIMEOUT_MS;
    this.heartbeatTimer = null;

    // Callbacks de eventos
    this.listeners = {
      memberJoined: new Set(),
      memberLeft: new Set(),
      membersUpdated: new Set(),
      streamPublished: new Set(),
      streamUnpublished: new Set(),
      roomClosed: new Set(),
      pinRequired: new Set(),
      pinAccepted: new Set(),
      joinRejected: new Set(),
      voiceChannelsUpdated: new Set(),
      voiceChannelError: new Set()
    };
  }

setRoomPin(pin) {
    this.roomPin = pin ? String(pin).trim() : null;
  }

on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].add(callback);
    }
  }

off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].delete(callback);
    }
  }

emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => {
        try { cb(data); } catch (err) { console.error(`[RoomManager] Erro no listener ${event}:`, err); }
      });
    }
  }

join(peerId, isMaster = false) {
    if (!isValidPeerId(peerId)) return false;
    if (this.roomKey && isMaster && peerId !== this.masterPeerId) return false;
    this.myPeerId = peerId;
    this.isMaster = isMaster;
    this.isInRoom = true;

    // Adiciona a si mesmo na lista de membros com identificação segura
    const fallbackName = this.isMaster ? 'Host' : `Amigo ${this.myPeerId.slice(-4)}`;
    const effectiveName = this.userName || fallbackName;

    const selfMember = {
      peerId: this.myPeerId,
      name: effectiveName,
      clientSessionId: this.clientSessionId || null,
      isMaster: this.isMaster,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      voiceChannelId: null,
      isStreaming: this.localStreamingState.isStreaming,
      streamDetails: this.localStreamingState.isStreaming ? { ...this.localStreamingState } : null,
      joinedAt: Date.now(),
      lastSeen: Date.now()
    };

    this.members.set(this.myPeerId, selfMember);
    this._startHeartbeat();
    this.emit('membersUpdated', this.getMembersList());
    this.notifyState();
    return true;
  }

leave() {
    this._stopHeartbeat();

    this.broadcast({
      type: 'ROOM_MEMBER_LEFT',
      peerId: this.myPeerId
    });

    this.meshConnections.forEach((conn) => {
      try { conn.close(); } catch (e) {}
    });
    this.pendingConnections.forEach((conn) => {
      try { conn.close(); } catch (e) {}
    });
    this.meshConnections.clear();
    this.pendingConnections.clear();
    this.authenticatedPeers.clear();
    this.pinAttemptLimiter.clear();
    this.members.clear();
    this.isInRoom = false;
    this.emit('roomClosed', { roomId: this.roomId });
    this.notifyState();
  }
}
