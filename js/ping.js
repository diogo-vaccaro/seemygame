/**
 * SeeMyGame - Módulo de Telestrator & Tactical Ping (Ping Tático & Laser Pointer)
 * Permite que espectadores e streamer apontem e desenhem na tela com coordenadas normalizadas.
 */

export class TacticalPingManager {
  constructor(options = {}) {
    this.canvas = options.canvas || null;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.pings = []; // Array de { id, x, y, type, color, senderName, startTime, duration }
    this.laserTrails = []; // Array de { points: [{ x, y, time }], color, maxAge }
    this.isDrawingLaser = false;
    this.currentLaserTrail = null;
    this.audioContext = null;
    this.animFrameId = null;
    this.maxPings = options.maxPings || 100;
    this.maxLaserTrails = options.maxLaserTrails || 24;
    this.maxLaserPoints = options.maxLaserPoints || 600;
  }

  setCanvas(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    if (this.canvas && !this.animFrameId) {
      this.startRenderLoop();
    }
  }

  /**
   * Dispara um bip sonoro sintético leve usando Web Audio API
   * @param {'ping'|'danger'} type
   */
  playPingSound(type = 'ping') {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }

      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();

      osc.type = type === 'danger' ? 'sawtooth' : 'sine';
      const freq = type === 'danger' ? 260 : 880;
      osc.frequency.setValueAtTime(freq, this.audioContext.currentTime);

      if (type === 'danger') {
        osc.frequency.exponentialRampToValueAtTime(180, this.audioContext.currentTime + 0.25);
      } else {
        osc.frequency.exponentialRampToValueAtTime(1320, this.audioContext.currentTime + 0.18);
      }

