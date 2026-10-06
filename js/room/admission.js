import { sendSessionMessage } from '../protocol/transport.js';
import { isValidPeerId } from ".././shared/peer-id.js";
import { sanitizeRoomId } from ".././room/room-id.js";
import { ROOM_PREFIX, MASTER_SUFFIX, MAX_ROOM_MEMBERS, MAX_PENDING_ROOM_CONNECTIONS, MAX_ROOM_MESSAGE_BYTES, ROOM_HEARTBEAT_INTERVAL_MS, ROOM_MEMBER_TIMEOUT_MS, sanitizeText, hashRoomKey, getRoomMasterPeerId, isWithinMessageLimit } from './shared.js';
/** RoomManager: admission. State and lifetime remain owned by the composed engine. */
export const withRoomManagerAdmission = Base => class extends Base {
registerConnection(peerId, conn, initialInfo = {}) {
    if (!isValidPeerId(peerId) || peerId === this.myPeerId) return false;
    if (!this.members.has(peerId) && this.members.size >= MAX_ROOM_MEMBERS) return false;

    // Se já temos uma conexão de malha aberta e autenticada com este peer, mantém a existente
    const existingMesh = this.meshConnections.get(peerId);
    if (existingMesh && existingMesh.open && this.authenticatedPeers.has(peerId)) {
      return existingMesh === conn;
    }

    // Se já temos uma conexão pendente aberta (ex: masterConn de saída), não a substitua por conexão reversa
    const existingPending = this.pendingConnections.get(peerId);
    if (existingPending && existingPending !== conn && existingPending.open) {
      return false;
    }

    // Every room connection starts pending until open/authenticated.
    if (!this.authenticatedPeers.has(peerId) || !conn.open) {
      if (!this.pendingConnections.has(peerId) && this.pendingConnections.size >= MAX_PENDING_ROOM_CONNECTIONS) return false;
      this.pendingConnections.set(peerId, conn);
      return true;
    }

    return this.promoteConnection(peerId, conn, initialInfo);
  }

  promoteConnection(peerId, conn, initialInfo = {}) {
    if (!isValidPeerId(peerId) || peerId === this.myPeerId || !conn) return false;
    if (!this.members.has(peerId) && this.members.size >= MAX_ROOM_MEMBERS) return false;

    this.authenticatedPeers.add(peerId);
    this.pendingConnections.delete(peerId);
    this.meshConnections.set(peerId, conn);

    if (!this.members.has(peerId)) {
      const newMember = {
        peerId,
        name: typeof initialInfo.name === 'string' && initialInfo.name.trim() ? sanitizeText(initialInfo.name).slice(0, 30) : `Amigo ${peerId.slice(-4)}`,
        clientSessionId: initialInfo.clientSessionId || null,
        isMaster: Boolean(initialInfo.isMaster),
        isMuted: Boolean(initialInfo.isMuted),
        isDeafened: Boolean(initialInfo.isDeafened),
        isSpeaking: Boolean(initialInfo.isSpeaking && !initialInfo.isMuted && this.voiceChannels.has(initialInfo.voiceChannelId)),
        voiceChannelId: this.voiceChannels.has(initialInfo.voiceChannelId) ? initialInfo.voiceChannelId : null,
        isStreaming: Boolean(initialInfo.isStreaming),
        streamDetails: initialInfo.streamDetails || null,
        joinedAt: initialInfo.joinedAt || Date.now(),
        lastSeen: Date.now()
      };
      this.members.set(peerId, newMember);
      this.emit('memberJoined', newMember);
      this.emit('membersUpdated', this.getMembersList());
      if (newMember.isStreaming) {
        this.emit('streamPublished', { peerId: newMember.peerId, details: newMember.streamDetails, member: newMember });
      }
      this.notifyState();
    } else {
      const existing = this.members.get(peerId);
      existing.lastSeen = Date.now();
      let changed = false;
      if (initialInfo.name && initialInfo.name.trim() && existing.name !== initialInfo.name) {
        existing.name = sanitizeText(initialInfo.name).slice(0, 30);
        changed = true;
      }
      if (initialInfo.clientSessionId && existing.clientSessionId !== initialInfo.clientSessionId) {
        existing.clientSessionId = initialInfo.clientSessionId;
        changed = true;
      }
      if ((initialInfo.voiceChannelId === null || this.voiceChannels.has(initialInfo.voiceChannelId)) && existing.voiceChannelId !== initialInfo.voiceChannelId) {
        existing.voiceChannelId = initialInfo.voiceChannelId;
        changed = true;
      }
      for (const key of ['isMuted', 'isDeafened', 'isSpeaking']) {
        if (typeof initialInfo[key] === 'boolean' && existing[key] !== initialInfo[key]) {
          existing[key] = initialInfo[key];
          changed = true;
        }
      }
      if (typeof initialInfo.isStreaming === 'boolean' && existing.isStreaming !== initialInfo.isStreaming) {
        existing.isStreaming = initialInfo.isStreaming;
        changed = true;
      }
      if (initialInfo.streamDetails && existing.streamDetails !== initialInfo.streamDetails) {
        existing.streamDetails = initialInfo.streamDetails;
        changed = true;
      }
      if (changed) {
        this.emit('membersUpdated', this.getMembersList());
        if (existing.isStreaming) {
          this.emit('streamPublished', { peerId: existing.peerId, details: existing.streamDetails, member: existing });
        }
        this.notifyState();
      }
    }
    return true;
  }

isPeerAuthorized(peerId) {
    if (peerId === this.myPeerId) return true;
    return this.authenticatedPeers.has(peerId);
  }
};
