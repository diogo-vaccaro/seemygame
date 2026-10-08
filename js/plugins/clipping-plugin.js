/**
 * SeeMyGame - ClippingPlugin (Isolated Feature Plugin)
 * 
 * Encapsula o ciclo de vida da gravação circular de 30s (Instant Replay),
 * isolamento de trilhas MediaRecorder e limpeza idempotente de listeners de áudio.
 */

import { BasePlugin } from './base-plugin.js';
import { clipRecorder, ClipRecorder } from '../clipping.js';

export class ClippingPlugin extends BasePlugin {
  constructor(options = {}) {
    super('clipping', options);
    this.recorder = options.recorder || clipRecorder;
    this.ownsRecorder = Boolean(options.recorder);
    this._activeStream = null;
  }

  setupListeners() {
    const eventBus = this.context?.eventBus;

    if (eventBus) {
      this.registerCleanup(
        eventBus.on('stream:started', ({ stream, sourceId = 'local-me' }) => {
          if (stream) {
            this.start(stream, sourceId);
          }
        })
      );

      this.registerCleanup(
        eventBus.on('stream:stopped', ({ sourceId = null } = {}) => {
          this.stop(sourceId);
        })
      );
      this.registerCleanup(eventBus.on('stream:received', ({ stream, hostId }) => this.start(stream, hostId)));
    }
  }

  /**
   * Inicia a gravação do buffer circular com o MediaStream fornecido.
   * @param {MediaStream} stream
   */
  start(stream, sourceId = 'local-me') {
    if (!stream) return;
    this._activeStream = stream;
    try {
      this.recorder.start(stream, sourceId);
    } catch (err) {
      console.warn('[ClippingPlugin] Falha ao iniciar gravação circular:', err);
    }
  }

  /**
   * Encerra a gravação e limpa listeners associados.
   */
  stop(sourceId = null) {
    try {
      return this.recorder.stop(sourceId);
    } catch (err) {
      console.warn('[ClippingPlugin] Erro ao encerrar gravador:', err);
    } finally {
      this._activeStream = null;
    }
  }

  /**
   * Exporta os últimos segundos em um Blob WebM.
   * @param {string|null} [customFilename=null]
   * @param {string|null} [sourceId=null]
   * @returns {Promise<Blob|null>}
   */
  async exportClip(customFilename = null, sourceId = null) {
    try {
      return await this.recorder.exportClip(customFilename, sourceId);
    } catch (err) {
      console.error('[ClippingPlugin] Falha ao exportar clipe:', err);
      return null;
    }
  }

  destroy() {
    const cleanup = super.destroy();
    const stopped = this.stop();
    return Promise.allSettled([cleanup, stopped, this.ownsRecorder ? this.recorder.dispose?.() : undefined]);
  }
}

export const clippingPlugin = new ClippingPlugin();
