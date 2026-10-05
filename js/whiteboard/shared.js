
export const WHITEBOARD_TOOLS = [
  { id: 'select', name: 'Mover / Selecionar', icon: '👆', shortcut: 'V' },
  { id: 'pencil', name: 'Caneta Livre', icon: '✏️', shortcut: 'P' },
  { id: 'rectangle', name: 'Retângulo', icon: '⬜', shortcut: 'R' },
  { id: 'diamond', name: 'Losango', icon: '💎', shortcut: 'D' },
  { id: 'circle', name: 'Círculo', icon: '⭕', shortcut: 'C' },
  { id: 'triangle', name: 'Triângulo', icon: '△' },
  { id: 'right-triangle', name: 'Triângulo retângulo', icon: '◺' },
  { id: 'hexagon', name: 'Hexágono', icon: '⬡' },
  { id: 'arrow', name: 'Flecha', icon: '➡️', shortcut: 'A' },
  { id: 'line', name: 'Linha / Vértices', icon: '📏', shortcut: 'L' },
  { id: 'text', name: 'Texto', icon: '🔤', shortcut: 'T' },
  { id: 'formula', name: 'Fórmula', icon: '∑', shortcut: 'M' },
  { id: 'image', name: 'Inserir Imagem', icon: '🖼️', shortcut: 'I' },
  { id: 'eraser', name: 'Borracha', icon: '🧼', shortcut: 'E' },
];

export const WHITEBOARD_SHAPES = WHITEBOARD_TOOLS.filter(tool =>
  ['rectangle', 'diamond', 'circle', 'triangle', 'right-triangle', 'hexagon'].includes(tool.id));

export const WHITEBOARD_COLORS = [
  '#ffffff', // Branco
  '#ef4444', // Vermelho
  '#10b981', // Verde
  '#06b6d4', // Ciano
  '#a855f7', // Roxo
  '#f59e0b', // Amarelo
  '#ec4899', // Rosa
  '#1e1e2e', // Grafite
];

export const CURSOR_PALETTE = [
  '#06b6d4', // Ciano
  '#8b5cf6', // Roxo
  '#10b981', // Esmeralda
  '#f59e0b', // Âmbar
  '#ec4899', // Rosa
  '#3b82f6', // Azul
  '#f97316', // Laranja
  '#14b8a6', // Teal
  '#e11d48', // Rubi
  '#6366f1', // Índigo
];

export function getPeerCursorColor(id) {
  if (!id || typeof id !== 'string') return CURSOR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return CURSOR_PALETTE[hash % CURSOR_PALETTE.length];
}

export function isTooBrightOrWhite(hexColor) {
  if (!hexColor || typeof hexColor !== 'string') return true;
  let hex = hexColor.replace('#', '').trim();
  if (hex.length === 3) {
    hex = hex.split('').map((c) => c + c).join('');
  }
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.90; // Evita branco puro e quase-branco
}

export function getContrastTextColor(hexColor) {
  if (!hexColor || typeof hexColor !== 'string') return '#ffffff';
  let hex = hexColor.replace('#', '').trim();
  if (hex.length === 3) {
    hex = hex.split('').map((c) => c + c).join('');
  }
  if (hex.length !== 6) return '#ffffff';
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.60 ? '#0f172a' : '#ffffff';
}

export function drawRoundedRect(ctx, x, y, width, height, radius = 4) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }
}

export function getFillAlpha(fill) {
  if (fill === 'semi') return 0.25;
  if (fill === 'solid' || fill === true) return 1.0;
  if (typeof fill === 'number') return Math.max(0, Math.min(1, fill));
  return 1.0;
}

export const MAX_WHITEBOARD_ELEMENTS = 1000;

export const MAX_WHITEBOARD_POINTS = 2000;

export const MAX_WHITEBOARD_TEXT_LENGTH = 500;

export const WHITEBOARD_REF_WIDTH = 1920;

export const WHITEBOARD_REF_HEIGHT = 1080;

