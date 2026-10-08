/**
 * SeeMyGame - ReactionsPlugin (Isolated Feature Plugin)
 * 
 * Encapsula o ciclo de vida das reações flutuantes de emojis,
 * animações sobre o player de vídeo e rate limiting de envio.
 */

import { BasePlugin } from './base-plugin.js';
import { floatingReactionsManager } from '../reactions.js';

export class ReactionsPlugin extends BasePlugin {
  constructor(options = {}) {
    super('reactions', options);
    this.manager = options.manager || floatingReactionsManager;
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
        dispatcher.register('EMOJI_REACTION', (data, sourceConn) => {
          this.manager.spawnReaction({
            emoji: data.emoji,
            xPercent: data.xPercent,
            senderName: data.senderName
          });
          if (eventBus) eventBus.emit('reaction:spawned', data);
          if (shouldRelay()) broadcast(data, sourceConn?.peer);
        }, { description: 'Reactions: Spawn Floating Emoji' })
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
   * Vincula o overlay e dock de emojis do DOM.
   * @param {HTMLElement} overlay
   * @param {HTMLElement} [dock]
   */
  bindDOM(overlay, dock = null) {
    if (overlay) {
      this.manager.setContainer(overlay);
    }

    if (dock) {
      if (this._abortController) {
        this._abortController.abort();
      }
      this._abortController = new AbortController();
      const { signal } = this._abortController;

      dock.querySelectorAll('.reaction-dock-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const emoji = btn.dataset.emoji;
          if (!emoji || !this.manager.canSend()) return;

          const senderName = this.context?.getDisplayName?.() || 'Espectador';
          const xPercent = Math.random() * 70 + 15;

          this.manager.spawnReaction({ emoji, xPercent, senderName });
          this.context?.broadcastDataMessage?.({
            type: 'EMOJI_REACTION',
            emoji,
            xPercent,
            senderName
          });
        }, { signal });
      });
    }
  }

  destroy() {
    const cleanup = super.destroy();
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    return Promise.allSettled([cleanup, this.ownsManager ? this.manager.dispose?.() : undefined]);
  }
}

export const reactionsPlugin = new ReactionsPlugin();
