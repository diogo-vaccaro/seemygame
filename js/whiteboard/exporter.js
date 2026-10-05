
import { WHITEBOARD_TOOLS, WHITEBOARD_COLORS, CURSOR_PALETTE, getPeerCursorColor, isTooBrightOrWhite, getContrastTextColor, drawRoundedRect, getFillAlpha, MAX_WHITEBOARD_ELEMENTS, MAX_WHITEBOARD_POINTS, MAX_WHITEBOARD_TEXT_LENGTH, WHITEBOARD_REF_WIDTH, WHITEBOARD_REF_HEIGHT, WHITEBOARD_ELEMENT_TYPES, isFiniteNumber, isSafeWhiteboardElement, processImageFile } from './shared.js';
/** WhiteboardManager: exporter. State and lifetime remain owned by the composed engine. */
export const withWhiteboardManagerExporter = Base => class extends Base {
async exportToBlob() {
    if (this.textEditing && !await this.finishTextEditing(true)) throw new Error('Confira a expressão antes de exportar.');
    await Promise.all(this.elements.map(element => this.prepareMathElement(element)));
    this.render();
    return new Promise((resolve) => {
      if (!this.canvas) {
        resolve(new Blob([], { type: 'image/png' }));
        return;
      }
      if (typeof this.canvas.toBlob === 'function') {
        this.canvas.toBlob((blob) => resolve(blob), 'image/png');
      } else if (typeof this.canvas.toDataURL === 'function') {
        const dataUrl = this.canvas.toDataURL('image/png');
        const binary = atob(dataUrl.split(',')[1] || '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        resolve(new Blob([bytes], { type: 'image/png' }));
      } else {
        resolve(new Blob([], { type: 'image/png' }));
      }
    });
  }

exportToDataUrl() {
    if (!this.canvas || typeof this.canvas.toDataURL !== 'function') return '';
    return this.canvas.toDataURL('image/png');
  }
};
