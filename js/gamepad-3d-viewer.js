/**
 * SeeMyGame - Gamepad 3D Viewer (Three.js + GLTF + Mouse Tracking)
 * Renderizador WebGL de alta fidelidade para visualização e calibração de gamepads em 3D real.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGamepadModel } from './gamepad-model-builder.js';

export class Gamepad3DViewer {
  constructor(options = {}) {
    this.container = options.container || null;
    this.canvas = options.canvas || null;
    this.modelUrl = options.modelUrl || 'css/assets/gamepad.glb';
    this.enableMouseTracking = options.enableMouseTracking !== false;

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controllerGroup = null;
    this.isInitialized = false;
    this.animId = null;

    // Peças animáveis indexadas
    this.parts = {
      stickL: null,
      stickR: null,
      dpadUp: null,
      dpadDown: null,
      dpadLeft: null,
      dpadRight: null,
      dpadGroup: null,
      buttonA: null,
      buttonB: null,
      buttonX: null,
      buttonY: null,
      bumperLB: null,
      bumperRB: null,
      triggerLT: null,
      triggerRT: null,
      buttonBack: null,
      buttonStart: null,
      buttonGuide: null,
      body: null,
      shadow: null
    };

    // Posições e rotações originais de descanso
    this.initialTransforms = new Map();

    // Estado de tracking do mouse
    this.baseRotation = { x: 0.36, y: -0.05, z: 0 };
    this.targetRotation = { x: 0.36, y: -0.05, z: 0 };
    this.mouse = { x: 0, y: 0, isHovering: false };

    // Estado do rumble
    this.rumbleIntensity = 0;
    this.rumbleDecay = 0.92;

    // Handlers para remoção de listeners
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseEnter = this._onMouseEnter.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
    this._onResize = this._onResize.bind(this);
    this._renderLoop = this._renderLoop.bind(this);
  }

  /**
   * Inicializa o renderizador WebGL, cena, luzes e câmera
   */
  init() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (this.isInitialized) return true;

    try {
      if (!this.canvas && this.container) {
        this.canvas = this.container.querySelector('canvas') || document.createElement('canvas');
        if (!this.canvas.parentElement) {
          this.canvas.className = 'gamepad-3d-canvas';
          this.container.appendChild(this.canvas);
        }
      }

      if (!this.canvas) return false;

      // Criação do WebGLRenderer com antialiasing e fundo transparente
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance'
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;

      // Cena 3D
      this.scene = new THREE.Scene();

      // Câmera Perspectiva
      const aspect = (this.canvas.clientWidth || 380) / (this.canvas.clientHeight || 240);
      this.camera = new THREE.PerspectiveCamera(34, aspect, 0.1, 100);
      this.camera.position.set(0, 2.35, 3.35);
      this.camera.lookAt(0, -0.05, 0.08);

      // Configuração de Iluminação Estúdio Gamer (Key Light + Rim/Neon Accents)
      this._setupLighting();

      // Contêiner principal do controle
      this.controllerGroup = new THREE.Group();
      this.controllerGroup.name = 'ControllerPivot';
      this.controllerGroup.rotation.set(this.baseRotation.x, this.baseRotation.y, this.baseRotation.z);
      this.scene.add(this.controllerGroup);

      // Sombra de contato no chão
      this._setupGroundShadow();

      // Carrega o modelo GLB (com fallback procedural instantâneo)
      this._loadModel();

      // Setup de mouse tracking no container e janela
      this._setupMouseTracking();

      this._onResize();
      window.addEventListener('resize', this._onResize);

      this.isInitialized = true;
      this.start();
      return true;
    } catch (err) {
      console.warn('[Gamepad3DViewer] WebGL indisponível ou falha na inicialização:', err);
      return false;
    }
  }

  _setupLighting() {
    // Luz ambiente para visibilidade geral
    const ambientLight = new THREE.AmbientLight(0x404866, 1.8);
    this.scene.add(ambientLight);

    // Key Light branca direcional frontal
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
    keyLight.position.set(2.5, 4.2, 3.6);
    this.scene.add(keyLight);

    // Rim Light Roxa Neon (Gamer Accent esquerda)
    const rimPurple = new THREE.DirectionalLight(0xc084fc, 3.8);
    rimPurple.position.set(-4.5, 2.0, -2.5);
    this.scene.add(rimPurple);

    // Fill Light Azul Ciano (Gamer Accent direita)
    const fillCyan = new THREE.DirectionalLight(0x22d3ee, 3.5);
    fillCyan.position.set(4.5, 1.8, -2.0);
    this.scene.add(fillCyan);

    // Luz de preenchimento frontal suave para destacar chanfros e detalhes
    const frontFill = new THREE.PointLight(0xa5b4fc, 1.8, 12);
    frontFill.position.set(0, -0.4, 3.0);
    this.scene.add(frontFill);
  }

  _setupGroundShadow() {
    const shadowGeo = new THREE.PlaneGeometry(3.8, 2.6);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(128, 128, 20, 128, 128, 120);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.7)');
      grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.3)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });
    this.parts.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.parts.shadow.rotation.x = -Math.PI / 2;
    this.parts.shadow.position.set(0, -0.68, 0.2);
    this.scene.add(this.parts.shadow);
  }

  _loadModel() {
    // 1. Instanciação inicial imediata do modelo procedural (0ms de latência)
    const proceduralModel = createGamepadModel();
    this._attachModel(proceduralModel);

    // 2. Se houver URL do GLB e suporte a GLTFLoader, tenta carregar o GLB externo
    if (this.modelUrl && typeof GLTFLoader !== 'undefined') {
      const loader = new GLTFLoader();
      loader.load(
        this.modelUrl,
        (gltf) => {
          if (gltf?.scene) {
            // Substitui o modelo procedural pelo GLB carregado
            while (this.controllerGroup.children.length > 0) {
              this.controllerGroup.remove(this.controllerGroup.children[0]);
            }
            this._attachModel(gltf.scene);
          }
        },
        undefined,
        (err) => {
          // Mantém o modelo procedural silenciosamente em caso de erro na requisição GLB
          // (ex: modo offline ou teste local)
        }
      );
    }
  }

  _attachModel(model) {
    this.controllerGroup.add(model);
    this.initialTransforms.clear();

    // Mapeamento e cache de peças
    const find = (name) => model.getObjectByName(name) || null;

    this.parts.stickL = find('Stick_L');
    this.parts.stickR = find('Stick_R');
    this.parts.dpadGroup = find('Dpad_Group');
    this.parts.dpadUp = find('Dpad_Up');
    this.parts.dpadDown = find('Dpad_Down');
    this.parts.dpadLeft = find('Dpad_Left');
    this.parts.dpadRight = find('Dpad_Right');
    this.parts.buttonA = find('Button_A');
    this.parts.buttonB = find('Button_B');
    this.parts.buttonX = find('Button_X');
    this.parts.buttonY = find('Button_Y');
    this.parts.bumperLB = find('Bumper_LB');
    this.parts.bumperRB = find('Bumper_RB');
    this.parts.triggerLT = find('Trigger_LT');
    this.parts.triggerRT = find('Trigger_RT');
    this.parts.buttonBack = find('Button_Back');
    this.parts.buttonStart = find('Button_Start');
    this.parts.buttonGuide = find('Button_Guide');
    this.parts.body = find('Body');

    // Registra posições e rotações iniciais
    for (const key of Object.keys(this.parts)) {
      const obj = this.parts[key];
      if (obj && obj.position && obj.rotation) {
        this.initialTransforms.set(obj, {
          pos: obj.position.clone(),
          rot: obj.rotation.clone()
        });
      }
    }
  }

  _setupMouseTracking() {
    if (!this.enableMouseTracking) return;

    const targetEl = this.container || this.canvas;
    if (!targetEl) return;

    targetEl.addEventListener('mousemove', this._onMouseMove);
    targetEl.addEventListener('mouseenter', this._onMouseEnter);
    targetEl.addEventListener('mouseleave', this._onMouseLeave);
  }

  _onMouseMove(e) {
    const rect = (this.container || this.canvas).getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;

    this.mouse.x = Math.max(-1, Math.min(1, nx));
    this.mouse.y = Math.max(-1, Math.min(1, ny));
    this.mouse.isHovering = true;

    // Inclinação suave do controle acompanhando a posição do cursor
    // Pitch (eixo X) e Yaw (eixo Y)
    this.targetRotation.y = this.baseRotation.y + this.mouse.x * 0.44;
    this.targetRotation.x = this.baseRotation.x - this.mouse.y * 0.32;
    this.targetRotation.z = -this.mouse.x * 0.08;
  }

  _onMouseEnter() {
    this.mouse.isHovering = true;
  }

  _onMouseLeave() {
    this.mouse.isHovering = false;
    this.targetRotation.x = this.baseRotation.x;
    this.targetRotation.y = this.baseRotation.y;
    this.targetRotation.z = this.baseRotation.z;
  }

  _onResize() {
    if (!this.canvas || !this.renderer || !this.camera) return;

    const width = this.canvas.clientWidth || 380;
    const height = this.canvas.clientHeight || 240;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Dispara feedback visual de vibração física do controle (Rumble)
   */
  triggerRumble(intensity = 1.0) {
    this.rumbleIntensity = Math.max(this.rumbleIntensity, intensity);
  }

  /**
   * Atualiza o estado visual das peças 3D com dados reais do Gamepad
   */
  updateInputs(gamepadData = {}) {
    if (!this.isInitialized) return;

    const axes = gamepadData.axes || [0, 0, 0, 0];
    const buttons = gamepadData.buttons || [];

    const getBtn = (idx) => {
      const b = buttons[idx];
      if (typeof b === 'object' && b !== null) {
        return { pressed: Boolean(b.pressed), value: Number(b.value || 0) };
      }
      const val = Number(b || 0);
      return { pressed: val > 0.1, value: val };
    };

    const MAX_STICK_ANGLE = 0.42; // ~24 graus
    const MAX_TRIGGER_ANGLE = 0.32; // ~18 graus
    const PRESS_DEPTH = 0.08;

    // 1. Analógico Esquerdo (Stick_L)
    if (this.parts.stickL) {
      const init = this.initialTransforms.get(this.parts.stickL);
      if (init) {
        const lx = Math.max(-1, Math.min(1, axes[0] || 0));
        const ly = Math.max(-1, Math.min(1, axes[1] || 0));
        const l3Pressed = getBtn(10).pressed;

        this.parts.stickL.rotation.x = init.rot.x - ly * MAX_STICK_ANGLE;
        this.parts.stickL.rotation.z = init.rot.z - lx * MAX_STICK_ANGLE;
        this.parts.stickL.position.y = init.pos.y - (l3Pressed ? 0.06 : 0);
      }
    }

    // 2. Analógico Direito (Stick_R)
    if (this.parts.stickR) {
      const init = this.initialTransforms.get(this.parts.stickR);
      if (init) {
        const rx = Math.max(-1, Math.min(1, axes[2] || 0));
        const ry = Math.max(-1, Math.min(1, axes[3] || 0));
        const r3Pressed = getBtn(11).pressed;

        this.parts.stickR.rotation.x = init.rot.x - ry * MAX_STICK_ANGLE;
        this.parts.stickR.rotation.z = init.rot.z - rx * MAX_STICK_ANGLE;
        this.parts.stickR.position.y = init.pos.y - (r3Pressed ? 0.06 : 0);
      }
    }

    // 3. Gatilhos Analógicos (LT / RT) - Rotação contínua proporcional
    if (this.parts.triggerLT) {
      const init = this.initialTransforms.get(this.parts.triggerLT);
      if (init) {
        const ltVal = getBtn(6).value;
        this.parts.triggerLT.rotation.x = init.rot.x - ltVal * MAX_TRIGGER_ANGLE;
      }
    }

    if (this.parts.triggerRT) {
      const init = this.initialTransforms.get(this.parts.triggerRT);
      if (init) {
        const rtVal = getBtn(7).value;
        this.parts.triggerRT.rotation.x = init.rot.x - rtVal * MAX_TRIGGER_ANGLE;
      }
    }

    // 4. Bumpers dos Ombros (LB / RB)
    const updateDepress = (obj, pressed) => {
      if (!obj) return;
      const init = this.initialTransforms.get(obj);
      if (init) {
        obj.position.y = init.pos.y - (pressed ? PRESS_DEPTH : 0);
      }
    };

    updateDepress(this.parts.bumperLB, getBtn(4).pressed);
    updateDepress(this.parts.bumperRB, getBtn(5).pressed);

    // 5. Botões de Ação (A, B, X, Y)
    updateDepress(this.parts.buttonA, getBtn(0).pressed);
    updateDepress(this.parts.buttonB, getBtn(1).pressed);
    updateDepress(this.parts.buttonX, getBtn(2).pressed);
    updateDepress(this.parts.buttonY, getBtn(3).pressed);

    // 6. Botões do Sistema (Back, Start, Guide)
    updateDepress(this.parts.buttonBack, getBtn(8).pressed);
    updateDepress(this.parts.buttonStart, getBtn(9).pressed);
    updateDepress(this.parts.buttonGuide, getBtn(16).pressed);

    // 7. D-Pad (Up: 12, Down: 13, Left: 14, Right: 15)
    updateDepress(this.parts.dpadUp, getBtn(12).pressed);
    updateDepress(this.parts.dpadDown, getBtn(13).pressed);
    updateDepress(this.parts.dpadLeft, getBtn(14).pressed);
    updateDepress(this.parts.dpadRight, getBtn(15).pressed);

    // Inclinação combinada do conjunto do D-Pad
    if (this.parts.dpadGroup) {
      const init = this.initialTransforms.get(this.parts.dpadGroup);
      if (init) {
        const up = getBtn(12).pressed ? 1 : 0;
        const down = getBtn(13).pressed ? 1 : 0;
        const left = getBtn(14).pressed ? 1 : 0;
        const right = getBtn(15).pressed ? 1 : 0;

        this.parts.dpadGroup.rotation.x = init.rot.x + (down - up) * 0.12;
        this.parts.dpadGroup.rotation.z = init.rot.z + (left - right) * 0.12;
      }
    }
  }

  start() {
    if (this.animId !== null) return;
    this._renderLoop();
  }

  stop() {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  _renderLoop() {
    this.animId = requestAnimationFrame(this._renderLoop);

    if (!this.renderer || !this.scene || !this.camera || !this.controllerGroup) return;

    const time = performance.now() * 0.001;

    // 1. Mouse tracking interpolação suave (Lerp)
    this.controllerGroup.rotation.x += (this.targetRotation.x - this.controllerGroup.rotation.x) * 0.085;
    this.controllerGroup.rotation.y += (this.targetRotation.y - this.controllerGroup.rotation.y) * 0.085;
    this.controllerGroup.rotation.z += (this.targetRotation.z - this.controllerGroup.rotation.z) * 0.085;

    // 2. Micro-flutuação orgânica (idle breathing) quando parado
    const breathY = Math.sin(time * 1.6) * 0.035;
    const breathRoll = Math.cos(time * 1.2) * 0.012;
    this.controllerGroup.position.y = breathY;

    // 3. Simulação física de motores de vibração (Rumble)
    if (this.rumbleIntensity > 0.01) {
      // Simula dois motores ERM com frequências dessincronizadas (motor pesado + motor leve)
      const shakeX = (Math.sin(time * 78) * 0.035 + Math.sin(time * 145) * 0.018) * this.rumbleIntensity;
      const shakeY = (Math.cos(time * 84) * 0.025 + Math.sin(time * 160) * 0.012) * this.rumbleIntensity;
      const shakeRot = Math.sin(time * 95) * 0.025 * this.rumbleIntensity;

      this.controllerGroup.position.x = shakeX;
      this.controllerGroup.position.y += shakeY;
      this.controllerGroup.rotation.z += shakeRot;

      this.rumbleIntensity *= this.rumbleDecay;
    } else {
      this.controllerGroup.position.x = 0;
    }

    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._onResize);

    const targetEl = this.container || this.canvas;
    if (targetEl) {
      targetEl.removeEventListener('mousemove', this._onMouseMove);
      targetEl.removeEventListener('mouseenter', this._onMouseEnter);
      targetEl.removeEventListener('mouseleave', this._onMouseLeave);
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.isInitialized = false;
  }
}
