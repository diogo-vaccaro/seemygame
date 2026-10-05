
import { WHITEBOARD_TOOLS, WHITEBOARD_COLORS, CURSOR_PALETTE, getPeerCursorColor, isTooBrightOrWhite, getContrastTextColor, drawRoundedRect, getFillAlpha, MAX_WHITEBOARD_ELEMENTS, MAX_WHITEBOARD_POINTS, MAX_WHITEBOARD_TEXT_LENGTH, WHITEBOARD_REF_WIDTH, WHITEBOARD_REF_HEIGHT, WHITEBOARD_ELEMENT_TYPES, isFiniteNumber, isSafeWhiteboardElement, processImageFile } from './shared.js';
import { getWhiteboardTextLayout } from './shared.js';
/** WhiteboardManager: geometry. State and lifetime remain owned by the composed engine. */
export const withWhiteboardManagerGeometry = Base => class extends Base {
getElementBounds(el) {
    if (!el) return null;
    if ((el.type === 'pencil' || el.type === 'line') && Array.isArray(el.points) && el.points.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of el.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
      return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
    }
    if ((el.type === 'text' || el.type === 'formula')) {
      const { width, height } = this.getTextLayout(el, this.ctx);
      return {
        minX: el.x, minY: el.y, maxX: el.x + width, maxY: el.y + height, width, height
      };
    }
    const minX = Math.min(el.startX, el.endX);
    const maxX = Math.max(el.startX, el.endX);
    const minY = Math.min(el.startY, el.endY);
    const maxY = Math.max(el.startY, el.endY);
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY)
    };
  }

translateElement(el, initial, dx, dy) {
    if (!el || !initial) return;
    if ((el.type === 'pencil' || el.type === 'line') && Array.isArray(initial.points)) {
      el.points = initial.points.map(p => ({
        x: Math.round((p.x + dx) * 10) / 10,
        y: Math.round((p.y + dy) * 10) / 10
      }));
    } else if ((el.type === 'text' || el.type === 'formula')) {
      el.x = Math.round((initial.x + dx) * 10) / 10;
      el.y = Math.round((initial.y + dy) * 10) / 10;
    } else {
      el.startX = Math.round((initial.startX + dx) * 10) / 10;
      el.startY = Math.round((initial.startY + dy) * 10) / 10;
      el.endX = Math.round((initial.endX + dx) * 10) / 10;
      el.endY = Math.round((initial.endY + dy) * 10) / 10;
      if (el.x !== undefined && initial.x !== undefined) {
        el.x = Math.round((initial.x + dx) * 10) / 10;
      }
      if (el.y !== undefined && initial.y !== undefined) {
        el.y = Math.round((initial.y + dy) * 10) / 10;
      }
    }
  }

findElementAt(x, y) {
    for (let i = this.elements.length - 1; i >= 0; i--) {
      if (this.hitTest(this.elements[i], x, y, 16)) {
        return this.elements[i];
      }
    }
    return null;
  }

getResizeHandles(el) {
    const bounds = this.getElementBounds(el);
    if (!bounds) return null;
    const pad = 6;
    const minX = bounds.minX - pad;
    const minY = bounds.minY - pad;
    const maxX = bounds.maxX + pad;
    const maxY = bounds.maxY + pad;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    return {
      tl: { x: minX, y: minY, cursor: 'nwse-resize' },
      tr: { x: maxX, y: minY, cursor: 'nesw-resize' },
      br: { x: maxX, y: maxY, cursor: 'nwse-resize' },
      bl: { x: minX, y: maxY, cursor: 'nesw-resize' },
      t: { x: midX, y: minY, cursor: 'ns-resize' },
      r: { x: maxX, y: midY, cursor: 'ew-resize' },
      b: { x: midX, y: maxY, cursor: 'ns-resize' },
      l: { x: minX, y: midY, cursor: 'ew-resize' }
    };
  }

