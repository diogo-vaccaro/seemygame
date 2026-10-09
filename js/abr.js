/**
 * SeeMyGame - Módulo de Bitrate Adaptativo Automático (ABR - Adaptive Bitrate)
 * Monitora telemetria WebRTC (perda de pacotes e latência RTT) e ajusta dinamicamente a taxa para evitar travamentos.
 */

export class AdaptiveBitrateController {
  constructor(options = {}) {
    this._initialTargetBitrateBps = options.targetBitrateBps || 7500000;
    this._minBitrateBps = options.minBitrateBps || 1500000; // Mínimo 1.5 Mbps
    this._initialEnabled = options.isEnabled !== false;
    this._states = new Map();
    this.onBitrateChange = options.onBitrateChange || null;
    this.goodSamplesRequiredForRecovery = 4; // ~8 segundos de rede estável
    this._ensureState('global');
  }

  _ensureState(peerId = 'global') {
    const key = peerId || 'global';
    if (!this._states.has(key)) {
      const global = this._states.get('global');
      const target = global?.targetBitrateBps ?? this._initialTargetBitrateBps;
      const enabled = global?.isEnabled ?? this._initialEnabled;
      this._states.set(key, {
        targetBitrateBps: target,
        currentBitrateBps: target,
        minBitrateBps: this._minBitrateBps,
        isEnabled: enabled,
        isLan: false,
        consecutiveBadSamples: 0,
        consecutiveGoodSamples: 0
      });
    }
    return this._states.get(key);
  }

  _globalStateProperty(name) {
    return this._ensureState('global')[name];
  }

  get targetBitrateBps() { return this._globalStateProperty('targetBitrateBps'); }
  set targetBitrateBps(value) { this._ensureState('global').targetBitrateBps = value; }
  get currentBitrateBps() { return this._globalStateProperty('currentBitrateBps'); }
  set currentBitrateBps(value) { this._ensureState('global').currentBitrateBps = value; }
  get minBitrateBps() { return this._globalStateProperty('minBitrateBps'); }
  set minBitrateBps(value) { this._ensureState('global').minBitrateBps = value; }
  get isEnabled() { return this._globalStateProperty('isEnabled'); }
  set isEnabled(value) { this._ensureState('global').isEnabled = !!value; }
  get consecutiveBadSamples() { return this._globalStateProperty('consecutiveBadSamples'); }
  set consecutiveBadSamples(value) { this._ensureState('global').consecutiveBadSamples = value; }
  get consecutiveGoodSamples() { return this._globalStateProperty('consecutiveGoodSamples'); }
  set consecutiveGoodSamples(value) { this._ensureState('global').consecutiveGoodSamples = value; }

  _emitBitrateChange(state, peerId) {
    if (typeof this.onBitrateChange !== 'function') return;
    if ((peerId || 'global') === 'global') {
      this.onBitrateChange(state.currentBitrateBps);
    } else {
      this.onBitrateChange(state.currentBitrateBps, peerId);
    }
  }

  setTargetBitrate(bps, peerId = 'global') {
    const state = this._ensureState(peerId);
    const val = Number(bps) || 7500000;
    const oldTarget = state.targetBitrateBps;
    state.targetBitrateBps = Math.max(this._minBitrateBps, Math.min(50000000, val));
    if (state.isLan) {
      state.minBitrateBps = Math.max(this._minBitrateBps, Math.min(state.targetBitrateBps, Math.round(state.targetBitrateBps * 0.4)));
    } else {
      state.minBitrateBps = this._minBitrateBps;
    }
    if (state.currentBitrateBps === oldTarget || state.currentBitrateBps > state.targetBitrateBps || !state.isEnabled) {
      state.currentBitrateBps = state.targetBitrateBps;
    }
  }

  setEnabled(enabled, peerId = 'global') {
    const state = this._ensureState(peerId);
    state.isEnabled = !!enabled;
    if (!state.isEnabled) {
      state.currentBitrateBps = state.targetBitrateBps;
      this._emitBitrateChange(state, peerId);
    }
  }

