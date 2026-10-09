/**
 * SeeMyGame - Gerenciador de P2P Relay (Tree Mesh)
 * 
 * Permite escalar transmissões para 4 ou mais espectadores sem sobrecarregar
 * o upload residencial do streamer. O streamer envia para até N espectadores
 * diretos (Nível 1, padrão: 3), que por sua vez retransmitem as trilhas de vídeo/áudio
 * para os demais espectadores (Nível 2+), com failover automático.
 */

export const DEFAULT_MAX_DIRECT_VIEWERS = 3;

export class RelayManager {
  /**
   * @param {Object} options
   * @param {string} [options.originPeerId=null] - ID do streamer (Origem raiz)
   * @param {number} [options.maxDirectViewers=3] - Número máximo de uploads diretos da origem
   * @param {Function} [options.onTopologyChange=null]
   * @param {Function} [options.onFailover=null]
   */
  constructor(options = {}) {
    this.originPeerId = options.originPeerId || null;
    this.maxDirectViewers = Math.max(1, Number(options.maxDirectViewers) || DEFAULT_MAX_DIRECT_VIEWERS);
    this.onTopologyChange = options.onTopologyChange || null;
    this.onFailover = options.onFailover || null;
    this.onRouteChange = options.onRouteChange || null;

    // Mapa de nós: peerId -> { peerId, role: 'origin'|'direct'|'relay', parentPeerId, children: Set, rtt: number, packetLoss: number }
    this.nodes = new Map();

    if (this.originPeerId) {
      this.setOrigin(this.originPeerId);
    }
  }

  /**
   * Define o nó raiz (Streamer/Origem)
   * @param {string} peerId 
   */
  setOrigin(peerId) {
    if (!peerId) return;
    this.originPeerId = peerId;
    this.nodes.set(peerId, {
      peerId,
      role: 'origin',
      parentPeerId: null,
      children: new Set(),
      rtt: 0,
      packetLoss: 0
    });
    this._emitTopologyChange();
  }

  /**
   * Registra um novo espectador e calcula sua posição na árvore
   * @param {string} peerId 
   * @param {Object} [telemetry={}]
   * @returns {{ role: 'direct'|'relay', parentPeerId: string }}
   */
  registerViewer(peerId, telemetry = {}) {
    if (!peerId || peerId === this.originPeerId) {
      return null;
    }

    const hasFiniteRtt = typeof telemetry.rtt === 'number' && Number.isFinite(telemetry.rtt) && telemetry.rtt >= 0;
    const rtt = hasFiniteRtt ? telemetry.rtt : 50;
    const packetLoss = typeof telemetry.packetLoss === 'number' && Number.isFinite(telemetry.packetLoss) ? telemetry.packetLoss : 0;

    let isLan = false;
    if (telemetry.isRelay === true || telemetry.isLan === false) {
      isLan = false;
    } else if (telemetry.isLan === true) {
      isLan = true;
    } else if (hasFiniteRtt && telemetry.rtt <= 5 && !telemetry.isRelay) {
      isLan = true;
    }

    // Se já existia, atualiza telemetria
    if (this.nodes.has(peerId)) {
      this.updateTelemetry(peerId, telemetry);
      const existing = this.nodes.get(peerId);
      return { role: existing.role, parentPeerId: existing.parentPeerId };
    }

    const directNodes = this.getDirectNodes();
    const directWanNodes = directNodes.filter(n => !n.isLan);
    let role = 'direct';
    let parentPeerId = this.originPeerId;

    if (isLan || directWanNodes.length < this.maxDirectViewers) {
      // Vaga direta disponível no Streamer (nós LAN sempre têm acesso direto sem consumir vagas de upload WAN)
      role = 'direct';
      parentPeerId = this.originPeerId;
      if (this.originPeerId && this.nodes.has(this.originPeerId)) {
        this.nodes.get(this.originPeerId).children.add(peerId);
      }
    } else {
      // Streamer já atingiu a cota de uploads diretos -> Aloca em um nó de Relay
      role = 'relay';
      const bestParent = this.electBestRelayParent();
      if (bestParent) {
        parentPeerId = bestParent.peerId;
        bestParent.children.add(peerId);
      } else {
        // Fallback para o streamer se nenhum pai estiver apto
        parentPeerId = this.originPeerId;
        if (this.originPeerId && this.nodes.has(this.originPeerId)) {
          this.nodes.get(this.originPeerId).children.add(peerId);
        }
      }
    }

    const node = {
      peerId,
      role,
      parentPeerId,
      children: new Set(),
      rtt,
      packetLoss,
      isLan
    };

    this.nodes.set(peerId, node);
    this._emitTopologyChange();

    return { role, parentPeerId };
  }

