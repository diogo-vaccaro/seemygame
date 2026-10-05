
import { WHITEBOARD_TOOLS, WHITEBOARD_COLORS, CURSOR_PALETTE, getPeerCursorColor, isTooBrightOrWhite, getContrastTextColor, drawRoundedRect, getFillAlpha, MAX_WHITEBOARD_ELEMENTS, MAX_WHITEBOARD_POINTS, MAX_WHITEBOARD_TEXT_LENGTH, WHITEBOARD_REF_WIDTH, WHITEBOARD_REF_HEIGHT, WHITEBOARD_ELEMENT_TYPES, isFiniteNumber, isSafeWhiteboardElement, processImageFile } from './shared.js';
/** WhiteboardManager: document. State and lifetime remain owned by the composed engine. */
export const withWhiteboardManagerDocument = Base => class extends Base {
setTool(toolId) {
    if (this.textEditing) {
      const finished = this.finishTextEditing(true);
      if (finished?.then) { finished.then(ok => { if (ok) this.setTool(toolId); }); return; }
      if (!finished) return;
    }
    this.cancelDrawing?.();
    this.selectedTool = toolId;
    if (toolId === 'hand') {
      this.selectedElementId = null;
      this.isDraggingElement = false;
      this.isResizingElement = false;
      if (this.canvas && this.canvas.style) this.canvas.style.cursor = 'grab';
    } else if (toolId !== 'select') {
      this.selectedElementId = null;
      this.isDraggingElement = false;
      this.isResizingElement = false;
      if (this.canvas && this.canvas.style) this.canvas.style.cursor = toolId === 'eraser' ? 'cell' : 'crosshair';
    } else {
      if (this.canvas && this.canvas.style) this.canvas.style.cursor = 'default';
    }
    this.render();
    if (typeof this.onToolChanged === 'function') {
      this.onToolChanged(toolId);
    }
  }

  pan(dx, dy) {
    this.panX = (this.panX || 0) + dx;
    this.panY = (this.panY || 0) + dy;
    this.render();
  }

  setZoom(newZoom, centerX = null, centerY = null) {
    const clamped = Math.max(0.15, Math.min(6.0, newZoom));
    const current = this.zoom || 1.0;
    if (this.canvas && isFiniteNumber(centerX) && isFiniteNumber(centerY)) {
      this.panX = centerX - (centerX - (this.panX || 0)) * (clamped / current);
      this.panY = centerY - (centerY - (this.panY || 0)) * (clamped / current);
    }
    this.zoom = clamped;
    this.render();
    if (typeof this.onZoomChanged === 'function') {
      this.onZoomChanged(this.zoom);
    }
  }

  resetView() {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1.0;
    this.render();
    if (typeof this.onZoomChanged === 'function') {
      this.onZoomChanged(this.zoom);
    }
  }

setColor(hexColor) {
    this.currentColor = hexColor;
    if (this.selectedElementId) {
      const el = this.elements.find(e => e.id === this.selectedElementId);
      if (el) {
        el.color = hexColor;
        this.render();
        if (typeof this.onElementUpdated === 'function') {
          this.onElementUpdated(el);
        }
      }
    }
  }

setStrokeWidth(width) {
    this.currentWidth = Number(width) || 4;
    if (this.selectedElementId) {
      const el = this.elements.find(e => e.id === this.selectedElementId);
      if (el) {
        el.strokeWidth = this.currentWidth;
        this.render();
        if (typeof this.onElementUpdated === 'function') {
          this.onElementUpdated(el);
        }
      }
    }
  }

setFill(fillMode) {
    this.currentFill = fillMode;
    if (this.selectedElementId) {
      const el = this.elements.find(e => e.id === this.selectedElementId);
      if (el && el.type !== 'pencil' && el.type !== 'line' && el.type !== 'text' && el.type !== 'formula' && el.type !== 'image') {
        el.fill = fillMode;
        this.render();
        if (typeof this.onElementUpdated === 'function') {
          this.onElementUpdated(el);
        }
      }
    }
  }

setRough(isRough) {
    this.isRough = !!isRough;
  }

setBackgroundMode(mode) {
    this.backgroundMode = mode;
    this.render();
  }

  saveUndoState(snapshot = this.elements.map(e => ({ ...e }))) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 50) {
      this.undoStack.splice(0, this.undoStack.length - 50);
    }
  }

  addElement(element, broadcast = true) {
    if (!isSafeWhiteboardElement(element) || this.elements.length >= MAX_WHITEBOARD_ELEMENTS) return;
    if (this.elements.some(el => el.id === element.id)) return;
    this.saveUndoState();
    this.redoStack = [];
    this.elements.push(element);
    this.render();

    if (broadcast && typeof this.onElementCreated === 'function') {
      this.onElementCreated(element);
    }
  }

  updateElement(element, broadcast = true) {
    if (!isSafeWhiteboardElement(element)) return;
    const idx = this.elements.findIndex(el => el.id === element.id);
    if (idx !== -1) {
      this.saveUndoState();
      this.redoStack = [];
      this.elements[idx] = element;
      this.pruneImageCache();
      this.render();

      if (broadcast && typeof this.onElementUpdated === 'function') {
        this.onElementUpdated(element);
      }
    } else {
      this.addElement(element, broadcast);
    }
  }

  removeElement(elementId, broadcast = true) {
    const idx = this.elements.findIndex(el => el.id === elementId);
    if (idx !== -1) {
      this.saveUndoState();
      this.redoStack = [];
      const removed = this.elements.splice(idx, 1)[0];
      this.pruneImageCache();
      if (this.selectedElementId === elementId) {
        this.selectedElementId = null;
      }
      this.render();

      if (broadcast && typeof this.onElementDeleted === 'function') {
        this.onElementDeleted(removed);
      }
    }
  }

