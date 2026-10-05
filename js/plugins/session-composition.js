import { SoundboardManager } from '../soundboard.js';
import { TacticalPingManager } from '../ping.js';
import { ClipRecorderRegistry } from '../clipping.js';
import {
  createWhiteboardPlugin,
  createSoundboardPlugin,
  createTacticalPingPlugin,
  createReactionsPlugin,
  createClippingPlugin
} from './factories.js';
import { bindWhiteboardUI } from '../whiteboard-ui.js';
import { bindClipEditor } from '../clipping/editor-controller.js';
import { NativeMediaPlugin } from './native-media-plugin.js';
import { nativeReplayContext } from '../clipping/native-context.js';
import { bindControllerLab } from '../controller-lab/index.js';
import { toggleCoopCardControl } from '../coop/card-action.js';

export function registerSessionFeatures(session, {
  role,
  broadcastDataMessage = () => {},
  getViewersCount = () => 0,
  getDisplayName = () => 'Jogador',
  showToast = () => {},
  chatManager = null,
  getPeerId = () => null,
  getRole = () => 'viewer',
  includeClipping = false,
  getCaptureProvider = () => null,
  getConnections = () => [],
  isAuthorizedPeer = () => false
} = {}) {
  const plugins = [
    createWhiteboardPlugin(),
    createSoundboardPlugin({ manager: new SoundboardManager({ audioScope: session.audioScope }) }),
    createTacticalPingPlugin({ manager: new TacticalPingManager({ audioScope: session.audioScope }) }),
    createReactionsPlugin()
  ];
  if (includeClipping) plugins.push(createClippingPlugin({ recorder: new ClipRecorderRegistry({ audioScope: session.audioScope,
    getNativeContext: sourceId => nativeReplayContext(sourceId, getCaptureProvider())
  }) }));
  plugins.push(new NativeMediaPlugin({ session, getProvider: getCaptureProvider, isAuthorized: isAuthorizedPeer,
    onClip: sourceId => session.state.features?.clipEditor?.exportClip(sourceId),
    onCoop: peerId => toggleCoopCardControl(session.services?.coopController, peerId, [...getConnections()].find(conn => conn.peer === peerId))
  }));
  for (const plugin of plugins) session.pluginManager.register(plugin);

  session.pluginManager.initAll({
    role,
    broadcastDataMessage,
    getViewersCount,
    getDisplayName,
    getPeerId,
    getRole,
    canUseTacticalPing: () => !session.services?.coopController?.getCoopState?.().isPlayer2,
    isRoomMode: () => role === 'room',
    isTrustedLaserRelayPeer: peerId => role === 'viewer' && isAuthorizedPeer(peerId),
    audioScope: session.audioScope,
    showToast
  });

  const whiteboard = session.pluginManager.get('whiteboard');
  const ping = session.pluginManager.get('tactical-ping');
  const reactions = session.pluginManager.get('reactions');
  const getElement = (id) => typeof document !== 'undefined' ? document.getElementById(id) : null;
  whiteboard?.manager.setCanvas?.(getElement('whiteboard-canvas'));
  ping?.bindCanvas(getElement('ping-canvas'));
  reactions?.bindDOM(
    getElement('reactions-overlay'),
    getElement('reactions-dock')
  );
  const whiteboardUI = bindWhiteboardUI(whiteboard?.manager, {
    broadcast: broadcastDataMessage,
    chatManager,
    peerId: getPeerId,
    displayName: getDisplayName,
    role: getRole,
    showToast
  });
  session.registerCleanup(() => whiteboardUI.destroy());
  const soundboard = session.pluginManager.get('soundboard');
  const clipping = session.pluginManager.get('clipping');
  const clipEditor = clipping && typeof document !== 'undefined' ? bindClipEditor(session, {
    recorder: clipping.recorder, soundboardManager: soundboard?.manager,
    showToast, broadcastDataMessage, getPeerId
  }) : null;
  const controllerLab = typeof document !== 'undefined' ? bindControllerLab(session, {
    getPeerId: () => session.getPeerId?.() || null, getDisplayName, getConnections, isAuthorizedPeer,
    canInvite: role !== 'viewer', canManageAccess: role === 'streamer' || role === 'room',
    showToast, coopController: session.services?.coopController
  }) : null;
  return { plugins, whiteboard, whiteboardUI, soundboard, ping, reactions, clipping, clipEditor, controllerLab, nativeMedia: session.pluginManager.get('native-media') };
}
