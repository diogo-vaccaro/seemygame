/**
 * SeeMyGame - SharedToolsService
 * 
 * Fundação comum para ferramentas colaborativas em tempo real na sala:
 * - Ciclo Proposta -> Validação no Coordenador -> Confirmação -> Snapshot
 * - Verificação de capacidades e proteção estrita contra escrita de espectadores somente-leitura
 * - Versionamento por entidade/recurso associado ao roomEpoch da sessão
 * - Deduplicação de operações por opId e detecção de lacunas de revisão
 * - Limpeza total e ausência de efeitos colaterais na importação
 */

export class SharedToolsService {
  constructor(options = {}) {
    this._isHostResolver = typeof options.isHost === 'function' ? options.isHost : null;
    this._isHost = typeof options.isHost === 'boolean' ? options.isHost : false;
    this.getLocalPeerId = options.getLocalPeerId || (() => 'me');
    this.getDisplayName = options.getDisplayName || (() => 'Jogador');
    this.getCoordinatorPeerId = options.getCoordinatorPeerId || (() => null);
    this.getIsReadonly = typeof options.isReadonly === 'function'
      ? options.isReadonly
      : () => Boolean(options.isReadonly);
    this.broadcast = options.broadcast || null;
    this.sendTo = options.sendTo || null;
    this.roomEpoch = String(options.roomEpoch || 'default-epoch');

    this.features = new Map();
    this.revisions = new Map();
    this.processedOps = new Map(); // opId -> { result, revision, timestamp }
    this.pendingOps = new Map(); // opId -> { feature, entityId, payload, timestamp, resolve, reject }
    this.maxHistoryOpIds = Number(options.maxHistoryOpIds) || 200;

    this.isCoordinatorOnline = true;
    this.listeners = new Set();
    this._disposed = false;
  }

  get isHost() {
    if (this._disposed) return false;
    if (typeof this._isHostResolver === 'function') {
      try {
        return Boolean(this._isHostResolver());
      } catch (_) {
        return false;
      }
    }
    return Boolean(this._isHost);
  }

  setIsHost(val) {
    if (typeof val === 'function') {
      this._isHostResolver = val;
    } else {
      this._isHostResolver = null;
      this._isHost = Boolean(val);
    }
  }

  setBroadcast(fn) {
    this.broadcast = fn;
  }

  setSendTo(fn) {
    this.sendTo = fn;
  }

  setRoomEpoch(epoch) {
    this.roomEpoch = String(epoch || 'default-epoch');
  }

  setCoordinatorOnline(online) {
    const next = Boolean(online);
    if (this.isCoordinatorOnline !== next) {
      this.isCoordinatorOnline = next;
      this._notifyChange('coordinator-status', { online: next });
    }
  }

  registerFeature(featureName, handlers = {}) {
    if (!featureName || typeof featureName !== 'string') {
      throw new TypeError('[SharedToolsService] featureName deve ser uma string não vazia.');
    }
    this.features.set(featureName, {
      applyProposal: handlers.applyProposal || (() => ({ success: true })),
      applyConfirm: handlers.applyConfirm || (() => {}),
      getSnapshot: handlers.getSnapshot || (() => null),
      applySnapshot: handlers.applySnapshot || (() => {}),
      checkCapability: handlers.checkCapability || null,
      maxEntityBytes: handlers.maxEntityBytes || 65536,
      maxAggregateBytes: handlers.maxAggregateBytes || 131072
    });
    if (!this.revisions.has(featureName)) {
      this.revisions.set(featureName, 0);
    }
  }

  getRevision(featureName) {
    return this.revisions.get(featureName) || 0;
  }

  setRevision(featureName, revision) {
    const rev = Math.max(0, Number(revision) || 0);
    this.revisions.set(featureName, rev);
  }

  checkPermission(featureName, peerId, role, isReadonly = false, actionType = 'edit') {
    if (isReadonly) {
      return actionType === 'read';
    }
    if (actionType === 'read') return true;

    // Ações de moderação administrativa exigem coordenador/host
    if (actionType === 'manage' || actionType === 'policy') {
      return this.isHost || peerId === this.getCoordinatorPeerId();
    }

    return true;
  }

