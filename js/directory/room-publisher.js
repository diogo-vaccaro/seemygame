/**
 * SeeMyGame - Publicador de Salas no Diretório da Comunidade
 *
 * Envia heartbeat a cada 60 segundos para manter a sala ativa na listagem pública/comunitária.
 * Despublica imediatamente ao fechar a sala ou ao descarregar a página (pagehide / beforeunload).
 */

export const HEARTBEAT_INTERVAL_MS = 60_000; // Exatamente 60 segundos

function generateSecretKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'sec_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class RoomPublisher {
  constructor(options = {}) {
    this.apiBase = options.apiBase || '/api/rooms';
    this.intervalMs = options.intervalMs || HEARTBEAT_INTERVAL_MS;
    this.secretKey = generateSecretKey();
    this.timer = null;
    this.isActive = false;
    this.generation = 0;
    this.pendingHeartbeats = new Set();
    this.stopPromise = null;
    this.roomInfo = {
      roomId: '',
      title: '',
      game: 'Geral',
      isPrivate: false,
      hasPlayer2Slot: false,
      memberCount: 1,
      maxMembers: 8
    };

    this._onUnload = this._handleUnload.bind(this);
  }

  /**
   * Inicia o heartbeat de 60s e publica a sala no diretório.
   */
  async start(info = {}) {
    const generation = ++this.generation;
    if (this.stopPromise) await this.stopPromise;
    if (generation !== this.generation) return false;
    this.roomInfo = { ...this.roomInfo, ...info };
    if (!this.roomInfo.roomId) {
      console.warn('[RoomPublisher] roomId é obrigatório para publicar.');
      return false;
    }

    this.isActive = true;

    // Vincula ouvintes de saída para unlist imediato
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this._onUnload);
      window.addEventListener('beforeunload', this._onUnload);
    }

    // Primeiro envio imediato
    await this.sendHeartbeat();

    // Inicia intervalo de heartbeat a cada 60s
    if (!this.isActive || generation !== this.generation) return false;
    this._startTimer();
    return true;
  }

  /**
   * Atualiza métricas dinâmicas (membros, vaga de Player 2, etc.)
   */
  updateMetrics(partial = {}) {
    this.roomInfo = { ...this.roomInfo, ...partial };
  }

  /**
   * Envia um pulso de heartbeat para /api/rooms.
   */
  async sendHeartbeat() {
    if (!this.isActive || !this.roomInfo.roomId) return false;

    const payload = {
      id: this.roomInfo.roomId,
      title: this.roomInfo.title || this.roomInfo.roomId,
      game: this.roomInfo.game || 'Geral',
      isPrivate: Boolean(this.roomInfo.isPrivate),
      hasPlayer2Slot: Boolean(this.roomInfo.hasPlayer2Slot),
      memberCount: Number(this.roomInfo.memberCount) || 1,
      maxMembers: Number(this.roomInfo.maxMembers) || 8,
      secretKey: this.secretKey
    };

    try {
      const operation = fetch(this.apiBase, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      this.pendingHeartbeats.add(operation);
      try { return (await operation).ok; }
      finally { this.pendingHeartbeats.delete(operation); }
    } catch (err) {
      console.warn('[RoomPublisher] Falha ao enviar heartbeat:', err);
      return false;
    }
  }

  _startTimer() {
    this._stopTimer();
    this.timer = setInterval(() => {
      if (this.isActive) {
        this.sendHeartbeat();
      }
    }, this.intervalMs);
  }

  _stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _handleUnload() {
    if (!this.isActive || !this.roomInfo.roomId) return;
    this.unpublishSync();
  }

  /**
   * Remove a sala de forma síncrona/keepalive durante o fechamento da página.
   */
  unpublishSync() {
    const id = encodeURIComponent(this.roomInfo.roomId);
    const secret = encodeURIComponent(this.secretKey);
    const payload = JSON.stringify({ id: this.roomInfo.roomId, secretKey: this.secretKey });

    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(`${this.apiBase}?action=delete&id=${id}&secret=${secret}`, blob);
    } else if (typeof fetch !== 'undefined') {
      try {
        fetch(`${this.apiBase}?id=${id}&secret=${secret}`, {
          method: 'DELETE',
          keepalive: true
        }).catch(() => {});
      } catch (_) {}
    }
  }

  /**
   * Interrompe o heartbeat e despublica a sala do diretório.
   */
  async stop() {
    ++this.generation;
    if (!this.isActive) return this.stopPromise;
    this.isActive = false;
    this._stopTimer();

    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._onUnload);
      window.removeEventListener('beforeunload', this._onUnload);
    }

    const id = encodeURIComponent(this.roomInfo.roomId);
    const secret = encodeURIComponent(this.secretKey);
    const pending = [...this.pendingHeartbeats];
    const operation = (async () => {
      await Promise.allSettled(pending);
      try {
        await fetch(`${this.apiBase}?id=${id}&secret=${secret}`, {
          method: 'DELETE'
        });
      } catch (err) {
        console.warn('[RoomPublisher] Falha ao despublicar sala:', err);
      }
    })();
    this.stopPromise = operation;
    try { await operation; }
    finally { if (this.stopPromise === operation) this.stopPromise = null; }
  }

  dispose() {
    return this.stop();
  }
}
