/**
 * SeeMyGame - TacticalPingPlugin (Isolated Feature Plugin)
 * 
 * Encapsula o ciclo de vida dos pings táticos sobre o jogo,
 * renderização em canvas, ponteiro laser sincronizado e limpeza de listeners.
 */

import { BasePlugin } from './base-plugin.js';
import { tacticalPingManager } from '../ping.js';
import { bindTacticalPingInput } from '../ping-input.js';

export class TacticalPingPlugin extends BasePlugin {
  constructor(options = {}) {
    super('tactical-ping', options);
    this.manager = options.manager || tacticalPingManager;
    this.ownsManager = Boolean(options.manager);
    this._abortController = null;
    this._dispatcherUnsubs = [];
  }

  setupListeners() {
    const dispatcher = this.context?.dispatcher;
    const eventBus = this.context?.eventBus;
    const shouldRelay = () => !this.context?.isRoomMode?.() && (this.context?.getViewersCount?.() > 0);
    const broadcast = (data, excludePeer) => this.context?.broadcastDataMessage?.(data, excludePeer);

    if (dispatcher) {
      this._dispatcherUnsubs.push(
        dispatcher.register('TACTICAL_PING', (data, sourceConn) => {
          if (data.ping) {
            this.manager.addPing(data.ping);
            if (eventBus) eventBus.emit('ping:added', data.ping);
            if (shouldRelay()) broadcast(data, sourceConn?.peer);
          }
        }, { description: 'Ping: Tactical Marker' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('TACTICAL_LASER', (data, sourceConn) => {
          const peer = sourceConn?.peer;
          // Só o host conhecido pode atestar a origem de um laser retransmitido.
          // Em conexões diretas a identidade sempre vem da conexão, não do payload.
          const senderId = peer
            ? (this.context?.isTrustedLaserRelayPeer?.(peer) && typeof data.laserOriginPeerId === 'string' && data.laserOriginPeerId.length > 0
              ? data.laserOriginPeerId : peer)
            : 'local';
          const point = data.point && { ...data.point, senderId };
          const message = { ...data, senderId, laserOriginPeerId: senderId, ...(point ? { point } : {}) };
          if (data.action === 'stop') {
            this.manager.stopLaserTrail(senderId);
            if (shouldRelay()) broadcast(message, peer);
            return;
          }
          if (data.point) {
            this.manager.addLaserPoint(point);
            if (shouldRelay()) broadcast(message, peer);
          }
        }, { description: 'Ping: Laser Pointer' })
      );
    }

    this.registerCleanup(() => {
      this._dispatcherUnsubs.forEach(unsub => unsub());
      this._dispatcherUnsubs = [];
      if (this._abortController) {
        this._abortController.abort();
        this._abortController = null;
      }
    });
  }

  /**
   * Vincula um elemento <canvas> do DOM ao sistema de pings.
   * @param {HTMLCanvasElement} canvas
   */
  bindCanvas(canvas) {
    if (!canvas) return;

    if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = new AbortController();
    const { signal } = this._abortController;

    bindTacticalPingInput(canvas, {
      manager: this.manager,
      signal,
      broadcast: data => this.context?.broadcastDataMessage?.(data),
      getPeerId: () => this.context?.getPeerId?.(),
      getDisplayName: () => this.context?.getDisplayName?.(),
      getRole: () => this.context?.getRole?.(),
      canDraw: () => this.context?.canUseTacticalPing?.() !== false
    });
  }

  destroy() {
    super.destroy();
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    if (this.ownsManager) this.manager.dispose?.();
  }
}

export const tacticalPingPlugin = new TacticalPingPlugin();
