import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGamepadModel } from ".././gamepad-model-builder.js";
import { detectGamepadType } from '../coop/input.js';
/** Gamepad3DViewer: mapping. State and lifetime remain owned by the composed engine. */
export const withGamepad3DViewerMapping = Base => class extends Base {
triggerRumble(intensity = 1.0) {
    const val = Number(intensity);
    if (!Number.isFinite(val) || val <= 0) return;
    this.rumbleIntensity = Math.min(1.0, Math.max(this.rumbleIntensity, val));
    this.requestRender();
  }

updateInputs(gamepadData = {}) {
    if (!this.isInitialized || this.isDestroyed || this._isElementHidden()) return;
    const data = gamepadData || {};
    this._cachedRawInputs = data;

    if (data.device || data.id) {
      const detected = detectGamepadType(data.device || data.id);
      if (detected && detected !== 'generic' && detected !== this.gamepadType && typeof this.setGamepadType === 'function') {
        this.setGamepadType(detected);
      }
    }

    const rawAxes = Array.isArray(data.axes) ? data.axes : [0, 0, 0, 0];
    const buttons = Array.isArray(data.buttons) ? data.buttons : [];

    const getBtn = (idx) => {
      const b = buttons[idx];
      if (typeof b === 'object' && b !== null) {
        const pressed = Boolean(b.pressed);
        let val = typeof b.value === 'number' ? b.value : (pressed ? 1.0 : 0.0);
        if (pressed && val <= 0) val = 1.0;
        return { pressed, value: val };
      }
      const val = Number(b || 0);
      return { pressed: val > 0.1, value: val };
    };

    const prevConnected = this.isConnected;
    if (data.connected !== undefined) {
      this.isConnected = Boolean(data.connected);
    } else if (buttons.length > 0) {
      this.isConnected = true;
    }

    // 1. Filtragem com deadzone radial anatômica nos analógicos
    const sanitizeAxis = (val) => {
      const n = Number(val);
      return Number.isFinite(n) ? Math.max(-1.0, Math.min(1.0, n)) : 0.0;
    };

    const STICK_DEADZONE = 0.06;
    let lx = sanitizeAxis(rawAxes[0]);
    let ly = sanitizeAxis(rawAxes[1]);
    const lMag = Math.hypot(lx, ly);
    if (lMag <= STICK_DEADZONE) {
      lx = 0;
      ly = 0;
    } else {
      const clampedMag = Math.min(1.0, lMag);
      const scaledMag = (clampedMag - STICK_DEADZONE) / (1.0 - STICK_DEADZONE);
      lx = (lx / lMag) * scaledMag;
      ly = (ly / lMag) * scaledMag;
    }

    let rx = sanitizeAxis(rawAxes[2]);
    let ry = sanitizeAxis(rawAxes[3]);
    const rMag = Math.hypot(rx, ry);
    if (rMag <= STICK_DEADZONE) {
      rx = 0;
      ry = 0;
    } else {
      const clampedMag = Math.min(1.0, rMag);
      const scaledMag = (clampedMag - STICK_DEADZONE) / (1.0 - STICK_DEADZONE);
      rx = (rx / rMag) * scaledMag;
      ry = (ry / rMag) * scaledMag;
    }

    // 2. Filtragem linear com deadzone nos gatilhos
    const TRIGGER_DEADZONE = 0.03;
    const rawLt = Math.max(0, Math.min(1, sanitizeAxis(getBtn(6).value)));
    const ltVal = rawLt <= TRIGGER_DEADZONE ? 0 : (rawLt - TRIGGER_DEADZONE) / (1.0 - TRIGGER_DEADZONE);

    const rawRt = Math.max(0, Math.min(1, sanitizeAxis(getBtn(7).value)));
    const rtVal = rawRt <= TRIGGER_DEADZONE ? 0 : (rawRt - TRIGGER_DEADZONE) / (1.0 - TRIGGER_DEADZONE);

    const currentAxes = [lx, ly, rx, ry];

    // Input diffing: detecta se os dados de entrada mudaram em relação ao frame anterior
    let inputsChanged = !this._lastInputs || this.isConnected !== prevConnected;
    if (!inputsChanged && this._lastInputs) {
      const prevAxes = this._lastInputs.axes;
      for (let i = 0; i < currentAxes.length; i++) {
        if (Math.abs(currentAxes[i] - (prevAxes[i] || 0)) > 0.005) {
          inputsChanged = true;
          break;
        }
      }
      if (!inputsChanged) {
        const prevBtns = this._lastInputs.buttons;
        if (prevBtns.length !== buttons.length) {
          inputsChanged = true;
        } else {
          for (let i = 0; i < buttons.length; i++) {
            const b = getBtn(i);
            const pb = prevBtns[i];
            if (b.pressed !== pb.pressed || Math.abs(b.value - pb.value) > 0.01) {
              inputsChanged = true;
              break;
            }
          }
        }
      }
    }

    // Se as entradas não mudaram, mantém repouso a 0 FPS sem consumir GPU/CPU
    if (!inputsChanged) {
      return;
    }

    const MAX_STICK_ANGLE = 0.42; // ~24 graus
    const MAX_TRIGGER_ANGLE = 0.32; // ~18 graus
    const PRESS_DEPTH = 0.08;

    let hasActive = false;

    // 1. Analógico Esquerdo (Stick_L) com limite físico circular
    if (this.parts.stickL) {
      const init = this.initialTransforms.get(this.parts.stickL);
      if (init) {
        const l3Pressed = getBtn(10).pressed;
        if (Math.abs(lx) > 0.02 || Math.abs(ly) > 0.02 || l3Pressed) {
          hasActive = true;
        }

        // +ly inclina para frente (-Z) ao empurrar analógico para cima (ly < 0)
        this.parts.stickL.rotation.x = init.rot.x + ly * MAX_STICK_ANGLE;
        this.parts.stickL.rotation.z = init.rot.z - lx * MAX_STICK_ANGLE;
        this.parts.stickL.position.y = init.pos.y - (l3Pressed ? 0.04 : 0);
        this._setPartEmissive(this.parts.stickL, l3Pressed, 0x06b6d4, 0.45);

        // The entire stick moves at its pivot; children retain their local assembly.
      }
    }

    // 2. Analógico Direito (Stick_R) com limite físico circular
    if (this.parts.stickR) {
      const init = this.initialTransforms.get(this.parts.stickR);
      if (init) {
        const r3Pressed = getBtn(11).pressed;
        if (Math.abs(rx) > 0.02 || Math.abs(ry) > 0.02 || r3Pressed) {
          hasActive = true;
        }

        this.parts.stickR.rotation.x = init.rot.x + ry * MAX_STICK_ANGLE;
        this.parts.stickR.rotation.z = init.rot.z - rx * MAX_STICK_ANGLE;
        this.parts.stickR.position.y = init.pos.y - (r3Pressed ? 0.04 : 0);
        this._setPartEmissive(this.parts.stickR, r3Pressed, 0x06b6d4, 0.45);

      }
    }

    // 3. Gatilhos Analógicos Progressivos (LT / RT) - Rotação por dobradiça e brilho proporcional
    if (this.parts.triggerLT) {
      const init = this.initialTransforms.get(this.parts.triggerLT);
      if (init) {
        if (ltVal > 0.02) hasActive = true;
        this.parts.triggerLT.rotation.x = init.rot.x - ltVal * MAX_TRIGGER_ANGLE;
        this._setPartEmissive(this.parts.triggerLT, ltVal > 0.05, 0x06b6d4, ltVal * 1.8);
      }
    }

    if (this.parts.triggerRT) {
      const init = this.initialTransforms.get(this.parts.triggerRT);
      if (init) {
        if (rtVal > 0.02) hasActive = true;
        this.parts.triggerRT.rotation.x = init.rot.x - rtVal * MAX_TRIGGER_ANGLE;
        this._setPartEmissive(this.parts.triggerRT, rtVal > 0.05, 0x06b6d4, rtVal * 1.8);
      }
    }

    // Helper para botões que afundam e modulam emissivo
    const updateDepress = (obj, pressed, glowColor = null) => {
      if (!obj) return;
      if (pressed) hasActive = true;
      const init = this.initialTransforms.get(obj);
      if (init) {
        obj.position.y = init.pos.y - (pressed ? PRESS_DEPTH : 0);
      }
      this._setPartEmissive(obj, pressed, glowColor);
    };

    // 4. Bumpers dos Ombros (LB / RB)
    updateDepress(this.parts.bumperLB, getBtn(4).pressed, 0x06b6d4);
    updateDepress(this.parts.bumperRB, getBtn(5).pressed, 0x06b6d4);

    // 5. Botões de Ação ABXY (depressão física + modulação de brilho)
    updateDepress(this.parts.buttonA, getBtn(0).pressed, 0x06b6d4);
    updateDepress(this.parts.buttonB, getBtn(1).pressed, 0x06b6d4);
    updateDepress(this.parts.buttonX, getBtn(2).pressed, 0x06b6d4);
    updateDepress(this.parts.buttonY, getBtn(3).pressed, 0x06b6d4);

    // 6. Botões do Sistema (Back, Start, Guide)
    updateDepress(this.parts.buttonBack, getBtn(8).pressed, 0x38bdf8);
    updateDepress(this.parts.buttonStart, getBtn(9).pressed, 0x38bdf8);

    const guidePressed = getBtn(16).pressed;
    if (this.parts.buttonGuide) {
      if (guidePressed) hasActive = true;
      const init = this.initialTransforms.get(this.parts.buttonGuide);
      if (init) {
        this.parts.buttonGuide.position.y = init.pos.y - (guidePressed ? PRESS_DEPTH : 0);
      }
    }

    // 7. D-Pad Direcional (depressão por braço + inclinação de conjunto)
    const up = getBtn(12).pressed;
    const down = getBtn(13).pressed;
    const left = getBtn(14).pressed;
    const right = getBtn(15).pressed;

    updateDepress(this.parts.dpadUp, up, 0x60a5fa);
    updateDepress(this.parts.dpadDown, down, 0x60a5fa);
    updateDepress(this.parts.dpadLeft, left, 0x60a5fa);
    updateDepress(this.parts.dpadRight, right, 0x60a5fa);

    if (this.parts.dpadGroup) {
      const init = this.initialTransforms.get(this.parts.dpadGroup);
      if (init) {
        const u = up ? 1 : 0;
        const d = down ? 1 : 0;
        const l = left ? 1 : 0;
        const r = right ? 1 : 0;
        // Pressionar Cima (u=1) deprime o braço superior em -Z (rotação negativa em X)
        this.parts.dpadGroup.rotation.x = init.rot.x + (d - u) * 0.12;
        this.parts.dpadGroup.rotation.z = init.rot.z + (l - r) * 0.12;
      }
    }

    // 8. Reatividade do LED central Guide / Nexus ring à conexão e inputs
    const targetGuide = this.parts.guideDisc || this.parts.buttonGuide;
    if (targetGuide) {
      if (!this.isConnected) {
        this._setPartEmissive(targetGuide, true, 0x334155, 0.1);
      } else if (guidePressed) {
        this._setPartEmissive(targetGuide, true, 0xc084fc, 2.5);
      } else if (hasActive) {
        this._setPartEmissive(targetGuide, true, null, 1.6);
      } else {
        this._setPartEmissive(targetGuide, false);
      }
    }

    if (this.parts.guideRing) {
      if (!this.isConnected) {
        this._setPartEmissive(this.parts.guideRing, true, 0x1e293b, 0.05);
      } else if (guidePressed || hasActive) {
        this._setPartEmissive(this.parts.guideRing, true, 0x22d3ee, 1.8);
      } else {
        this._setPartEmissive(this.parts.guideRing, false);
      }
    }

    this.hasActiveInputs = hasActive;

    // Cache do estado para comparativo no próximo frame
    this._lastInputs = {
      axes: currentAxes,
      buttons: buttons.map((_, i) => getBtn(i))
    };

    this.requestRender();
  }
};
