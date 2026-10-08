/**
 * SeeMyGame - SoundboardPlugin (Isolated Feature Plugin)
 * 
 * Encapsula o ciclo de vida do reprodutor de sons, áudios customizados
 * e memes sonoros com isolamento de nós de áudio e barramento P2P.
 */

import { BasePlugin } from './base-plugin.js';
import { soundboardManager } from '../soundboard.js';
import { getSharedAudioContext } from '../core/audio-context-pool.js';
import { base64ToWavBlob, decodeAudioFromBlob, playAudioBuffer } from '../audio-meme.js';

export class SoundboardPlugin extends BasePlugin {
  constructor(options = {}) {
    super('soundboard', options);
    this.manager = options.manager || soundboardManager;
    this.ownsManager = Boolean(options.manager);
    this._dispatcherUnsubs = [];
  }

  setupListeners() {
    const dispatcher = this.context?.dispatcher;
    const eventBus = this.context?.eventBus;
    const shouldRelay = () => !this.context?.isRoomMode?.() && (this.context?.getViewersCount?.() > 0);
    const broadcast = (data, excludePeer) => this.context?.broadcastDataMessage?.(data, excludePeer);
    const showToast = this.context?.showToast || (() => {});

    if (dispatcher) {
      this._dispatcherUnsubs.push(
        dispatcher.register('SOUNDBOARD_PLAY', (data, sourceConn) => {
          if (this.context?.canReceiveSound && !this.context.canReceiveSound(data, sourceConn)) return;
          this.manager.playSound(data.soundId);
          showToast(`🔊 ${data.senderName || 'Alguém'} tocou um som no soundboard!`, 'info', 2500);
          if (eventBus) eventBus.emit('soundboard:played', data);
          if (shouldRelay()) broadcast(data, sourceConn?.peer);
        }, { description: 'Soundboard: Play Preset' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('SOUNDBOARD_PLAY_CUSTOM', (data, sourceConn) => {
          if (this.context?.canReceiveSound && !this.context.canReceiveSound(data, sourceConn)) return;
          if (data.audioBase64) {
            try {
              const wavBlob = base64ToWavBlob(data.audioBase64);
              const ctx = this.context?.audioScope?.getContext() || getSharedAudioContext();
              if (ctx) {
                decodeAudioFromBlob(wavBlob, ctx).then(buf => {
                  if (buf && this.enabled && (!this.context?.canReceiveSound || this.context.canReceiveSound(data, sourceConn))) playAudioBuffer(buf, ctx);
                }).catch((err) => {
                  console.warn('[SoundboardPlugin] Falha ao decodificar áudio customizado:', err);
                });
              }
            } catch (err) {
              console.warn('[SoundboardPlugin] Erro ao deserializar áudio meme P2P:', err);
            }
          }
          const effectLabel = data.effectName ? ` (${data.effectName})` : '';
          showToast(`🎙️ ${data.senderName || 'Alguém'} disparou um áudio meme${effectLabel}!`, 'info', 3000);
          if (eventBus) eventBus.emit('soundboard:custom-played', data);
          if (shouldRelay()) broadcast(data, sourceConn?.peer);
        }, { description: 'Soundboard: Play Custom Meme' })
      );
    }

    this.registerCleanup(() => {
      this._dispatcherUnsubs.forEach(unsub => unsub());
      this._dispatcherUnsubs = [];
    });
  }

  destroy() {
    const cleanup = super.destroy();
    return Promise.allSettled([cleanup, this.ownsManager ? this.manager.dispose?.() : undefined]);
  }
}

export const soundboardPlugin = new SoundboardPlugin();
