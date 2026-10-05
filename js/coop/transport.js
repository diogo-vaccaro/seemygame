import { sendCoopMessage } from './message-transport.js';
/** transport: commands receive explicit compatibility ports; no page initialization. */
export function isTauriEnvironment(compatibilityContext) {
  return compatibilityContext.isNativeGamepadAvailable();
}

export async function triggerGamepadRumble(compatibilityContext, strongMagnitude = 0.5, weakMagnitude = 0.5, duration = 200, padIndex = 0) {
  const strong = Math.max(0, Math.min(1, Number(strongMagnitude) || 0));
  const weak = Math.max(0, Math.min(1, Number(weakMagnitude) || 0));
  const durationMs = Math.max(50, Math.min(2000, Number(duration) || 200));
  let gamepad;

  try {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads
      ? Array.from(navigator.getGamepads() || [])
      : [];
    gamepad = pads.find((pad) => pad?.index === Number(padIndex)) || pads[Number(padIndex)];
  } catch (error) {
    gamepad = null;
  }

  const tryNativeRumble = async () => {
    if (!compatibilityContext.isTauriEnvironment()) return false;
    try {
      await compatibilityContext.testGamepadVibration(Number(padIndex), strong, weak, durationMs);
      return true;
    } catch (error) {
      console.warn('[Gamepad] Vibração nativa indisponível:', error?.message || error);
      return false;
    }
  };

  if (!gamepad?.connected) return tryNativeRumble();

  let actuators = [];
  try {
    actuators = [...new Set([
      gamepad.vibrationActuator,
      ...Array.from(gamepad.hapticActuators || [])
    ].filter(Boolean))];
  } catch (error) {}
  for (const actuator of actuators) {
    try {
      if (typeof actuator.playEffect === 'function') {
        const effects = Array.from(actuator.effects || []);
        if (effects.length && !effects.includes('dual-rumble')) continue;
        const result = await actuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration: durationMs,
          weakMagnitude: weak,
          strongMagnitude: strong
        });
        if (result === 'complete' || result === true) return true;
      } else if (typeof actuator.pulse === 'function') {
        if (await actuator.pulse(Math.max(strong, weak), durationMs) === true) return true;
      }
    } catch (error) {
      // Alguns WebViews expõem o Gamepad, mas recusam sua API háptica. No
      // desktop Windows, tentamos então o caminho XInput nativo abaixo.
    }
  }

  return tryNativeRumble();
}

export function setCoopInputTarget(compatibilityContext, rect) {
  compatibilityContext.coopInputTargetRect = compatibilityContext.normalizeTargetRect(rect);
  if (compatibilityContext.isCompanionConnected && compatibilityContext.companionSocket?.readyState === WebSocket.OPEN) {
    try {
      compatibilityContext.companionSocket.send(JSON.stringify({ type: 'COOP_TARGET', targetRect: compatibilityContext.coopInputTargetRect }));
    } catch (e) {}
  }
}

