
import { WHITEBOARD_TOOLS, WHITEBOARD_COLORS, CURSOR_PALETTE, getPeerCursorColor, isTooBrightOrWhite, getContrastTextColor, drawRoundedRect, getFillAlpha, MAX_WHITEBOARD_ELEMENTS, MAX_WHITEBOARD_POINTS, MAX_WHITEBOARD_TEXT_LENGTH, WHITEBOARD_REF_WIDTH, WHITEBOARD_REF_HEIGHT, WHITEBOARD_ELEMENT_TYPES, isFiniteNumber, isSafeWhiteboardElement, processImageFile } from './shared.js';
import { getWhiteboardTextLayout } from './shared.js';
/** WhiteboardManager: renderer. State and lifetime remain owned by the composed engine. */
export const withWhiteboardManagerRenderer = Base => class extends Base {
pruneImageCache() {
    const used = new Set(this.elements.filter(element => element.type === 'image').map(element => element.dataUrl));
    for (const [url, image] of this.imageCache) if (!used.has(url)) { image.onload = null; this.imageCache.delete(url); }
  }
render() {
    this.pruneMathCache?.();
    this.positionTextEditor?.();
    if (!this.ctx || !this.canvas) return;

    const width = this.canvas.width || WHITEBOARD_REF_WIDTH;
    const height = this.canvas.height || WHITEBOARD_REF_HEIGHT;

    this.ctx.clearRect(0, 0, width, height);

    // 1. Fundo e Dot Grid
    if (this.backgroundMode === 'dark') {
      this.ctx.fillStyle = '#12131c';
      this.ctx.fillRect(0, 0, width, height);
      this.drawDotGrid('#252839', 24);
    } else if (this.backgroundMode === 'light') {
      this.ctx.fillStyle = '#f8fafc';
      this.ctx.fillRect(0, 0, width, height);
      this.drawDotGrid('#cbd5e1', 24);
    }
    // transparent não preenche nada, fica vazado sobre o vídeo

    const scaleX = width / WHITEBOARD_REF_WIDTH;
    const scaleY = height / WHITEBOARD_REF_HEIGHT;
    const zoom = this.zoom || 1.0;
    const panX = this.panX || 0;
    const panY = this.panY || 0;

    if (typeof this.ctx.save === 'function') this.ctx.save();
    if (typeof this.ctx.translate === 'function') this.ctx.translate(panX, panY);
    if (typeof this.ctx.scale === 'function') {
      this.ctx.scale(scaleX * zoom, scaleY * zoom);
    }

    // 2. Renderiza todos os elementos consolidados no plano de referência virtual
    for (const el of this.elements) {
      if (el.id === this.textEditing?.elementId) continue;
      this.drawElement(this.ctx, el);
    }

    // 3. Renderiza o elemento atualmente sendo traçado pelo usuário
    if (this.currentElement) {
      this.drawElement(this.ctx, this.currentElement);
      if (this.lineDraft) {
        this.ctx.save();
        this.ctx.fillStyle = this.currentElement.color;
        for (const point of this.lineDraft.element.points) {
          this.ctx.beginPath(); this.ctx.arc(point.x, point.y, 4 / zoom, 0, Math.PI * 2); this.ctx.fill();
        }
        this.ctx.restore();
      }
    }

    // 4. Renderiza caixa de seleção (bounding box) do elemento selecionado
    if (this.selectedElementId) {
      const selectedEl = this.elements.find(e => e.id === this.selectedElementId);
      if (selectedEl) {
        this.drawSelectionBox(this.ctx, selectedEl);
      }
    }

    if (typeof this.ctx.restore === 'function') this.ctx.restore();

    // 5. Renderiza os cursores multiplayer remotos
    this.drawRemoteCursors(this.ctx, width, height);
  }

drawSelectionBox(ctx, el) {
    const bounds = this.getElementBounds(el);
    if (!bounds) return;
    const pad = 6;
    const x = bounds.minX - pad;
    const y = bounds.minY - pad;
    const w = bounds.width + pad * 2;
    const h = bounds.height + pad * 2;

    ctx.save();
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.5;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([6, 4]);
    if (typeof ctx.strokeRect === 'function') {
      ctx.strokeRect(x, y, w, h);
    } else {
      ctx.stroke();
    }
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

    const handles = this.getResizeHandles ? this.getResizeHandles(el) : null;
    const handleList = handles ? Object.values(handles) : [
      { x: x, y: y },
      { x: x + w, y: y },
      { x: x + w, y: y + h },
      { x: x, y: y + h }
    ];

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.8;
    const handleSize = 8;
    for (const hPos of handleList) {
      ctx.beginPath();
      if (typeof ctx.rect === 'function') {
        ctx.rect(hPos.x - handleSize / 2, hPos.y - handleSize / 2, handleSize, handleSize);
      }
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

drawDotGrid(dotColor, spacing = 24) {
    this.ctx.save();
    this.ctx.fillStyle = dotColor;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const zoom = this.zoom || 1.0;
    const effectiveSpacing = Math.max(12, Math.round(spacing * zoom));
    const panX = this.panX || 0;
    const panY = this.panY || 0;
    const startX = ((panX % effectiveSpacing) + effectiveSpacing) % effectiveSpacing;
    const startY = ((panY % effectiveSpacing) + effectiveSpacing) % effectiveSpacing;

    for (let x = startX; x < w; x += effectiveSpacing) {
      for (let y = startY; y < h; y += effectiveSpacing) {
        this.ctx.beginPath();
        this.ctx.arc(x, y, 1.2, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
    this.ctx.restore();
  }

drawElement(ctx, el) {
    ctx.save();
    ctx.strokeStyle = el.color || '#ffffff';
    ctx.lineWidth = el.strokeWidth || 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (el.type) {
      case 'pencil':
        this.renderPencil(ctx, el);
        break;
      case 'rectangle':
        this.renderRectangle(ctx, el);
        break;
      case 'diamond':
        this.renderDiamond(ctx, el);
        break;
      case 'triangle':
      case 'right-triangle':
      case 'hexagon':
        this.renderPolygon(ctx, el);
        break;
      case 'circle':
        this.renderCircle(ctx, el);
        break;
      case 'arrow':
        this.renderArrow(ctx, el);
        break;
      case 'line':
        this.renderLine(ctx, el);
        break;
      case 'text':
        this.renderText(ctx, el);
        break;
      case 'formula':
        this.renderFormula(ctx, el);
        break;
      case 'image':
        this.renderImage(ctx, el);
        break;
    }
    ctx.restore();
  }

drawSketchLine(ctx, x1, y1, x2, y2, rough = true) {
    if (!rough) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      return;
    }

    // Passada 1 com leve desvio central
    const midX = (x1 + x2) / 2 + (Math.sin(x1 * 0.05 + y2) * 1.5);
    const midY = (y1 + y2) / 2 + (Math.cos(y1 * 0.05 + x2) * 1.5);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(midX, midY, x2, y2);
    ctx.stroke();

    // Passada 2 de imperfeição manual sutil
    ctx.save();
    ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.6;
    ctx.beginPath();
    ctx.moveTo(x1 + 0.8, y1 - 0.8);
    ctx.quadraticCurveTo(midX - 1.2, midY + 1.2, x2 - 0.8, y2 + 0.8);
    ctx.stroke();
    ctx.restore();
  }

renderPencil(ctx, el) {
    if (!el.points || el.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);

    for (let i = 1; i < el.points.length - 1; i++) {
      const xc = (el.points[i].x + el.points[i + 1].x) / 2;
      const yc = (el.points[i].y + el.points[i + 1].y) / 2;
      ctx.quadraticCurveTo(el.points[i].x, el.points[i].y, xc, yc);
    }
    ctx.lineTo(el.points[el.points.length - 1].x, el.points[el.points.length - 1].y);
    ctx.stroke();
  }

renderRectangle(ctx, el) {
    const x = Math.min(el.startX, el.endX);
    const y = Math.min(el.startY, el.endY);
    const w = Math.abs(el.endX - el.startX);
    const h = Math.abs(el.endY - el.startY);

    if (el.fill && el.fill !== 'none') {
      ctx.save();
      ctx.fillStyle = el.color;
      ctx.globalAlpha = getFillAlpha(el.fill);
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }

    this.drawSketchLine(ctx, x, y, x + w, y, el.rough);
    this.drawSketchLine(ctx, x + w, y, x + w, y + h, el.rough);
    this.drawSketchLine(ctx, x + w, y + h, x, y + h, el.rough);
    this.drawSketchLine(ctx, x, y + h, x, y, el.rough);
  }

renderDiamond(ctx, el) {
    const cx = (el.startX + el.endX) / 2;
    const cy = (el.startY + el.endY) / 2;
    const top = { x: cx, y: Math.min(el.startY, el.endY) };
    const right = { x: Math.max(el.startX, el.endX), y: cy };
    const bottom = { x: cx, y: Math.max(el.startY, el.endY) };
    const left = { x: Math.min(el.startX, el.endX), y: cy };

    if (el.fill && el.fill !== 'none') {
      ctx.save();
      ctx.fillStyle = el.color;
      ctx.globalAlpha = getFillAlpha(el.fill);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(right.x, right.y);
      ctx.lineTo(bottom.x, bottom.y);
      ctx.lineTo(left.x, left.y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    this.drawSketchLine(ctx, top.x, top.y, right.x, right.y, el.rough);
    this.drawSketchLine(ctx, right.x, right.y, bottom.x, bottom.y, el.rough);
    this.drawSketchLine(ctx, bottom.x, bottom.y, left.x, left.y, el.rough);
    this.drawSketchLine(ctx, left.x, left.y, top.x, top.y, el.rough);
  }

renderCircle(ctx, el) {
    const rx = Math.abs(el.endX - el.startX) / 2;
    const ry = Math.abs(el.endY - el.startY) / 2;
    const cx = (el.startX + el.endX) / 2;
    const cy = (el.startY + el.endY) / 2;

    if (el.fill && el.fill !== 'none') {
      ctx.save();
      ctx.fillStyle = el.color;
      ctx.globalAlpha = getFillAlpha(el.fill);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (el.rough) {
      ctx.save();
      ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.55;
      ctx.beginPath();
      ctx.ellipse(cx + 0.5, cy - 0.5, Math.max(1, rx - 0.8), Math.max(1, ry + 0.8), 0.05, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

renderLine(ctx, el) {
    if (Array.isArray(el.points)) {
      for (let i = 1; i < el.points.length; i++) {
        this.drawSketchLine(ctx, el.points[i - 1].x, el.points[i - 1].y, el.points[i].x, el.points[i].y, el.rough);
      }
      return;
    }
    this.drawSketchLine(ctx, el.startX, el.startY, el.endX, el.endY, el.rough);
  }

renderArrow(ctx, el) {
    const x1 = el.startX;
    const y1 = el.startY;
    const x2 = el.endX;
    const y2 = el.endY;

    this.drawSketchLine(ctx, x1, y1, x2, y2, el.rough);

    // Ponta da flecha
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLength = 16 + (el.strokeWidth || 4);
    const arrowAngle = Math.PI / 6; // 30 graus

    const px1 = x2 - headLength * Math.cos(angle - arrowAngle);
    const py1 = y2 - headLength * Math.sin(angle - arrowAngle);
    const px2 = x2 - headLength * Math.cos(angle + arrowAngle);
    const py2 = y2 - headLength * Math.sin(angle + arrowAngle);

    this.drawSketchLine(ctx, x2, y2, px1, py1, el.rough);
    this.drawSketchLine(ctx, x2, y2, px2, py2, el.rough);
  }

renderPolygon(ctx, el) {
    const x = Math.min(el.startX, el.endX), y = Math.min(el.startY, el.endY);
    const w = Math.abs(el.endX - el.startX), h = Math.abs(el.endY - el.startY);
    const points = el.type === 'triangle' ? [[x + w / 2, y], [x + w, y + h], [x, y + h]]
      : el.type === 'right-triangle' ? [[x, y], [x + w, y + h], [x, y + h]]
      : [[x + w / 4, y], [x + w * 3 / 4, y], [x + w, y + h / 2], [x + w * 3 / 4, y + h], [x + w / 4, y + h], [x, y + h / 2]];
    if (el.fill && el.fill !== 'none') {
      ctx.save(); ctx.fillStyle = el.color; ctx.globalAlpha = getFillAlpha(el.fill);
      ctx.beginPath(); ctx.moveTo(...points[0]); points.slice(1).forEach(point => ctx.lineTo(...point)); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    points.forEach((point, index) => this.drawSketchLine(ctx, ...point, ...points[(index + 1) % points.length], el.rough));
  }

renderText(ctx, el) {
    ctx.save();
    const layout = this.getTextLayout(el, ctx);
    ctx.font = layout.font;
    ctx.fillStyle = el.color || '#ffffff';
    ctx.textBaseline = 'top';
    if (layout.rich) for (const run of layout.runs) {
      if (run.entry?.status === 'ready') ctx.drawImage(run.entry.image, el.x + run.x, el.y + run.y, run.entry.width, run.entry.height);
      else {
        ctx.textBaseline = 'alphabetic'; ctx.fillStyle = run.entry?.status === 'error' ? '#f87171' : el.color || '#ffffff';
        ctx.fillText(run.text, el.x + run.x, el.y + run.y + run.baseline);
      }
    }
    else layout.lines.forEach((line, index) => ctx.fillText(line, el.x, el.y + index * layout.lineHeight));
    ctx.restore();
  }

renderImage(ctx, el) {
    let img = this.imageCache.get(el.dataUrl);
    if (!img) {
      img = new Image();
      img.src = el.dataUrl;
      img.onload = () => {
        if (this.imageCache.get(el.dataUrl) === img) this.render();
      };
      this.imageCache.set(el.dataUrl, img);
    }

    const x = Math.min(el.startX, el.endX);
    const y = Math.min(el.startY, el.endY);
    const w = Math.abs(el.endX - el.startX);
    const h = Math.abs(el.endY - el.startY);

    if (img.complete && (img.naturalWidth > 0 || img.width > 0)) {
      ctx.save();
      ctx.beginPath();
      drawRoundedRect(ctx, x, y, w, h, 6);
      if (typeof ctx.clip === 'function') ctx.clip();
      try {
        ctx.drawImage(img, x, y, w, h);
      } catch (err) {
        console.warn('[Whiteboard] Erro ao desenhar imagem:', err);
      }
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = el.color || 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      drawRoundedRect(ctx, x, y, w, h, 6);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.fillStyle = 'rgba(30, 41, 59, 0.6)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      drawRoundedRect(ctx, x, y, w, h, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🖼️ Carregando imagem...', x + w / 2, y + h / 2);
      ctx.restore();
    }
  }

drawRemoteCursors(ctx, width, height) {
    const now = Date.now();
    for (const [peerId, cursor] of this.remoteCursors.entries()) {
      if (now - cursor.time > 15000) {
        this.remoteCursors.delete(peerId);
        continue;
      }

      const px = cursor.x * width * (this.zoom || 1) + (this.panX || 0);
      const py = cursor.y * height * (this.zoom || 1) + (this.panY || 0);
      if (px < 0 || py < 0 || px > width || py > height) continue;
      const userName = (typeof cursor.userName === 'string' && cursor.userName.trim())
        ? cursor.userName.trim()
        : 'Amigo';

      let cursorColor = cursor.color;
      if (!cursorColor || isTooBrightOrWhite(cursorColor)) {
        cursorColor = getPeerCursorColor(peerId);
      }
      const textColor = getContrastTextColor(cursorColor);

      ctx.save();

      // Sombra suave para destacar cursor e badge sobre qualquer fundo (escuro, claro ou sobreposição)
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 2;

      // 1. Ponteiro de seta estilo Figma/Excalidraw
      ctx.fillStyle = cursorColor;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + 13, py + 13);
      ctx.lineTo(px + 5, py + 13);
      ctx.lineTo(px, py + 19);
      ctx.closePath();
      ctx.fill();

      // Contorno sutil no ponteiro
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Remove sombra para renderizar badge e texto ultra nítidos
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // 2. Badge arredondada moderna (pill) com nome legível e contraste garantido
      ctx.font = 'bold 11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const textMetrics = ctx.measureText(userName);
      const textWidth = (textMetrics && typeof textMetrics.width === 'number') ? textMetrics.width : 50;
      const paddingX = 8;
      const badgeHeight = 20;
      const badgeWidth = textWidth + paddingX * 2;
      const badgeX = px + 10;
      const badgeY = py + 10;

      ctx.beginPath();
      drawRoundedRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 5);
      ctx.fillStyle = cursorColor;
      ctx.fill();

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Texto de alto contraste garantido
      ctx.fillStyle = textColor;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(userName, badgeX + paddingX, badgeY + badgeHeight / 2);

      ctx.restore();
    }
  }
};
