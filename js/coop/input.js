import { sendCoopMessage } from './message-transport.js';
import { getVideoContentRect } from '../ui/video-geometry.js';
const inputStates = new WeakMap();
const inputState = ports => {
  if (!inputStates.has(ports)) inputStates.set(ports, { keys: new Map(), buttons: new Set() });
  return inputStates.get(ports);
};
function releaseHeldInputs(ports) {
  const state = inputState(ports);
  for (const [code, key] of [...state.keys]) handleKeyUp(ports, { ...key, code });
  for (const button of [...state.buttons]) handleMouseUp(ports, { button });
}
/** input: commands receive explicit compatibility ports; no page initialization. */
export function handleKeyDown(compatibilityContext, e) {
  if (!compatibilityContext.isPlayer2 || !compatibilityContext.activeDataConn || !compatibilityContext.attachedCard || compatibilityContext.activeHostCapabilities.keyboard === false) return;

  // A13: Ignora captura de teclas se o usuário estiver digitando no chat ou em campos editáveis
  const target = e.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }

  // Previne rolagem de página em teclas de jogo comuns se o foco estiver na live
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
    e.preventDefault();
  }

  inputState(compatibilityContext).keys.set(e.code, { key: e.key, keyCode: e.keyCode });
  sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, {
    type: 'INPUT_KEY',
    slot: compatibilityContext.myAssignedSlot !== null ? compatibilityContext.myAssignedSlot : 1,
    action: 'down',
    key: e.key,
    code: e.code,
    keyCode: e.keyCode
  });
}

export function handleKeyUp(compatibilityContext, e) {
  const state = inputState(compatibilityContext);
  if (!state.keys.has(e.code)) return;
  state.keys.delete(e.code);
  if (!compatibilityContext.activeDataConn) return;

  sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, {
    type: 'INPUT_KEY',
    slot: compatibilityContext.myAssignedSlot !== null ? compatibilityContext.myAssignedSlot : 1,
    action: 'up',
    key: e.key,
    code: e.code,
    keyCode: e.keyCode
  });
}

export function focusControlWrapper(compatibilityContext, e) {
  e.currentTarget?.focus?.();
}

export function handleControlVisibilityChange(compatibilityContext) {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && compatibilityContext.isPlayer2 && compatibilityContext.activeDataConn) {
    try { sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, { type: 'INPUT_RESET', slot: compatibilityContext.myAssignedSlot ?? 1, preserveGamepads: true }); } catch (e) {}
  }
}

export function handleMouseMove(compatibilityContext, e) {
  if (!compatibilityContext.isPlayer2 || !compatibilityContext.activeDataConn || !compatibilityContext.attachedCard || compatibilityContext.activeHostCapabilities.mouse === false) return;

  const video = compatibilityContext.attachedCard.querySelector('video');
  if (!video) return;

  const rect = getVideoContentRect(video);
  if (rect.width === 0 || rect.height === 0) return;

  // Coordenadas normalizadas (0.0 a 1.0)
  const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

  sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, {
    type: 'INPUT_MOUSE',
    slot: compatibilityContext.myAssignedSlot !== null ? compatibilityContext.myAssignedSlot : 1,
    action: 'move',
    x: normX,
    y: normY
  });
}

export function handleMouseDown(compatibilityContext, e) {
  if (!compatibilityContext.isPlayer2 || !compatibilityContext.activeDataConn || compatibilityContext.activeHostCapabilities.mouse === false) return;
  inputState(compatibilityContext).buttons.add(e.button);
  sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, {
    type: 'INPUT_MOUSE',
    slot: compatibilityContext.myAssignedSlot !== null ? compatibilityContext.myAssignedSlot : 1,
    action: 'down',
    button: e.button
  });
}

export function handleMouseUp(compatibilityContext, e) {
  const state = inputState(compatibilityContext);
  if (!state.buttons.has(e.button)) return;
  state.buttons.delete(e.button);
  if (!compatibilityContext.activeDataConn) return;
  sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, {
    type: 'INPUT_MOUSE',
    slot: compatibilityContext.myAssignedSlot !== null ? compatibilityContext.myAssignedSlot : 1,
    action: 'up',
    button: e.button
  });
}

