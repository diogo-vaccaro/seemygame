
import { WHITEBOARD_TOOLS, WHITEBOARD_COLORS, CURSOR_PALETTE, getPeerCursorColor, isTooBrightOrWhite, getContrastTextColor, drawRoundedRect, getFillAlpha, MAX_WHITEBOARD_ELEMENTS, MAX_WHITEBOARD_POINTS, MAX_WHITEBOARD_TEXT_LENGTH, WHITEBOARD_REF_WIDTH, WHITEBOARD_REF_HEIGHT, WHITEBOARD_ELEMENT_TYPES, isFiniteNumber, isSafeWhiteboardElement, processImageFile } from './whiteboard/shared.js';
export * from './whiteboard/shared.js';
import { withWhiteboardManagerDocument } from './whiteboard/document.js';
import { withWhiteboardManagerGeometry } from './whiteboard/geometry.js';
import { withWhiteboardManagerInput } from './whiteboard/input.js';
import { withWhiteboardManagerTextEditor } from './whiteboard/text-editor.js';
import { withWhiteboardManagerRenderer } from './whiteboard/renderer.js';
import { withWhiteboardManagerExporter } from './whiteboard/exporter.js';
import { withWhiteboardManagerMath } from './whiteboard/math.js';
import { createMathRenderer } from './whiteboard/math-renderer.js';
export class WhiteboardManager extends withWhiteboardManagerExporter(withWhiteboardManagerRenderer(withWhiteboardManagerInput(withWhiteboardManagerTextEditor(withWhiteboardManagerMath(withWhiteboardManagerGeometry(withWhiteboardManagerDocument(class {}))))))) {
constructor(options = {}) {
    super();
    this.canvas = options.canvas || null;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.elements = []; // Array de elementos desenhados
    this.undoStack = [];
    this.redoStack = [];
    this.isDisposed = false;
    this.imageImportGeneration = 0;
    this.pendingImageImports = new Set();

    this.selectedTool = 'pencil';
    this.currentColor = '#ffffff';
    this.currentWidth = 4;
    this.currentFill = 'none'; // 'none' | 'semi' | 'solid'
    this.isRough = true; // Estilo rascunho hand-drawn
    this.backgroundMode = 'dark'; // 'dark' | 'light' | 'transparent'

    this.isDrawing = false;
    this.currentElement = null;
    this.remoteCursors = new Map(); // peerId -> { x, y, userName, color, time }

    // Seleção e Arrastar
    this.selectedElementId = null;
    this.isDraggingElement = false;
    this.dragStartPos = null;
    this.dragInitialState = null;
    this._dragUndoSnapshot = null;

    // Cache de imagens decodificadas
    this.imageCache = new Map();
    this.mathRenderer = options.mathRenderer || createMathRenderer({ onReady: () => {
      this.render(); this.updateMathPreview?.();
    } });

    // Callbacks de eventos para mensageria P2P
    this.onElementCreated = options.onElementCreated || null;
    this.onElementUpdated = options.onElementUpdated || null;
    this.onElementDeleted = options.onElementDeleted || null;
    this.onBoardCleared = options.onBoardCleared || null;
    this.onCursorMoved = options.onCursorMoved || null;

    if (this.canvas) {
      this.attachEvents();
      this.render();
    }
  }

setCanvas(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    if (this.canvas) {
      this.attachEvents();
      this.render();
    }
  }

updateRemoteCursor(peerId, { x, y, userName = 'Amigo', color = '#06b6d4' }) {
    if (typeof peerId !== 'string' || peerId.length > 64) return;
    if (!this.remoteCursors.has(peerId) && this.remoteCursors.size >= 64) return;
    let safeColor = typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null;
    if (!safeColor || isTooBrightOrWhite(safeColor)) {
      safeColor = getPeerCursorColor(peerId);
    }
    this.remoteCursors.set(peerId, {
      x: Math.max(0, Math.min(1, Number(x) || 0)),
      y: Math.max(0, Math.min(1, Number(y) || 0)),
      userName: typeof userName === 'string' && userName.trim() ? userName.trim().slice(0, 64) : 'Amigo',
      color: safeColor,
      time: Date.now()
    });
    this.render();
  }

removeRemoteCursor(peerId) {
    if (this.remoteCursors.has(peerId)) {
      this.remoteCursors.delete(peerId);
      this.render();
    }
  }
}
export const whiteboardManager = new WhiteboardManager();
