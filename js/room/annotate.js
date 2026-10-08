/**
 * SeeMyGame - AnnotateManager (Telestrator)
 * Permite desenhar e fazer anotações táticas em tempo real sobre a transmissão
 * com sincronização P2P usando coordenadas normalizadas (0 a 1).
 */

export class AnnotateManager {
  constructor(options = {}) {
    this.container = null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.toolbarEl = null;

    this.tool = options.tool || 'pen'; // 'pen', 'highlighter', 'arrow', 'rect', 'circle', 'eraser'
    this.color = options.color || '#ff4757';
    this.width = options.width || 4;
    this.autoClear = options.autoClear ?? false;
    this.autoClearDelay = options.autoClearDelay || 4000;

    this.broadcast = options.broadcast || null;
    this.strokes = [];
    this.currentStroke = null;
    this.isDrawing = false;
    this.isActive = false;
    this.autoClearTimers = new Set();

    this.resizeObserver = null;
    this.streamId = null;
    this.streamStrokes = new Map();
    this.getLocalPeerId = () => null;
    this._boundOnPointerDown = this._onPointerDown.bind(this);
    this._boundOnPointerMove = this._onPointerMove.bind(this);
    this._boundOnPointerUp = this._onPointerUp.bind(this);
    this._boundResize = this._syncCanvasSize.bind(this);
  }