export function loadGamepadMappingFromStorage(compatibilityContext) {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem('seemygame_gamepad_mapping');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.map) && parsed.map.length === 17) {
        compatibilityContext.currentGamepadMapping = [...parsed.map];
        compatibilityContext.currentMappingPreset = parsed.preset || 'custom';
      }
    }
  } catch (e) {}
}

export function saveGamepadMappingToStorage(compatibilityContext) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem('seemygame_gamepad_mapping', JSON.stringify({
      preset: compatibilityContext.currentMappingPreset,
      map: compatibilityContext.currentGamepadMapping
    }));
  } catch (e) {}
}

export function getGamepadMapping(compatibilityContext) {
  return {
    preset: compatibilityContext.currentMappingPreset,
    map: [...compatibilityContext.currentGamepadMapping]
  };
}

export function setGamepadMappingPreset(compatibilityContext, preset) {
  if (preset === 'playstation') {
    compatibilityContext.currentGamepadMapping = [...compatibilityContext.DEFAULT_BUTTON_MAP];
    compatibilityContext.currentMappingPreset = 'playstation';
  } else if (preset === 'nintendo') {
    compatibilityContext.currentGamepadMapping = [...compatibilityContext.NINTENDO_BUTTON_MAP];
    compatibilityContext.currentMappingPreset = 'nintendo';
  } else if (preset === 'xbox') {
    compatibilityContext.currentGamepadMapping = [...compatibilityContext.DEFAULT_BUTTON_MAP];
    compatibilityContext.currentMappingPreset = 'xbox';
  } else {
    compatibilityContext.currentMappingPreset = 'custom';
  }
  compatibilityContext.saveGamepadMappingToStorage();
  return compatibilityContext.getGamepadMapping();
}

export function swapGamepadButtons(compatibilityContext, btnA, btnB) {
  const tmp = compatibilityContext.currentGamepadMapping[btnA];
  compatibilityContext.currentGamepadMapping[btnA] = compatibilityContext.currentGamepadMapping[btnB];
  compatibilityContext.currentGamepadMapping[btnB] = tmp;
  compatibilityContext.currentMappingPreset = 'custom';
  compatibilityContext.saveGamepadMappingToStorage();
  return compatibilityContext.getGamepadMapping();
}

export function resetGamepadMapping(compatibilityContext) {
  return compatibilityContext.setGamepadMappingPreset('xbox');
}

export function applyButtonMapping(compatibilityContext, rawButtons) {
  if (!Array.isArray(rawButtons)) return [];
  const result = new Array(rawButtons.length).fill(false);
  for (let i = 0; i < rawButtons.length; i++) {
    const mappedTarget = compatibilityContext.currentGamepadMapping[i] !== undefined ? compatibilityContext.currentGamepadMapping[i] : i;
    if (rawButtons[i]) {
      result[mappedTarget] = true;
    }
  }
  return result;
}

/**
 * Detecta o tipo de hardware do gamepad através da identificação do dispositivo
 * @param {string} gamepadId
 * @returns {'playstation'|'nintendo'|'8bitdo'|'xbox'|'generic'}
 */
export function detectGamepadType(gamepadId) {
  if (!gamepadId || typeof gamepadId !== 'string') return 'generic';
  const id = gamepadId.toLowerCase();
  // Fabricante explícito tem precedência sobre nomes de modos de compatibilidade.
  if (id.includes('2dc8') || id.includes('8bitdo')) return '8bitdo';
  if (id.includes('054c')) return 'playstation';
  if (id.includes('057e')) return 'nintendo';
  if (id.includes('045e')) return 'xbox';
  if (
    id.includes('dualsense') ||
    id.includes('dualshock') ||
    id.includes('playstation') ||
    id.includes('sony') ||
    id.includes('ps5') ||
    id.includes('ps4') ||
    id.includes('ps3') ||
    id.includes('dual sense') ||
    id.includes('dual shock')
  ) {
    return 'playstation';
  }
  if (
    id.includes('switch') ||
    id.includes('joy-con') ||
    id.includes('nintendo')
  ) {
    return 'nintendo';
  }
  if (id.includes('xbox') || id.includes('xinput')) {
    return 'xbox';
  }
  return 'generic';
}

