/**
 * SeeMyGame - PluginManager (Kernel Core)
 * 
 * Gerenciador de ciclo de vida de plugins. Permite registro,
 * inicialização unificada e encerramento ordenado com barreira de falha.
 */

import { globalBus } from './event-bus.js';
import { globalDispatcher } from './message-dispatcher.js';

export class PluginManager {
  constructor({ eventBus = null, dispatcher = null } = {}) {
    this.eventBus = eventBus || globalBus;
    this.dispatcher = dispatcher || globalDispatcher;
    this.plugins = new Map(); // name -> pluginInstance
    this.activePlugins = new Set();
  }

  /**
   * Registra um plugin no gerenciador.
   * @param {import('../plugins/base-plugin.js').BasePlugin} plugin
   * @returns {import('../plugins/base-plugin.js').BasePlugin}
   */
  register(plugin) {
    if (!plugin || !plugin.name) {
      throw new TypeError('[PluginManager] Plugin inválido fornecido.');
    }
    if (this.plugins.has(plugin.name) && this.plugins.get(plugin.name) !== plugin) {
      throw new Error(`[PluginManager] Plugin "${plugin.name}" já registrado.`);
    }
    this.plugins.set(plugin.name, plugin);
    return plugin;
  }

  /**
   * Inicializa todos os plugins registrados injetando o contexto do Kernel.
   * @param {Object} [customContext={}]
   */
  initAll(customContext = {}) {
    const mergedContext = {
      eventBus: this.eventBus,
      dispatcher: this.dispatcher,
      ...customContext
    };

    for (const [name, plugin] of this.plugins.entries()) {
      if (this.activePlugins.has(plugin)) continue;
      try {
        const initialized = plugin.init(mergedContext);
        // Só destrói instâncias cuja inicialização este manager efetivamente
        // assumiu; um plugin BasePlugin já ativo em outra sessão retorna false.
        if (initialized !== false) this.activePlugins.add(plugin);
      } catch (err) {
        console.error(`[PluginManager] Falha ao inicializar o plugin "${name}":`, err);
      }
    }
  }

  /**
   * Retorna um plugin pelo seu nome.
   * @param {string} name
   */
  get(name) {
    return this.plugins.get(name);
  }

  /**
   * Encerra um plugin individualmente.
   * @param {string} name
   */
  destroy(name) {
    const plugin = this.plugins.get(name);
    if (plugin) {
      this.plugins.delete(name);
      if (this.activePlugins.delete(plugin)) {
        try {
          return Promise.resolve(plugin.destroy()).catch(error => {
            this.eventBus.emit('system:error', { sourceEvent: 'plugin:destroy', plugin: name, error });
          });
        } catch (err) {
          console.error(`[PluginManager] Falha ao encerrar o plugin "${name}":`, err);
        }
      }
    }
  }

  /**
   * Encerra todos os plugins registrados.
   */
  destroyAll() {
    const pending = [];
    const active = [...this.activePlugins];
    this.activePlugins.clear();
    this.plugins.clear();
    for (const plugin of active) {
      try {
        const result = plugin.destroy();
        if (result?.then) pending.push(Promise.resolve(result).catch(error => {
          this.eventBus.emit('system:error', { sourceEvent: 'plugin:destroy', plugin: plugin.name, error });
        }));
      } catch (err) {
        console.error(`[PluginManager] Falha ao encerrar o plugin "${plugin.name}":`, err);
      }
    }
    return Promise.allSettled(pending);
  }
}

export const pluginManager = new PluginManager();
export const globalPluginManager = pluginManager;