  attach(container, video = null, editable = true) {
    if (!container) return;
    if (this.streamId) this.streamStrokes.set(this.streamId, this.strokes);
    this.detach();

    this.container = container;
    this.video = video || container.querySelector('video');
    this.isEditing = editable;
    this.video?.addEventListener('loadedmetadata', this._boundResize);
    this.streamId = container.id?.startsWith('card-') ? container.id.slice(5) : null;
    if (this.streamId === 'local-me') this.streamId = this.getLocalPeerId();
    this.strokes = this.streamStrokes.get(this.streamId) || [];

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'annotate-overlay-canvas';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: editable ? 'auto' : 'none',
      zIndex: '45',
      touchAction: 'none'
    });

    this.container.style.position = this.container.style.position || 'relative';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this._syncCanvasSize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this._syncCanvasSize());
      this.resizeObserver.observe(this.container);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._boundResize);
    }

    const hasPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
    if (hasPointer) {
      this.canvas.addEventListener('pointerdown', this._boundOnPointerDown);
      window.addEventListener('pointermove', this._boundOnPointerMove);
      window.addEventListener('pointerup', this._boundOnPointerUp);
    } else {
      this.canvas.addEventListener('mousedown', this._boundOnPointerDown);
      window.addEventListener('mousemove', this._boundOnPointerMove);
      window.addEventListener('mouseup', this._boundOnPointerUp);
    }

    this.isActive = true;
    this.redraw();

    // Solicitar anotações existentes aos peers se houver broadcast
    if (this.broadcast) {
      try {
        this.broadcast({ type: 'ANNOTATE_REQUEST_SYNC' });
      } catch (_) {}
    }
  }

  detach() {
    this.isActive = false;
    this.isEditing = false;
    this.video?.removeEventListener('loadedmetadata', this._boundResize);
    this.isDrawing = false; this.currentStroke = null;
    for (const tid of this.autoClearTimers) {
      clearTimeout(tid);
    }
    this.autoClearTimers.clear();

    if (this.canvas) {
      this.canvas.removeEventListener('pointerdown', this._boundOnPointerDown);
      this.canvas.removeEventListener('mousedown', this._boundOnPointerDown);
      if (this.canvas.parentElement) {
        this.canvas.parentElement.removeChild(this.canvas);
      }
      this.canvas = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this._boundOnPointerMove);
      window.removeEventListener('mousemove', this._boundOnPointerMove);
      window.removeEventListener('pointerup', this._boundOnPointerUp);
      window.removeEventListener('mouseup', this._boundOnPointerUp);
      window.removeEventListener('resize', this._boundResize);
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.removeToolbar();
    this.container = null;
    this.video = null;
    this.ctx = null;
  }

  setTool(tool) {
    this.tool = tool;
  }

  setColor(color) {
    this.color = color;
  }

  setWidth(width) {
    this.width = width;
  }

  setAutoClear(enabled, delay = 4000) {
    this.autoClear = enabled;
    this.autoClearDelay = delay;
  }

  setBroadcast(fn) {
    this.broadcast = fn ? message => fn({ ...message, ...(this.streamId ? { streamId: this.streamId } : {}) }) : null;
  }

  _syncCanvasSize() {
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const videoRect = this.video?.getBoundingClientRect();
    let width = videoRect?.width || rect.width;
    let height = videoRect?.height || rect.height;
    let left = videoRect?.width ? videoRect.left - rect.left : 0;
    let top = videoRect?.height ? videoRect.top - rect.top : 0;
    if (this.video?.videoWidth && this.video?.videoHeight && getComputedStyle(this.video).objectFit === 'contain') {
      const scale = Math.min(width / this.video.videoWidth, height / this.video.videoHeight);
      const displayWidth = this.video.videoWidth * scale, displayHeight = this.video.videoHeight * scale;
      left += (width - displayWidth) / 2; top += (height - displayHeight) / 2;
      width = displayWidth; height = displayHeight;
    }
    width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
    Object.assign(this.canvas.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
      if (this.ctx) {
        this.ctx.scale(dpr, dpr);
      }
      this.redraw();
    }
  }

  _getNormalizedCoords(e) {
    if (!this.canvas) return { x: 0, y: 0 };
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 1;
    const height = rect.height || 1;
    const clientX = e.clientX ?? 0;
    const clientY = e.clientY ?? 0;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / height));
    return { x, y };
  }

  _onPointerDown(e) {
    if (!this.isActive || !this.isEditing) return;
    if (e.button !== undefined && e.button !== 0) return;
    this.isDrawing = true;
    const pt = this._getNormalizedCoords(e);

    if (this.tool === 'eraser') {
      this._eraseNear(pt);
      return;
    }

    this.currentStroke = {
      id: 'stroke-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      tool: this.tool,
      color: this.color,
      width: this.width,
      points: [pt],
      shapeStart: pt,
      shapeEnd: pt,
      createdAt: Date.now()
    };
  }

  _onPointerMove(e) {
    if (!this.isDrawing || !this.isActive) return;
    const pt = this._getNormalizedCoords(e);

    if (this.tool === 'eraser') {
      this._eraseNear(pt);
      return;
    }

    if (!this.currentStroke) return;

    if (this.currentStroke.tool === 'pen' || this.currentStroke.tool === 'highlighter') {
      if (this.currentStroke.points.length < 4096) this.currentStroke.points.push(pt);
    } else {
      this.currentStroke.shapeEnd = pt;
    }

    this.redraw();
  }

  _onPointerUp(e) {
    if (!this.isDrawing && !this.currentStroke) return;
    this.isDrawing = false;

    if (this.currentStroke) {
      const stroke = this.currentStroke;
      this.strokes.push(stroke);
      if (this.strokes.length > 256) this.strokes.shift();
      this.currentStroke = null;

      if (this.broadcast) {
        this.broadcast({
          type: 'ANNOTATE_DRAW',
          stroke
        });
      }

      if (this.autoClear) {
        const tid = setTimeout(() => {
          this.autoClearTimers.delete(tid);
          this.removeStroke(stroke.id);
        }, this.autoClearDelay);
        this.autoClearTimers.add(tid);
      }
    }

    this.redraw();
  }

  _eraseNear(pt, radius = 0.05) {
    const before = this.strokes;
    const distance = (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / length)) : 0;
      return Math.hypot(pt.x - a.x - t * dx, pt.y - a.y - t * dy);
    };
    this.strokes = this.strokes.filter(s => {
      if (s.shapeStart && s.shapeEnd && ['arrow', 'rect', 'circle'].includes(s.tool)) {
        const a = s.shapeStart, b = s.shapeEnd;
        if (s.tool === 'arrow') return distance(a, b) >= radius;
        if (s.tool === 'rect') {
          const corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
          return corners.every((point, i) => distance(point, corners[(i + 1) % 4]) >= radius);
        }
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
        for (let i = 0; i < 64; i++) {
          const angle = i * Math.PI / 32;
          if (Math.hypot(pt.x - center.x - rx * Math.cos(angle), pt.y - center.y - ry * Math.sin(angle)) < radius) return false;
        }
        return true;
      }
      if (s.points && s.points.length > 0) {
        return !s.points.some((p, i) => distance(p, s.points[i + 1] || p) < radius);
      }
      if (s.shapeStart && s.shapeEnd) {
        const midX = (s.shapeStart.x + s.shapeEnd.x) / 2;
        const midY = (s.shapeStart.y + s.shapeEnd.y) / 2;
        return Math.hypot(midX - pt.x, midY - pt.y) >= radius;
      }
      return true;
    });

    if (this.strokes.length !== before.length) {
      this.redraw();
      if (this.broadcast) {
        const remaining = new Set(this.strokes.map(stroke => stroke.id));
        before.filter(stroke => !remaining.has(stroke.id)).forEach(stroke => this.broadcast({ type: 'ANNOTATE_REMOVE', strokeId: stroke.id }));
      }
    }
  }

  removeStroke(strokeId) {
    this.strokes = this.strokes.filter(s => s.id !== strokeId);
    this.redraw();
    this.broadcast?.({ type: 'ANNOTATE_REMOVE', strokeId });
  }

  clear(notify = true) {
    for (const tid of this.autoClearTimers) {
      clearTimeout(tid);
    }
    this.autoClearTimers.clear();

    this.strokes = [];
    this.currentStroke = null;
    this.redraw();

    if (notify && this.broadcast) {
      this.broadcast({ type: 'ANNOTATE_CLEAR' });
    }
  }

  handleRemoteMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.streamId && msg.streamId !== this.streamId) {
      if (typeof msg.streamId !== 'string' || msg.streamId.length > 128) return;
      const id = msg.streamId === this.getLocalPeerId() ? 'local-me' : msg.streamId;
      if (msg.type === 'ANNOTATE_CLEAR') { this.streamStrokes.set(msg.streamId, []); return; }
      if (msg.type === 'ANNOTATE_REMOVE') {
        this.streamStrokes.set(msg.streamId, (this.streamStrokes.get(msg.streamId) || []).filter(stroke => stroke.id !== msg.strokeId)); return;
      }
      const target = document.getElementById(`card-${id}`);
      if (!target || !['ANNOTATE_DRAW', 'ANNOTATE_SYNC'].includes(msg.type)) return;
      this.attach(target, target.querySelector('video'), false);
    }

    if (msg.type === 'ANNOTATE_REQUEST_SYNC') {
      if (this.strokes.length > 0 && this.broadcast) {
        this.broadcast({
          type: 'ANNOTATE_SYNC',
          strokes: this.strokes
        });
      }
      return;
    }

    if (msg.type === 'ANNOTATE_DRAW' && msg.stroke) {
      if (!this._validStroke(msg.stroke) || this.strokes.some(stroke => stroke.id === msg.stroke.id)) return;
      if (!this.isActive || !this.canvas) {
        const target = document.querySelector('.video-card.active, .video-card, #video-grid');
        if (target) {
          const video = target.querySelector('video');
          this.attach(target, video, false);
        }
      }
      this.strokes.push(msg.stroke);
      if (this.strokes.length > 256) this.strokes.shift();
      this.redraw();
      if (this.autoClear) {
        const tid = setTimeout(() => {
          this.autoClearTimers.delete(tid);
          this.removeStroke(msg.stroke.id);
        }, this.autoClearDelay);
        this.autoClearTimers.add(tid);
      }
    } else if (msg.type === 'ANNOTATE_REMOVE' && typeof msg.strokeId === 'string') {
      this.strokes = this.strokes.filter(stroke => stroke.id !== msg.strokeId); this.redraw();
    } else if (msg.type === 'ANNOTATE_CLEAR') {
      this.clear(false);
    } else if (msg.type === 'ANNOTATE_SYNC' && Array.isArray(msg.strokes)) {
      if (msg.strokes.length > 256 || msg.strokes.some(stroke => !this._validStroke(stroke))) return;
      this.strokes = [...new Map(msg.strokes.map(stroke => [stroke.id, stroke])).values()];
      this.redraw();
    }
  }

  _validStroke(stroke) {
    const point = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
    return stroke && typeof stroke.id === 'string' && stroke.id.length <= 128 &&
      ['pen', 'highlighter', 'arrow', 'rect', 'circle'].includes(stroke.tool) &&
      (stroke.width == null || (Number.isFinite(stroke.width) && stroke.width > 0 && stroke.width <= 64)) &&
      (stroke.color == null || (typeof stroke.color === 'string' && stroke.color.length <= 32)) &&
      (!stroke.points || (Array.isArray(stroke.points) && stroke.points.length <= 4096 && stroke.points.every(point))) &&
      (!stroke.shapeStart || point(stroke.shapeStart)) && (!stroke.shapeEnd || point(stroke.shapeEnd));
  }

  redraw() {
    if (!this.ctx || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || this.canvas.width || 1));
    const h = Math.max(1, Math.round(rect.height || this.canvas.height || 1));

    this.ctx.clearRect(0, 0, w, h);

    const allStrokes = [...this.strokes];
    if (this.currentStroke) {
      allStrokes.push(this.currentStroke);
    }

    for (const stroke of allStrokes) {
      this._drawStroke(stroke, w, h);
    }
  }

  _drawStroke(stroke, w, h) {
    if (!stroke || typeof stroke !== 'object') return;
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.width || 4;

    if (stroke.tool === 'highlighter') {
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = stroke.color || '#ffff00';
      ctx.fillStyle = stroke.color || '#ffff00';
      ctx.lineWidth = (stroke.width || 4) * 3;
    } else {
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = stroke.color || '#ff4757';
      ctx.fillStyle = stroke.color || '#ff4757';
    }

    if (stroke.tool === 'pen' || stroke.tool === 'highlighter') {
      if (Array.isArray(stroke.points) && stroke.points.length > 0) {
        const validPoints = stroke.points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
        if (validPoints.length === 1) {
          ctx.beginPath();
          ctx.arc(validPoints[0].x * w, validPoints[0].y * h, Math.max(2, (stroke.width || 4) / 2), 0, Math.PI * 2);
          ctx.fill();
        } else if (validPoints.length > 1) {
          ctx.beginPath();
          ctx.moveTo(validPoints[0].x * w, validPoints[0].y * h);
          for (let i = 1; i < validPoints.length; i++) {
            ctx.lineTo(validPoints[i].x * w, validPoints[i].y * h);
          }
          ctx.stroke();
        }
      }
    } else if (stroke.tool === 'arrow') {
      const p1 = stroke.shapeStart || (stroke.points && stroke.points[0]);
      const p2 = stroke.shapeEnd || (stroke.points && stroke.points[stroke.points.length - 1]);
      if (p1 && p2 && Number.isFinite(p1.x) && Number.isFinite(p1.y) && Number.isFinite(p2.x) && Number.isFinite(p2.y)) {
        this._drawArrow(ctx, p1.x * w, p1.y * h, p2.x * w, p2.y * h, stroke.width);
      }
    } else if (stroke.tool === 'rect') {
      const p1 = stroke.shapeStart || (stroke.points && stroke.points[0]);
      const p2 = stroke.shapeEnd || (stroke.points && stroke.points[stroke.points.length - 1]);
      if (p1 && p2 && Number.isFinite(p1.x) && Number.isFinite(p1.y) && Number.isFinite(p2.x) && Number.isFinite(p2.y)) {
        const x = Math.min(p1.x, p2.x) * w;
        const y = Math.min(p1.y, p2.y) * h;
        const rw = Math.abs(p2.x - p1.x) * w;
        const rh = Math.abs(p2.y - p1.y) * h;
        ctx.strokeRect(x, y, rw, rh);
      }
    } else if (stroke.tool === 'circle') {
      const p1 = stroke.shapeStart || (stroke.points && stroke.points[0]);
      const p2 = stroke.shapeEnd || (stroke.points && stroke.points[stroke.points.length - 1]);
      if (p1 && p2 && Number.isFinite(p1.x) && Number.isFinite(p1.y) && Number.isFinite(p2.x) && Number.isFinite(p2.y)) {
        const cx = ((p1.x + p2.x) / 2) * w;
        const cy = ((p1.y + p2.y) / 2) * h;
        const rx = (Math.abs(p2.x - p1.x) / 2) * w;
        const ry = (Math.abs(p2.y - p1.y) / 2) * h;
        ctx.beginPath();
        if (typeof ctx.ellipse === 'function') {
          ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
        } else {
          ctx.arc(cx, cy, Math.max(1, rx), 0, Math.PI * 2);
        }
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  _drawArrow(ctx, x1, y1, x2, y2, width = 4) {
    const dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist < 4) {
      ctx.beginPath();
      ctx.arc(x1, y1, Math.max(2, width / 2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const headLen = Math.min(dist * 0.45, Math.max(8, width * 3));
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  createToolbar(parentElement = null) {
    this.removeToolbar();

    const bar = document.createElement('div');
    bar.className = 'annotate-toolbar glass-panel';
    bar.style.zIndex = '70';
    bar.style.pointerEvents = 'auto';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Ferramentas de Anotação');

    const tools = [
      { id: 'pen', icon: '✏️', label: 'Caneta' },
      { id: 'highlighter', icon: '🖍️', label: 'Marca-texto' },
      { id: 'arrow', icon: '↗️', label: 'Seta' },
      { id: 'rect', icon: '⬜', label: 'Retângulo' },
      { id: 'circle', icon: '⭕', label: 'Círculo' },
      { id: 'eraser', icon: '🧹', label: 'Borracha' }
    ];

    const colors = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#ffffff'];

    bar.innerHTML = `
      <div class="annotate-tool-group">
        ${tools.map(t => `
          <button type="button" class="annotate-tool-btn ${this.tool === t.id ? 'active' : ''}" data-tool="${t.id}" title="${t.label}">
            <span>${t.icon}</span>
          </button>
        `).join('')}
      </div>
      <div class="annotate-sep"></div>
      <div class="annotate-color-group">
        ${colors.map(c => `
          <button type="button" class="annotate-color-btn ${this.color === c ? 'active' : ''}" data-color="${c}" style="background-color: ${c};" title="${c}">
          </button>
        `).join('')}
      </div>
      <div class="annotate-sep"></div>
      <div class="annotate-action-group">
        <button type="button" class="annotate-action-btn annotate-clear-btn" title="Limpar Tudo">🗑️</button>
        <button type="button" class="annotate-action-btn annotate-close-btn" title="Fechar Anotações">✖️</button>
      </div>
    `;

    // Event listeners
    bar.addEventListener('click', (e) => {
      const toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) {
        bar.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        toolBtn.classList.add('active');
        this.setTool(toolBtn.dataset.tool);
        return;
      }

      const colorBtn = e.target.closest('[data-color]');
      if (colorBtn) {
        bar.querySelectorAll('[data-color]').forEach(b => b.classList.remove('active'));
        colorBtn.classList.add('active');
        this.setColor(colorBtn.dataset.color);
        return;
      }

      if (e.target.closest('.annotate-clear-btn')) {
        this.clear(true);
        return;
      }

      if (e.target.closest('.annotate-close-btn')) {
        this.detach();
        return;
      }
    });

    const target = parentElement || this.container || document.body;
    target.appendChild(bar);
    this.toolbarEl = bar;
    return bar;
  }

  removeToolbar() {
    if (this.toolbarEl && this.toolbarEl.parentElement) {
      this.toolbarEl.parentElement.removeChild(this.toolbarEl);
    }
    this.toolbarEl = null;
  }
}

export const annotateManager = new AnnotateManager();
