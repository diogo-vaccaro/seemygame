/**
 * SeeMyGame - Room Tools Suite Facade
 * 
 * Agrega e orquestra a nova suíte de ferramentas colaborativas da sala:
 * - SharedToolsService (Fundação comum com propostas, confirmações e snapshots)
 * - SnippetsManager (Binds, scripts e configs colaborativos com lease)
 * - TasksManager (Checklist colaborativo de objetivos e etapas com tombstones)
 * - HandsManager (Levantar a mão, fila de fala e moderação de áudio)
 * - WatchTogetherController (Co-visualização de YouTube gravado e MP4)
 * - TranscriptManager (Legendas em tempo real e exportação de transcrições)
 */

export { SharedToolsService } from './shared-tools-service.js';
export { SnippetsManager, ALLOWED_LANGUAGES, MAX_SNIPPET_BYTES, MAX_AGGREGATE_BYTES } from './snippets.js';
export { TasksManager, MAX_ROOM_TASKS, MAX_TASK_TITLE_CHARS, MAX_TASK_DESC_CHARS } from './tasks.js';
export { HandsManager } from './hands.js';
export { WatchTogetherController } from './watch-together.js';
export { TranscriptManager } from './transcript.js';

import { SharedToolsService } from './shared-tools-service.js';
import { SnippetsManager } from './snippets.js';
import { TasksManager } from './tasks.js';
import { HandsManager } from './hands.js';
import { WatchTogetherController } from './watch-together.js';
import { TranscriptManager } from './transcript.js';

/**
 * Cria a suíte completa de ferramentas colaborativas vinculada ao ciclo de vida da sessão.
 */
export function createRoomToolsSuite(options = {}) {
  const service = new SharedToolsService(options);

  const snippets = new SnippetsManager({
    service,
    getLocalPeerId: options.getLocalPeerId,
    getDisplayName: options.getDisplayName,
    isHost: options.isHost,
    getIsReadonly: options.getIsReadonly
  });

  const tasks = new TasksManager({
    service,
    getLocalPeerId: options.getLocalPeerId,
    getDisplayName: options.getDisplayName,
    isHost: options.isHost,
    getIsReadonly: options.getIsReadonly,
    getActivePeers: options.getActivePeers
  });

  const hands = new HandsManager({
    service,
    getLocalPeerId: options.getLocalPeerId,
    getDisplayName: options.getDisplayName,
    isHost: options.isHost,
    getCoordinatorPeerId: options.getCoordinatorPeerId,
    getIsReadonly: options.getIsReadonly
  });

  const watchTogether = new WatchTogetherController({
    service,
    getLocalPeerId: options.getLocalPeerId,
    getDisplayName: options.getDisplayName,
    isHost: options.isHost,
    getCoordinatorPeerId: options.getCoordinatorPeerId,
    getIsReadonly: options.getIsReadonly
  });

  const transcript = new TranscriptManager({
    service,
    getLocalPeerId: options.getLocalPeerId,
    getDisplayName: options.getDisplayName,
    isHost: options.isHost,
    getIsReadonly: options.getIsReadonly,
    lang: options.lang || 'pt-BR',
    roomClockStart: options.roomClockStart
  });

  return {
    service,
    snippets,
    tasks,
    hands,
    watchTogether,
    transcript,
    handlePeerDisconnected(peerId) {
      snippets.handlePeerDisconnected(peerId);
      hands.handlePeerDisconnected(peerId);
    },
    dispose() {
      snippets.dispose();
      tasks.dispose();
      hands.dispose();
      watchTogether.destroy();
      transcript.dispose();
      service.dispose();
    }
  };
}
