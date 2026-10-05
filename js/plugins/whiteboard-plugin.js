/**
 * SeeMyGame - WhiteboardPlugin (Isolated Feature Plugin)
 * 
 * Encapsula o ciclo de vida da lousa colaborativa vetorial (Excalidraw-style),
 * registro de mensagens P2P na rede e listeners de canvas.
 */

import { BasePlugin } from './base-plugin.js';
import { whiteboardManager } from '../whiteboard.js';
import { createWhiteboardTransfers, sendWhiteboardImage, sendWhiteboardSnapshot } from '../whiteboard/transfer.js';
import { isValidPeerId } from '../shared/peer-id.js';

export class WhiteboardPlugin extends BasePlugin {
  constructor(options = {}) {
    super('whiteboard', options);
    this.manager = options.manager || whiteboardManager;
    this.ownsManager = Boolean(options.manager);
    this._dispatcherUnsubs = [];
  }

  setupListeners() {
    const dispatcher = this.context?.dispatcher;
    const shouldRelay = () => !this.context?.isRoomMode?.() && (this.context?.getViewersCount?.() > 0);
    const broadcast = (data, excludePeer) => this.context?.broadcastDataMessage?.(data, excludePeer);

    if (dispatcher) {
      const transfers = createWhiteboardTransfers(this.manager, {
        onSnapshotApplied: (elements, sourceConn) => {
          if (shouldRelay()) sendWhiteboardSnapshot(elements, data => broadcast(data, sourceConn?.peer));
        },
        relayImage: (element, isUpdate, sourceConn) => {
          if (shouldRelay()) sendWhiteboardImage(element, data => broadcast(data, sourceConn?.peer), { isUpdate });
        }
      });
      this.registerCleanup(() => transfers.dispose());

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_ELEMENT_CHUNK', (data, sourceConn) => transfers.receiveChunk(data, sourceConn),
          { description: 'Whiteboard: Element Chunk' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_ELEMENT_ADD', (data, sourceConn) => {
          const exists = this.manager.elements.some(el => el.id === data.element?.id);
          if (!exists && data.element) {
            this.manager.addElement(data.element, false);
            if (shouldRelay()) broadcast(data, sourceConn?.peer);
          }
        }, { description: 'Whiteboard: Element Add' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_ELEMENT_UPDATE', (data, sourceConn) => {
          if (data.element) {
            this.manager.updateElement(data.element, false);
            if (shouldRelay()) broadcast(data, sourceConn?.peer);
          }
        }, { description: 'Whiteboard: Element Update' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_ELEMENT_DELETE', (data, sourceConn) => {
          const exists = this.manager.elements.some(el => el.id === data.elementId);
          if (exists) {
            this.manager.removeElement(data.elementId, false);
            if (shouldRelay()) broadcast(data, sourceConn?.peer);
          }
        }, { description: 'Whiteboard: Element Delete' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_CLEAR', (data, sourceConn) => {
          this.manager.clear(false);
          if (shouldRelay()) broadcast(data, sourceConn?.peer);
        }, { description: 'Whiteboard: Clear' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_CURSOR', (data, sourceConn) => {
          const transportPeer = sourceConn?.peer;
          if (!isValidPeerId(transportPeer)) return;
          const trustedRelay = this.context?.isTrustedWhiteboardRelayPeer?.(transportPeer) && data.relayedBy === transportPeer;
          const author = trustedRelay ? data.peerId : transportPeer;
          if (!isValidPeerId(author)) return;
          this.manager.updateRemoteCursor(author, {
            x: data.x,
            y: data.y,
            userName: data.userName,
            color: data.color
          });
          if (shouldRelay()) broadcast({ ...data, peerId: author, relayedBy: this.context?.getPeerId?.() }, transportPeer);
        }, { description: 'Whiteboard: Cursor Movement' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_REQUEST_SYNC', (data, sourceConn) => {
          if (sourceConn && sourceConn.open) {
            sendWhiteboardSnapshot(this.manager.elements || [], data => sourceConn.send(data));
          }
        }, { description: 'Whiteboard: Request Sync' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_SYNC', (data, sourceConn) => transfers.receiveFull(data, sourceConn),
          { description: 'Whiteboard: Full Sync' })
      );

      this._dispatcherUnsubs.push(
        dispatcher.register('WHITEBOARD_SYNC_BATCH', (data, sourceConn) => transfers.receiveBatch(data, sourceConn),
          { description: 'Whiteboard: Batch Sync' }),
        dispatcher.register('WHITEBOARD_SYNC_END', (data, sourceConn) => transfers.endSnapshot(data, sourceConn),
          { description: 'Whiteboard: Snapshot Complete' })
      );
    }

    this.registerCleanup(() => {
      this._dispatcherUnsubs.forEach(unsub => unsub());
      this._dispatcherUnsubs = [];
    });
  }

  destroy() {
    super.destroy();
    // Limpa referências ativas no manager para liberar GC
    this.manager.onElementCreated = null;
    this.manager.onElementUpdated = null;
    this.manager.onElementDeleted = null;
    this.manager.onBoardCleared = null;
    this.manager.onCursorMoved = null;
    this.manager.onToolChanged = null;
    if (this.ownsManager) this.manager.dispose?.();
  }
}

export const whiteboardPlugin = new WhiteboardPlugin();
