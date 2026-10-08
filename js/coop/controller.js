import { showToast } from ".././ui.js";
import {
  isNativeGamepadAvailable,
  plugVirtualGamepad,
  updateVirtualGamepad,
  unplugVirtualGamepad,
  unplugAllVirtualGamepads,
  checkVirtualGamepadDriver,
  installViGEmDriver,
  testGamepadVibration,
  getXInputGamepads
} from ".././desktop.js";
import { isTauriEnvironment as isTauriEnvironmentImpl, triggerGamepadRumble as triggerGamepadRumbleImpl, setCoopInputTarget as setCoopInputTargetImpl, initCompanionAgentConnection as initCompanionAgentConnectionImpl, isCompanionAgentRunning as isCompanionAgentRunningImpl, sendCompanionReset as sendCompanionResetImpl, closeCompanionAgentConnection as closeCompanionAgentConnectionImpl, dispatchHostKeyboardInput as dispatchHostKeyboardInputImpl, dispatchHostMouseInput as dispatchHostMouseInputImpl, dispatchHostGamepadInput as dispatchHostGamepadInputImpl, dispatchHostInputReset as dispatchHostInputResetImpl } from './transport.js';
import { reconcileCoopSlots as reconcileCoopSlotsImpl, setMaxCoopPlayers as setMaxCoopPlayersImpl, getMaxCoopPlayers as getMaxCoopPlayersImpl, setPartyModeEnabled as setPartyModeEnabledImpl, isPartyModeEnabled as isPartyModeEnabledImpl, registerCoopBroadcastHandler as registerCoopBroadcastHandlerImpl, broadcastSlotsUpdate as broadcastSlotsUpdateImpl, getCoopSlots as getCoopSlotsImpl, getNextAvailableSlot as getNextAvailableSlotImpl, registerCoopPromptHandler as registerCoopPromptHandlerImpl, registerCoopStateChangeHandler as registerCoopStateChangeHandlerImpl, notifyStateChange as notifyStateChangeImpl, setCoopEnabled as setCoopEnabledImpl, getCoopState as getCoopStateImpl } from './slots.js';
import { handleHostCoopMessage as handleHostCoopMessageImpl, grantCoopPlayer as grantCoopPlayerImpl, revokeCoopPlayer as revokeCoopPlayerImpl, revokeAllCoopPlayers as revokeAllCoopPlayersImpl, revokePlayer2 as revokePlayer2Impl } from './host.js';
import { requestCoopControl as requestCoopControlImpl, handleViewerCoopMessage as handleViewerCoopMessageImpl, releaseCoopControl as releaseCoopControlImpl } from './viewer.js';
import { handleKeyDown as handleKeyDownImpl, handleKeyUp as handleKeyUpImpl, focusControlWrapper as focusControlWrapperImpl, handleControlVisibilityChange as handleControlVisibilityChangeImpl, handleMouseMove as handleMouseMoveImpl, handleMouseDown as handleMouseDownImpl, handleMouseUp as handleMouseUpImpl, loadGamepadMappingFromStorage as loadGamepadMappingFromStorageImpl, saveGamepadMappingToStorage as saveGamepadMappingToStorageImpl, getGamepadMapping as getGamepadMappingImpl, setGamepadMappingPreset as setGamepadMappingPresetImpl, swapGamepadButtons as swapGamepadButtonsImpl, resetGamepadMapping as resetGamepadMappingImpl, applyButtonMapping as applyButtonMappingImpl, pollGamepads as pollGamepadsImpl, attachPlayer2InputListeners as attachPlayer2InputListenersImpl, detachPlayer2InputListeners as detachPlayer2InputListenersImpl, detectGamepadType as detectGamepadTypeImpl, getButtonDisplayLabel as getButtonDisplayLabelImpl } from './input.js';
import { normalizeTargetRect as normalizeTargetRectImpl, applyRadialDeadzone as applyRadialDeadzoneImpl } from './mapping.js';
import { setupGamepadTesterModal as setupGamepadTesterModalImpl } from './tester-controller.js';