  /**
   * Remove um espectador e executa failover para os nós filhos caso ele fosse pai de relay
   * @param {string} peerId 
   * @returns {Array<{ childPeerId: string, newParentPeerId: string, role: string }>}
   */
  unregisterViewer(peerId) {
    if (!peerId || !this.nodes.has(peerId)) return [];

    const node = this.nodes.get(peerId);
    const affectedChildren = Array.from(node.children);

    // Remove do pai
    if (node.parentPeerId && this.nodes.has(node.parentPeerId)) {
      this.nodes.get(node.parentPeerId).children.delete(peerId);
    }

    this.nodes.delete(peerId);

    const failoverResults = [];

    // Executa failover para os nós que ficaram órfãos
    for (const childId of affectedChildren) {
      if (!this.nodes.has(childId)) continue;
      const childNode = this.nodes.get(childId);

      // Tenta promover a direto ou realocar em outro nó de relay
      const directNodes = this.getDirectNodes();
      if (directNodes.length < this.maxDirectViewers) {
        childNode.role = 'direct';
        childNode.parentPeerId = this.originPeerId;
        if (this.originPeerId && this.nodes.has(this.originPeerId)) {
          this.nodes.get(this.originPeerId).children.add(childId);
        }
      } else {
        const bestParent = this.electBestRelayParent(childId);
        if (bestParent) {
          childNode.role = 'relay';
          childNode.parentPeerId = bestParent.peerId;
          bestParent.children.add(childId);
        } else {
          childNode.role = 'direct';
          childNode.parentPeerId = this.originPeerId;
          if (this.originPeerId && this.nodes.has(this.originPeerId)) {
            this.nodes.get(this.originPeerId).children.add(childId);
          }
        }
      }

      failoverResults.push({
        childPeerId: childId,
        newParentPeerId: childNode.parentPeerId,
        role: childNode.role
      });

      if (typeof this.onFailover === 'function') {
        this.onFailover(childId, childNode.parentPeerId, childNode.role);
      }
    }

    this._emitTopologyChange();
    return failoverResults;
  }

  /**
   * Atualiza métricas de telemetria de um nó
   * @param {string} peerId 
   * @param {Object} metrics { rtt?: number, packetLoss?: number }
   */
  updateTelemetry(peerId, metrics = {}) {
    const node = this.nodes.get(peerId);
    if (!node) return;
    const hasFiniteRtt = typeof metrics.rtt === 'number' && Number.isFinite(metrics.rtt) && metrics.rtt >= 0;
    if (hasFiniteRtt) node.rtt = metrics.rtt;
    if (typeof metrics.packetLoss === 'number' && Number.isFinite(metrics.packetLoss)) node.packetLoss = metrics.packetLoss;

    const wasLan = node.isLan;
    if (metrics.isRelay === true || metrics.isLan === false) {
      node.isLan = false;
    } else if (metrics.isLan === true) {
      node.isLan = true;
    } else if (hasFiniteRtt) {
      node.isLan = metrics.rtt <= 5 && !metrics.isRelay;
    }

    if (wasLan !== node.isLan) {
      const oldParentPeerId = node.parentPeerId;
      let parentPeerId = oldParentPeerId;
      let role = node.role;
      if (node.isLan && node.role === 'relay') {
        parentPeerId = this.originPeerId;
        role = 'direct';
      } else if (!node.isLan && node.role === 'direct' &&
          this.getDirectNodes().filter(other => other !== node && !other.isLan).length >= this.maxDirectViewers) {
        const parent = this.electBestRelayParent(peerId);
        if (parent) { parentPeerId = parent.peerId; role = 'relay'; }
      }
      if (parentPeerId !== oldParentPeerId || role !== node.role) {
        this.nodes.get(oldParentPeerId)?.children.delete(peerId);
        this.nodes.get(parentPeerId)?.children.add(peerId);
        node.parentPeerId = parentPeerId;
        node.role = role;
        this.onRouteChange?.(peerId, parentPeerId, role, oldParentPeerId);
      }
      this._emitTopologyChange();
    }
  }

