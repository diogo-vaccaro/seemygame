import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGamepadModel, getGamepadModelUrl } from ".././gamepad-model-builder.js";
/** Gamepad3DViewer: model. State and lifetime remain owned by the composed engine. */
export const withGamepad3DViewerModel = Base => class extends Base {
_disposeHierarchy(rootObj) {
    if (!rootObj) return;
    const disposedGeos = new Set();
    const disposedMats = new Set();
    const disposedTexs = new Set();
    rootObj.traverse((obj) => {
      if (obj.geometry && typeof obj.geometry.dispose === 'function' && !disposedGeos.has(obj.geometry)) {
        disposedGeos.add(obj.geometry);
        obj.geometry.dispose();
      }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (!mat || disposedMats.has(mat)) continue;
          disposedMats.add(mat);
          for (const key of Object.keys(mat)) {
            const val = mat[key];
            if (val && typeof val.dispose === 'function' && !disposedTexs.has(val)) {
              disposedTexs.add(val);
              val.dispose();
            }
          }
          if (typeof mat.dispose === 'function') {
            mat.dispose();
          }
        }
      }
    });
  }

_loadModel() {
    const type = this.gamepadType || 'playstation';
    // 1. Instanciação inicial imediata do modelo procedural (0ms de latência)
    const proceduralModel = createGamepadModel(type);
    this._attachModel(proceduralModel);
    this.modelSource = 'procedural';

    // 2. Se houver URL do GLB e suporte a GLTFLoader, tenta carregar o GLB externo
    if (this.modelUrl && typeof GLTFLoader !== 'undefined') {
      const currentUrl = this.modelUrl;
      try {
        const loader = new GLTFLoader();
        loader.load(
          currentUrl,
          (gltf) => {
            if (this.isDestroyed || !this.controllerGroup || this.modelUrl !== currentUrl) {
              if (gltf?.scene) this._disposeHierarchy(gltf.scene);
              return;
            }
            if (gltf?.scene) {
              while (this.controllerGroup.children.length > 0) {
                const child = this.controllerGroup.children[0];
                this.controllerGroup.remove(child);
                this._disposeHierarchy(child);
              }
              this._attachModel(gltf.scene);
              this.modelSource = 'glb';
              this._lastInputs = null;
              if (this._cachedRawInputs) {
                this.updateInputs(this._cachedRawInputs);
              }
              this.requestRender();
            }
          },
          undefined,
          () => {
            // Mantém o modelo procedural silenciosamente em caso de erro na requisição GLB
          }
        );
      } catch (e) {
        // Fallback procedural
      }
    }
  }

setGamepadType(type) {
    const norm = String(type || '').toLowerCase().trim();
    const canonical = (norm === 'xbox' || norm === 'xinput') ? 'xbox'
      : (norm === 'nintendo' || norm === 'switch' || norm === '8bitdo') ? 'nintendo'
      : 'playstation';

    if (this.gamepadType === canonical && this.controllerGroup && this.controllerGroup.children.length > 0) {
      return;
    }
    this.gamepadType = canonical;
    if (!this._customModelUrl) {
      this.modelUrl = getGamepadModelUrl(canonical);
    }

    if (this.controllerGroup) {
      while (this.controllerGroup.children.length > 0) {
        const child = this.controllerGroup.children[0];
        this.controllerGroup.remove(child);
        this._disposeHierarchy(child);
      }
    }

    if (this.isInitialized) {
      this._loadModel();
      if (this._cachedRawInputs) {
        this._lastInputs = null;
        this.updateInputs(this._cachedRawInputs);
      }
      if (typeof this.requestRender === 'function') {
        this.requestRender();
      }
    }
  }


_attachModel(model) {
    this.controllerGroup.add(model);
    this._fitCameraToModel();
    this.initialTransforms.clear();
    this.partMaterials.clear();
    this._lastInputs = null;

    // Mapeamento e cache de peças interativas
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
    this.parts.guideDisc = find('Button_Guide_Disc');
    this.parts.guideRing = find('Button_Guide_Ring');
    this.parts.body = find('Body');

    // Registra posições e rotações iniciais e prepara materiais independentes
    for (const key of Object.keys(this.parts)) {
      const obj = this.parts[key];
      if (obj && obj.position && obj.rotation) {
        this.initialTransforms.set(obj, {
          pos: obj.position.clone(),
          rot: obj.rotation.clone()
        });
      }
      if (obj) {
        this._preparePartMaterials(obj);
      }
    }

    // Registra subpartes da cúpula do analógico para depressão unificada (Cap, Dish, Rim, Grooves)
    this.stickLCapParts = [];
    if (this.parts.stickL) {
      this.parts.stickL.children.forEach((child) => {
        if (child.name !== 'Stick_L_Ball' && child.name !== 'Stick_L_Stem') {
          this.stickLCapParts.push(child);
          this.initialTransforms.set(child, { pos: child.position.clone(), rot: child.rotation.clone() });
        }
      });
    }

    this.stickRCapParts = [];
    if (this.parts.stickR) {
      this.parts.stickR.children.forEach((child) => {
        if (child.name !== 'Stick_R_Ball' && child.name !== 'Stick_R_Stem') {
          this.stickRCapParts.push(child);
          this.initialTransforms.set(child, { pos: child.position.clone(), rot: child.rotation.clone() });
        }
      });
    }
  }

_preparePartMaterials(obj) {
    if (!obj) return;
    const records = [];
    obj.traverse((child) => {
      if (child.isMesh && child.material) {
        if (Array.isArray(child.material)) {
          child.material = child.material.map((m) => {
            if (!m.__viewerCloned) {
              const clone = m.clone();
              clone.__viewerCloned = true;
              return clone;
            }
            return m;
          });
          for (const m of child.material) {
            records.push({
              material: m,
              baseEmissive: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
              baseIntensity: typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 0.0
            });
          }
        } else {
          if (!child.material.__viewerCloned) {
            child.material = child.material.clone();
            child.material.__viewerCloned = true;
          }
          records.push({
            material: child.material,
            baseEmissive: child.material.emissive ? child.material.emissive.clone() : new THREE.Color(0x000000),
            baseIntensity: typeof child.material.emissiveIntensity === 'number' ? child.material.emissiveIntensity : 0.0
          });
        }
      }
    });
    if (records.length > 0) {
      this.partMaterials.set(obj, records);
    }
  }

_setPartEmissive(obj, active, highlightColor = null, boostIntensity = null) {
    if (!obj) return;
    const records = this.partMaterials.get(obj);
    if (!records) return;

    for (const { material, baseEmissive, baseIntensity } of records) {
      if (!material || !material.emissive) continue;
      if (active) {
        if (highlightColor !== null) {
          material.emissive.set(highlightColor);
        } else {
          material.emissive.copy(baseEmissive);
        }
        material.emissiveIntensity = boostIntensity !== null
          ? boostIntensity
          : (baseIntensity > 0 ? baseIntensity * 2.8 + 0.8 : 1.8);
      } else {
        material.emissive.copy(baseEmissive);
        material.emissiveIntensity = baseIntensity;
      }
    }
  }
};
