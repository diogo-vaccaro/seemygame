/**
 * SeeMyGame - HandsManager (Levantar a Mão e Fila de Fala)
 * 
 * Gerenciador de fila ordenada para pedidos de fala e moderação de áudio:
 * - Sequência estrita definida pelo Coordenador (evita corrida de timestamps de clientes)
 * - Uma única entrada por participante na fila de espera
 * - Moderação visual e modo de áudio moderado (filtro em reprodução/playback)
 * - Concessão da palavra NUNCA liga remotamente microfone de convidado
 * - Limpeza automática ao desconectar ou sair da sala
 */

export class HandsManager {
  constructor(options = {}) {
    this.service = options.service || null;
    this.getLocalPeerId = options.getLocalPeerId || (() => 'me');
    this.getDisplayName = options.getDisplayName || (() => 'Jogador');
    this.isHost = typeof options.isHost === 'function' ? options.isHost : () => Boolean(options.isHost);
    this.getCoordinatorPeerId = options.getCoordinatorPeerId || (() => null);
    this.getIsReadonly = typeof options.getIsReadonly === 'function'
      ? options.getIsReadonly
      : () => Boolean(options.isReadonly);

    this.queue = []; // Array<{ peerId, displayName, sequence, requestedAt }>
    this.currentSpeakerPeerId = null;
    this.currentSpeakerName = null;
    this.policy = 'open'; // 'open' | 'moderated'
    this.sequenceCounter = 0;
    this.listeners = new Set();

    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  setService(service) {
    this.service = service;
    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  _bindWithService(service) {
    service.registerFeature('hands', {
      applyProposal: (payload, meta) => this._applyProposalOnHost(payload, meta),
      applyConfirm: (payload, meta) => this._applyConfirmOnClient(payload, meta),
      getSnapshot: () => this.getSnapshot(),
      applySnapshot: (snapshot) => this.applySnapshot(snapshot)
    });
  }

  _applyProposalOnHost(payload, { authorPeerId }) {
    const { action } = payload;
    const now = Date.now();

    switch (action) {
      case 'request_hand': {
        // Verifica se já está na fila
        if (this.queue.some(item => item.peerId === authorPeerId)) {
          return { success: true, payload: { action: 'noop' } };
        }

        this.sequenceCounter++;
        const entry = {
          peerId: authorPeerId,
          displayName: String(payload.displayName || 'Jogador').slice(0, 32),
          sequence: this.sequenceCounter,
          requestedAt: now
        };

        this.queue.push(entry);
        return { success: true, payload: { action: 'queue_updated', queue: [...this.queue] } };
      }

      case 'cancel_hand': {
        const targetPeerId = payload.peerId || authorPeerId;
        // Participante comum só pode cancelar o próprio pedido
        if (targetPeerId !== authorPeerId && !this.isHost()) {
          return { success: false, reason: 'unauthorized' };
        }

        const initialLen = this.queue.length;
        this.queue = this.queue.filter(item => item.peerId !== targetPeerId);
        if (this.queue.length !== initialLen) {
          return { success: true, payload: { action: 'queue_updated', queue: [...this.queue] } };
        }
        return { success: true, payload: { action: 'noop' } };
      }

      case 'grant_speaker': {
        // Concessão de fala é exclusiva do host/coordenador
        const isAuthorHost = authorPeerId === this.getCoordinatorPeerId() || (this.isHost() && authorPeerId === this.getLocalPeerId());
        if (!isAuthorHost) {
          return { success: false, reason: 'unauthorized_only_host' };
        }

        const targetPeerId = String(payload.peerId || '');
        if (!targetPeerId) return { success: false, reason: 'invalid_peer' };

        // Remove da fila de espera se estiver nela
        this.queue = this.queue.filter(item => item.peerId !== targetPeerId);
        this.currentSpeakerPeerId = targetPeerId;
        this.currentSpeakerName = String(payload.displayName || 'Orador').slice(0, 32);

        return {
          success: true,
          payload: {
            action: 'speaker_granted',
            speakerPeerId: this.currentSpeakerPeerId,
            speakerName: this.currentSpeakerName,
            queue: [...this.queue]
          }
        };
      }

      case 'revoke_speaker': {
        const isAuthorHost = authorPeerId === this.getCoordinatorPeerId() || (this.isHost() && authorPeerId === this.getLocalPeerId());
        if (!isAuthorHost && authorPeerId !== this.currentSpeakerPeerId) {
          return { success: false, reason: 'unauthorized' };
        }

        this.currentSpeakerPeerId = null;
        this.currentSpeakerName = null;
        return {
          success: true,
          payload: { action: 'speaker_revoked', queue: [...this.queue] }
        };
      }

      case 'next_speaker': {
        const isAuthorHost = authorPeerId === this.getCoordinatorPeerId() || (this.isHost() && authorPeerId === this.getLocalPeerId());
        if (!isAuthorHost) {
          return { success: false, reason: 'unauthorized_only_host' };
        }

        if (this.queue.length > 0) {
          const next = this.queue.shift();
          this.currentSpeakerPeerId = next.peerId;
          this.currentSpeakerName = next.displayName;
          return {
            success: true,
            payload: {
              action: 'speaker_granted',
              speakerPeerId: this.currentSpeakerPeerId,
              speakerName: this.currentSpeakerName,
              queue: [...this.queue]
            }
          };
        } else {
          this.currentSpeakerPeerId = null;
          this.currentSpeakerName = null;
          return {
            success: true,
            payload: { action: 'speaker_revoked', queue: [] }
          };
        }
      }

      case 'set_policy': {
        const isAuthorHost = authorPeerId === this.getCoordinatorPeerId() || (this.isHost() && authorPeerId === this.getLocalPeerId());
        if (!isAuthorHost) {
          return { success: false, reason: 'unauthorized_only_host' };
        }

        const policy = payload.policy === 'moderated' ? 'moderated' : 'open';
        this.policy = policy;
        return {
          success: true,
          payload: { action: 'policy_updated', policy: this.policy }
        };
      }

      default:
        return { success: false, reason: 'unknown_action' };
    }
  }

  _applyConfirmOnClient(payload) {
    if (!payload || !payload.action) return;
    const { action } = payload;

    switch (action) {
      case 'queue_updated': {
        if (Array.isArray(payload.queue)) {
          this.queue = [...payload.queue];
        }
        break;
      }
      case 'speaker_granted': {
        this.currentSpeakerPeerId = payload.speakerPeerId || null;
        this.currentSpeakerName = payload.speakerName || null;
        if (Array.isArray(payload.queue)) {
          this.queue = [...payload.queue];
        }
        break;
      }
      case 'speaker_revoked': {
        this.currentSpeakerPeerId = null;
        this.currentSpeakerName = null;
        if (Array.isArray(payload.queue)) {
          this.queue = [...payload.queue];
        }
        break;
      }
      case 'policy_updated': {
        this.policy = payload.policy || 'open';
        break;
      }
    }

    this._notify();
  }

  getSnapshot() {
    return {
      queue: [...this.queue],
      currentSpeakerPeerId: this.currentSpeakerPeerId,
      currentSpeakerName: this.currentSpeakerName,
      policy: this.policy,
      sequenceCounter: this.sequenceCounter
    };
  }

  applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (Array.isArray(snapshot.queue)) {
      this.queue = [...snapshot.queue];
    }
    this.currentSpeakerPeerId = snapshot.currentSpeakerPeerId || null;
    this.currentSpeakerName = snapshot.currentSpeakerName || null;
    this.policy = snapshot.policy === 'moderated' ? 'moderated' : 'open';
    if (Number.isSafeInteger(snapshot.sequenceCounter)) {
      this.sequenceCounter = snapshot.sequenceCounter;
    }
    this._notify();
  }

  async requestHand() {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = {
      action: 'request_hand',
      displayName: this.getDisplayName()
    };

    if (this.service) {
      return this.service.propose('hands', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async cancelHand(peerId = null) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = {
      action: 'cancel_hand',
      peerId: peerId || this.getLocalPeerId()
    };

    if (this.service) {
      return this.service.propose('hands', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async grantSpeaker(peerId, displayName = null) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = {
      action: 'grant_speaker',
      peerId,
      displayName: displayName || 'Jogador'
    };

    if (this.service) {
      return this.service.propose('hands', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async revokeSpeaker() {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = { action: 'revoke_speaker' };

    if (this.service) {
      return this.service.propose('hands', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async nextSpeaker() {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = { action: 'next_speaker' };

    if (this.service) {
      return this.service.propose('hands', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async setPolicy(policy) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = { action: 'set_policy', policy };

    if (this.service) {
      return this.service.propose('hands', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  hasRequestedHand(peerId = null) {
    const id = peerId || this.getLocalPeerId();
    return this.queue.some(item => item.peerId === id);
  }

  isCurrentSpeaker(peerId = null) {
    const id = peerId || this.getLocalPeerId();
    return this.currentSpeakerPeerId === id;
  }

  /**
   * Avalia se o áudio de um determinado participante deve ser audível neste receptor.
   * No modo moderado ('moderated'), somente o coordenador/host e o orador atual
   * têm áudio reproduzido. No modo aberto ('open'), todos são audíveis.
   */
  isPeerAudible(peerId) {
    if (!peerId) return true;
    if (this.policy !== 'moderated') return true;

    const coordinator = this.getCoordinatorPeerId();
    // Host e Coordenador sempre audíveis
    if (peerId === coordinator || (this.isHost() && peerId === this.getLocalPeerId())) {
      return true;
    }
    // Orador atual é audível
    if (peerId === this.currentSpeakerPeerId) {
      return true;
    }

    return false;
  }

  handlePeerDisconnected(peerId) {
    if (!peerId) return;
    let changed = false;

    const initialLen = this.queue.length;
    this.queue = this.queue.filter(item => item.peerId !== peerId);
    if (this.queue.length !== initialLen) changed = true;

    if (this.currentSpeakerPeerId === peerId) {
      this.currentSpeakerPeerId = null;
      this.currentSpeakerName = null;
      changed = true;
    }

    if (changed && this.isHost()) {
      this.service?.broadcastFullSync();
      this._notify();
    }
  }

  getQueue() {
    return [...this.queue];
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notify() {
    const state = {
      queue: [...this.queue],
      currentSpeakerPeerId: this.currentSpeakerPeerId,
      currentSpeakerName: this.currentSpeakerName,
      policy: this.policy
    };
    this.listeners.forEach(fn => {
      try { fn(state); } catch (_) {}
    });
  }

  dispose() {
    this.queue = [];
    this.currentSpeakerPeerId = null;
    this.currentSpeakerName = null;
    this.listeners.clear();
  }
}