export const PLAYSTATION_BUTTON_NAMES = [
  '✕ (Cross)', '○ (Circle)', '□ (Square)', '△ (Triangle)',
  'L1', 'R1', 'L2', 'R2',
  'Share / Create', 'Options',
  'L3', 'R3',
  'D-Pad Cima', 'D-Pad Baixo', 'D-Pad Esquerda', 'D-Pad Direita',
  'PS Button'
];

export const NINTENDO_BUTTON_NAMES = [
  'B', 'A', 'Y', 'X',
  'L', 'R', 'ZL', 'ZR',
  '-', '+',
  'L3', 'R3',
  'D-Pad Cima', 'D-Pad Baixo', 'D-Pad Esquerda', 'D-Pad Direita',
  'Home'
];

export const XBOX_BUTTON_NAMES = [
  'A', 'B', 'X', 'Y',
  'LB', 'RB', 'LT', 'RT',
  'Back / View', 'Start / Menu',
  'L3', 'R3',
  'D-Pad Cima', 'D-Pad Baixo', 'D-Pad Esquerda', 'D-Pad Direita',
  'Xbox / Guide'
];

/**
 * Retorna o rótulo visual canônico do botão de acordo com a plataforma/layout ativo
 * @param {number} buttonIndex
 * @param {'auto'|'xbox'|'nintendo'|'playstation'|'custom'} preset
 * @param {'playstation'|'nintendo'|'8bitdo'|'xbox'|'generic'} deviceType
 * @returns {string}
 */
export function getButtonDisplayLabel(buttonIndex, preset = 'xbox', deviceType = null) {
  const idx = Number(buttonIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx > 16) return `B${buttonIndex}`;
  if (preset === 'playstation' || (preset !== 'nintendo' && preset !== 'xbox' && deviceType === 'playstation')) {
    return PLAYSTATION_BUTTON_NAMES[idx] || `B${idx}`;
  }
  if (preset === 'nintendo' || (preset !== 'playstation' && preset !== 'xbox' && deviceType === 'nintendo')) {
    return NINTENDO_BUTTON_NAMES[idx] || `B${idx}`;
  }
  return XBOX_BUTTON_NAMES[idx] || `B${idx}`;
}

export function pollGamepads(compatibilityContext, targetIndex = 0) {
  if (!compatibilityContext.isPlayer2 || !compatibilityContext.activeDataConn || compatibilityContext.activeHostCapabilities.gamepad === false) return;

  try {
    const gamepads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads[targetIndex] || gamepads[0]; // Captura o controle alvo ou o primeiro conectado

    if (gp && gp.connected) {
      const device = `${gp.index ?? targetIndex}:${gp.id || ''}`;
      const state = inputState(compatibilityContext);
      if (state.gamepadDevice && state.gamepadDevice !== device) compatibilityContext.lastGamepadState = null;
      state.gamepadDevice = device;
      const rawButtons = gp.buttons.map(b => (typeof b === 'object' ? Boolean(b.pressed) : b === 1.0));
      const buttons = compatibilityContext.applyButtonMapping(rawButtons);
      const leftTrigger = typeof gp.buttons[6] === 'object' ? (gp.buttons[6].value ?? (gp.buttons[6].pressed ? 1.0 : 0.0)) : (buttons[6] ? 1.0 : 0.0);
      const rightTrigger = typeof gp.buttons[7] === 'object' ? (gp.buttons[7].value ?? (gp.buttons[7].pressed ? 1.0 : 0.0)) : (buttons[7] ? 1.0 : 0.0);

      const leftStick = compatibilityContext.applyRadialDeadzone(gp.axes[0] || 0, gp.axes[1] || 0);
      const rightStick = compatibilityContext.applyRadialDeadzone(gp.axes[2] || 0, gp.axes[3] || 0);

      const currentState = {
        buttons,
        triggers: [Math.round(leftTrigger * 100) / 100, Math.round(rightTrigger * 100) / 100],
        axes: [leftStick.x, leftStick.y, rightStick.x, rightStick.y]
      };

      // Envia apenas se houver mudanças para economizar canal
      const serialized = JSON.stringify(currentState);
      if (serialized !== compatibilityContext.lastGamepadState) {
        compatibilityContext.lastGamepadState = serialized;
        sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, {
          type: 'INPUT_GAMEPAD',
          slot: compatibilityContext.myAssignedSlot !== null ? compatibilityContext.myAssignedSlot : 1,
          state: currentState
        });
      }
    } else if (compatibilityContext.lastGamepadState) {
      sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, { type: 'INPUT_GAMEPAD', slot: compatibilityContext.myAssignedSlot ?? 1,
        state: { buttons: new Array(17).fill(false), triggers: [0, 0], axes: [0, 0, 0, 0] } });
      compatibilityContext.lastGamepadState = null;
      inputState(compatibilityContext).gamepadDevice = null;
    }
  } catch (e) {}

  compatibilityContext.gamepadLoopId = requestAnimationFrame(compatibilityContext.pollGamepads);
}

