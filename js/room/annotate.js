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
    this._boundOnPointerDown = this._onPointerDown.bind(this);
    this._boundOnPointerMove = this._onPointerMove.bind(this);
    this._boundOnPointerUp = this._onPointerUp.bind(this);
    this._boundResize = this._syncCanvasSize.bind(this);
  }

  attach(container, video = null) {
    if (!container) return;
    this.detach();

    this.container = container;
    this.video = video || container.querySelector('video');

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'annotate-overlay-canvas';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'auto',
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
    this.broadcast = fn;
  }

  _syncCanvasSize() {
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

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
    if (!this.isActive) return;
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
      this.currentStroke.points.push(pt);
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
    const beforeCount = this.strokes.length;
    this.strokes = this.strokes.filter(s => {
      if (s.points && s.points.length > 0) {
        return !s.points.some(p => Math.hypot(p.x - pt.x, p.y - pt.y) < radius);
      }
      if (s.shapeStart && s.shapeEnd) {
        const midX = (s.shapeStart.x + s.shapeEnd.x) / 2;
        const midY = (s.shapeStart.y + s.shapeEnd.y) / 2;
        return Math.hypot(midX - pt.x, midY - pt.y) >= radius;
      }
      return true;
    });

    if (this.strokes.length !== beforeCount) {
      this.redraw();
      if (this.broadcast) {
        this.broadcast({
          type: 'ANNOTATE_SYNC',
          strokes: this.strokes
        });
      }
    }
  }

  removeStroke(strokeId) {
    this.strokes = this.strokes.filter(s => s.id !== strokeId);
    this.redraw();
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
      if (!this.isActive || !this.canvas) {
        const target = document.querySelector('.video-card.active, .video-card, #video-grid');
        if (target) {
          const video = target.querySelector('video');
          this.attach(target, video);
        }
      }
      this.strokes.push(msg.stroke);
      this.redraw();
      if (this.autoClear) {
        const tid = setTimeout(() => {
          this.autoClearTimers.delete(tid);
          this.removeStroke(msg.stroke.id);
        }, this.autoClearDelay);
        this.autoClearTimers.add(tid);
      }
    } else if (msg.type === 'ANNOTATE_CLEAR') {
      this.clear(false);
    } else if (msg.type === 'ANNOTATE_SYNC' && Array.isArray(msg.strokes)) {
      this.strokes = msg.strokes;
      this.redraw();
    }
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
