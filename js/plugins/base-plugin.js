/**
 * SeeMyGame - BasePlugin (Plugin Architecture)
 * 
 * Classe base padronizada para funcionalidades e periféricos autônomos.
 * Fornece ciclo de vida formal (init, destroy), injeção de contexto do Kernel
 * (EventBus, MessageDispatcher) e coleta idempotente de limpeza de recursos.
 */

export class BasePlugin {
  constructor(name, options = {}) {
    if (!name || typeof name !== 'string') {
      throw new TypeError('[BasePlugin] O nome do plugin deve ser uma string não vazia.');
    }
    this.name = name;
    this.options = options;
    this.enabled = false;
    this.context = null;
    this._cleanupFns = [];
  }

  /**
   * Inicializa o plugin injetando o contexto do Kernel.
   * @param {Object} context
   * @param {import('../core/event-bus.js').EventBus} [context.eventBus]
   * @param {import('../core/message-dispatcher.js').MessageDispatcher} [context.dispatcher]
   * @param {Function} [context.broadcastDataMessage]
   * @param {Function} [context.isRoomMode]
   */
  init(context = {}) {
    if (this.enabled) return false;
    this.context = context;
    this.enabled = true;

    try {
      this.setupListeners();
      if (this.context?.eventBus) {
        this.context.eventBus.emit(`plugin:${this.name}:initialized`, { name: this.name });
      }
      return true;
    } catch (err) {
      console.error(`[BasePlugin] Erro durante inicialização do plugin "${this.name}":`, err);
      this.destroy();
      throw err;
    }
  }

  /**
   * Ponto de extensão para que subclasses registrem ouvintes de eventos,
   * despachantes de rede e listeners no DOM.
   */
  setupListeners() {
    // Implementado pelas subclasses
  }

  /**
   * Registra uma função de limpeza para ser executada no destroy().
   * @param {Function} fn
   */
  registerCleanup(fn) {
    if (typeof fn === 'function') {
      this._cleanupFns.push(fn);
    }
  }

  /**
   * Encerra o plugin, desfazendo todas as assinaturas, removendo listeners
   * e liberando nós de memória/DOM.
   */
  destroy() {
    if (!this.enabled) return;
    const context = this.context;
    const cleanups = this._cleanupFns;
    this._cleanupFns = [];
    this.enabled = false;
    this.context = null;
    const pending = [];
    for (const fn of cleanups) {
      try {
        const result = fn();
        if (result?.then) pending.push(Promise.resolve(result).catch(error => {
          context?.eventBus?.emit('system:error', { sourceEvent: 'plugin:cleanup', plugin: this.name, error });
        }));
      } catch (err) {
        console.error(`[BasePlugin] Erro na função de limpeza do plugin "${this.name}":`, err);
      }
    }
    if (context?.eventBus) {
      context.eventBus.emit(`plugin:${this.name}:destroyed`, { name: this.name });
    }
    return Promise.allSettled(pending);
  }
}