export const WHITEBOARD_ELEMENT_TYPES = new Set([
  'pencil', 'rectangle', 'diamond', 'circle', 'triangle', 'right-triangle', 'hexagon', 'arrow', 'line', 'text', 'formula', 'image'
]);

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isSafeWhiteboardElement(element) {
  if (!element || typeof element !== 'object' || typeof element.id !== 'string' || element.id.length > 64) return false;
  if (!WHITEBOARD_ELEMENT_TYPES.has(element.type)) return false;
  if (element.type === 'pencil') {
    return Array.isArray(element.points) && element.points.length > 0 && element.points.length <= MAX_WHITEBOARD_POINTS &&
      element.points.every((point) => isFiniteNumber(point?.x) && isFiniteNumber(point?.y));
  }
  if (element.type === 'line' && element.points !== undefined) {
    return Array.isArray(element.points) && element.points.length >= 2 && element.points.length <= MAX_WHITEBOARD_POINTS &&
      element.points.every(point => isFiniteNumber(point?.x) && isFiniteNumber(point?.y));
  }
  if (element.type === 'formula') {
    return isFiniteNumber(element.x) && isFiniteNumber(element.y) &&
      typeof element.latex === 'string' && element.latex.length > 0 && element.latex.length <= 2000 &&
      (element.fontSize === undefined || (isFiniteNumber(element.fontSize) && element.fontSize >= 8 && element.fontSize <= 96));
  }
  if (element.type === 'text') {
    return isFiniteNumber(element.x) && isFiniteNumber(element.y) &&
      typeof element.text === 'string' && element.text.length <= MAX_WHITEBOARD_TEXT_LENGTH &&
      (element.fontSize === undefined || (isFiniteNumber(element.fontSize) && element.fontSize >= 8 && element.fontSize <= 96));
  }
  if (element.type === 'image') {
    return isFiniteNumber(element.startX) && isFiniteNumber(element.startY) &&
      isFiniteNumber(element.endX) && isFiniteNumber(element.endY) &&
      typeof element.dataUrl === 'string' &&
      element.dataUrl.startsWith('data:image/') &&
      element.dataUrl.length <= 2_500_000;
  }
  if (isFiniteNumber(element.x) && isFiniteNumber(element.y)) {
    if (isFiniteNumber(element.width) && isFiniteNumber(element.height)) {
      if (!isFiniteNumber(element.startX)) element.startX = element.x;
      if (!isFiniteNumber(element.startY)) element.startY = element.y;
      if (!isFiniteNumber(element.endX)) element.endX = element.x + element.width;
      if (!isFiniteNumber(element.endY)) element.endY = element.y + element.height;
    } else if (isFiniteNumber(element.radius)) {
      if (!isFiniteNumber(element.startX)) element.startX = element.x - element.radius;
      if (!isFiniteNumber(element.startY)) element.startY = element.y - element.radius;
      if (!isFiniteNumber(element.endX)) element.endX = element.x + element.radius;
      if (!isFiniteNumber(element.endY)) element.endY = element.y + element.radius;
    }
  }
  return ['startX', 'startY', 'endX', 'endY'].every((key) => isFiniteNumber(element[key]));
}

export function getWhiteboardTextLayout(element, ctx) {
  const fontSize = element.fontSize || 15;
  const lines = (element.text || '').split('\n');
  const font = `600 ${fontSize}px Arial, sans-serif`;
  ctx?.save?.();
  if (ctx) ctx.font = font;
  const width = Math.max(1, ...lines.map(line => ctx?.measureText?.(line)?.width ?? line.length * fontSize * 0.6));
  ctx?.restore?.();
  return { fontSize, font, lines, lineHeight: fontSize * 1.35, width, height: lines.length * fontSize * 1.35 };
}

export async function processImageFile(file, maxWidth = 960, maxHeight = 720) {
  if (!file) throw new Error('Nenhum arquivo fornecido');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth || 400;
        let h = img.naturalHeight || 300;
        if (w > maxWidth || h > maxHeight) {
          const ratio = Math.min(maxWidth / w, maxHeight / h);
          w = Math.max(1, Math.round(w * ratio));
          h = Math.max(1, Math.round(h * ratio));
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(e.target.result);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          let dataUrl = canvas.toDataURL('image/webp', 0.80);
          if (!dataUrl || !dataUrl.startsWith('data:image/webp')) {
            const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
            dataUrl = canvas.toDataURL(mime, 0.80);
          }
          resolve(dataUrl);
        } catch (_) {
          try {
            resolve(canvas.toDataURL('image/jpeg', 0.80));
          } catch (e2) {
            resolve(e.target.result);
          }
        }
      };
      img.onerror = () => reject(new Error('Erro ao decodificar imagem'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Erro ao ler arquivo'));
    reader.readAsDataURL(file);
  });
}