deleteSelected() {
    if (!this.selectedElementId) return false;
    const id = this.selectedElementId;
    this.selectedElementId = null;
    this.removeElement(id, true);
    return true;
  }

undo() {
    if (this.undoStack.length === 0) return false;
    this.invalidateImageImports();
    this.redoStack.push([...this.elements]);
    this.elements = this.undoStack.pop();
    this.pruneImageCache();
    this.selectedElementId = null;
    this.render();
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.invalidateImageImports();
    this.saveUndoState();
    this.elements = this.redoStack.pop();
    this.pruneImageCache();
    this.selectedElementId = null;
    this.render();
    return true;
  }

  clear(broadcast = true) {
    this.invalidateImageImports();
    this.finishTextEditing?.(false);
    this.cancelDrawing?.();
    if (this.elements.length === 0) {
      if (broadcast) this.onBoardCleared?.();
      return;
    }
    this.saveUndoState();
    this.redoStack = [];
    this.elements = [];
    this.pruneImageCache();
    this.selectedElementId = null;
    this.render();

    if (broadcast && typeof this.onBoardCleared === 'function') {
      this.onBoardCleared();
    }
  }

setElements(elements) {
    this.invalidateImageImports();
    this.elements = Array.isArray(elements)
      ? elements.filter(isSafeWhiteboardElement).slice(0, MAX_WHITEBOARD_ELEMENTS)
      : [];
    this.pruneImageCache();
    this.selectedElementId = null;
    this.render();
  }

invalidateImageImports() {
    this.imageImportGeneration++;
    for (const cancel of [...this.pendingImageImports]) cancel();
  }

async importImageFile(file, targetX = null, targetY = null, broadcast = true) {
    const generation = this.imageImportGeneration;
    if (this.isDisposed) return null;
    const dataUrl = await processImageFile(file);
    if (this.isDisposed || generation !== this.imageImportGeneration) return null;
    return this.addImageFromDataUrl(dataUrl, targetX, targetY, broadcast);
  }

async addImageFromDataUrl(dataUrl, targetX = null, targetY = null, broadcast = true) {
    if (this.isDisposed || !dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
    const generation = this.imageImportGeneration;
    return new Promise((resolve) => {
      const img = new Image();
      const finish = value => {
        this.pendingImageImports.delete(cancel);
        img.onload = null; img.onerror = null;
        resolve(value);
      };
      const cancel = () => finish(null);
      this.pendingImageImports.add(cancel);
      img.onload = () => {
        if (this.isDisposed || generation !== this.imageImportGeneration) { finish(null); return; }
        let w = img.naturalWidth || 400;
        let h = img.naturalHeight || 300;
        const MAX_W = 640;
        const MAX_H = 480;
        if (w > MAX_W || h > MAX_H) {
          const ratio = Math.min(MAX_W / w, MAX_H / h);
          w = Math.max(1, Math.round(w * ratio));
          h = Math.max(1, Math.round(h * ratio));
        }

        let posX = targetX;
        let posY = targetY;
        if (!isFiniteNumber(posX) || !isFiniteNumber(posY)) {
          if (this.canvas && this.canvas.width && this.canvas.height) {
            const scaleX = (this.canvas.width || WHITEBOARD_REF_WIDTH) / WHITEBOARD_REF_WIDTH;
            const scaleY = (this.canvas.height || WHITEBOARD_REF_HEIGHT) / WHITEBOARD_REF_HEIGHT;
            const zoom = this.zoom || 1.0;
            const panX = this.panX || 0;
            const panY = this.panY || 0;
            const centerVirtX = ((this.canvas.width / 2) - panX) / (scaleX * zoom);
            const centerVirtY = ((this.canvas.height / 2) - panY) / (scaleY * zoom);
            posX = Math.round(centerVirtX - w / 2);
            posY = Math.round(centerVirtY - h / 2);
          } else {
            posX = Math.round(WHITEBOARD_REF_WIDTH / 2 - w / 2);
            posY = Math.round(WHITEBOARD_REF_HEIGHT / 2 - h / 2);
          }
        }

        const el = {
          id: 'wb_' + Math.random().toString(36).substring(2, 9),
          type: 'image',
          x: posX,
          y: posY,
          width: w,
          height: h,
          startX: posX,
          startY: posY,
          endX: posX + w,
          endY: posY + h,
          dataUrl,
          color: '#ffffff',
          strokeWidth: 2
        };

        this.addElement(el, broadcast);
        if (!this.elements.some(element => element.id === el.id)) { finish(null); return; }
        this.setTool('select');
        this.selectedElementId = el.id;
        this.render();
        finish(el);
      };
      img.onerror = () => {
        console.warn('[Whiteboard] Falha ao carregar imagem para renderização');
        finish(null);
      };
      img.src = dataUrl;
    });
  }
};
