/**
 * SeeMyGame - MessageDispatcher (Kernel Core)
 * 
 * Despachante de mensagens P2P com sandbox, deduplicação automática,
 * métricas de entrega, registro de handlers por tipo de mensagem e
 * proteção contra falhas em cascata.
 */

import { validateReceivedMessage } from '../protocol/transport.js';

export class MessageDispatcher {
  constructor({ maxHistorySize = 500 } = {}) {
    // Map<string, Array<{ handler: Function, priority: number, description: string }>>
    this._handlers = new Map();
    this._recentMessageIds = new Set();
    this._messageIdQueue = [];
    this._maxHistorySize = maxHistorySize;
    this._fallbackHandler = null;
    this._metrics = {
      received: 0,
      dispatched: 0,
      duplicates: 0,
      errors: 0,
      unhandled: 0
    };
  }

  /**
   * Registra um handler para um tipo específico de mensagem P2P.
   * @param {string} type - Tipo da mensagem (ex: 'CHAT_MESSAGE', 'WHITEBOARD_ELEMENT_ADD')
   * @param {Function} handler - (data, sourceConn) => void | Promise<void>
   * @param {Object} [options]
   * @param {number} [options.priority=0] - Prioridade de execução (maior executa primeiro)
   * @param {string} [options.description=''] - Descrição para fins diagnósticos
   * @returns {() => void} Função de desregistro
   */
  register(type, handler, { priority = 0, description = '' } = {}) {
    if (!type || typeof type !== 'string') {
      throw new TypeError('[MessageDispatcher] Tipo de mensagem deve ser uma string não vazia.');
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`[MessageDispatcher] Handler para "${type}" deve ser uma função.`);
    }

    if (!this._handlers.has(type)) {
      this._handlers.set(type, []);
    }

    const entry = { handler, priority: Number(priority) || 0, description };
    const list = this._handlers.get(type);
    list.push(entry);
    list.sort((a, b) => b.priority - a.priority);

    return () => {
      const current = this._handlers.get(type);
      const index = current?.indexOf(entry) ?? -1;
      if (index === -1) return;
      current.splice(index, 1);
      if (!current.length) this._handlers.delete(type);
    };
  }

  /**
   * Remove um handler registrado.
   */
  unregister(type, handler) {
    if (!this._handlers.has(type)) return;
    const list = this._handlers.get(type);
    const index = list.findIndex(e => e.handler === handler);
    if (index !== -1) {
      list.splice(index, 1);
      if (list.length === 0) {
        this._handlers.delete(type);
      }
    }
  }

  /**
   * Define um handler de fallback para mensagens sem registro específico.
   */
  setFallbackHandler(handler) {
    this._fallbackHandler = typeof handler === 'function' ? handler : null;
  }

  /**
   * Verifica se a mensagem é duplicada baseado em ID.
   */
  isDuplicate(msgId) {
    if (!msgId || typeof msgId !== 'string') return false;
    return this._recentMessageIds.has(msgId);
  }

  /**
   * Marca uma mensagem como processada no histórico de deduplicação.
   */
  markProcessed(msgId) {
    if (!msgId || typeof msgId !== 'string') return;
    if (this._recentMessageIds.has(msgId)) return;

    this._recentMessageIds.add(msgId);
    this._messageIdQueue.push(msgId);

    if (this._messageIdQueue.length > this._maxHistorySize) {
      const oldest = this._messageIdQueue.shift();
      this._recentMessageIds.delete(oldest);
    }
  }

  /**
   * Despacha uma mensagem recebida para os handlers registrados.
   * Isolamento estrito: exceções em handlers NÃO propagam para o chamador.
   * 
   * @param {any} data - Dados brutos recebidos
   * @param {any} [sourceConn=null] - Conexão de origem (ex: DataConnection do PeerJS)
   * @param {Object} [options={}] - Opções adicionais (ex: checkDuplicates)
   * @returns {{ handled: boolean, duplicate: boolean, errorCount: number }}
   */
  dispatch(data, sourceConn = null, options = {}) {
    this._metrics.received++;

    if (!validateReceivedMessage(data, sourceConn)) {
      return { handled: false, duplicate: false, errorCount: 0 };
    }

    const msgId = data.msgId || data.message?.id;
    const shouldCheckDuplicate = options.checkDuplicates !== false;

    if (shouldCheckDuplicate && msgId && this.isDuplicate(msgId)) {
      this._metrics.duplicates++;
      return { handled: false, duplicate: true, errorCount: 0 };
    }

    if (msgId) {
      this.markProcessed(msgId);
    }

    const type = data.type;
    if (!type || typeof type !== 'string') {
      this._metrics.unhandled++;
      return { handled: false, duplicate: false, errorCount: 0 };
    }

    const list = this._handlers.get(type);
    let errorCount = 0;

    if (list && list.length > 0) {
      for (const entry of [...list]) {
        try {
          const res = entry.handler(data, sourceConn);
          if (res && typeof res.catch === 'function') {
            res.catch((err) => {
              this._metrics.errors++;
              console.error(`[MessageDispatcher] Erro assíncrono isolado no handler de "${type}" (${entry.description || 'anônimo'}):`, err);
            });
          }
        } catch (err) {
          errorCount++;
          this._metrics.errors++;
          console.error(`[MessageDispatcher] Erro isolado no handler de "${type}" (${entry.description || 'anônimo'}):`, err);
        }
      }
      this._metrics.dispatched++;
      return { handled: true, duplicate: false, errorCount };
    }

    if (this._fallbackHandler) {
      try {
        const res = this._fallbackHandler(data, sourceConn);
        if (res && typeof res.catch === 'function') {
          res.catch((err) => {
            this._metrics.errors++;
            console.error(`[MessageDispatcher] Erro assíncrono isolado no fallbackHandler para "${type}":`, err);
          });
        }
        this._metrics.dispatched++;
        return { handled: true, duplicate: false, errorCount: 0 };
      } catch (err) {
        this._metrics.errors++;
        console.error(`[MessageDispatcher] Erro isolado no fallbackHandler para "${type}":`, err);
        return { handled: false, duplicate: false, errorCount: 1 };
      }
    }

    this._metrics.unhandled++;
    return { handled: false, duplicate: false, errorCount: 0 };
  }

  /**
   * Retorna métricas do despachante.
   */
  getMetrics() {
    return { ...this._metrics, registeredTypes: this._handlers.size };
  }

  /**
   * Limpa handlers e histórico de IDs (para testes).
   */
  clear() {
    this._handlers.clear();
    this._recentMessageIds.clear();
    this._messageIdQueue = [];
    this._fallbackHandler = null;
  }
}

export const globalDispatcher = new MessageDispatcher();
export const p2pDispatcher = globalDispatcher;
