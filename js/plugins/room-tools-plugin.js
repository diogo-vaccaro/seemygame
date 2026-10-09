/**
 * SeeMyGame - RoomToolsPlugin
 * 
 * Plugin autônomo que encapsula o ciclo de vida e transporte da nova suíte
 * de ferramentas colaborativas (Snippets, Tasks, Hands, Watch Together, Transcript):
 * - Registra e desregistra manipuladores no MessageDispatcher do Kernel
 * - Conecta o transporte broadcast/sendTo do serviço compartilhado
 * - Garante descarte limpo na destruição da sessão
 */

import { BasePlugin } from './base-plugin.js';
import { createRoomToolsSuite } from '../room/tools/index.js';

export class RoomToolsPlugin extends BasePlugin {
  constructor(options = {}) {
    super('room-tools', options);
    this.suite = null;
    this._dispatcherUnsubs = [];
  }

  setupListeners() {
    const dispatcher = this.context?.dispatcher;
    const broadcast = (data) => this.context?.broadcastDataMessage?.(data);
    const sendTo = (peerId, data) => {
      // Procura conexão específica se houver ou usa broadcast
      const conn = this.context?.getConnection?.(peerId);
      if (conn?.send) {
        conn.send(data);
      } else {
        broadcast(data);
      }
    };

    const isHostResolver = () => {
      if (typeof this.context?.isHost === 'function') return this.context.isHost();
      return Boolean(
        this.context?.role === 'streamer' ||
        this.context?.role === 'host' ||
        this.context?.isMaster ||
        this.context?.session?.isMaster
      );
    };

    const isReadonlyResolver = () => {
      if (typeof this.context?.isReadonly === 'function') return this.context.isReadonly();
      return Boolean(
        this.context?.role === 'readonly-viewer' ||
        this.context?.role === 'readonly' ||
        this.context?.isReadonly
      );
    };

    this.suite = createRoomToolsSuite({
      isHost: isHostResolver,
      getLocalPeerId: () => this.context?.getPeerId?.() || 'me',
      getDisplayName: () => this.context?.getDisplayName?.() || 'Jogador',
      getCoordinatorPeerId: () => this.context?.getCoordinatorPeerId?.() || null,
      getIsReadonly: isReadonlyResolver,
      broadcast,
      sendTo,
      roomEpoch: this.context?.roomEpoch || 'session-epoch'
    });

    this.suite.service.setBroadcast(broadcast);
    this.suite.service.setSendTo(sendTo);

    if (dispatcher) {
      const toolTypes = [
        'TOOL_PROPOSAL',
        'TOOL_CONFIRM',
        'TOOL_REJECT',
        'TOOL_REQUEST_SYNC',
        'TOOL_SYNC'
      ];

      for (const type of toolTypes) {
        const unsub = dispatcher.register(
          type,
          (data, sourceConn) => {
            this.suite.service.handleRemoteMessage(data, sourceConn?.peer, sourceConn);
          },
          { description: `RoomTools: ${type}` }
        );
        this._dispatcherUnsubs.push(unsub);
      }
    }

    this.registerCleanup(() => {
      this._dispatcherUnsubs.forEach(unsub => unsub());
      this._dispatcherUnsubs = [];
      if (this.suite) {
        this.suite.dispose();
        this.suite = null;
      }
    });
  }
}

export function createRoomToolsPlugin(options = {}) {
  return new RoomToolsPlugin(options);
}