hitTestResizeHandle(el, x, y, hitRadius = 14) {
    const handles = this.getResizeHandles(el);
    if (!handles) return null;
    for (const [key, h] of Object.entries(handles)) {
      const dist = Math.hypot(x - h.x, y - h.y);
      if (dist <= hitRadius) {
        return { handle: key, cursor: h.cursor };
      }
    }
    return null;
  }

resizeElement(el, initial, handle, dx, dy) {
    if (!el || !initial || !handle) return;
    const bounds = this.getElementBounds(initial);
    if (!bounds) return;

    let newMinX = bounds.minX;
    let newMinY = bounds.minY;
    let newMaxX = bounds.maxX;
    let newMaxY = bounds.maxY;

    if (handle.includes('l')) newMinX = bounds.minX + dx;
    if (handle.includes('r')) newMaxX = bounds.maxX + dx;
    if (handle.includes('t')) newMinY = bounds.minY + dy;
    if (handle.includes('b')) newMaxY = bounds.maxY + dy;

    // Garante dimensões mínimas para não colapsar
    const MIN_DIM = 12;
    if (newMaxX - newMinX < MIN_DIM) {
      if (handle.includes('l')) newMinX = newMaxX - MIN_DIM;
      else newMaxX = newMinX + MIN_DIM;
    }
    if (newMaxY - newMinY < MIN_DIM) {
      if (handle.includes('t')) newMinY = newMaxY - MIN_DIM;
      else newMaxY = newMinY + MIN_DIM;
    }

    const origW = Math.max(1, bounds.width);
    const origH = Math.max(1, bounds.height);
    const newW = newMaxX - newMinX;
    const newH = newMaxY - newMinY;
    const scaleX = newW / origW;
    const scaleY = newH / origH;

    if (el.type === 'image') {
      el.startX = Math.round(newMinX * 10) / 10;
      el.startY = Math.round(newMinY * 10) / 10;
      el.endX = Math.round(newMaxX * 10) / 10;
      el.endY = Math.round(newMaxY * 10) / 10;
      el.x = el.startX;
      el.y = el.startY;
      el.width = Math.round(newW * 10) / 10;
      el.height = Math.round(newH * 10) / 10;
    } else if ((el.type === 'pencil' || el.type === 'line') && Array.isArray(initial.points)) {
      el.points = initial.points.map(p => ({
        x: Math.round((newMinX + (p.x - bounds.minX) * scaleX) * 10) / 10,
        y: Math.round((newMinY + (p.y - bounds.minY) * scaleY) * 10) / 10
      }));
    } else if ((el.type === 'text' || el.type === 'formula')) {
      el.x = Math.round(newMinX * 10) / 10;
      el.y = Math.round(newMinY * 10) / 10;
      const fontScale = Math.sqrt(scaleX * scaleY);
      if (fontScale > 1.1 || fontScale < 0.9) {
        el.fontSize = Math.max(8, Math.min(96, (initial.fontSize || 15) * fontScale));
      }
    } else {
      el.startX = Math.round((newMinX + (initial.startX - bounds.minX) * scaleX) * 10) / 10;
      el.startY = Math.round((newMinY + (initial.startY - bounds.minY) * scaleY) * 10) / 10;
      el.endX = Math.round((newMinX + (initial.endX - bounds.minX) * scaleX) * 10) / 10;
      el.endY = Math.round((newMinY + (initial.endY - bounds.minY) * scaleY) * 10) / 10;
      if (el.x !== undefined) el.x = Math.round((newMinX + (initial.x - bounds.minX) * scaleX) * 10) / 10;
      if (el.y !== undefined) el.y = Math.round((newMinY + (initial.y - bounds.minY) * scaleY) * 10) / 10;
      if (el.width !== undefined) el.width = Math.round(newW * 10) / 10;
      if (el.height !== undefined) el.height = Math.round(newH * 10) / 10;
    }
  }
};