  async propose(featureName, { entityId = null, baseRevision = null, payload = {}, opId = null } = {}) {
    if (this._disposed) {
      return { success: false, reason: 'disposed' };
    }
    if (this.getIsReadonly()) {
      return { success: false, reason: 'readonly_not_permitted' };
    }
    if (!this.isHost && !this.isCoordinatorOnline) {
      return { success: false, reason: 'coordinator_offline' };
    }

    const feature = this.features.get(featureName);
    if (!feature) {
      return { success: false, reason: 'unknown_feature' };
    }

    const effectiveOpId = opId || `op_${this.getLocalPeerId()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const effectiveBaseRev = baseRevision !== null && baseRevision !== undefined
      ? Number(baseRevision)
      : this.getRevision(featureName);

    // Se sou o host coordenador, aplico diretamente
    if (this.isHost) {
      return this._handleProposalAsHost({
        type: 'TOOL_PROPOSAL',
        feature: featureName,
        opId: effectiveOpId,
        entityId,
        baseRevision: effectiveBaseRev,
        payload,
        senderPeerId: this.getLocalPeerId(),
        roomEpoch: this.roomEpoch
      });
    }

    // Se sou convidado, envio TOOL_PROPOSAL ao coordenador e retorno Promise com timeout
    const coordinatorPeerId = this.getCoordinatorPeerId();
    const proposalMsg = {
      type: 'TOOL_PROPOSAL',
      feature: featureName,
      opId: effectiveOpId,
      entityId,
      baseRevision: effectiveBaseRev,
      payload,
      senderPeerId: this.getLocalPeerId(),
      roomEpoch: this.roomEpoch
    };

    return new Promise((resolve) => {
      const timeoutTimer = setTimeout(() => {
        if (this.pendingOps.has(effectiveOpId)) {
          this.pendingOps.delete(effectiveOpId);
          resolve({ success: false, reason: 'timeout', opId: effectiveOpId });
        }
      }, 7000);

      this.pendingOps.set(effectiveOpId, {
        feature: featureName,
        entityId,
        payload,
        resolve: (val) => {
          clearTimeout(timeoutTimer);
          resolve(val);
        }
      });

      if (this.sendTo && coordinatorPeerId) {
        this.sendTo(coordinatorPeerId, proposalMsg);
      } else if (this.broadcast) {
        this.broadcast(proposalMsg);
      } else {
        clearTimeout(timeoutTimer);
        this.pendingOps.delete(effectiveOpId);
        resolve({ success: false, reason: 'no_transport' });
      }
    });
  }

  _handleProposalAsHost(message, conn = null) {
    const { feature: featureName, opId, entityId, baseRevision, payload, senderPeerId, roomEpoch } = message;

    if (roomEpoch && roomEpoch !== this.roomEpoch) {
      return { success: false, reason: 'epoch_mismatch' };
    }

    const feature = this.features.get(featureName);
    if (!feature) {
      return { success: false, reason: 'unknown_feature' };
    }

    // Deduplicação idempotente: se já processou esse opId, retorna confirmação gravada
    if (this.processedOps.has(opId)) {
      const cached = this.processedOps.get(opId);
      const confirmMsg = {
        type: 'TOOL_CONFIRM',
        feature: featureName,
        opId,
        entityId,
        revision: cached.revision,
        authorPeerId: cached.authorPeerId,
        payload: cached.payload,
        timestamp: cached.timestamp,
        roomEpoch: this.roomEpoch
      };
      if (conn?.send) conn.send(confirmMsg);
      else if (this.broadcast) this.broadcast(confirmMsg);
      return { success: true, duplicated: true, revision: cached.revision };
    }

    // Guarda de permissão / readonly
    const isPeerReadonly = Boolean(conn?.metadata?.role === 'readonly-viewer' || conn?.metadata?.role === 'readonly');
    const actionType = payload?.__actionType || 'edit';
    if (!this.checkPermission(featureName, senderPeerId, conn?.metadata?.role, isPeerReadonly, actionType)) {
      const rejectMsg = {
        type: 'TOOL_REJECT',
        feature: featureName,
        opId,
        reason: isPeerReadonly ? 'readonly_not_permitted' : 'unauthorized',
        currentRevision: this.getRevision(featureName),
        roomEpoch: this.roomEpoch
      };
      if (conn?.send) conn.send(rejectMsg);
      return { success: false, reason: rejectMsg.reason };
    }

    // Validação de concorrência / revisão estrita se requerida pelo payload
    const currentRev = this.getRevision(featureName);
    if (payload?.__requireExactRevision && baseRevision !== null && baseRevision !== currentRev) {
      const rejectMsg = {
        type: 'TOOL_REJECT',
        feature: featureName,
        opId,
        reason: 'conflict',
        currentRevision: currentRev,
        snapshot: feature.getSnapshot(),
        roomEpoch: this.roomEpoch
      };
      if (conn?.send) conn.send(rejectMsg);
      return { success: false, reason: 'conflict' };
    }

    // Aplicação da operação no estado do recurso
    let applicationResult = null;
    try {
      applicationResult = feature.applyProposal(payload, {
        authorPeerId: senderPeerId,
        entityId,
        baseRevision,
        isHost: true
      });
    } catch (err) {
      applicationResult = { success: false, error: err.message };
    }

    if (!applicationResult || applicationResult.success === false) {
      const rejectMsg = {
        type: 'TOOL_REJECT',
        feature: featureName,
        opId,
        reason: applicationResult?.reason || 'validation_failed',
        currentRevision: currentRev,
        snapshot: feature.getSnapshot(),
        roomEpoch: this.roomEpoch
      };
      if (conn?.send) conn.send(rejectMsg);
      return { success: false, reason: rejectMsg.reason };
    }

    const nextRev = currentRev + 1;
    this.setRevision(featureName, nextRev);

    const resultingPayload = applicationResult.payload !== undefined ? applicationResult.payload : payload;
    const confirmData = {
      authorPeerId: senderPeerId,
      revision: nextRev,
      payload: resultingPayload,
      timestamp: Date.now()
    };

    // Registrar no histórico de idempotência
    this._recordProcessedOp(opId, confirmData);

    const confirmMsg = {
      type: 'TOOL_CONFIRM',
      feature: featureName,
      opId,
      entityId,
      revision: nextRev,
      authorPeerId: senderPeerId,
      payload: resultingPayload,
      timestamp: confirmData.timestamp,
      roomEpoch: this.roomEpoch
    };

    if (this.broadcast) {
      this.broadcast(confirmMsg);
    }

    this._notifyChange(featureName, { action: 'confirm', revision: nextRev, entityId });

    // Se a proposta foi local (host), resolve pendingOps se houver
    if (this.pendingOps.has(opId)) {
      const p = this.pendingOps.get(opId);
      this.pendingOps.delete(opId);
      p.resolve({ success: true, revision: nextRev, payload: resultingPayload });
    }

    return { success: true, revision: nextRev, payload: resultingPayload };
  }

  _recordProcessedOp(opId, confirmData) {
    this.processedOps.set(opId, confirmData);
    if (this.processedOps.size > this.maxHistoryOpIds) {
      const firstKey = this.processedOps.keys().next().value;
      if (firstKey) this.processedOps.delete(firstKey);
    }
  }

  handleRemoteMessage(data, senderPeerId = null, conn = null) {
    if (this._disposed || !data || typeof data !== 'object') return false;

    // Verificar roomEpoch se fornecido na mensagem
    if (data.roomEpoch && data.roomEpoch !== this.roomEpoch) {
      return false;
    }

    const peerId = senderPeerId || conn?.peer || data.senderPeerId || 'unknown';

    switch (data.type) {
      case 'TOOL_PROPOSAL': {
        if (!this.isHost) return false;
        this._handleProposalAsHost(data, conn);
        return true;
      }

      case 'TOOL_CONFIRM': {
        const { feature: featureName, opId, entityId, revision, authorPeerId, payload } = data;
        const feature = this.features.get(featureName);
        if (!feature) return false;

        const currentRev = this.getRevision(featureName);
        const incomingRev = Number(revision) || 0;

        // Se houver lacuna de revisão no cliente (perda de mensagens intermediárias), requisita snapshot
        if (!this.isHost && incomingRev > currentRev + 1) {
          this.requestSync(featureName);
        }

        try {
          feature.applyConfirm(payload, {
            authorPeerId,
            entityId,
            revision: incomingRev,
            isHost: this.isHost
          });
        } catch (_) {}

        if (incomingRev >= currentRev) {
          this.setRevision(featureName, incomingRev);
        }

        if (this.pendingOps.has(opId)) {
          const p = this.pendingOps.get(opId);
          this.pendingOps.delete(opId);
          p.resolve({ success: true, revision: incomingRev, payload });
        }

        this._notifyChange(featureName, { action: 'confirm', revision: incomingRev, entityId });
        return true;
      }

      case 'TOOL_REJECT': {
        const { feature: featureName, opId, reason, currentRevision, snapshot } = data;
        const feature = this.features.get(featureName);

        if (snapshot && feature?.applySnapshot) {
          try {
            feature.applySnapshot(snapshot, { revision: currentRevision });
            if (currentRevision) this.setRevision(featureName, currentRevision);
          } catch (_) {}
        }

        if (this.pendingOps.has(opId)) {
          const p = this.pendingOps.get(opId);
          this.pendingOps.delete(opId);
          p.resolve({ success: false, reason, currentRevision, snapshot });
        }

        this._notifyChange(featureName, { action: 'reject', reason, opId });
        return true;
      }

      case 'TOOL_REQUEST_SYNC': {
        if (!this.isHost) return false;
        const { feature: featureName } = data;
        const feature = this.features.get(featureName);
        if (!feature) return false;

        const syncMsg = {
          type: 'TOOL_SYNC',
          feature: featureName,
          revision: this.getRevision(featureName),
          data: feature.getSnapshot ? feature.getSnapshot() : null,
          roomEpoch: this.roomEpoch
        };

        if (conn?.send) conn.send(syncMsg);
        else if (this.broadcast) this.broadcast(syncMsg);
        return true;
      }

      case 'TOOL_SYNC': {
        const { feature: featureName, revision, data: snapshotData } = data;
        const coordinator = this.getCoordinatorPeerId();
        // Snapshots só são autoritativos vindos do coordenador
        if (!this.isHost && coordinator && peerId !== coordinator) {
          return false;
        }

        const feature = this.features.get(featureName);
        if (!feature) return false;

        const rev = Number(revision) || 0;
        if (feature.applySnapshot && snapshotData !== undefined) {
          try {
            feature.applySnapshot(snapshotData, { revision: rev });
            this.setRevision(featureName, rev);
          } catch (_) {}
        }

        this._notifyChange(featureName, { action: 'sync', revision: rev });
        return true;
      }

      default:
        return false;
    }
  }

  requestSync(featureName) {
    if (this.isHost) return;
    const msg = {
      type: 'TOOL_REQUEST_SYNC',
      feature: featureName,
      knownRevision: this.getRevision(featureName),
      roomEpoch: this.roomEpoch
    };
    const coord = this.getCoordinatorPeerId();
    if (this.sendTo && coord) {
      this.sendTo(coord, msg);
    } else if (this.broadcast) {
      this.broadcast(msg);
    }
  }

  broadcastFullSync() {
    if (!this.isHost || !this.broadcast) return;
    for (const [name, feature] of this.features.entries()) {
      this.broadcast({
        type: 'TOOL_SYNC',
        feature: name,
        revision: this.getRevision(name),
        data: feature.getSnapshot ? feature.getSnapshot() : null,
        roomEpoch: this.roomEpoch
      });
    }
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notifyChange(featureName, detail = {}) {
    this.listeners.forEach((fn) => {
      try { fn(featureName, detail); } catch (_) {}
    });
  }

  dispose() {
    this._disposed = true;
    for (const [, op] of this.pendingOps.entries()) {
      try { op.resolve({ success: false, reason: 'disposed' }); } catch (_) {}
    }
    this.pendingOps.clear();
    this.processedOps.clear();
    this.features.clear();
    this.revisions.clear();
    this.listeners.clear();
  }
}