  getCurrentBitrate(peerId = 'global') {
    return this._ensureState(peerId).currentBitrateBps;
  }

  reset(peerId = 'global') {
    if (peerId && peerId !== 'global') {
      this._states.delete(peerId);
      return;
    }
    this._lastMeshGuard = null;
    for (const [, state] of this._states.entries()) {
      state.currentBitrateBps = state.targetBitrateBps;
      state.minBitrateBps = this._minBitrateBps;
      state.isLan = false;
      state.consecutiveBadSamples = 0;
      state.consecutiveGoodSamples = 0;
    }
  }

  /**
   * Calcula o teto de bitrate recomendado por espectador com base na quantidade total de espectadores (Mesh Guard).
   * Evita saturação do canal de upload doméstico do streamer na malha P2P.
   * @param {number} viewerCount
   * @param {number} [baseTargetBps=8000000]
   * @returns {number}
   */
  static calculateMeshGuardCap(viewerCount, baseTargetBps = 8000000, lanViewerCount = 0) {
    const total = Math.max(1, Number(viewerCount) || 1);
    const base = Number(baseTargetBps) || 8000000;
    const wanCount = Math.max(1, total - Math.max(0, Number(lanViewerCount) || 0));
    if (wanCount <= 1) return base;
    if (wanCount === 2) return Math.min(base, 6000000);
    if (wanCount === 3) return Math.min(base, 4000000);
    // 4 ou mais espectadores WAN: divide teto conjunto de 12 Mbps pela quantidade, preservando piso de 1.5 Mbps
    return Math.max(1500000, Math.floor(12000000 / wanCount));
  }

  /**
   * Aplica o teto do Mesh Guard a todos os espectadores ativos.
   * @param {number} viewerCount
   * @param {number} [baseTargetBps=null]
   * @param {number} [lanViewerCount=0]
   * @returns {number} novo teto em bps
   */
  applyMeshGuard(viewerCount, baseTargetBps = null, lanViewerCount = 0) {
    const count = Math.max(1, Number(viewerCount) || 1);
    const base = baseTargetBps || this._initialTargetBitrateBps;
    const cap = AdaptiveBitrateController.calculateMeshGuardCap(count, base, lanViewerCount);
    this._lastMeshGuard = { viewerCount: count, baseTargetBps: base, lanViewerCount, cap };

    for (const [peerId, state] of this._states.entries()) {
      if (state.isLan) {
        // Pares na rede local (LAN) não compartilham o canal de upload residencial da WAN
        continue;
      }
      state.targetBitrateBps = cap;
      if (state.currentBitrateBps > cap) {
        state.currentBitrateBps = cap;
        this._emitBitrateChange(state, peerId);
      }
    }
    return cap;
  }