      gain.gain.setValueAtTime(0.15, this.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(this.audioContext.destination);

      osc.start();
      osc.stop(this.audioContext.currentTime + 0.26);
    } catch (e) {}
  }

  /**
   * Adiciona um novo ping tático na tela
   * @param {Object} param
   */
  addPing({ x, y, type = 'ping', color = null, senderName = 'Amigo', duration = 2000 }) {
    if ((!this.canvas || !this.canvas.isConnected) && typeof document !== 'undefined') {
      const canvasEl = document.getElementById('ping-canvas');
      if (canvasEl) this.setCanvas(canvasEl);
    }
    const safeType = type === 'danger' ? 'danger' : 'ping';
    const safeColor = typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null;
    const safeSenderName = typeof senderName === 'string' ? senderName.slice(0, 64) : 'Amigo';
    const safeDuration = Math.max(500, Math.min(10000, Number(duration) || 2000));
    // Clampa coordenadas normalizadas entre 0.0 e 1.0
    const clampedX = Math.max(0, Math.min(1, Number(x) || 0));
    const clampedY = Math.max(0, Math.min(1, Number(y) || 0));

    const defaultColor = safeType === 'danger' ? '#ef4444' : '#06b6d4';
    const pingObj = {
      id: Math.random().toString(36).substring(2, 9),
      x: clampedX,
      y: clampedY,
      type: safeType,
      color: safeColor || defaultColor,
      senderName: safeSenderName,
      startTime: Date.now(),
      duration: safeDuration
    };

    this.pings.push(pingObj);
    if (this.pings.length > this.maxPings) this.pings.splice(0, this.pings.length - this.maxPings);
    this.playPingSound(safeType);
    return pingObj;
  }

  /**
   * Inicia um traçado de laser pointer
   */
  startLaserTrail({ color = '#10b981' } = {}) {
    if ((!this.canvas || !this.canvas.isConnected) && typeof document !== 'undefined') {
      const canvasEl = document.getElementById('ping-canvas');
      if (canvasEl) this.setCanvas(canvasEl);
    }
    const safeColor = typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#10b981';
    if (this.laserTrails.length >= this.maxLaserTrails) this.laserTrails.shift();
    this.isDrawingLaser = true;
    this.currentLaserTrail = {
      points: [],
      color: safeColor,
      maxAge: 2200
    };
    this.laserTrails.push(this.currentLaserTrail);
  }

  /**
   * Adiciona um ponto ao traço de laser ativo
   */
  addLaserPoint({ x, y, color = '#10b981' }) {
    const clampedX = Math.max(0, Math.min(1, Number(x) || 0));
    const clampedY = Math.max(0, Math.min(1, Number(y) || 0));
    const safeColor = typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#10b981';

    if (!this.currentLaserTrail) {
      this.startLaserTrail({ color: safeColor });
    }

    if (this.currentLaserTrail.points.length >= this.maxLaserPoints) return;

    this.currentLaserTrail.points.push({
      x: clampedX,
      y: clampedY,
      time: Date.now()
    });
  }

  stopLaserTrail() {
    this.isDrawingLaser = false;
    this.currentLaserTrail = null;
  }

  /**
   * Renderiza os pings e lasers no canvas em cada frame
   */
  render() {
    if (!this.ctx || !this.canvas) return;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const now = Date.now();

    this.ctx.clearRect(0, 0, width, height);

    // 1. Renderiza os Pings Táticos
    this.pings = this.pings.filter(ping => {
      const elapsed = now - ping.startTime;
      if (elapsed >= ping.duration) return false;

      const progress = elapsed / ping.duration; // 0.0 -> 1.0
      const alpha = Math.max(0, 1 - progress);
      const px = ping.x * width;
      const py = ping.y * height;

      this.ctx.save();

      // Anel expansivo de radar
      const maxRadius = ping.type === 'danger' ? 42 : 36;
      const currentRadius = 8 + (maxRadius - 8) * progress;

      this.ctx.beginPath();
      this.ctx.arc(px, py, currentRadius, 0, Math.PI * 2);
      this.ctx.strokeStyle = ping.color;
      this.ctx.globalAlpha = alpha * 0.8;
      this.ctx.lineWidth = 2.5;
      this.ctx.stroke();

      // Ponto central
      this.ctx.beginPath();
      this.ctx.arc(px, py, 6, 0, Math.PI * 2);
      this.ctx.fillStyle = ping.color;
      this.ctx.globalAlpha = alpha;
      this.ctx.fill();

      // Rótulo com nome do jogador
      if (ping.senderName) {
        this.ctx.font = 'bold 11px sans-serif';
        this.ctx.fillStyle = '#ffffff';
        this.ctx.globalAlpha = alpha * 0.9;
        this.ctx.textAlign = 'center';
        this.ctx.shadowColor = 'rgba(0,0,0,0.8)';
        this.ctx.shadowBlur = 4;
        this.ctx.fillText(ping.senderName, px, py - 12);
      }

      this.ctx.restore();
      return true;
    });

    // 2. Renderiza os Traços de Laser Pointer
    this.laserTrails = this.laserTrails.filter(trail => {
      // Remove pontos antigos
      trail.points = trail.points.filter(p => now - p.time < trail.maxAge);
      if (trail.points.length < 2) return trail.points.length > 0;

      this.ctx.save();
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      for (let i = 1; i < trail.points.length; i++) {
        const p1 = trail.points[i - 1];
        const p2 = trail.points[i];
        const age = now - p2.time;
        const alpha = Math.max(0, 1 - (age / trail.maxAge));

        this.ctx.beginPath();
        this.ctx.moveTo(p1.x * width, p1.y * height);
        this.ctx.lineTo(p2.x * width, p2.y * height);
        this.ctx.strokeStyle = trail.color;
        this.ctx.globalAlpha = alpha;
        this.ctx.lineWidth = 4;
        this.ctx.shadowColor = trail.color;
        this.ctx.shadowBlur = 8;
        this.ctx.stroke();
      }

      this.ctx.restore();
      return trail.points.length > 0;
    });
  }

  startRenderLoop() {
    const loop = () => {
      this.render();
      if (typeof requestAnimationFrame !== 'undefined') {
        this.animFrameId = requestAnimationFrame(loop);
      }
    };
    loop();
  }

  stopRenderLoop() {
    if (this.animFrameId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  clear() {
    this.pings = [];
    this.laserTrails = [];
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}

export const tacticalPingManager = new TacticalPingManager();
