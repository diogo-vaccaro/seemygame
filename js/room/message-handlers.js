import { sendSessionMessage, validateReceivedMessage } from '../protocol/transport.js';
import { isValidPeerId } from ".././shared/peer-id.js";
import { sanitizeRoomId } from ".././room/room-id.js";
import { ROOM_PREFIX, MASTER_SUFFIX, MAX_ROOM_MEMBERS, MAX_PENDING_ROOM_CONNECTIONS, MAX_ROOM_MESSAGE_BYTES, ROOM_HEARTBEAT_INTERVAL_MS, ROOM_MEMBER_TIMEOUT_MS, sanitizeText, hashRoomKey, getRoomMasterPeerId, isWithinMessageLimit } from './shared.js';
/** RoomManager: message-handlers. State and lifetime remain owned by the composed engine. */
export const withRoomManagerMessageHandlers = Base => class extends Base {
handleRoomMessage(senderPeerId, message, conn) {
    if (!message || typeof message !== 'object') return false;
    if (!validateReceivedMessage(message, conn)) return true;

    if (!isValidPeerId(senderPeerId)) return true;
    try {
      if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_ROOM_MESSAGE_BYTES) return true;
    } catch (error) {
      return true;
    }

    // A DataConnection cannot legitimately speak for another PeerJS peer. Keep
    // this check at the protocol boundary so a forged peerId never reaches the
    // membership or media layers.
    if (conn?.peer && conn.peer !== senderPeerId) return true;

    const isJoinOrAuthMessage = [
      'ROOM_JOIN_REQUEST',
      'ROOM_PIN_REQUIRED',
      'ROOM_PIN_ACCEPTED',
      'ROOM_KEY_REQUIRED',
      'ROOM_JOIN_REJECTED',
      'ROOM_SYNC_ALL',
      'ROOM_MEMBER_AUTH',
      'ROOM_MEMBER_AUTH_ACCEPTED',
      'ROOM_HEARTBEAT',
      'ROOM_MEMBER_JOINED'
    ].includes(message.type);
    if (isJoinOrAuthMessage && message.roomId && sanitizeRoomId(message.roomId) !== this.roomId) return true;
    if (isJoinOrAuthMessage && !this.authenticatedPeers.has(senderPeerId) &&
        !['ROOM_JOIN_REQUEST', 'ROOM_SYNC_ALL', 'ROOM_MEMBER_AUTH', 'ROOM_MEMBER_AUTH_ACCEPTED', 'ROOM_PIN_REQUIRED', 'ROOM_PIN_ACCEPTED', 'ROOM_KEY_REQUIRED', 'ROOM_JOIN_REJECTED', 'ROOM_MEMBER_JOINED'].includes(message.type)) {
      return true;
    }
    if (!isJoinOrAuthMessage && !this.authenticatedPeers.has(senderPeerId)) {
      if (senderPeerId === this.masterPeerId) {
        this.authenticatedPeers.add(senderPeerId);
      } else {
        console.warn(`[RoomManager] Mensagem de peer não autenticado rejeitada: ${senderPeerId}`);
        return true;
      }
    }

    const senderMember = this.members.get(senderPeerId);
    if (senderMember) {
      senderMember.lastSeen = Date.now();
    }
    if (this.handleVoiceChannelMessage(senderPeerId, message, conn)) return true;

    switch (message.type) {
      case 'ROOM_JOIN_REQUEST': {
        // Only the coordinator admits members. A guest must never be able to
        // turn an arbitrary inbound connection into an authenticated member.
        if (!this.isMaster) {
          conn?.send?.({ type: 'ROOM_JOIN_REJECTED', error: 'Somente o coordenador pode admitir membros.' });
          return true;
        }

        if (!this.members.has(senderPeerId) && this.members.size >= MAX_ROOM_MEMBERS) {
          conn?.send?.({ type: 'ROOM_JOIN_REJECTED', error: 'A sala atingiu o limite de participantes.' });
          return true;
        }

        if (this.roomKey && message.roomKey !== this.roomKey) {
          conn?.send?.({ type: 'ROOM_KEY_REQUIRED', error: 'Convite de sala invalido ou expirado.' });
          if (this.pendingConnections.get(senderPeerId) === conn) {
            this.pendingConnections.delete(senderPeerId);
          }
          return true;
        }

        // SEGURANÇA (A02): Validação rigorosa de PIN se configurado no Master
        if (this.isMaster && this.roomPin) {
          if (this.pinAttemptLimiter.isRateLimited(senderPeerId)) {
            conn?.send?.({ type: 'ROOM_PIN_REQUIRED', error: 'Excesso de tentativas. Aguarde 30 segundos.' });
            if (this.pendingConnections.get(senderPeerId) === conn) this.pendingConnections.delete(senderPeerId);
            try { conn?.close(); } catch (_) {}
            return true;
          }
          const providedPin = message.pin ? String(message.pin).trim() : '';

          if (providedPin !== this.roomPin) {
            const failures = this.pinAttemptLimiter.recordFailedAttempt(senderPeerId);
            const isExceeded = failures >= 5;
            conn?.send?.({
              type: 'ROOM_PIN_REQUIRED',
              error: isExceeded ? 'Excesso de tentativas incorretas de PIN.' : 'PIN incorreto para esta sala.'
            });
            if (this.pendingConnections.get(senderPeerId) === conn) {
              this.pendingConnections.delete(senderPeerId);
            }
            if (isExceeded) {
              try { conn.close(); } catch (_) {}
            }
            return true;
          }
          this.pinAttemptLimiter.resetPeer(senderPeerId);
        }

        const cleanName = typeof message.name === 'string' && message.name.trim()
          ? sanitizeText(message.name).trim().slice(0, 30)
          : `Amigo ${senderPeerId.slice(-4)}`;

        const isGenericName = ['você', 'voce', 'amigo', 'host', 'visitante', 'guest'].includes(cleanName.toLowerCase()) || cleanName.startsWith('Amigo ');

        // Se um usuário com a mesma sessão de aba (F5/relog) relogou com novo ID, limpa a sessão antiga
        for (const [existingPeerId, existingMember] of this.members.entries()) {
          if (existingPeerId === this.myPeerId || existingPeerId === senderPeerId) continue;

          const isSameSession = Boolean(message.clientSessionId && existingMember.clientSessionId && existingMember.clientSessionId === message.clientSessionId);

          if (isSameSession) {
            console.log(`[RoomManager] Relog detectado para sessão "${message.clientSessionId}" (${senderPeerId}). Purgando peer fantasma anterior (${existingPeerId}).`);
            this.removeMember(existingPeerId);
            this.broadcast({
              type: 'ROOM_MEMBER_LEFT',
              peerId: existingPeerId
            }, senderPeerId);
            break;
          }
        }

        // Sucesso na autenticação
        const memberInfo = {
          peerId: senderPeerId,
          name: cleanName,
          clientSessionId: message.clientSessionId || null,
          isMaster: false,
          isMuted: Boolean(message.isMuted),
          isDeafened: Boolean(message.isDeafened),
          voiceChannelId: this.voiceChannels.has(message.voiceChannelId) ? message.voiceChannelId : null,
          isStreaming: Boolean(message.isStreaming),
          streamDetails: message.streamDetails || null,
          joinedAt: Date.now(),
          lastSeen: Date.now()
        };

        if (!this.promoteConnection(senderPeerId, conn, memberInfo)) return true;

        // Se eu sou o Master, envio confirmação de PIN, lista de todos os membros e aviso aos outros membros
        if (this.isMaster) {
          conn?.send?.({ type: 'ROOM_PIN_ACCEPTED', roomId: this.roomId, roomKey: this.roomKey });
          conn?.send?.({
            type: 'ROOM_SYNC_ALL',
            roomId: this.roomId,
            roomKey: this.roomKey,
            members: this.getMembersList(),
            voiceChannels: [...this.voiceChannels.values()], voiceChannelsRevision: this.voiceChannelsRevision
          });

          this.broadcast({
            type: 'ROOM_MEMBER_JOINED',
            member: memberInfo
          }, senderPeerId);
        }

        this.emit('memberJoined', memberInfo);
        this.emit('membersUpdated', this.getMembersList());
        this.notifyState();
        return true;
      }

      case 'ROOM_PIN_REQUIRED': {
        this.emit('pinRequired', { error: message.error || 'PIN necessário para ingressar nesta sala.' });
        return true;
      }

      case 'ROOM_KEY_REQUIRED':
      case 'ROOM_JOIN_REJECTED': {
        this.emit('joinRejected', { error: message.error || 'Não foi possível ingressar nesta sala.' });
        return true;
      }

      case 'ROOM_PIN_ACCEPTED': {
        // The acceptance is authoritative only when it comes from the
        // deterministic room coordinator and through the pending connection.
        if (senderPeerId !== this.masterPeerId) {
          console.warn(`[RoomManager] ROOM_PIN_ACCEPTED rejeitado de remetente não coordenador: ${senderPeerId}`);
          return true;
        }

        if (this.roomKey && message.roomKey !== this.roomKey) {
          conn?.send?.({ type: 'ROOM_KEY_REQUIRED', error: 'Convite de sala inválido ou expirado.' });
          return true;
        }
        const pendingConn = this.pendingConnections.get(senderPeerId);
        const targetConn = conn || pendingConn;
        if (!targetConn) {
          console.warn(`[RoomManager] ROOM_PIN_ACCEPTED sem conexão válida: ${senderPeerId}`);
          return true;
        }
        if (!this.promoteConnection(senderPeerId, targetConn, { isMaster: true })) return true;
        if (!this.members.has(senderPeerId)) {
          const member = {
            peerId: senderPeerId,
            name: 'Host',
            isMaster: true,
            isMuted: false,
            isDeafened: false,
            isSpeaking: false,
            isStreaming: false,
            streamDetails: null,
            joinedAt: Date.now()
          };
          this.members.set(senderPeerId, member);
          this.emit('memberJoined', member);
          this.emit('membersUpdated', this.getMembersList());
        }
        this.emit('pinAccepted', { peerId: senderPeerId, roomId: message.roomId });
        this.notifyState();
        return true;
      }

      case 'ROOM_SYNC_ALL': {
        const knownMasterConnection = this.pendingConnections.get(senderPeerId) === conn ||
          (this.meshConnections.get(senderPeerId) === conn && this.authenticatedPeers.has(senderPeerId));
        if (senderPeerId !== this.masterPeerId || !knownMasterConnection) return true;
        if (this.roomKey && message.roomKey !== this.roomKey) {
          console.warn('[RoomManager] ROOM_SYNC_ALL rejeitado: chave da sala inválida.');
          return true;
        }
        // SEGURANÇA (A03): Apenas o Coordenador/Master oficial da sala pode enviar ROOM_SYNC_ALL
        if (senderPeerId !== this.masterPeerId) {
          console.warn(`[RoomManager] Tentativa de ROOM_SYNC_ALL rejeitada de remetente não autorizado: ${senderPeerId}`);
          return true;
        }

        if (message.voiceChannels) this.applyVoiceChannels(message.voiceChannels, message.voiceChannelsRevision);
        if (Array.isArray(message.members)) {
          const newlyActiveStreamers = [];
          message.members.forEach((m) => {
            if (m && isValidPeerId(m.peerId) && m.peerId !== this.myPeerId) {
              const prev = this.members.get(m.peerId);
              if (!prev && this.members.size >= MAX_ROOM_MEMBERS) return;
              const cleanName = typeof m.name === 'string' && m.name.trim() ? sanitizeText(m.name).slice(0, 30) : (prev ? prev.name : `Amigo ${m.peerId.slice(-4)}`);
              const updatedMember = {
                ...prev,
                ...m,
                peerId: m.peerId,
                name: cleanName,
                voiceChannelId: this.voiceChannels.has(m.voiceChannelId) ? m.voiceChannelId : null,
                clientSessionId: m.clientSessionId || (prev ? prev.clientSessionId : null),
                lastSeen: Date.now()
              };
              this.members.set(m.peerId, updatedMember);
              this.authenticatedPeers.add(m.peerId);

              // Se o membro já estiver transmitindo na sala, detecta para notificação do ingressante
              if (updatedMember.isStreaming && (!prev || !prev.isStreaming)) {
                newlyActiveStreamers.push(updatedMember);
              }
            }
          });
          this.emit('membersUpdated', this.getMembersList());
          newlyActiveStreamers.forEach((m) => {
            this.emit('streamPublished', { peerId: m.peerId, details: m.streamDetails, member: m });
          });
          this.notifyState();
        }
        return true;
      }

      case 'ROOM_MEMBER_JOINED': {
        const knownCoordinatorConnection = this.pendingConnections.get(senderPeerId) === conn ||
          (this.meshConnections.get(senderPeerId) === conn && this.authenticatedPeers.has(senderPeerId));
        if (senderPeerId !== this.masterPeerId || !knownCoordinatorConnection) return true;
        if (senderPeerId !== this.masterPeerId) {
          console.warn(`[RoomManager] ROOM_MEMBER_JOINED rejeitado de remetente não coordenador: ${senderPeerId}`);
          return true;
        }

        if (!this.authenticatedPeers.has(senderPeerId)) {
          if (!this.promoteConnection(senderPeerId, conn, { isMaster: true })) return true;
        }
        if (message.member && isValidPeerId(message.member.peerId) && message.member.peerId !== this.myPeerId) {
          if (!this.members.has(message.member.peerId) && this.members.size >= MAX_ROOM_MEMBERS) return true;
          const cleanName = typeof message.member.name === 'string' && message.member.name.trim() ? sanitizeText(message.member.name).slice(0, 30) : `Amigo ${message.member.peerId.slice(-4)}`;
          const safeMember = {
            ...message.member,
            name: cleanName,
            clientSessionId: message.member.clientSessionId || null,
            lastSeen: Date.now()
          };
          this.members.set(message.member.peerId, safeMember);
          this.authenticatedPeers.add(message.member.peerId);
          // Se havia uma conexão pendente deste membro aguardando confirmação do coordenador, promove-a agora
          const pendingConn = this.pendingConnections.get(message.member.peerId);
          if (pendingConn) {
            this.promoteConnection(message.member.peerId, pendingConn, safeMember);
          }
          this.emit('memberJoined', safeMember);
          if (safeMember.isStreaming) {
            this.emit('streamPublished', { peerId: safeMember.peerId, details: safeMember.streamDetails, member: safeMember });
          }
          this.emit('membersUpdated', this.getMembersList());
          this.notifyState();
        }
        return true;
      }

      case 'ROOM_MEMBER_AUTH': {
        if (message.roomId && sanitizeRoomId(message.roomId) !== this.roomId) return true;
        if (this.roomKey && message.roomKey !== this.roomKey) {
          conn?.send?.({ type: 'ROOM_KEY_REQUIRED', error: 'Convite de sala inválido ou expirado.' });
          return true;
        }
        if (!this.members.has(senderPeerId) || !this.pendingConnections.has(senderPeerId)) return true;
        if (this.promoteConnection(senderPeerId, conn, this.members.get(senderPeerId))) {
          conn?.send?.({ type: 'ROOM_MEMBER_AUTH_ACCEPTED', roomId: this.roomId, roomKey: this.roomKey });
        }
        return true;
      }

      case 'ROOM_MEMBER_AUTH_ACCEPTED': {
        if (message.roomId && sanitizeRoomId(message.roomId) !== this.roomId) return true;
        if (this.roomKey && message.roomKey !== this.roomKey) return true;
        if (senderPeerId === this.masterPeerId || this.members.has(senderPeerId)) {
          this.promoteConnection(senderPeerId, conn, this.members.get(senderPeerId));
        }
        return true;
      }

      case 'ROOM_MEMBER_LEFT': {
        // SEGURANÇA (A03): Apenas o próprio membro saindo ou o Master expulsando
        const leftId = senderPeerId === this.masterPeerId ? (message.peerId || senderPeerId) : senderPeerId;
        this.removeMember(leftId);
        return true;
      }

      case 'ROOM_STREAM_PUBLISHED': {
        // SEGURANÇA (A03): Apenas o próprio streamer publica sua stream, ou o Master retransmite
        const peerId = (senderPeerId === this.masterPeerId && message.peerId) ? message.peerId : senderPeerId;
        let member = this.members.get(peerId);
        if (!member) {
          member = {
            peerId,
            name: peerId === this.masterPeerId ? 'Host' : `Amigo ${peerId.slice(-4)}`,
            isStreaming: true,
            streamDetails: message.details || null
          };
          this.members.set(peerId, member);
        } else {
          member.isStreaming = true;
          member.streamDetails = message.details || null;
        }
        if (this.isMaster) {
          this.broadcast({
            type: 'ROOM_STREAM_PUBLISHED',
            peerId,
            details: member.streamDetails
          }, senderPeerId);
        }
        this.emit('streamPublished', { peerId, details: member.streamDetails, member });
        this.emit('membersUpdated', this.getMembersList());
        this.notifyState();
        return true;
      }

      case 'ROOM_STREAM_UNPUBLISHED': {
        // SEGURANÇA (A03): Apenas o próprio streamer despublica sua stream, ou o Master retransmite
        const peerId = (senderPeerId === this.masterPeerId && message.peerId) ? message.peerId : senderPeerId;
        let member = this.members.get(peerId);
        if (!member) {
          member = {
            peerId,
            name: peerId === this.masterPeerId ? 'Host' : `Amigo ${peerId.slice(-4)}`,
            isStreaming: false,
            streamDetails: null
          };
          this.members.set(peerId, member);
        } else {
          member.isStreaming = false;
          member.streamDetails = null;
        }
        if (this.isMaster) {
          this.broadcast({
            type: 'ROOM_STREAM_UNPUBLISHED',
            peerId
          }, senderPeerId);
        }
        this.emit('streamUnpublished', { peerId, member });
        this.emit('membersUpdated', this.getMembersList());
        this.notifyState();
        return true;
      }

      case 'ROOM_MEMBER_STATE_UPDATE': {
        // SEGURANÇA (A03): Um membro só pode atualizar seu próprio estado, ou o Master retransmite
        const targetPeerId = senderPeerId === this.masterPeerId ? (message.peerId || senderPeerId) : senderPeerId;
        const member = this.members.get(targetPeerId);
        if (member) {
          if (typeof message.isMuted === 'boolean') member.isMuted = message.isMuted;
          if (typeof message.isDeafened === 'boolean') member.isDeafened = message.isDeafened;
          if (typeof message.isSpeaking === 'boolean') member.isSpeaking = message.isSpeaking;
          if (message.voiceChannelId === null || this.voiceChannels.has(message.voiceChannelId)) member.voiceChannelId = message.voiceChannelId;
          if (this.isMaster) {
            this.broadcast({
              type: 'ROOM_MEMBER_STATE_UPDATE',
              peerId: targetPeerId,
              isMuted: member.isMuted,
              isDeafened: member.isDeafened,
              isSpeaking: member.isSpeaking,
              voiceChannelId: member.voiceChannelId ?? null
            }, senderPeerId);
          }
          this.emit('membersUpdated', this.getMembersList());
          this.notifyState();
        }
        return true;
      }

      case 'ROOM_HEARTBEAT': {
        const member = this.members.get(senderPeerId);
        if (member) {
          member.lastSeen = Date.now();
        }
        return true;
      }

      default:
        return false;
    }
  }
};