export function attachPlayer2InputListeners(compatibilityContext, videoCard) {
  if (!videoCard) return;
  compatibilityContext.detachPlayer2InputListeners();
  compatibilityContext.attachedCard = videoCard;
  const wrapper = videoCard.querySelector?.('.video-wrapper') || videoCard;
  if (wrapper?.addEventListener) {
    // Input is scoped to the explicitly selected/focused video card. This
    // prevents a chat field or another browser tab control from being
    // captured while the user is Player 2.
    if (typeof wrapper.tabIndex !== 'number' || wrapper.tabIndex < 0) wrapper.tabIndex = 0;
    wrapper.setAttribute?.('aria-label', 'Área de controle do Player 2');
    wrapper.addEventListener('keydown', compatibilityContext.handleKeyDown);
    wrapper.addEventListener('mousemove', compatibilityContext.handleMouseMove);
    wrapper.addEventListener('mousedown', compatibilityContext.handleMouseDown);
    wrapper.addEventListener('pointerdown', compatibilityContext.focusControlWrapper);
    const state = inputState(compatibilityContext);
    state.release = () => releaseHeldInputs(compatibilityContext);
    wrapper.addEventListener('blur', state.release);
    window.addEventListener('blur', state.release);
    window.addEventListener('keyup', compatibilityContext.handleKeyUp);
    window.addEventListener('mouseup', compatibilityContext.handleMouseUp);
  }

  compatibilityContext.controlVisibilityTarget = typeof document !== 'undefined' ? document : null;
  compatibilityContext.controlVisibilityTarget?.addEventListener('visibilitychange', compatibilityContext.handleControlVisibilityChange);
  window.addEventListener('pagehide', compatibilityContext.handleControlVisibilityChange);

  // Inicia loop do Gamepad
  cancelAnimationFrame(compatibilityContext.gamepadLoopId);
  compatibilityContext.gamepadLoopId = requestAnimationFrame(compatibilityContext.pollGamepads);
}

export function detachPlayer2InputListeners(compatibilityContext) {
  const state = inputState(compatibilityContext);
  releaseHeldInputs(compatibilityContext);
  if (compatibilityContext.attachedCard) {
    const wrapper = compatibilityContext.attachedCard.querySelector?.('.video-wrapper') || compatibilityContext.attachedCard;
    wrapper.removeEventListener?.('keydown', compatibilityContext.handleKeyDown);
    wrapper.removeEventListener?.('keyup', compatibilityContext.handleKeyUp);
    wrapper.removeEventListener?.('mousemove', compatibilityContext.handleMouseMove);
    wrapper.removeEventListener?.('mousedown', compatibilityContext.handleMouseDown);
    wrapper.removeEventListener?.('mouseup', compatibilityContext.handleMouseUp);
    wrapper.removeEventListener?.('pointerdown', compatibilityContext.focusControlWrapper);
    wrapper.removeEventListener?.('blur', state.release);
    compatibilityContext.attachedCard = null;
  }

  compatibilityContext.controlVisibilityTarget?.removeEventListener?.('visibilitychange', compatibilityContext.handleControlVisibilityChange);
  window.removeEventListener('pagehide', compatibilityContext.handleControlVisibilityChange);
  window.removeEventListener('blur', state.release);
  window.removeEventListener('keyup', compatibilityContext.handleKeyUp);
  window.removeEventListener('mouseup', compatibilityContext.handleMouseUp);
  state.gamepadDevice = null;
  compatibilityContext.controlVisibilityTarget = null;

  compatibilityContext.dispatchHostInputReset();
  cancelAnimationFrame(compatibilityContext.gamepadLoopId);
  compatibilityContext.gamepadLoopId = null;
  compatibilityContext.lastGamepadState = null;
}
