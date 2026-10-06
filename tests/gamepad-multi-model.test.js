import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  createGamepadModel,
  createXboxGamepadModel,
  createSwitchGamepadModel,
  getGamepadModelUrl,
  GAMEPAD_MODEL_REVISION
} from '../js/gamepad-model-builder.js';
import { Gamepad3DViewer } from '../js/gamepad-3d-viewer.js';
import { detectGamepadType } from '../js/coop/input.js';

const canonicalNodes = [
  'Stick_L', 'Stick_R', 'Dpad_Group', 'Dpad_Up', 'Dpad_Down', 'Dpad_Left', 'Dpad_Right',
  'Button_A', 'Button_B', 'Button_X', 'Button_Y', 'Bumper_LB', 'Bumper_RB',
  'Trigger_LT', 'Trigger_RT', 'Button_Back', 'Button_Start', 'Button_Guide'
];

let viewer;

beforeEach(() => {
  vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}
  });
});

afterEach(() => {
  viewer?.destroy();
  viewer = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function makeViewer(options = {}) {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  document.body.appendChild(container);

  viewer = new Gamepad3DViewer({
    container,
    canvas,
    modelUrl: null,
    fitToContainer: true,
    renderer: {
      setPixelRatio() {},
      setSize() {},
      render() {},
      dispose() {},
      forceContextLoss() {}
    },
    ...options
  });
  expect(viewer.init()).toBe(true);
  return viewer;
}

describe('Reconhecimento de tipo de controle (detectGamepadType)', () => {
  it('detecta controles Xbox por vendor ID e nomes canônicos', () => {
    expect(detectGamepadType('045e-02fd-Xbox Wireless Controller')).toBe('xbox');
    expect(detectGamepadType('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
    expect(detectGamepadType('Microsoft Xbox One Controller')).toBe('xbox');
  });

  it('detecta controles Nintendo Switch Pro por vendor ID e nomenclaturas', () => {
    expect(detectGamepadType('057e-2009-Switch Pro Controller')).toBe('nintendo');
    expect(detectGamepadType('Wireless Gamepad (Vendor: 057e Product: 2009)')).toBe('nintendo');
    expect(detectGamepadType('Nintendo Switch Joy-Con (L/R)')).toBe('nintendo');
  });

  it('detecta controles PlayStation (DualSense / DualShock)', () => {
    expect(detectGamepadType('054c-0ce6-DualSense Wireless Controller')).toBe('playstation');
    expect(detectGamepadType('Sony Interactive Entertainment Wireless Controller (PS5)')).toBe('playstation');
    expect(detectGamepadType('DualShock 4 USB Wireless Adaptor')).toBe('playstation');
  });

  it('retorna generic para dispositivos desconhecidos', () => {
    expect(detectGamepadType('USB Gamepad Device')).toBe('generic');
    expect(detectGamepadType('')).toBe('generic');
    expect(detectGamepadType(null)).toBe('generic');
  });
});

describe('URLs dos modelos GLB (getGamepadModelUrl)', () => {
  it('retorna os caminhos corretos para cada plataforma', () => {
    expect(getGamepadModelUrl('xbox')).toContain('css/assets/gamepad-xbox.glb');
    expect(getGamepadModelUrl('nintendo')).toContain('css/assets/gamepad-switch.glb');
    expect(getGamepadModelUrl('switch')).toContain('css/assets/gamepad-switch.glb');
    expect(getGamepadModelUrl('playstation')).toContain('css/assets/gamepad.glb');
    expect(getGamepadModelUrl('unknown')).toContain('css/assets/gamepad.glb');
  });
});

describe('Montagem do modelo Xbox Wireless Controller', () => {
  it('possui layout assimétrico: Stick_L superior esquerdo e Dpad inferior esquerdo', () => {
    const root = createXboxGamepadModel();
    root.updateMatrixWorld(true);

    const stickL = root.getObjectByName('Stick_L').position;
    const stickR = root.getObjectByName('Stick_R').position;
    const dpad = root.getObjectByName('Dpad_Group').position;
    const btnA = root.getObjectByName('Button_A').position;

    // Stick L no quadrante superior esquerdo (x < 0, z < 0)
    expect(stickL.x).toBeLessThan(0);
    expect(stickL.z).toBeLessThan(0);

    // D-pad no quadrante inferior esquerdo (x < 0, z > 0)
    expect(dpad.x).toBeLessThan(0);
    expect(dpad.z).toBeGreaterThan(0);

    // Stick R no quadrante inferior direito (x > 0, z > 0)
    expect(stickR.x).toBeGreaterThan(0);
    expect(stickR.z).toBeGreaterThan(0);

    // Botões de ação no quadrante superior direito (x > 0)
    expect(btnA.x).toBeGreaterThan(0);

    // Todos os nós canônicos devem existir
    for (const name of canonicalNodes) {
      expect(root.getObjectByName(name), `Nó ${name} deve existir no modelo Xbox`).toBeTruthy();
    }

    root.traverse(p => p.geometry?.dispose());
  });
});

describe('Montagem do modelo Nintendo Switch Pro Controller', () => {
  it('possui layout assimétrico e botões dedicados de sistema', () => {
    const root = createSwitchGamepadModel();
    root.updateMatrixWorld(true);

    const stickL = root.getObjectByName('Stick_L').position;
    const stickR = root.getObjectByName('Stick_R').position;
    const dpad = root.getObjectByName('Dpad_Group').position;

    // Layout assimétrico
    expect(stickL.x).toBeLessThan(0);
    expect(stickL.z).toBeLessThan(0);
    expect(dpad.x).toBeLessThan(0);
    expect(dpad.z).toBeGreaterThan(0);
    expect(stickR.x).toBeGreaterThan(0);
    expect(stickR.z).toBeGreaterThan(0);

    // Nós canônicos e nós exclusivos
    for (const name of canonicalNodes) {
      expect(root.getObjectByName(name), `Nó ${name} deve existir no modelo Switch Pro`).toBeTruthy();
    }
    expect(root.getObjectByName('Button_Capture')).toBeTruthy();

    root.traverse(p => p.geometry?.dispose());
  });
});

describe('Validação dos arquivos GLB gerados', () => {
  it('gamepad-xbox.glb possui todos os nós canônicos e revisão correta', async () => {
    const bytes = fs.readFileSync('css/assets/gamepad-xbox.glb');
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    const root = gltf.scene.getObjectByName('GamepadRoot');

    expect(root).toBeTruthy();
    expect(root.userData.modelRevision).toBe(GAMEPAD_MODEL_REVISION);

    for (const name of canonicalNodes) {
      expect(root.getObjectByName(name), `GLB Xbox deve conter nó ${name}`).toBeTruthy();
    }
  });

  it('gamepad-switch.glb possui todos os nós canônicos e revisão correta', async () => {
    const bytes = fs.readFileSync('css/assets/gamepad-switch.glb');
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    const root = gltf.scene.getObjectByName('GamepadRoot');

    expect(root).toBeTruthy();
    expect(root.userData.modelRevision).toBe(GAMEPAD_MODEL_REVISION);

    for (const name of canonicalNodes) {
      expect(root.getObjectByName(name), `GLB Switch deve conter nó ${name}`).toBeTruthy();
    }
  });
});

describe('Alternância dinâmica de modelo no Gamepad3DViewer', () => {
  it('inicializa com o tipo especificado e permite troca dinâmica via setGamepadType', () => {
    const v = makeViewer({ gamepadType: 'playstation' });
    expect(v.gamepadType).toBe('playstation');
    expect(v.parts.stickL).toBeTruthy();

    // Troca para Xbox
    v.setGamepadType('xbox');
    expect(v.gamepadType).toBe('xbox');
    expect(v.parts.stickL).toBeTruthy();
    // No Xbox, Stick_L fica em z < 0 (assimétrico)
    expect(v.parts.stickL.position.z).toBeLessThan(0);

    // Troca para Nintendo Switch Pro
    v.setGamepadType('nintendo');
    expect(v.gamepadType).toBe('nintendo');
    expect(v.parts.stickL).toBeTruthy();
    expect(v.parts.buttonGuide).toBeTruthy();
  });

  it('detecta automaticamente o tipo e atualiza o modelo quando updateInputs traz ID de dispositivo', () => {
    const v = makeViewer({ gamepadType: 'playstation' });
    expect(v.gamepadType).toBe('playstation');

    // Simula evento de input com controle Xbox
    v.updateInputs({
      connected: true,
      device: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
      axes: [0.5, -0.5, 0, 0],
      buttons: Array(17).fill(0)
    });

    expect(v.gamepadType).toBe('xbox');
    // Verifica que os inputs ativos foram aplicados no novo modelo
    expect(v.parts.stickL.rotation.z).toBeLessThan(0);

    // Simula evento de input com Switch Pro Controller
    v.updateInputs({
      connected: true,
      device: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
      axes: [0, 0, 0.8, 0],
      buttons: Array(17).fill(0)
    });

    expect(v.gamepadType).toBe('nintendo');
    expect(v.parts.stickR.rotation.z).toBeLessThan(0);
  });
});