  /**
   * Processa uma amostra de telemetria WebRTC
   * @param {Object} sample { packetLossRate: number, rttMs: number, qualityLimitationReason?: string, encodeTimeMs?: number, isLan?: boolean }
   * @returns {number} currentBitrateBps
   */
  processSample(sample = {}, peerId = 'global') {
    const state = this._ensureState(peerId);
    if (!state.isEnabled) return state.currentBitrateBps;
    if (!sample || typeof sample !== 'object') return state.currentBitrateBps;

    const rawLoss = sample.packetLossRate;
    const rawRtt = sample.rttMs !== undefined ? sample.rttMs : sample.rtt;
    const qualityReason = sample.qualityLimitationReason || sample.qualityReason;
    const rawEncodeTime = sample.encodeTimeMs !== undefined ? sample.encodeTimeMs : sample.encodeTime;

    const lossValid = Number.isFinite(rawLoss) && rawLoss >= 0 && rawLoss <= 1;
    const rttValid = Number.isFinite(rawRtt) && rawRtt >= 0;
    const encodeTimeValid = Number.isFinite(rawEncodeTime) && rawEncodeTime >= 0;
    const qualityValid = typeof qualityReason === 'string' && qualityReason.length > 0;

    // Se nenhuma métrica for válida, descarta a amostra sem avançar contadores
    if (!lossValid && !rttValid && !encodeTimeValid && !qualityValid) {
      state.consecutiveGoodSamples = 0;
      return state.currentBitrateBps;
    }

    // Classificação da rota (LAN vs WAN/Relay):
    // Rejeição prioritária de TURN/Relay ou negação explícita.
    const wasLan = state.isLan;
    if (sample.isRelay === true || sample.isLan === false) {
      state.isLan = false;
      state.minBitrateBps = this._minBitrateBps;
    } else if (sample.isLan === true) {
      state.isLan = true;
      state.minBitrateBps = Math.max(this._minBitrateBps, Math.min(state.targetBitrateBps, Math.round(state.targetBitrateBps * 0.4)));
    } else if (rttValid && rawRtt > 25) {
      state.isLan = false;
      state.minBitrateBps = this._minBitrateBps;
    }

    if (wasLan && !state.isLan && this._lastMeshGuard && state.targetBitrateBps > this._lastMeshGuard.cap) {
      state.targetBitrateBps = this._lastMeshGuard.cap;
      if (state.currentBitrateBps > this._lastMeshGuard.cap) {
        state.currentBitrateBps = this._lastMeshGuard.cap;
        this._emitBitrateChange(state, peerId);
      }
    }

    const loss = lossValid ? rawLoss : 0;
    const rtt = rttValid ? rawRtt : 0;
    const encodeTime = encodeTimeValid ? rawEncodeTime : 0;

    // Condição de saturação de CPU / Hardware Encoder:
    // Se o encoder relatar degradação por 'cpu' ou tempo de codificação exceder 20ms (>1.2x frame budget a 60fps)
    const budget = 1000 / (Number.isFinite(sample.targetFps) && sample.targetFps > 0 ? sample.targetFps : 60);
    const isCpuOverloaded = qualityReason === 'cpu' || (encodeTimeValid && encodeTime > budget * 1.2);

    // Condição de instabilidade / congestionamento de rede
    const isBadNetwork = (lossValid && loss > 0.04) || (rttValid && rtt > 220) || qualityReason === 'bandwidth';

    const isDegraded = isBadNetwork || isCpuOverloaded;

    // Condição de estabilidade e sobra de banda: requer métricas válidas e ausência de saturação
    const isGoodNetwork = !isDegraded && lossValid && rttValid && (loss < 0.01) && (rtt < 90) && (!encodeTimeValid || encodeTime <= budget * .9);

    const samplesRequired = state.isLan ? 1 : this.goodSamplesRequiredForRecovery;

    if (isDegraded) {
      state.consecutiveBadSamples++;
      state.consecutiveGoodSamples = 0;

      // Redução agressiva de 25% na primeira detecção
      if (state.currentBitrateBps > state.minBitrateBps) {
        const reduced = Math.max(state.minBitrateBps, Math.round(state.currentBitrateBps * 0.75));
        if (reduced !== state.currentBitrateBps) {
          state.currentBitrateBps = reduced;
          this._emitBitrateChange(state, peerId);
        }
      }
    } else if (isGoodNetwork && state.currentBitrateBps < state.targetBitrateBps) {
      state.consecutiveBadSamples = 0;
      state.consecutiveGoodSamples++;

      if (state.consecutiveGoodSamples >= samplesRequired) {
        state.consecutiveGoodSamples = 0;
        // Recuperação: 25% na LAN, 15% na WAN
        const factor = state.isLan ? 1.25 : 1.15;
        const increased = Math.min(state.targetBitrateBps, Math.round(state.currentBitrateBps * factor));
        if (increased !== state.currentBitrateBps) {
          state.currentBitrateBps = increased;
          this._emitBitrateChange(state, peerId);
        }
      }
    } else {
      state.consecutiveBadSamples = 0;
      state.consecutiveGoodSamples = 0;
    }

    return state.currentBitrateBps;
  }
}

export const adaptiveBitrateController = new AdaptiveBitrateController();