  /**
   * Retorna os nós de Nível 1 (espectadores diretos do streamer)
   * @returns {Array<Object>}
   */
  getDirectNodes() {
    const results = [];
    for (const [id, node] of this.nodes.entries()) {
      if (id !== this.originPeerId && node.role === 'direct') {
        results.push(node);
      }
    }
    return results;
  }

  /**
   * Elege o melhor nó direto para servir de pai de relay (menor RTT e menos filhos)
   * @param {string} [excludePeerId=null]
   * @returns {Object|null}
   */
  electBestRelayParent(excludePeerId = null) {
    const candidates = this.getDirectNodes().filter(n => n.peerId !== excludePeerId);
    if (candidates.length === 0) return null;

    // Ordena: primeiro por menor número de filhos, depois por menor perda e menor RTT
    candidates.sort((a, b) => {
      if (a.children.size !== b.children.size) {
        return a.children.size - b.children.size;
      }
      if (a.packetLoss !== b.packetLoss) {
        return a.packetLoss - b.packetLoss;
      }
      return a.rtt - b.rtt;
    });

    return candidates[0] || null;
  }

  /**
   * Retorna a topologia consolidada da árvore
   * @returns {Object}
   */
  getTopology() {
    const direct = [];
    const relayed = [];

    for (const [id, node] of this.nodes.entries()) {
      if (id === this.originPeerId) continue;
      if (node.role === 'direct') {
        direct.push({
          peerId: id,
          rtt: node.rtt,
          childrenCount: node.children.size
        });
      } else {
        relayed.push({
          peerId: id,
          parentPeerId: node.parentPeerId,
          rtt: node.rtt
        });
      }
    }

    return {
      origin: this.originPeerId,
      totalViewers: direct.length + relayed.length,
      directCount: direct.length,
      relayedCount: relayed.length,
      direct,
      relayed
    };
  }

  /**
   * Calcula a economia de largura de banda de upload do streamer graças à árvore de relay
   * @param {number} [streamBitrateBps=8000000]
   * @returns {{ fullMeshUploadBps: number, treeUploadBps: number, savingsBps: number, percentSaved: number }}
   */
  calculateBandwidthSavings(streamBitrateBps = 8000000) {
    const topology = this.getTopology();
    const total = topology.totalViewers;
    const direct = topology.directCount;

    const fullMeshUploadBps = total * streamBitrateBps;
    const treeUploadBps = direct * streamBitrateBps;
    const savingsBps = Math.max(0, fullMeshUploadBps - treeUploadBps);
    const percentSaved = fullMeshUploadBps > 0 ? Math.round((savingsBps / fullMeshUploadBps) * 100) : 0;

    return {
      fullMeshUploadBps,
      treeUploadBps,
      savingsBps,
      percentSaved
    };
  }

  /**
   * Encaminha nativamente um MediaStream recebido através de uma nova RTCPeerConnection (Relay de Mídia)
   * Sem transcodificação na CPU: retransmissão direta dos pacotes da trilha.
   * @param {MediaStream} remoteStream
   * @param {RTCPeerConnection} targetPeerConnection
   * @returns {boolean}
   */
  static forwardMediaStream(remoteStream, targetPeerConnection) {
    if (!remoteStream || !targetPeerConnection || typeof targetPeerConnection.addTrack !== 'function') {
      return false;
    }
    const tracks = remoteStream.getTracks ? remoteStream.getTracks() : [];
    if (tracks.length === 0) return false;

    let addedAny = false;
    for (const track of tracks) {
      if (track.readyState === 'live') {
        try {
          targetPeerConnection.addTrack(track, remoteStream);
          addedAny = true;
        } catch (err) {
          console.warn('[RelayManager] Falha ao adicionar trilha para relay:', err);
        }
      }
    }
    return addedAny;
  }

  _emitTopologyChange() {
    if (typeof this.onTopologyChange === 'function') {
      this.onTopologyChange(this.getTopology());
    }
  }
}