export function initCompanionAgentConnection(compatibilityContext, token = null, isExplicit = false) {
  const authToken = token || (typeof localStorage !== 'undefined' ? localStorage.getItem('seemygame_coop_token') : null);
  if (!authToken) {
    if (isExplicit) {
      compatibilityContext.showToast('Informe o token de pareamento para ativar o Companion Agent.', 'info');
    }
    return false;
  }
  if (typeof WebSocket === 'undefined') return false;
  if (compatibilityContext.isCompanionConnected || compatibilityContext.companionSocket) return true;

  try {
    const ws = new WebSocket('ws://localhost:9876');
    compatibilityContext.companionSocket = ws;
    ws.onopen = () => {
      if (compatibilityContext.companionSocket !== ws) { try { ws.close(); } catch (_) {} return; }
      compatibilityContext.isCompanionConnected = false;
      ws.send(JSON.stringify({ type: 'AUTH', token: authToken }));
    };
    ws.onmessage = (event) => {
      if (compatibilityContext.companionSocket !== ws) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'AUTH_OK') {
          compatibilityContext.isCompanionConnected = true;
          compatibilityContext.companionCapabilities = {
            keyboard: Boolean(data.keyboard),
            mouse: Boolean(data.mouse),
            gamepad: Boolean(data.gamepad),
            mouseCoordinateSpace: data.mouseCoordinateSpace || 'primary-screen'
          };
          console.log('[Co-op Companion] Agente nativo Windows autenticado.');
          compatibilityContext.showToast('⚡ Agente Co-op Windows conectado e pareado.', 'success', 5000);
          if (compatibilityContext.activeDataConn && compatibilityContext.activeDataConn.open !== false) {
            try {
              sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, {
                type: 'COOP_CAPABILITIES',
                keyboard: true,
                mouse: Boolean(compatibilityContext.companionCapabilities.mouse),
                gamepad: Boolean(compatibilityContext.companionCapabilities.gamepad),
                browserKeyboardFallback: true,
                mouseCoordinateSpace: compatibilityContext.companionCapabilities.mouseCoordinateSpace
              });
            } catch (e) {}
          }
          try {
            ws.send(JSON.stringify({ type: 'COOP_TARGET', targetRect: compatibilityContext.coopInputTargetRect }));
          } catch (e) {}
          compatibilityContext.notifyStateChange();
        } else if (data.type === 'AGENT_CAPABILITIES') {
          compatibilityContext.companionCapabilities = {
            keyboard: Boolean(data.keyboard),
            mouse: Boolean(data.mouse),
            gamepad: Boolean(data.gamepad),
            mouseCoordinateSpace: data.mouseCoordinateSpace || 'primary-screen'
          };
          compatibilityContext.notifyStateChange();
        } else if (data.type === 'AUTH_FAILED') {
          compatibilityContext.showToast('O token do Companion Agent foi recusado.', 'error');
          try { ws.close(); } catch (e) {}
        }
      } catch (e) {}
    };
    ws.onclose = () => {
      if (compatibilityContext.companionSocket !== ws) return;
      compatibilityContext.companionSocket = null;
      compatibilityContext.isCompanionConnected = false;
      compatibilityContext.companionCapabilities = { keyboard: false, mouse: false, gamepad: false, mouseCoordinateSpace: 'primary-screen' };
      compatibilityContext.notifyStateChange();
    };
    ws.onerror = () => {
      if (compatibilityContext.companionSocket !== ws) return;
      compatibilityContext.companionSocket = null;
      try { ws.close(); } catch (_) {}
      compatibilityContext.isCompanionConnected = false;
      compatibilityContext.companionCapabilities = { keyboard: false, mouse: false, gamepad: false, mouseCoordinateSpace: 'primary-screen' };
      compatibilityContext.notifyStateChange();
    };
    return true;
  } catch (e) {}
  return false;
}

export function isCompanionAgentRunning(compatibilityContext) {
  return compatibilityContext.isCompanionConnected;
}

export function sendCompanionReset(compatibilityContext) {
  if (!compatibilityContext.isCompanionConnected || !compatibilityContext.companionSocket || compatibilityContext.companionSocket.readyState !== WebSocket.OPEN) return;
  try {
    compatibilityContext.companionSocket.send(JSON.stringify({ type: 'INPUT_RESET' }));
  } catch (e) {}
}

export function closeCompanionAgentConnection(compatibilityContext) {
  compatibilityContext.sendCompanionReset();
  if (compatibilityContext.companionSocket) {
    try { compatibilityContext.companionSocket.close(1000, 'Co-op session ended'); } catch (e) {}
  }
  compatibilityContext.companionSocket = null;
  compatibilityContext.isCompanionConnected = false;
  compatibilityContext.notifyStateChange();
}

export function dispatchHostKeyboardInput(compatibilityContext, data, slot = 1) {
  // 1. Se o companion Windows estiver aberto, envia para jogos nativos do PC
  if (compatibilityContext.isCompanionConnected && compatibilityContext.companionSocket && compatibilityContext.companionSocket.readyState === WebSocket.OPEN) {
    compatibilityContext.companionSocket.send(JSON.stringify({ ...data, slot }));
    return;
  }

  // 2. Fallback: Despacha evento no navegador (jogos web, emuladores HTML5)
  try {
    const eventType = data.action === 'down' ? 'keydown' : 'keyup';
    const evt = new KeyboardEvent(eventType, {
      key: data.key,
      code: data.code,
      keyCode: data.keyCode,
      bubbles: true,
      cancelable: true
    });
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(evt);
    }
    if (data.code) {
      let keys = compatibilityContext.slotPressedKeys.get(slot);
      if (!keys) {
        keys = new Set();
        compatibilityContext.slotPressedKeys.set(slot, keys);
      }
      if (data.action === 'down') {
        keys.add(data.code);
        compatibilityContext.pressedBrowserKeys.add(data.code);
      } else {
        keys.delete(data.code);
        let stillPressed = false;
        for (const sKeys of compatibilityContext.slotPressedKeys.values()) {
          if (sKeys.has(data.code)) { stillPressed = true; break; }
        }
        if (!stillPressed) compatibilityContext.pressedBrowserKeys.delete(data.code);
      }
    }
  } catch (e) {}
}

