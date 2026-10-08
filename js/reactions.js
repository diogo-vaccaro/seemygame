/**
 * SeeMyGame - Módulo de Reações Flutuantes (Hype Reactions)
 * Emojis e badges sobem flutuando pela tela em tempo real via WebRTC DataChannel.
 */

export const ALLOWED_REACTIONS = ['🔥', '💀', '🎯', '👏', '😂', 'GG', '🚀', '❤️'];

export class FloatingReactionsManager {
  constructor(options = {}) {
    this.container = options.container || null;
    this.maxConcurrent = options.maxConcurrent || 30;
    this.activeReactionsCount = 0;
    this.activeElements = new Set();
    this.lastSentTimestamp = 0;
    this.cooldownMs = options.cooldownMs || 250; // Max 4 por segundo por jogador
    this.lastBurstTimestamp = 0;
    this.burstCooldownMs = options.burstCooldownMs || 1200; // 1 rajada a cada 1.2s
  }

  setContainer(container) {
    this.container = container;
  }

  /**
   * Verifica se o emoji é válido
   * @param {string} emoji
   */
  isValidReaction(emoji) {
    return ALLOWED_REACTIONS.includes(emoji);
  }

  /**
   * Verifica taxa de envio para evitar spam
   */
  canSend() {
    const now = Date.now();
    if (now - this.lastSentTimestamp >= this.cooldownMs) {
      this.lastSentTimestamp = now;
      return true;
    }
    return false;
  }

  /**
   * Verifica taxa de envio para rajadas (burst)
   */
  canSendBurst() {
    const now = Date.now();
    if (now - this.lastBurstTimestamp >= this.burstCooldownMs) {
      this.lastBurstTimestamp = now;
      this.lastSentTimestamp = now;
      return true;
    }
    return false;
  }

  /**
   * Instancia uma reação flutuante na tela
   * @param {Object} param
   */
  spawnReaction({ emoji, xPercent = null, senderName = null }) {
    if (!this.isValidReaction(emoji)) return null;
    if (this.activeReactionsCount >= this.maxConcurrent) return null;
    if ((!this.container || !this.container.isConnected) && typeof document !== 'undefined') {
      const overlay = document.getElementById('reactions-overlay');
      if (overlay) this.container = overlay;
    }
    if (!this.container || typeof document === 'undefined') return null;

    const el = document.createElement('div');
    el.className = 'floating-reaction';

    // Suporte à preferência do sistema por redução de movimento
    const prefersReduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Posição horizontal aleatória (10% a 90%) se não fornecida
    const parsedX = Number(xPercent);
    const x = xPercent !== null && Number.isFinite(parsedX)
      ? Math.max(5, Math.min(95, parsedX))
      : (Math.random() * 70 + 15);
    const drift = prefersReduced ? 0 : ((Math.random() - 0.5) * 60); // Desvio lateral em pixels
    const duration = prefersReduced ? 1.5 : (2.0 + Math.random() * 0.8); // 2s a 2.8s

    el.style.left = `${x}%`;
    el.style.setProperty('--drift', `${drift}px`);
    el.style.animationDuration = `${duration}s`;

    if (emoji === 'GG') {
      const ggBadge = document.createElement('span');
      ggBadge.className = 'reaction-gg-badge';
      ggBadge.textContent = 'GG';
      el.appendChild(ggBadge);
    } else {
      el.textContent = emoji;
    }

    if (senderName) {
      const nameTag = document.createElement('small');
      nameTag.className = 'reaction-sender';
      nameTag.textContent = String(senderName).slice(0, 64);
      el.appendChild(nameTag);
    }

    this.container.appendChild(el);
    this.activeElements.add(el);
    this.activeReactionsCount++;

    const cleanup = () => {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
      this.activeElements.delete(el);
      this.activeReactionsCount = Math.max(0, this.activeReactionsCount - 1);
    };

    el.addEventListener('animationend', cleanup);
    setTimeout(cleanup, (duration + 0.5) * 1000);

    return el;
  }

  /**
   * Instancia uma rajada (burst) de emojis em leque
   * @param {Object} param
   */
  spawnBurst({ emoji, count = 4, originX = null, senderName = null }) {
    if (!this.isValidReaction(emoji)) return [];
    const elements = [];
    const baseCount = Math.min(6, Math.max(2, Number(count) || 4));
    const center = originX !== null && Number.isFinite(Number(originX))
      ? Math.max(10, Math.min(90, Number(originX)))
      : (Math.random() * 60 + 20);

    for (let i = 0; i < baseCount; i++) {
      setTimeout(() => {
        const offset = (Math.random() - 0.5) * 18;
        const el = this.spawnReaction({
          emoji,
          xPercent: Math.max(5, Math.min(95, center + offset)),
          senderName: i === 0 ? senderName : null
        });
        if (el) elements.push(el);
      }, i * 65);
    }
    return elements;
  }

  dispose() {
    this.activeElements.forEach((el) => el.remove?.());
    this.activeElements.clear();
    this.activeReactionsCount = 0;
    this.container = null;
  }
}

export const floatingReactionsManager = new FloatingReactionsManager();
