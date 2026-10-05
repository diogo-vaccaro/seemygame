
import { WHITEBOARD_TOOLS, WHITEBOARD_COLORS, CURSOR_PALETTE, getPeerCursorColor, isTooBrightOrWhite, getContrastTextColor, drawRoundedRect, getFillAlpha, MAX_WHITEBOARD_ELEMENTS, MAX_WHITEBOARD_POINTS, MAX_WHITEBOARD_TEXT_LENGTH, WHITEBOARD_REF_WIDTH, WHITEBOARD_REF_HEIGHT, WHITEBOARD_ELEMENT_TYPES, isFiniteNumber, isSafeWhiteboardElement, processImageFile } from './shared.js';
/** WhiteboardManager: input. State and lifetime remain owned by the composed engine. */
export const withWhiteboardManagerInput = Base => class extends Base {
attachEvents() {
    if (!this.canvas || typeof window === 'undefined') return;

    const getCanvasPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const scaleX = (this.canvas.width || WHITEBOARD_REF_WIDTH) / WHITEBOARD_REF_WIDTH;
      const scaleY = (this.canvas.height || WHITEBOARD_REF_HEIGHT) / WHITEBOARD_REF_HEIGHT;
      const zoom = this.zoom || 1.0;
      const panX = this.panX || 0;
      const panY = this.panY || 0;

      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;

      const virtX = (screenX - panX) / (scaleX * zoom);
      const virtY = (screenY - panY) / (scaleY * zoom);

      return {
        x: Math.round(virtX * 10) / 10,
        y: Math.round(virtY * 10) / 10,
        screenX,
        screenY,
        normX: Math.max(0, Math.min(1, virtX / WHITEBOARD_REF_WIDTH)),
        normY: Math.max(0, Math.min(1, virtY / WHITEBOARD_REF_HEIGHT))
      };
    };

    const handlePointerDown = (e) => {
      e.preventDefault();
      const pos = getCanvasPos(e);

      // Pan da tela (Botão do meio do mouse, barra de espaço pressionada ou ferramenta 'hand')
      if (e.button === 1 || this.isSpacePressed || this.selectedTool === 'hand') {
        this.isPanning = true;
        this.panStartPos = { x: e.clientX, y: e.clientY, initialPanX: this.panX || 0, initialPanY: this.panY || 0 };
        if (this.canvas && this.canvas.style) this.canvas.style.cursor = 'grabbing';
        return;
      }

      // Ferramenta Selecionar / Mover / Redimensionar
      if (this.selectedTool === 'select') {
        if (this.selectedElementId) {
          const selectedEl = this.elements.find(el => el.id === this.selectedElementId);
          if (selectedEl && this.hitTestResizeHandle) {
            const handleHit = this.hitTestResizeHandle(selectedEl, pos.x, pos.y);
            if (handleHit) {
              this.isResizingElement = true;
              this.activeResizeHandle = handleHit.handle;
              this.resizeStartPos = { x: pos.x, y: pos.y };
              this.resizeInitialState = JSON.parse(JSON.stringify(selectedEl));
              this._resizeUndoSnapshot = this.elements.map(el => JSON.parse(JSON.stringify(el)));
              if (this.canvas && this.canvas.style) this.canvas.style.cursor = handleHit.cursor;
              return;
            }
          }
        }

        const target = this.findElementAt(pos.x, pos.y);
        if (target) {
          this.selectedElementId = target.id;
          this.isDraggingElement = true;
          this.dragStartPos = { x: pos.x, y: pos.y };
          this.dragInitialState = JSON.parse(JSON.stringify(target));
          this._dragUndoSnapshot = this.elements.map(el => JSON.parse(JSON.stringify(el)));
          if (this.canvas && this.canvas.style) this.canvas.style.cursor = 'grabbing';
        } else {
          this.selectedElementId = null;
          this.isDraggingElement = false;
          this.isResizingElement = false;
          this.dragStartPos = null;
          this.dragInitialState = null;
          this._dragUndoSnapshot = null;
          if (this.canvas && this.canvas.style) this.canvas.style.cursor = 'default';
        }
        this.render();
        return;
      }

      if (this.selectedTool === 'eraser') {
        this.eraseAt(pos.x, pos.y);
        return;
      }

      if (this.selectedTool === 'text') {
        const text = prompt('Digite o texto para a lousa:', 'Nota Tática');
        if (text && text.trim()) {
          const el = {
            id: 'wb_' + Math.random().toString(36).substring(2, 9),
            type: 'text',
            x: pos.x,
            y: pos.y,
            text: text.trim(),
            color: this.currentColor,
            strokeWidth: this.currentWidth
          };
          this.addElement(el, true);
        }
        return;
      }

      this.isDrawing = true;
      const id = 'wb_' + Math.random().toString(36).substring(2, 9);

      if (this.selectedTool === 'pencil') {
        this.currentElement = {
          id,
          type: 'pencil',
          points: [{ x: pos.x, y: pos.y }],
          color: this.currentColor,
          strokeWidth: this.currentWidth,
          rough: this.isRough
        };
      } else {
        this.currentElement = {
          id,
          type: this.selectedTool,
          startX: pos.x,
          startY: pos.y,
          endX: pos.x,
          endY: pos.y,
          color: this.currentColor,
          strokeWidth: this.currentWidth,
          fill: this.currentFill,
          rough: this.isRough
        };
      }
      this.render();
    };

    const handlePointerMove = (e) => {
      const pos = getCanvasPos(e);

      // Notifica movimento do cursor para multiplayer
      if (typeof this.onCursorMoved === 'function') {
        this.onCursorMoved({ x: pos.normX, y: pos.normY });
      }

      // Pan ativo da tela
      if (this.isPanning && this.panStartPos) {
        this.panX = this.panStartPos.initialPanX + (e.clientX - this.panStartPos.x);
        this.panY = this.panStartPos.initialPanY + (e.clientY - this.panStartPos.y);
        this.render();
        return;
      }

      // Ferramenta Selecionar / Mover / Redimensionar
      if (this.selectedTool === 'select') {
        // Redimensionamento ativo
        if (this.isResizingElement && this.selectedElementId && this.resizeInitialState && this.activeResizeHandle) {
          const dx = pos.x - this.resizeStartPos.x;
          const dy = pos.y - this.resizeStartPos.y;
          const el = this.elements.find(e => e.id === this.selectedElementId);
          if (el && this.resizeElement) {
            this.resizeElement(el, this.resizeInitialState, this.activeResizeHandle, dx, dy);
            this.render();
          }
          return;
        }

        // Mover/arrastar objeto ativo
        if (this.isDraggingElement && this.selectedElementId && this.dragInitialState) {
          const dx = pos.x - this.dragStartPos.x;
          const dy = pos.y - this.dragStartPos.y;
          const el = this.elements.find(e => e.id === this.selectedElementId);
          if (el) {
            this.translateElement(el, this.dragInitialState, dx, dy);
            this.render();
          }
          return;
        } else if (this.canvas && this.canvas.style) {
          if (this.selectedElementId && this.hitTestResizeHandle) {
            const selectedEl = this.elements.find(e => e.id === this.selectedElementId);
            if (selectedEl) {
              const handleHit = this.hitTestResizeHandle(selectedEl, pos.x, pos.y);
              if (handleHit) {
                this.canvas.style.cursor = handleHit.cursor;
                return;
              }
            }
          }
          const hoverEl = this.findElementAt(pos.x, pos.y);
          this.canvas.style.cursor = hoverEl ? 'grab' : 'default';
        }
        return;
      }

      if (this.selectedTool === 'hand' && this.canvas?.style) {
        this.canvas.style.cursor = this.isPanning ? 'grabbing' : 'grab';
        return;
      }

      if (!this.isDrawing) return;

      if (this.selectedTool === 'eraser') {
        this.eraseAt(pos.x, pos.y);
        return;
      }

      if (this.currentElement) {
        if (this.currentElement.type === 'pencil') {
          const pts = this.currentElement.points;
          const last = pts[pts.length - 1];
          const distSq = (pos.x - last.x) ** 2 + (pos.y - last.y) ** 2;
          if (distSq >= 9) {
            if (pts.length >= MAX_WHITEBOARD_POINTS - 1) {
              this.addElement(this.currentElement, true);
              this.currentElement = { ...this.currentElement, id: 'wb_' + Math.random().toString(36).slice(2, 11), points: [{ ...last }] };
            }
            this.currentElement.points.push({ x: pos.x, y: pos.y });
            this.render();
          }
        } else {
          this.currentElement.endX = pos.x;
          this.currentElement.endY = pos.y;
          this.render();
        }
      }
    };

    const handlePointerUp = (e) => {
      // Pan finalizado
      if (this.isPanning) {
        this.isPanning = false;
        this.panStartPos = null;
        if (this.canvas && this.canvas.style) {
          this.canvas.style.cursor = (this.isSpacePressed || this.selectedTool === 'hand') ? 'grab' : 'default';
        }
        return;
      }

      // Redimensionamento finalizado
      if (this.selectedTool === 'select' && this.isResizingElement) {
        this.isResizingElement = false;
        this.activeResizeHandle = null;
        if (this.canvas && this.canvas.style) this.canvas.style.cursor = 'default';
        const el = this.elements.find(e => e.id === this.selectedElementId);
        if (el && this._resizeUndoSnapshot) {
          this.saveUndoState(this._resizeUndoSnapshot);
          this.redoStack = [];
          if (typeof this.onElementUpdated === 'function') {
            this.onElementUpdated(el);
          }
        }
        this.resizeStartPos = null;
        this.resizeInitialState = null;
        this._resizeUndoSnapshot = null;
        this.render();
        return;
      }

      // Ferramenta Selecionar / Mover
      if (this.selectedTool === 'select' && this.isDraggingElement) {
        this.isDraggingElement = false;
        if (this.canvas && this.canvas.style) this.canvas.style.cursor = 'default';
        const el = this.elements.find(e => e.id === this.selectedElementId);
        if (el && this.dragInitialState && this._dragUndoSnapshot) {
          const initial = this.dragInitialState;
          const hasMoved = (el.startX !== undefined && initial.startX !== undefined && (Math.abs(el.startX - initial.startX) > 1 || Math.abs(el.startY - initial.startY) > 1)) ||
            (el.points && initial.points && Math.abs(el.points[0]?.x - initial.points[0]?.x) > 1) ||
            (el.x !== undefined && initial.x !== undefined && (Math.abs(el.x - initial.x) > 1 || Math.abs(el.y - initial.y) > 1));

          if (hasMoved) {
            this.saveUndoState(this._dragUndoSnapshot);
            this.redoStack = [];
            if (typeof this.onElementUpdated === 'function') {
              this.onElementUpdated(el);
            }
          }
        }
        this.dragStartPos = null;
        this.dragInitialState = null;
        this._dragUndoSnapshot = null;
        this.render();
        return;
      }

      if (!this.isDrawing) return;
      this.isDrawing = false;

      if (this.currentElement) {
        // Valida se o elemento tem tamanho significativo
        let isValid = true;
        if (this.currentElement.type === 'pencil') {
          if (e && (e.clientX !== undefined || e.touches)) {
            const pos = getCanvasPos(e);
            const pts = this.currentElement.points;
            const last = pts[pts.length - 1];
            if (last && pts.length < MAX_WHITEBOARD_POINTS && (last.x !== pos.x || last.y !== pos.y)) {
              pts.push({ x: pos.x, y: pos.y });
            }
          }
          isValid = this.currentElement.points.length > 1;
        } else {
          const dx = Math.abs(this.currentElement.endX - this.currentElement.startX);
          const dy = Math.abs(this.currentElement.endY - this.currentElement.startY);
          isValid = dx > 4 || dy > 4;
        }

        if (isValid) {
          this.addElement(this.currentElement, true);
        }
        this.currentElement = null;
        this.render();
      }
    };

    const handleWheel = (e) => {
      e.preventDefault();
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      const currentZoom = this.zoom || 1.0;
      this.setZoom(currentZoom * zoomFactor, cx, cy);
    };

    const handleKeyDown = (e) => {
      if (e.code === 'Space' && !this.isSpacePressed) {
        if (e.target?.matches?.('input,textarea')) return;
        this.isSpacePressed = true;
        if (this.canvas?.style && !this.isPanning) {
          this.canvas.style.cursor = 'grab';
        }
      }
    };

    const handleKeyUp = (e) => {
      if (e.code === 'Space') {
        this.isSpacePressed = false;
        if (this.canvas?.style && !this.isPanning && this.selectedTool !== 'hand') {
          this.canvas.style.cursor = this.selectedTool === 'select' ? 'default' : (this.selectedTool === 'eraser' ? 'cell' : 'crosshair');
        }
      }
    };

    if (this._pointerUpHandler && typeof window !== 'undefined') {
      window.removeEventListener('mouseup', this._pointerUpHandler);
      window.removeEventListener('touchend', this._pointerUpHandler);
    }
    if (this._wheelHandler && this.canvas) {
      this.canvas.removeEventListener('wheel', this._wheelHandler);
    }
    if (this._keyDownHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._keyDownHandler);
      window.removeEventListener('keyup', this._keyUpHandler);
    }

    this._pointerUpHandler = handlePointerUp;
    this._wheelHandler = handleWheel;
    this._keyDownHandler = handleKeyDown;
    this._keyUpHandler = handleKeyUp;

    this.canvas.onmousedown = handlePointerDown;
    this.canvas.onmousemove = handlePointerMove;
    if (typeof window !== 'undefined') window.addEventListener('mouseup', handlePointerUp);

    this.canvas.ontouchstart = handlePointerDown;
    this.canvas.ontouchmove = handlePointerMove;
    if (typeof window !== 'undefined') window.addEventListener('touchend', handlePointerUp);

    if (typeof this.canvas.addEventListener === 'function') {
      this.canvas.addEventListener('wheel', handleWheel, { passive: false });
    } else {
      this.canvas.onwheel = handleWheel;
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
    }
  }

