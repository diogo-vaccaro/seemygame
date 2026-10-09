/**
 * Cria instâncias de plugins com ciclo de vida pertencente a uma sessão.
 * Os singletons legados continuam disponíveis para a composição antiga.
 */
import { WhiteboardPlugin } from './whiteboard-plugin.js';
import { SoundboardPlugin } from './soundboard-plugin.js';
import { TacticalPingPlugin } from './ping-plugin.js';
import { ReactionsPlugin } from './reactions-plugin.js';
import { ClippingPlugin } from './clipping-plugin.js';
import { WhiteboardManager } from '../whiteboard.js';
import { SoundboardManager } from '../soundboard.js';
import { TacticalPingManager } from '../ping.js';
import { FloatingReactionsManager } from '../reactions.js';
import { ClipRecorder } from '../clipping.js';

import { RoomToolsPlugin, createRoomToolsPlugin } from './room-tools-plugin.js';

export const createWhiteboardPlugin = (options = {}) => new WhiteboardPlugin({ manager: new WhiteboardManager(), ...options });
export const createSoundboardPlugin = (options = {}) => new SoundboardPlugin({ manager: new SoundboardManager(), ...options });
export const createTacticalPingPlugin = (options = {}) => new TacticalPingPlugin({ manager: new TacticalPingManager(), ...options });
export const createReactionsPlugin = (options = {}) => new ReactionsPlugin({ manager: new FloatingReactionsManager(), ...options });
export const createClippingPlugin = (options = {}) => new ClippingPlugin({ recorder: new ClipRecorder(), ...options });
export { createRoomToolsPlugin };
