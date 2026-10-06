import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGamepadModel, GAMEPAD_MODEL_REVISION, getGamepadModelUrl } from './gamepad-model-builder.js';
export { getGamepadModelUrl };

import { withGamepad3DViewerModel } from './gamepad-3d-viewer/model.js';
import { withGamepad3DViewerPointer } from './gamepad-3d-viewer/pointer.js';
import { withGamepad3DViewerMapping } from './gamepad-3d-viewer/mapping.js';
import { withGamepad3DViewerRenderer } from './gamepad-3d-viewer/renderer.js';
export class Gamepad3DViewer extends withGamepad3DViewerRenderer(withGamepad3DViewerMapping(withGamepad3DViewerPointer(withGamepad3DViewerModel(class {})))) {
constructor(options = {}) {
    super();
    this.container = options.container || null;
    this.canvas = options.canvas || null;
    this.renderer = options.renderer || null;
    this._customModelUrl = options.modelUrl !== undefined;
    this.gamepadType = options.gamepadType || 'playstation';
    this.modelUrl = options.modelUrl === null ? null : (options.modelUrl || getGamepadModelUrl(this.gamepadType));
    this.modelSource = null;
    this.enableMouseTracking = options.enableMouseTracking !== false;
    this.fitToContainer = options.fitToContainer === true;

    this.scene = null;
    this.camera = null;
    this.controllerGroup = null;
    this.isInitialized = false;
    this.isDestroyed = false;
    this.isRendering = false;
    this.isPaused = false;
    this.animId = null;
    this.settleFrames = 0;

    // Subpartes das cabeças dos analógicos (cúpula, prato, aro, ranhuras)
    this.stickLCapParts = [];
    this.stickRCapParts = [];
    this._lastInputs = null;

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
      guideDisc: null,
      guideRing: null,
      body: null,
      shadow: null
    };

    // Posições e rotações originais de descanso
    this.initialTransforms = new Map();

    // Cache de materiais para feedback emissivo dinâmico sem interferência mútua
    this.partMaterials = new Map();

    // Estado de tracking do mouse
    this.baseRotation = { x: 0.36, y: -0.05, z: 0 };
    this.targetRotation = { x: 0.36, y: -0.05, z: 0 };
    this.currentRotation = { x: 0.36, y: -0.05, z: 0 };
    this.mouse = { x: 0, y: 0, isHovering: false };
    this._renderedWidth = 0;
    this._renderedHeight = 0;
    this.resizeObserver = null;

    // Estado do rumble
    this.rumbleIntensity = 0;
    this.rumbleDecay = 0.92;

    // Estado de conexão e atividade
    this.isConnected = true;
    this.hasActiveInputs = false;

    // Handlers para remoção de listeners
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseEnter = this._onMouseEnter.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
    this._onResize = this._onResize.bind(this);
    this._renderLoop = this._renderLoop.bind(this);
  }

init() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (this.isInitialized) return true;
    if (this.isDestroyed) return false;

    try {
      if (!this.canvas && this.container) {
        this.canvas = this.container.querySelector('canvas') || document.createElement('canvas');
        if (!this.canvas.parentElement) {
          this.canvas.className = 'gamepad-3d-canvas';
          this.container.appendChild(this.canvas);
        }
      }

      if (!this.canvas && !this.renderer) return false;

      // Criação ou reutilização do WebGLRenderer com antialiasing e fundo transparente
      if (!this.renderer && this.canvas) {
        this.renderer = new THREE.WebGLRenderer({
          canvas: this.canvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance'
        });
      }

      if (!this.renderer) return false;

      if (this.renderer.setPixelRatio) {
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      }
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;

      // Cena 3D
      this.scene = new THREE.Scene();

      // Câmera Perspectiva
      const dims = this._getEffectiveDimensions();
      const aspect = dims.width / (dims.height || 1);
      this.camera = new THREE.PerspectiveCamera(34, aspect, 0.1, 100);
      this.camera.position.set(0, 4.4, 3.35);
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

      // Setup de mouse tracking no container e canvas
      this._setupMouseTracking();

      this._onResize(true);
      window.addEventListener('resize', this._onResize);

      if (typeof ResizeObserver !== 'undefined') {
        const observeTarget = this.container || (this.canvas && this.canvas.parentElement) || this.canvas;
        if (observeTarget) {
          try {
            this.resizeObserver = new ResizeObserver((entries) => {
              for (const entry of entries) {
                const cr = entry.contentRect;
                if (!cr || cr.width > 0 || cr.height > 0) {
                  this._onResize(false);
                  break;
                }
              }
            });
            this.resizeObserver.observe(observeTarget);
          } catch (e) {
            console.warn('[Gamepad3DViewer] Falha ao inicializar ResizeObserver:', e);
          }
        }
      }

      this.isInitialized = true;
      this.requestRender();
      return true;
    } catch (err) {
      console.warn('[Gamepad3DViewer] WebGL indisponível ou falha na inicialização:', err);
      return false;
    }
  }

destroy() {
    this.stop();
    if (this.resizeObserver) {
      try {
        this.resizeObserver.disconnect();
      } catch (_) {}
      this.resizeObserver = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onResize);
    }

    const targetEl = this.container || this.canvas;
    if (targetEl) {
      targetEl.removeEventListener('mousemove', this._onMouseMove);
      targetEl.removeEventListener('mouseenter', this._onMouseEnter);
      targetEl.removeEventListener('mouseleave', this._onMouseLeave);
    }

    if (this.parts.shadow) {
      if (this.scene) {
        this.scene.remove(this.parts.shadow);
      }
      if (this.parts.shadow.material) {
        if (this.parts.shadow.material.map && typeof this.parts.shadow.material.map.dispose === 'function') {
          this.parts.shadow.material.map.dispose();
        }
        if (typeof this.parts.shadow.material.dispose === 'function') {
          this.parts.shadow.material.dispose();
        }
      }
      if (this.parts.shadow.geometry && typeof this.parts.shadow.geometry.dispose === 'function') {
        this.parts.shadow.geometry.dispose();
      }
      this.parts.shadow = null;
    }

    if (this.scene) {
      this._disposeHierarchy(this.scene);
    }

    this.initialTransforms.clear();
    this.partMaterials.clear();
    for (const key of Object.keys(this.parts)) {
      this.parts[key] = null;
    }
    this.stickLCapParts = [];
    this.stickRCapParts = [];
    this._lastInputs = null;

    if (this.renderer) {
      if (typeof this.renderer.dispose === 'function') {
        this.renderer.dispose();
      }
      if (typeof this.renderer.forceContextLoss === 'function') {
        this.renderer.forceContextLoss();
      }
      this.renderer = null;
    }

    this.scene = null;
    this.camera = null;
    this.controllerGroup = null;
    this.canvas = null;
    this.container = null;
    this.isInitialized = false;
    this.isDestroyed = true;
  }
}
