/**
 * SeeMyGame - Gerenciador de Salas P2P (Room-First Architecture)
 * 
 * Permite que múltiplos participantes entrem na mesma sala (Full Mesh P2P),
 * compartilhem presença, chat de voz e transmitam telas sob demanda.
 */

import { isValidPeerId } from './ui.js';

export const ROOM_PREFIX = 'smg_room_';
export const MASTER_SUFFIX = '_host';
export const MAX_ROOM_MEMBERS = 16;
export const MAX_PENDING_ROOM_CONNECTIONS = 16;
export const MAX_ROOM_MESSAGE_BYTES = 64 * 1024;
export const ROOM_HEARTBEAT_INTERVAL_MS = 4000;
export const ROOM_MEMBER_TIMEOUT_MS = 30000;

/**
 * Sanitiza o ID da sala para garantir caracteres seguros
 * @param {string} rawId 
 * @returns {string}
 */
export function sanitizeRoomId(rawId) {
  if (!rawId || typeof rawId !== 'string') return 'general';
  const clean = rawId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  return clean.slice(0, 32) || 'general';
}

export function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Gera o Peer ID fixo do Coordenador/Master da sala
 * @param {string} roomId 
 * @returns {string}
 */
function hashRoomKey(roomId, roomKey) {
  const value = `${sanitizeRoomId(roomId)}|${String(roomKey)}`;
  const seeds = [2166136261, 2246822519, 3266489917, 668265263];
  return seeds.map((seed) => {
    let hash = seed;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');
}

export function getRoomMasterPeerId(roomId, roomKey = null) {
  const sanitized = sanitizeRoomId(roomId);
  if (typeof roomKey === 'string' && roomKey.length >= 16) {
    return `${ROOM_PREFIX}${sanitized}_${hashRoomKey(sanitized, roomKey)}${MASTER_SUFFIX}`.slice(0, 64);
  }
  return `${ROOM_PREFIX}${sanitized}${MASTER_SUFFIX}`;
}

function isWithinMessageLimit(payload) {
  try {
    const serialized = JSON.stringify(payload);
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(serialized).length <= MAX_ROOM_MESSAGE_BYTES;
    }
    return serialized.length <= MAX_ROOM_MESSAGE_BYTES;
  } catch (error) {
    return false;
  }
}

export class RoomManager {
  constructor({ roomId = 'general', userName = null, clientSessionId = null, roomPin = null, roomKey = null, onStateChange } = {}) {
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
      joinRejected: new Set()
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

  /**
   * Inicializa a entrada na sala com o Peer ID do usuário
   * @param {string} peerId
   * @param {boolean} [isMaster=false] 
   */
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

  /**
   * Registra uma conexão DataConnection estabelecida com outro membro da sala
   * @param {string} peerId
   * @param {Object} conn 
   * @param {Object} [initialInfo] 
   */
  registerConnection(peerId, conn, initialInfo = {}) {
    if (!isValidPeerId(peerId) || peerId === this.myPeerId) return false;
    if (!this.members.has(peerId) && this.members.size >= MAX_ROOM_MEMBERS) return false;

    // Every room connection starts pending. Public rooms still need the room
    // admission handshake; otherwise a peer could connect directly to a
    // guest and bypass the coordinator's membership list.
    if (!this.authenticatedPeers.has(peerId)) {
      if (!this.pendingConnections.has(peerId) && this.pendingConnections.size >= MAX_PENDING_ROOM_CONNECTIONS) return false;
      this.pendingConnections.set(peerId, conn);
      return true;
    }

    return this.promoteConnection(peerId, conn, initialInfo);
  }

  promoteConnection(peerId, conn, initialInfo = {}) {
    if (!isValidPeerId(peerId) || peerId === this.myPeerId || !conn) return false;
    const pendingConn = this.pendingConnections.get(peerId);
    if (pendingConn && pendingConn !== conn) return false;
    if (!this.members.has(peerId) && this.members.size >= MAX_ROOM_MEMBERS) return false;

    this.authenticatedPeers.add(peerId);
    this.pendingConnections.delete(peerId);
    this.meshConnections.set(peerId, conn || pendingConn);

    if (!this.members.has(peerId)) {
      const newMember = {
        peerId,
        name: typeof initialInfo.name === 'string' && initialInfo.name.trim() ? sanitizeText(initialInfo.name).slice(0, 30) : `Amigo ${peerId.slice(-4)}`,
        clientSessionId: initialInfo.clientSessionId || null,
        isMaster: Boolean(initialInfo.isMaster),
        isMuted: Boolean(initialInfo.isMuted),
        isDeafened: Boolean(initialInfo.isDeafened),
        isSpeaking: false,
        isStreaming: Boolean(initialInfo.isStreaming),
        streamDetails: initialInfo.streamDetails || null,
        joinedAt: initialInfo.joinedAt || Date.now(),
        lastSeen: Date.now()
      };
      this.members.set(peerId, newMember);
      this.emit('memberJoined', newMember);
      this.emit('membersUpdated', this.getMembersList());
      this.notifyState();
    } else {
      const existing = this.members.get(peerId);
      existing.lastSeen = Date.now();
      if (initialInfo.name && initialInfo.name.trim()) {
        existing.name = sanitizeText(initialInfo.name).slice(0, 30);
      }
      if (initialInfo.clientSessionId) {
        existing.clientSessionId = initialInfo.clientSessionId;
      }
    }
    return true;
  }

  /**
   * Verifica se um peer está devidamente autenticado/autorizado na sala
   * @param {string} peerId
   * @returns {boolean}
   */
  isPeerAuthorized(peerId) {
    if (peerId === this.myPeerId) return true;
    return this.authenticatedPeers.has(peerId);
  }

  /**
   * Remove conexão e membro da sala
   * @param {string} peerId 
   */
  removeMember(peerId) {
    if (!peerId) return;
    if (peerId === this.myPeerId) {
      console.warn(`[RoomManager] Bloqueada tentativa de remover o próprio usuário local: ${peerId}`);
      return;
    }

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
  }

  /**
   * Processa mensagens de protocolo da sala recebidas via DataConnection
   * @param {string} senderPeerId 
   * @param {Object} message 
   * @param {Object} conn 
   * @returns {boolean} Retorna true se a mensagem foi tratada pelo protocolo da sala
   */
  handleRoomMessage(senderPeerId, message, conn) {
    if (!message || typeof message !== 'object') return false;

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
      'ROOM_HEARTBEAT'
    ].includes(message.type);
    if (isJoinOrAuthMessage && message.roomId && sanitizeRoomId(message.roomId) !== this.roomId) return true;
    if (isJoinOrAuthMessage && !this.authenticatedPeers.has(senderPeerId) &&
        !['ROOM_JOIN_REQUEST', 'ROOM_SYNC_ALL', 'ROOM_MEMBER_AUTH', 'ROOM_MEMBER_AUTH_ACCEPTED', 'ROOM_PIN_REQUIRED', 'ROOM_PIN_ACCEPTED', 'ROOM_KEY_REQUIRED', 'ROOM_JOIN_REJECTED'].includes(message.type)) {
      return true;
    }
    if (!isJoinOrAuthMessage && !this.authenticatedPeers.has(senderPeerId)) {
      console.warn(`[RoomManager] Mensagem de peer não autenticado rejeitada: ${senderPeerId}`);
      return true;
    }

    const senderMember = this.members.get(senderPeerId);
    if (senderMember) {
      senderMember.lastSeen = Date.now();
    }

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
          const providedPin = message.pin ? String(message.pin).trim() : '';
          if (providedPin !== this.roomPin) {
            conn?.send?.({ type: 'ROOM_PIN_REQUIRED', error: 'PIN incorreto para esta sala.' });
            // Remove qualquer estado pendente ou prévio
            if (this.pendingConnections.get(senderPeerId) === conn) {
              this.pendingConnections.delete(senderPeerId);
            }
            return true;
          }
        }

        const cleanName = typeof message.name === 'string' && message.name.trim()
          ? sanitizeText(message.name).trim().slice(0, 30)
          : `Amigo ${senderPeerId.slice(-4)}`;

        const isGenericName = ['você', 'voce', 'amigo', 'host', 'visitante', 'guest'].includes(cleanName.toLowerCase()) || cleanName.startsWith('Amigo ');

        // Se um usuário com a mesma sessão de aba (F5/relog) ou mesmo nome customizado não-genérico relogou com novo ID, limpa a sessão antiga
        for (const [existingPeerId, existingMember] of this.members.entries()) {
          if (existingPeerId === this.myPeerId || existingPeerId === senderPeerId) continue;

          const isSameSession = Boolean(message.clientSessionId && existingMember.clientSessionId && existingMember.clientSessionId === message.clientSessionId);
          const isSameCustomName = Boolean(!isGenericName && cleanName.length >= 3 && existingMember.name?.toLowerCase() === cleanName.toLowerCase());

          if (isSameSession || isSameCustomName) {
            console.log(`[RoomManager] Relog detectado para "${cleanName}" (${senderPeerId}). Purgando peer fantasma anterior (${existingPeerId}).`);
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
            members: this.getMembersList()
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
        if (!pendingConn || (conn && pendingConn !== conn)) {
          console.warn(`[RoomManager] ROOM_PIN_ACCEPTED sem conexão pendente válida: ${senderPeerId}`);
          return true;
        }
        if (!this.promoteConnection(senderPeerId, pendingConn || conn, { isMaster: true })) return true;
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
        const member = this.members.get(peerId);
        if (member) {
          member.isStreaming = true;
          member.streamDetails = message.details || null;
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
        }
        return true;
      }

      case 'ROOM_STREAM_UNPUBLISHED': {
        // SEGURANÇA (A03): Apenas o próprio streamer despublica sua stream, ou o Master retransmite
        const peerId = (senderPeerId === this.masterPeerId && message.peerId) ? message.peerId : senderPeerId;
        const member = this.members.get(peerId);
        if (member) {
          member.isStreaming = false;
          member.streamDetails = null;
          if (this.isMaster) {
            this.broadcast({
              type: 'ROOM_STREAM_UNPUBLISHED',
              peerId
            }, senderPeerId);
          }
          this.emit('streamUnpublished', { peerId, member });
          this.emit('membersUpdated', this.getMembersList());
          this.notifyState();
        }
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
          if (this.isMaster) {
            this.broadcast({
              type: 'ROOM_MEMBER_STATE_UPDATE',
              peerId: targetPeerId,
              isMuted: member.isMuted,
              isDeafened: member.isDeafened,
              isSpeaking: member.isSpeaking
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

  /**
   * Atualiza o estado da transmissão local ("Go Live")
   * @param {boolean} isStreaming 
   * @param {Object} [details] 
   */
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

  /**
   * Atualiza o estado de voz local do usuário (Mute, Deafen, Speaking)
   * @param {Object} state 
   */
  setLocalVoiceState({ isMuted, isDeafened, isSpeaking } = {}) {
    const selfMember = this.members.get(this.myPeerId);
    if (!selfMember) return;

    if (typeof isMuted === 'boolean') selfMember.isMuted = isMuted;
    if (typeof isDeafened === 'boolean') selfMember.isDeafened = isDeafened;
    if (typeof isSpeaking === 'boolean') selfMember.isSpeaking = isSpeaking;

    this.broadcast({
      type: 'ROOM_MEMBER_STATE_UPDATE',
      peerId: this.myPeerId,
      isMuted: selfMember.isMuted,
      isDeafened: selfMember.isDeafened,
      isSpeaking: selfMember.isSpeaking
    });

    this.emit('membersUpdated', this.getMembersList());
    this.notifyState();
  }

  /**
   * Envia uma mensagem via broadcast para todas as conexões ativas na sala
   * @param {Object} payload 
   * @param {string} [excludePeerId] 
   */
  broadcast(payload, excludePeerId = null) {
    if (!isWithinMessageLimit(payload)) return false;
    this.meshConnections.forEach((conn, peerId) => {
      if (peerId !== excludePeerId && conn && conn.open && this.isPeerAuthorized(peerId)) {
        try {
          conn.send(payload);
        } catch (e) {
          console.warn(`[RoomManager] Erro ao enviar mensagem para ${peerId}:`, e);
        }
      }
    });
    return true;
  }

  /**
   * Retorna a lista completa de membros presentes na sala
   * @returns {Array<Object>}
   */
  getMembersList() {
    return Array.from(this.members.values());
  }

  /**
   * Retorna os membros que estão transmitindo tela ativamente no momento
   * @returns {Array<Object>}
   */
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
    this.members.clear();
    this.isInRoom = false;
    this.emit('roomClosed', { roomId: this.roomId });
    this.notifyState();
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
}
