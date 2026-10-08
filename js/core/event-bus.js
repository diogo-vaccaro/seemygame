/**
 * SeeMyGame - EventBus (Kernel Core)
 * 
 * Barramento de eventos publish/subscribe com isolamento de falhas (circuit breaker),
 * suporte a prioridades, desinscrição segura e proteção contra recursão em caso de erro.
 */

export class EventBus {
  constructor({ name = 'GlobalBus' } = {}) {
    this.name = name;
    // Map<string, Array<{ handler: Function, priority: number, once: boolean }>>
    this._listeners = new Map();
    this._isDispatchingError = false;
  }

  /**
   * Registra um ouvinte para um evento.
   * @param {string} event - Nome do evento
   * @param {Function} handler - Função de callback
   * @param {Object} [options]
   * @param {number} [options.priority=0] - Prioridade (maior executa primeiro)
   * @param {boolean} [options.once=false] - Se true, executa apenas uma vez
   * @returns {() => void} Função de desinscrição
   */
  on(event, handler, { priority = 0, once = false } = {}) {
    if (typeof event !== 'string' || !event.trim()) {
      throw new TypeError(`[${this.name}] O nome do evento deve ser uma string não vazia.`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`[${this.name}] O handler para "${event}" deve ser uma função.`);
    }

    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }

    const entry = { handler, priority: Number(priority) || 0, once: Boolean(once) };
    const list = this._listeners.get(event);
    list.push(entry);
    // Ordena de forma decrescente por prioridade
    list.sort((a, b) => b.priority - a.priority);

    return () => this._removeEntry(event, entry);
  }

  /**
   * Registra um ouvinte de execução única.
   */
  once(event, handler, { priority = 0 } = {}) {
    return this.on(event, handler, { priority, once: true });
  }

  /**
   * Remove um ouvinte previamente registrado.
   */
  off(event, handler) {
    if (!this._listeners.has(event)) return;
    const list = this._listeners.get(event);
    const index = list.findIndex(entry => entry.handler === handler);
    if (index !== -1) {
      this._removeEntry(event, list[index]);
    }
  }

  _removeEntry(event, entry) {
    const list = this._listeners.get(event);
    const index = list?.indexOf(entry) ?? -1;
    if (index === -1) return false;
    list.splice(index, 1);
    if (!list.length) this._listeners.delete(event);
    return true;
  }

  /**
   * Emite um evento de forma segura.
   * Qualquer exceção lançada por um ouvinte é capturada e isolada,
   * garantindo que nenhum ouvinte subsequente ou o emissor sejam interrompidos.
   * 
   * @param {string} event - Nome do evento
   * @param {any} [payload] - Dados associados ao evento
   * @returns {number} Quantidade de ouvintes acionados com sucesso
   */
  emit(event, payload) {
    if (!this._listeners.has(event)) return 0;

    // Clona a lista para proteger contra mutações durante a iteração
    const list = [...this._listeners.get(event)];
    let successCount = 0;

    for (const entry of list) {
      if (entry.once) {
        // A nested emit may already have consumed this exact registration.
        if (!this._removeEntry(event, entry)) continue;
      }

      try {
        const res = entry.handler(payload);
        if (res && typeof res.catch === 'function') {
          res.catch((error) => {
            console.error(`[${this.name}] Erro assíncrono capturado e isolado no ouvinte de "${event}":`, error);
            if (!this._isDispatchingError && event !== 'system:error') {
              this._isDispatchingError = true;
              try {
                this.emit('system:error', {
                  sourceEvent: event,
                  error,
                  payload
                });
              } finally {
                this._isDispatchingError = false;
              }
            }
          });
        }
        successCount++;
      } catch (error) {
        console.error(`[${this.name}] Erro capturado e isolado no ouvinte de "${event}":`, error);

        // Previne recursão infinita se o handler do evento de erro também falhar
        if (!this._isDispatchingError && event !== 'system:error') {
          this._isDispatchingError = true;
          try {
            this.emit('system:error', {
              sourceEvent: event,
              error,
              payload
            });
          } finally {
            this._isDispatchingError = false;
          }
        }
      }
    }

    return successCount;
  }

  /**
   * Retorna a quantidade de ouvintes registrados para um determinado evento.
   */
  listenerCount(event) {
    const list = this._listeners.get(event);
    return list ? list.length : 0;
  }

  /**
   * Remove todos os ouvintes (útil para testes ou teardown completo).
   */
  clear(event = null) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }
}

// Instância singleton global do kernel
export const globalBus = new EventBus({ name: 'SeeMyGameGlobalBus' });
