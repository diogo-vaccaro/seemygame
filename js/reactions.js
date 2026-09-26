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
    this.lastSentTimestamp = 0;
    this.cooldownMs = options.cooldownMs || 250; // Max 4 por segundo por jogador
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

    // Posição horizontal aleatória (10% a 90%) se não fornecida
    const parsedX = Number(xPercent);
    const x = xPercent !== null && Number.isFinite(parsedX)
      ? Math.max(5, Math.min(95, parsedX))
      : (Math.random() * 70 + 15);
    const drift = (Math.random() - 0.5) * 60; // Desvio lateral em pixels
    const duration = 2.0 + Math.random() * 0.8; // 2s a 2.8s

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
    this.activeReactionsCount++;

    const cleanup = () => {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
        this.activeReactionsCount = Math.max(0, this.activeReactionsCount - 1);
      }
    };

    el.addEventListener('animationend', cleanup);
    setTimeout(cleanup, (duration + 0.5) * 1000);

    return el;
  }
}

export const floatingReactionsManager = new FloatingReactionsManager();
