import { sendSessionMessage } from '../protocol/transport.js';
import { isValidPeerId } from ".././shared/peer-id.js";
import { sanitizeRoomId } from ".././room/room-id.js";
import { ROOM_PREFIX, MASTER_SUFFIX, MAX_ROOM_MEMBERS, MAX_PENDING_ROOM_CONNECTIONS, MAX_ROOM_MESSAGE_BYTES, ROOM_HEARTBEAT_INTERVAL_MS, ROOM_MEMBER_TIMEOUT_MS, sanitizeText, hashRoomKey, getRoomMasterPeerId, isWithinMessageLimit } from './shared.js';
/** RoomManager: presence. State and lifetime remain owned by the composed engine. */
export const withRoomManagerPresence = Base => class extends Base {
removeMember(peerId) {
    if (!peerId) return;
    if (peerId === this.myPeerId) {
      console.warn(`[RoomManager] Bloqueada tentativa de remover o próprio usuário local: ${peerId}`);
      return;
    }

    const connections = new Set([this.pendingConnections.get(peerId), this.meshConnections.get(peerId)]);
    this.pendingConnections.delete(peerId);
    this.authenticatedPeers.delete(peerId);
    this.meshConnections.delete(peerId);

    if (this.members.has(peerId)) {
      const removed = this.members.get(peerId);
      this.members.delete(peerId);
      this.emit('memberLeft', removed);

      if (removed.isStreaming) {
        this.emit('streamUnpublished', { peerId });
      }

      this.emit('membersUpdated', this.getMembersList());
      this.notifyState();
    }
    for (const conn of connections) { try { conn?.close?.(); } catch (_) {} }
  }

setLocalStreaming(isStreaming, details = {}) {
    this.localStreamingState.isStreaming = Boolean(isStreaming);
    if (details.title) this.localStreamingState.title = details.title;
    if (details.provider) this.localStreamingState.provider = details.provider;
    if (details.sourceType) this.localStreamingState.sourceType = details.sourceType;
    if (details.preset) this.localStreamingState.preset = details.preset;
    if (details.fps) this.localStreamingState.fps = details.fps;
    if (details.height) this.localStreamingState.height = details.height;
    if (details.audioMode) this.localStreamingState.audioMode = details.audioMode;

    const selfMember = this.members.get(this.myPeerId);
    if (selfMember) {
      selfMember.isStreaming = this.localStreamingState.isStreaming;
      selfMember.streamDetails = this.localStreamingState.isStreaming ? { ...this.localStreamingState } : null;
    }

    if (this.localStreamingState.isStreaming) {
      this.broadcast({
        type: 'ROOM_STREAM_PUBLISHED',
        peerId: this.myPeerId,
        details: { ...this.localStreamingState }
      });
      this.emit('streamPublished', { peerId: this.myPeerId, details: { ...this.localStreamingState }, member: selfMember });
    } else {
      this.broadcast({
        type: 'ROOM_STREAM_UNPUBLISHED',
        peerId: this.myPeerId
      });
      this.emit('streamUnpublished', { peerId: this.myPeerId, member: selfMember });
    }

    this.emit('membersUpdated', this.getMembersList());
    this.notifyState();
  }

setLocalVoiceState({ isMuted, isDeafened, isSpeaking, voiceChannelId } = {}) {
    const selfMember = this.members.get(this.myPeerId);
    if (!selfMember) return;

    if (typeof isMuted === 'boolean') selfMember.isMuted = isMuted;
    if (typeof isDeafened === 'boolean') selfMember.isDeafened = isDeafened;
    if (typeof isSpeaking === 'boolean') selfMember.isSpeaking = isSpeaking;
    if (voiceChannelId === null || this.voiceChannels.has(voiceChannelId)) selfMember.voiceChannelId = voiceChannelId;

    this.broadcast({
      type: 'ROOM_MEMBER_STATE_UPDATE',
      peerId: this.myPeerId,
      isMuted: selfMember.isMuted,
      isDeafened: selfMember.isDeafened,
      voiceChannelId: selfMember.voiceChannelId ?? null,
      isSpeaking: selfMember.isSpeaking
    });

    this.emit('membersUpdated', this.getMembersList());
    this.notifyState();
  }

broadcast(payload, excludePeerId = null) {
    if (!isWithinMessageLimit(payload)) return false;
    this.meshConnections.forEach((conn, peerId) => {
      if (peerId !== excludePeerId && conn && conn.open && this.isPeerAuthorized(peerId)) {
        try {
          sendSessionMessage({ getPeerId: () => this.myPeerId }, conn, payload);
        } catch (e) {
          console.warn(`[RoomManager] Erro ao enviar mensagem para ${peerId}:`, e);
        }
      }
    });
    return true;
  }

getMembersList() {
    return Array.from(this.members.values());
  }

getActiveStreamers() {
    return Array.from(this.members.values()).filter((m) => m.isStreaming);
  }

notifyState() {
    try {
      this.onStateChange({
        roomId: this.roomId,
        isMaster: this.isMaster,
        membersCount: this.members.size,
        streamersCount: this.getActiveStreamers().length,
        members: this.getMembersList()
      });
    } catch (e) {}
  }

_startHeartbeat() {
    this._stopHeartbeat();
    if (typeof setInterval !== 'function') return;

    this.heartbeatTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.heartbeatIntervalMs);

    if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
      try { this.heartbeatTimer.unref(); } catch (_) {}
    }
  }

_stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

performHealthCheck() {
    if (!this.isInRoom) return;

    // 1. Envia batimento cardíaco para todas as conexões ativas na sala
    this.broadcast({
      type: 'ROOM_HEARTBEAT',
      peerId: this.myPeerId,
      timestamp: Date.now()
    });

    // 2. Checagem e poda de conexões mortas ou inativas
    const now = Date.now();
    const deadPeers = [];

    this.members.forEach((member, peerId) => {
      if (peerId === this.myPeerId) return;

      const conn = this.meshConnections.get(peerId);
      const isConnDead = conn && (
        conn.open === false ||
        conn.peerConnection?.connectionState === 'closed' ||
        conn.peerConnection?.connectionState === 'failed' ||
        conn.peerConnection?.iceConnectionState === 'closed' ||
        conn.peerConnection?.iceConnectionState === 'failed'
      );

      const isConnHealthy = conn && conn.open && conn.peerConnection?.connectionState === 'connected';

      const lastSeen = member.lastSeen || member.joinedAt || now;
      const isTimedOut = (now - lastSeen) > this.memberTimeoutMs;

      // Poda segura:
      // - Se a conexão estiver explicitamente morta (fechada ou com falha de ICE)
      // - Se timeout foi atingido (30s) e a conexão NÃO estiver conectada de forma saudável
      // - Um guest NUNCA remove o Master apenas por timeout de batimento enquanto a conexão WebRTC estiver viva
      if (isConnDead || (!isConnHealthy && isTimedOut && this.isMaster)) {
        deadPeers.push(peerId);
      }
    });

    deadPeers.forEach((peerId) => {
      console.log(`[RoomManager] Removendo membro inativo/desconectado: ${peerId}`);
      this.removeMember(peerId);
      if (this.isMaster) {
        this.broadcast({
          type: 'ROOM_MEMBER_LEFT',
          peerId
        });
      }
    });
  }
};
