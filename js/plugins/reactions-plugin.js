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
        }, { description: 'Reactions: Spawn Floating Emoji' }),

        dispatcher.register('EMOJI_BURST', (data, sourceConn) => {
          this.manager.spawnBurst({
            emoji: data.emoji,
            count: data.count || 4,
            originX: data.originX,
            senderName: data.senderName
          });
          if (eventBus) eventBus.emit('reaction:burst-spawned', data);
          if (shouldRelay()) broadcast(data, sourceConn?.peer);
        }, { description: 'Reactions: Spawn Floating Emoji Burst' })
      );
    }

    this._setupKeyboardShortcuts();

    this.registerCleanup(() => {
      this._dispatcherUnsubs.forEach(unsub => unsub());
      this._dispatcherUnsubs = [];
      if (this._abortController) {
        this._abortController.abort();
        this._abortController = null;
      }
    });
  }

  _setupKeyboardShortcuts() {
    if (typeof document === 'undefined') return;

    const CODE_OR_KEY_MAP = {
      'Digit1': '🔥', 'Numpad1': '🔥', '1': '🔥',
      'Digit2': '💀', 'Numpad2': '💀', '2': '💀',
      'Digit3': '🎯', 'Numpad3': '🎯', '3': '🎯',
      'Digit4': '👏', 'Numpad4': '👏', '4': '👏',
      'Digit5': '😂', 'Numpad5': '😂', '5': '😂',
      'Digit6': 'GG', 'Numpad6': 'GG', '6': 'GG',
      'Digit7': '🚀', 'Numpad7': '🚀', '7': '🚀',
      'Digit8': '❤️', 'Numpad8': '❤️', '8': '❤️'
    };

    const onKeyDown = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const emoji = CODE_OR_KEY_MAP[e.code] || CODE_OR_KEY_MAP[e.key];
      if (!emoji) return;

      // Guarda estrita de foco e contexto
      const active = document.activeElement;
      if (active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable ||
        active.closest?.('.modal-overlay[style*="flex"], .modal-overlay[style*="block"]')
      )) {
        return;
      }

      // Guarda de Co-op Player 2: não interferir quando o gamepad/teclado estiver sob captura
      if (this.context?.coopController?.isCapturingInput?.()) {
        return;
      }

      const senderName = this.context?.getDisplayName?.() || 'Gamer';
      const originX = Math.random() * 70 + 15;

      if (e.shiftKey && this.manager.canSendBurst()) {
        this.manager.spawnBurst({ emoji, count: 4, originX, senderName });
        this.context?.broadcastDataMessage?.({
          type: 'EMOJI_BURST',
          emoji,
          count: 4,
          originX,
          senderName
        });
      } else if (this.manager.canSend()) {
        this.manager.spawnReaction({ emoji, xPercent: originX, senderName });
        this.context?.broadcastDataMessage?.({
          type: 'EMOJI_REACTION',
          emoji,
          xPercent: originX,
          senderName
        });
      }
    };

    document.addEventListener('keydown', onKeyDown);
    this._dispatcherUnsubs.push(() => document.removeEventListener('keydown', onKeyDown));
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
        btn.addEventListener('click', (e) => {
          const emoji = btn.dataset.emoji;
          if (!emoji) return;

          const senderName = this.context?.getDisplayName?.() || 'Espectador';
          const originX = Math.random() * 70 + 15;

          if (e.shiftKey && this.manager.canSendBurst()) {
            this.manager.spawnBurst({ emoji, count: 4, originX, senderName });
            this.context?.broadcastDataMessage?.({
              type: 'EMOJI_BURST',
              emoji,
              count: 4,
              originX,
              senderName
            });
          } else if (this.manager.canSend()) {
            this.manager.spawnReaction({ emoji, xPercent: originX, senderName });
            this.context?.broadcastDataMessage?.({
              type: 'EMOJI_REACTION',
              emoji,
              xPercent: originX,
              senderName
            });
          }
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