export function dispatchHostMouseInput(compatibilityContext, data) {
  if (compatibilityContext.isCompanionConnected && compatibilityContext.companionSocket && compatibilityContext.companionSocket.readyState === WebSocket.OPEN) {
    if (!compatibilityContext.companionCapabilities.mouse) return;
    compatibilityContext.companionSocket.send(JSON.stringify({ ...data, targetRect: compatibilityContext.coopInputTargetRect }));
  }
}

export function dispatchHostGamepadInput(compatibilityContext, data) {
  // 1. Desktop Tauri: despacha diretamente para o backend nativo ViGEmBus
  if (compatibilityContext.isTauriEnvironment()) {
    const slot = Number(data.slot ?? 1);
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) return;
    const report = {
      buttons: Array.isArray(data.state?.buttons) ? data.state.buttons : (Array.isArray(data.buttons) ? data.buttons : []),
      triggers: Array.isArray(data.state?.triggers) ? data.state.triggers : (Array.isArray(data.triggers) ? data.triggers : null),
      axes: Array.isArray(data.state?.axes) ? data.state.axes : (Array.isArray(data.axes) ? data.axes : [])
    };
    compatibilityContext.updateVirtualGamepad(slot, report).catch(() => {});
    return;
  }

  // 2. Companion Agent via WebSocket
  if (compatibilityContext.isCompanionConnected && compatibilityContext.companionSocket && compatibilityContext.companionSocket.readyState === WebSocket.OPEN) {
    if (!compatibilityContext.companionCapabilities.gamepad) {
      if (!compatibilityContext.capabilityWarningShown) {
        compatibilityContext.capabilityWarningShown = true;
        compatibilityContext.showToast('Este Companion Agent não possui suporte a gamepad virtual.', 'info', 5000);
      }
      return;
    }
    compatibilityContext.companionSocket.send(JSON.stringify(data));
  }
}

export function dispatchHostInputReset(compatibilityContext, { unplugVirtualGamepads = true, slot = null } = {}) {
  const scoped = Number.isInteger(slot) && slot >= 0 && slot <= 3;
  if (compatibilityContext.isTauriEnvironment()) {
    if (unplugVirtualGamepads) {
      if (scoped) compatibilityContext.unplugVirtualGamepad(slot).catch(() => {});
      else compatibilityContext.unplugAllVirtualGamepads().catch(() => {});
    }
    else for (const targetSlot of scoped ? [slot] : compatibilityContext.coopSlots.keys()) {
      compatibilityContext.updateVirtualGamepad(targetSlot, { buttons: new Array(17).fill(false), triggers: [0, 0], axes: [0, 0, 0, 0] }).catch(() => {});
    }
  }
  if (compatibilityContext.isCompanionConnected && compatibilityContext.companionSocket && compatibilityContext.companionSocket.readyState === WebSocket.OPEN) {
    try { compatibilityContext.companionSocket.send(JSON.stringify({ type: 'INPUT_RESET', ...(scoped ? { slot } : {}) })); } catch (e) {}
  }
  if (scoped) {
    const keys = compatibilityContext.slotPressedKeys.get(slot) || new Set();
    compatibilityContext.slotPressedKeys.delete(slot);
    for (const code of keys) {
      if ([...compatibilityContext.slotPressedKeys.values()].some(other => other.has(code))) continue;
      if (typeof window !== 'undefined') window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
      compatibilityContext.pressedBrowserKeys.delete(code);
    }
    return;
  }
  if (typeof window !== 'undefined') {
    compatibilityContext.pressedBrowserKeys.forEach((code) => {
      try {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
      } catch (e) {}
    });
  }
  compatibilityContext.pressedBrowserKeys.clear();
  compatibilityContext.slotPressedKeys.clear();
}