dispose() {
    if (this._pointerUpHandler && typeof window !== 'undefined') {
      window.removeEventListener('mouseup', this._pointerUpHandler);
      window.removeEventListener('touchend', this._pointerUpHandler);
    }
    if (this._wheelHandler && this.canvas) {
      if (typeof this.canvas.removeEventListener === 'function') {
        this.canvas.removeEventListener('wheel', this._wheelHandler);
      } else {
        this.canvas.onwheel = null;
      }
    }
    if (this._keyDownHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._keyDownHandler);
      window.removeEventListener('keyup', this._keyUpHandler);
    }
    if (this.canvas) {
      this.canvas.onmousedown = null;
      this.canvas.onmousemove = null;
      this.canvas.ontouchstart = null;
      this.canvas.ontouchmove = null;
    }
    this._pointerUpHandler = null;
    this._wheelHandler = null;
    this._keyDownHandler = null;
    this._keyUpHandler = null;
    this.canvas = null;
    this.ctx = null;
    this.elements = [];
    this.imageCache.clear();
  }

eraseAt(x, y) {
    const threshold = 28;
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (this.hitTest(el, x, y, threshold)) {
        this.removeElement(el.id, true);
        break;
      }
    }
  }

hitTest(el, x, y, threshold = 24) {
    if (!el) return false;
    if (el.type === 'pencil') {
      return el.points?.some(p => Math.hypot(p.x - x, p.y - y) <= threshold);
    }
    if (el.type === 'text') {
      const bounds = this.getElementBounds(el);
      return x >= bounds.minX - threshold && x <= bounds.maxX + threshold &&
             y >= bounds.minY - threshold && y <= bounds.maxY + threshold;
    }
    const bounds = this.getElementBounds(el);
    if (!bounds) return false;
    return x >= bounds.minX - threshold && x <= bounds.maxX + threshold &&
           y >= bounds.minY - threshold && y <= bounds.maxY + threshold;
  }
};