/** Creates a runtime whose state and resource lifetime belong to one session. */
export function createCoopController(options = {}) {
let inputTestMode = false;

function sendControllerMessage(connection, message) {
  if (inputTestMode && message.type?.startsWith('INPUT_')) return false;
  return options.sendMessage ? options.sendMessage(connection, message) : connection.send(message);
}

const compatibilityPorts = Object.defineProperties({}, {
"sendMessage": { get: () => sendControllerMessage },
"showToast": { get: () => showToast },
"isNativeGamepadAvailable": { get: () => isNativeGamepadAvailable },
"plugVirtualGamepad": { get: () => plugVirtualGamepad },
"updateVirtualGamepad": { get: () => updateVirtualGamepad },
"unplugVirtualGamepad": { get: () => unplugVirtualGamepad },
"unplugAllVirtualGamepads": { get: () => unplugAllVirtualGamepads },
"checkVirtualGamepadDriver": { get: () => checkVirtualGamepadDriver },
"installViGEmDriver": { get: () => installViGEmDriver },
"testGamepadVibration": { get: () => testGamepadVibration },
"getXInputGamepads": { get: () => getXInputGamepads },
"isCoopEnabled": { get: () => isCoopEnabled, set: value => { isCoopEnabled = value; } },
"maxCoopPlayers": { get: () => maxCoopPlayers, set: value => { maxCoopPlayers = value; } },
"partyModeEnabled": { get: () => partyModeEnabled, set: value => { partyModeEnabled = value; } },
"coopSlots": { get: () => coopSlots },
"activePlayer2PeerId": { get: () => activePlayer2PeerId, set: value => { activePlayer2PeerId = value; } },
"isPlayer2": { get: () => isPlayer2, set: value => { isPlayer2 = value; } },
"myAssignedSlot": { get: () => myAssignedSlot, set: value => { myAssignedSlot = value; } },
"activeHostPeerId": { get: () => activeHostPeerId, set: value => { activeHostPeerId = value; } },
"activeDataConn": { get: () => activeDataConn, set: value => { activeDataConn = value; } },
"companionSocket": { get: () => companionSocket, set: value => { companionSocket = value; } },
"isCompanionConnected": { get: () => isCompanionConnected, set: value => { isCompanionConnected = value; } },
"companionCapabilities": { get: () => companionCapabilities, set: value => { companionCapabilities = value; } },
"onPromptCallback": { get: () => onPromptCallback, set: value => { onPromptCallback = value; } },
"onStateChangeCallback": { get: () => onStateChangeCallback, set: value => { onStateChangeCallback = value; } },
"broadcastSlotsCallback": { get: () => broadcastSlotsCallback, set: value => { broadcastSlotsCallback = value; } },
"gamepadLoopId": { get: () => gamepadLoopId, set: value => { gamepadLoopId = value; } },
"lastGamepadState": { get: () => lastGamepadState, set: value => { lastGamepadState = value; } },
"selectedGamepadIndex": { get: () => selectedGamepadIndex },
"setSelectedGamepadIndex": { get: () => setSelectedGamepadIndex },
"getSelectedGamepadIndex": { get: () => getSelectedGamepadIndex },
"pressedBrowserKeys": { get: () => pressedBrowserKeys },
"slotPressedKeys": { get: () => slotPressedKeys },
"capabilityWarningShown": { get: () => capabilityWarningShown, set: value => { capabilityWarningShown = value; } },
"activeHostCapabilities": { get: () => activeHostCapabilities, set: value => { activeHostCapabilities = value; } },
"controlVisibilityTarget": { get: () => controlVisibilityTarget, set: value => { controlVisibilityTarget = value; } },
"coopInputTargetRect": { get: () => coopInputTargetRect, set: value => { coopInputTargetRect = value; } },
"nextCoopSlotGeneration": { get: () => nextCoopSlotGeneration, set: value => { nextCoopSlotGeneration = value; } },
"normalizeTargetRect": { get: () => normalizeTargetRect },
"isTauriEnvironment": { get: () => isTauriEnvironment },
"applyRadialDeadzone": { get: () => applyRadialDeadzone },
"triggerGamepadRumble": { get: () => triggerGamepadRumble },
"setCoopInputTarget": { get: () => setCoopInputTarget },
"initCompanionAgentConnection": { get: () => initCompanionAgentConnection },
"isCompanionAgentRunning": { get: () => isCompanionAgentRunning },
"reconcileCoopSlots": { get: () => reconcileCoopSlots },
"setMaxCoopPlayers": { get: () => setMaxCoopPlayers },
"getMaxCoopPlayers": { get: () => getMaxCoopPlayers },
"setPartyModeEnabled": { get: () => setPartyModeEnabled },
"isPartyModeEnabled": { get: () => isPartyModeEnabled },
"registerCoopBroadcastHandler": { get: () => registerCoopBroadcastHandler },
"broadcastSlotsUpdate": { get: () => broadcastSlotsUpdate },
"getCoopSlots": { get: () => getCoopSlots },
"getNextAvailableSlot": { get: () => getNextAvailableSlot },
"registerCoopPromptHandler": { get: () => registerCoopPromptHandler },
"registerCoopStateChangeHandler": { get: () => registerCoopStateChangeHandler },
"notifyStateChange": { get: () => notifyStateChange },
"setCoopEnabled": { get: () => setCoopEnabled },
"getCoopState": { get: () => getCoopState },
"handleHostCoopMessage": { get: () => handleHostCoopMessage },
"revokeCoopPlayer": { get: () => revokeCoopPlayer },
"revokeAllCoopPlayers": { get: () => revokeAllCoopPlayers },
"revokePlayer2": { get: () => revokePlayer2 },
"sendCompanionReset": { get: () => sendCompanionReset },
"closeCompanionAgentConnection": { get: () => closeCompanionAgentConnection },
"dispatchHostKeyboardInput": { get: () => dispatchHostKeyboardInput },
"dispatchHostMouseInput": { get: () => dispatchHostMouseInput },
"dispatchHostGamepadInput": { get: () => dispatchHostGamepadInput },
"dispatchHostInputReset": { get: () => dispatchHostInputReset },
"requestCoopControl": { get: () => requestCoopControl },
"handleViewerCoopMessage": { get: () => handleViewerCoopMessage },
"releaseCoopControl": { get: () => releaseCoopControl },
"attachedCard": { get: () => attachedCard, set: value => { attachedCard = value; } },
"handleKeyDown": { get: () => handleKeyDown },
"handleKeyUp": { get: () => handleKeyUp },
"focusControlWrapper": { get: () => focusControlWrapper },
"handleControlVisibilityChange": { get: () => handleControlVisibilityChange },
"handleMouseMove": { get: () => handleMouseMove },
"handleMouseDown": { get: () => handleMouseDown },
"handleMouseUp": { get: () => handleMouseUp },
"DEFAULT_BUTTON_MAP": { get: () => DEFAULT_BUTTON_MAP },
"NINTENDO_BUTTON_MAP": { get: () => NINTENDO_BUTTON_MAP },
"currentGamepadMapping": { get: () => currentGamepadMapping, set: value => { currentGamepadMapping = value; } },
"currentMappingPreset": { get: () => currentMappingPreset, set: value => { currentMappingPreset = value; } },
"loadGamepadMappingFromStorage": { get: () => loadGamepadMappingFromStorage },
"saveGamepadMappingToStorage": { get: () => saveGamepadMappingToStorage },
"getGamepadMapping": { get: () => getGamepadMapping },
"setGamepadMappingPreset": { get: () => setGamepadMappingPreset },
"swapGamepadButtons": { get: () => swapGamepadButtons },
"resetGamepadMapping": { get: () => resetGamepadMapping },
"applyButtonMapping": { get: () => applyButtonMapping },
"pollGamepads": { get: () => pollGamepads },
"attachPlayer2InputListeners": { get: () => attachPlayer2InputListeners },
"detachPlayer2InputListeners": { get: () => detachPlayer2InputListeners },
"setupGamepadTesterModal": { get: () => setupGamepadTesterModal },
"detectGamepadType": { get: () => detectGamepadType },
"getButtonDisplayLabel": { get: () => getButtonDisplayLabel }
});

let isCoopEnabled = true;

let maxCoopPlayers = 1;

let partyModeEnabled = false;

const coopSlots = new Map();

let activePlayer2PeerId = null;

let isPlayer2 = false;

let myAssignedSlot = null;

let activeHostPeerId = null;

let activeDataConn = null;

let companionSocket = null;

let isCompanionConnected = false;

let companionCapabilities = {
  keyboard: false,
  mouse: false,
  gamepad: false,
  mouseCoordinateSpace: 'primary-screen'
};

let onPromptCallback = null;

let onStateChangeCallback = null;

let broadcastSlotsCallback = null;

let gamepadLoopId = null;

let lastGamepadState = null;
let selectedGamepadIndex = null;

function setSelectedGamepadIndex(index) {
  if (index === null || (Number.isInteger(index) && index >= 0)) selectedGamepadIndex = index;
}
function getSelectedGamepadIndex() { return selectedGamepadIndex; }

const pressedBrowserKeys = new Set();

const slotPressedKeys = new Map();

let capabilityWarningShown = false;

let activeHostCapabilities = { keyboard: true, mouse: false, gamepad: false };

let controlVisibilityTarget = null;

let coopInputTargetRect = null;

let nextCoopSlotGeneration = 0;

function normalizeTargetRect(...args) { return normalizeTargetRectImpl(compatibilityPorts, ...args); }

function isTauriEnvironment(...args) { return isTauriEnvironmentImpl(compatibilityPorts, ...args); }

function applyRadialDeadzone(...args) { return applyRadialDeadzoneImpl(compatibilityPorts, ...args); }

function triggerGamepadRumble(...args) { return triggerGamepadRumbleImpl(compatibilityPorts, ...args); }

function setCoopInputTarget(...args) { return setCoopInputTargetImpl(compatibilityPorts, ...args); }

function initCompanionAgentConnection(...args) { return initCompanionAgentConnectionImpl(compatibilityPorts, ...args); }

function isCompanionAgentRunning(...args) { return isCompanionAgentRunningImpl(compatibilityPorts, ...args); }

function reconcileCoopSlots(...args) { return reconcileCoopSlotsImpl(compatibilityPorts, ...args); }

function setMaxCoopPlayers(...args) { return setMaxCoopPlayersImpl(compatibilityPorts, ...args); }

function getMaxCoopPlayers(...args) { return getMaxCoopPlayersImpl(compatibilityPorts, ...args); }

function setPartyModeEnabled(...args) { return setPartyModeEnabledImpl(compatibilityPorts, ...args); }

function isPartyModeEnabled(...args) { return isPartyModeEnabledImpl(compatibilityPorts, ...args); }

function registerCoopBroadcastHandler(...args) { return registerCoopBroadcastHandlerImpl(compatibilityPorts, ...args); }

function broadcastSlotsUpdate(...args) { return broadcastSlotsUpdateImpl(compatibilityPorts, ...args); }

function getCoopSlots(...args) { return getCoopSlotsImpl(compatibilityPorts, ...args); }

function getNextAvailableSlot(...args) { return getNextAvailableSlotImpl(compatibilityPorts, ...args); }

function registerCoopPromptHandler(...args) { return registerCoopPromptHandlerImpl(compatibilityPorts, ...args); }

function registerCoopStateChangeHandler(...args) { return registerCoopStateChangeHandlerImpl(compatibilityPorts, ...args); }

function notifyStateChange(...args) { return notifyStateChangeImpl(compatibilityPorts, ...args); }

function setCoopEnabled(...args) { return setCoopEnabledImpl(compatibilityPorts, ...args); }

function getCoopState(...args) { return getCoopStateImpl(compatibilityPorts, ...args); }

function handleHostCoopMessage(...args) {
  if (inputTestMode && args[1]?.type?.startsWith('INPUT_')) return;
  return handleHostCoopMessageImpl(compatibilityPorts, ...args);
}

function setInputTestMode(enabled) {
  const next = Boolean(enabled);
  if (next === inputTestMode) return;
  if (next) {
    // Release held inputs before pausing, retaining slots and virtual devices.
    if (isPlayer2 && activeDataConn) sendControllerMessage(activeDataConn, { type: 'INPUT_RESET', slot: myAssignedSlot ?? 1, preserveGamepads: true });
    dispatchHostInputReset({ unplugVirtualGamepads: false });
  }
  inputTestMode = next;
  lastGamepadState = null;
}

function revokeCoopPlayer(...args) { return revokeCoopPlayerImpl(compatibilityPorts, ...args); }

function grantCoopPlayer(...args) { return grantCoopPlayerImpl(compatibilityPorts, ...args); }

function revokeAllCoopPlayers(...args) { return revokeAllCoopPlayersImpl(compatibilityPorts, ...args); }

function revokePlayer2(...args) { return revokePlayer2Impl(compatibilityPorts, ...args); }

function sendCompanionReset(...args) { return sendCompanionResetImpl(compatibilityPorts, ...args); }

function closeCompanionAgentConnection(...args) { return closeCompanionAgentConnectionImpl(compatibilityPorts, ...args); }

function dispatchHostKeyboardInput(...args) { return dispatchHostKeyboardInputImpl(compatibilityPorts, ...args); }

function dispatchHostMouseInput(...args) { return dispatchHostMouseInputImpl(compatibilityPorts, ...args); }

function dispatchHostGamepadInput(...args) { return dispatchHostGamepadInputImpl(compatibilityPorts, ...args); }

function dispatchHostInputReset(...args) { return dispatchHostInputResetImpl(compatibilityPorts, ...args); }

function requestCoopControl(...args) { return requestCoopControlImpl(compatibilityPorts, ...args); }

function handleViewerCoopMessage(...args) { return handleViewerCoopMessageImpl(compatibilityPorts, ...args); }

function releaseCoopControl(...args) { return releaseCoopControlImpl(compatibilityPorts, ...args); }

let attachedCard = null;

function handleKeyDown(...args) { return handleKeyDownImpl(compatibilityPorts, ...args); }

function handleKeyUp(...args) { return handleKeyUpImpl(compatibilityPorts, ...args); }

function focusControlWrapper(...args) { return focusControlWrapperImpl(compatibilityPorts, ...args); }

function handleControlVisibilityChange(...args) { return handleControlVisibilityChangeImpl(compatibilityPorts, ...args); }

function handleMouseMove(...args) { return handleMouseMoveImpl(compatibilityPorts, ...args); }

function handleMouseDown(...args) { return handleMouseDownImpl(compatibilityPorts, ...args); }

function handleMouseUp(...args) { return handleMouseUpImpl(compatibilityPorts, ...args); }

const DEFAULT_BUTTON_MAP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

const NINTENDO_BUTTON_MAP = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

let currentGamepadMapping = [...DEFAULT_BUTTON_MAP];

let currentMappingPreset = 'xbox';

function loadGamepadMappingFromStorage(...args) { return loadGamepadMappingFromStorageImpl(compatibilityPorts, ...args); }

function saveGamepadMappingToStorage(...args) { return saveGamepadMappingToStorageImpl(compatibilityPorts, ...args); }

function getGamepadMapping(...args) { return getGamepadMappingImpl(compatibilityPorts, ...args); }

function setGamepadMappingPreset(...args) { return setGamepadMappingPresetImpl(compatibilityPorts, ...args); }

function swapGamepadButtons(...args) { return swapGamepadButtonsImpl(compatibilityPorts, ...args); }

function resetGamepadMapping(...args) { return resetGamepadMappingImpl(compatibilityPorts, ...args); }

function applyButtonMapping(...args) { return applyButtonMappingImpl(compatibilityPorts, ...args); }

loadGamepadMappingFromStorage();

function pollGamepads(...args) { return pollGamepadsImpl(compatibilityPorts, ...args); }

function attachPlayer2InputListeners(...args) { return attachPlayer2InputListenersImpl(compatibilityPorts, ...args); }

function detachPlayer2InputListeners(...args) { return detachPlayer2InputListenersImpl(compatibilityPorts, ...args); }

let testerCleanup = null;
let testerModal = null;
function setupGamepadTesterModal(...args) {
  const current = typeof document !== 'undefined' ? document.getElementById('gamepad-tester-modal') : null;
  if (current !== testerModal) { testerCleanup?.(); testerCleanup = null; testerModal = current; }
  if (!testerCleanup) testerCleanup = setupGamepadTesterModalImpl(compatibilityPorts, ...args);
  return testerCleanup;
}
function detectGamepadType(...args) { return detectGamepadTypeImpl(...args); }
function getButtonDisplayLabel(...args) { return getButtonDisplayLabelImpl(...args); }
return {
get isInputTestMode() { return inputTestMode; },
setInputTestMode,
setSelectedGamepadIndex,
getSelectedGamepadIndex,
get coopSlots() { return coopSlots; },
get pressedBrowserKeys() { return pressedBrowserKeys; },
get slotPressedKeys() { return slotPressedKeys; },
isTauriEnvironment,
applyRadialDeadzone,
triggerGamepadRumble,
setCoopInputTarget,
initCompanionAgentConnection,
isCompanionAgentRunning,
reconcileCoopSlots,
setMaxCoopPlayers,
getMaxCoopPlayers,
setPartyModeEnabled,
isPartyModeEnabled,
registerCoopBroadcastHandler,
getCoopSlots,
getNextAvailableSlot,
registerCoopPromptHandler,
registerCoopStateChangeHandler,
setCoopEnabled,
getCoopState,
handleHostCoopMessage,
revokeCoopPlayer,
grantCoopPlayer,
revokeAllCoopPlayers,
revokePlayer2,
requestCoopControl,
handleViewerCoopMessage,
releaseCoopControl,
loadGamepadMappingFromStorage,
saveGamepadMappingToStorage,
getGamepadMapping,
setGamepadMappingPreset,
swapGamepadButtons,
resetGamepadMapping,
applyButtonMapping,
setupGamepadTesterModal,
detectGamepadType,
getButtonDisplayLabel,
dispose() { testerCleanup?.(); testerCleanup = null; revokeAllCoopPlayers(); releaseCoopControl(activeHostPeerId, activeDataConn); closeCompanionAgentConnection(); detachPlayer2InputListeners(); onPromptCallback = null; onStateChangeCallback = null; broadcastSlotsCallback = null; }
};
}
