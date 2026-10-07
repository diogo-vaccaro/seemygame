/**
 * SeeMyGame - StreamerModeController
 * Modo Streamer: Protege contra Stream Sniping ocultando código de sala, PINs,
 * links de convite e anonimizando o título da aba para lives na Twitch/YouTube/Kick.
 */

export class StreamerModeController {
  constructor(options = {}) {
    this.storageKey = 'seemygame_streamer_mode';
    this.enabled = false;
    this.originalTitle = typeof document !== 'undefined' ? document.title : '';
    this.originalBadgeText = null;
    this.listeners = new Set();
    this.elements = {};

    this.onKeydown = this.onKeydown.bind(this);
    this._observer = null;
  }

  init(elements = {}) {
    this.elements = { ...this.elements, ...elements };

    // Restaurar preferência do localStorage
    try {
      if (typeof localStorage !== 'undefined') {
        this.enabled = localStorage.getItem(this.storageKey) === 'true';
      }
    } catch (_) {}

    // Registrar atalho global Ctrl + Shift + S
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeydown);
    }

    if (this.elements.toggleBtn) {
      this.elements.toggleBtn.addEventListener('click', () => this.toggle());
    }

    this.apply();
    return this;
  }

  destroy() {
    this._stopObserver();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeydown);
    }
    this.listeners.clear();
  }

  onKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      this.toggle();
    }
  }

  toggle() {
    return this.setStreamerMode(!this.enabled);
  }

  setStreamerMode(enable) {
    this.enabled = Boolean(enable);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.storageKey, String(this.enabled));
      }
    } catch (_) {}

    this.apply();
    this.notify();
    return this.enabled;
  }

  onChange(listener) {
    if (typeof listener === 'function') {
      this.listeners.add(listener);
    }
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.enabled);
      } catch (err) {
        console.error('[StreamerMode] Erro no listener:', err);
      }
    }
  }

  apply() {
    if (typeof document === 'undefined') return;

    if (document.body) {
      document.body.classList.toggle('streamer-mode-active', this.enabled);
    }

    // Toggle button UI
    if (this.elements.toggleBtn) {
      this.elements.toggleBtn.classList.toggle('active', this.enabled);
      this.elements.toggleBtn.setAttribute('aria-pressed', String(this.enabled));
      this.elements.toggleBtn.title = this.enabled
        ? 'Modo Streamer Ativo: Códigos e PINs ocultos (Ctrl+Shift+S)'
        : 'Ativar Modo Streamer: Oculta códigos e PINs para lives (Ctrl+Shift+S)';
      
      const label = this.elements.toggleBtn.querySelector('.streamer-mode-label');
      if (label) {
        label.textContent = this.enabled ? 'Streamer ON' : 'Streamer';
      }
    }

    // Badge do cabeçalho da sala
    const badge = this.elements.roomHeaderBadge || document.getElementById('room-header-badge');
    if (badge) {
      if (this.enabled) {
        if (this.originalBadgeText === null) {
          this.originalBadgeText = badge.textContent;
        }
        badge.textContent = '🛡️ Sala Oculta (Modo Streamer)';
        badge.classList.add('badge-streamer-protected');
      } else if (this.originalBadgeText !== null) {
        badge.textContent = this.originalBadgeText;
        badge.classList.remove('badge-streamer-protected');
      }
    }

    // Título da aba do navegador
    if (this.enabled) {
      if (!this.originalTitle) this.originalTitle = document.title;
      document.title = 'SeeMyGame - Em Transmissão';
    } else if (this.originalTitle) {
      document.title = this.originalTitle;
    }

    // Campo de código da sala no modal de compartilhamento
    const codeDisplay = this.elements.shareRoomCodeDisplay || document.getElementById('share-room-code-display');
    if (codeDisplay) {
      if (this.enabled) {
        if (!codeDisplay.dataset.realValue) {
          codeDisplay.dataset.realValue = codeDisplay.value;
        }
        codeDisplay.value = '••••••••';
      } else if (codeDisplay.dataset.realValue) {
        codeDisplay.value = codeDisplay.dataset.realValue;
        delete codeDisplay.dataset.realValue;
      }
    }

    // QR code blur
    const qrWrapper = this.elements.qrWrapper || document.querySelector('.qr-code-wrapper');
    if (qrWrapper) {
      qrWrapper.classList.toggle('qr-blur-protected', this.enabled);
    }

    if (this.enabled) {
      this._startObserver();
    } else {
      this._stopObserver();
    }
  }

  _startObserver() {
    if (this._observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    this._observer = new MutationObserver(() => {
      if (this.enabled) {
        document.querySelectorAll('.room-code, .room-pin, #share-room-code-display, [data-streamer-mask]').forEach(el => {
          if (el.tagName === 'INPUT') {
            if (el.value !== '••••••••' && !el.dataset.realValue) {
              el.dataset.realValue = el.value;
              el.value = '••••••••';
            }
          }
        });
        if (document.title !== 'SeeMyGame - Em Transmissão') {
          if (!this.originalTitle) this.originalTitle = document.title;
          document.title = 'SeeMyGame - Em Transmissão';
        }
      }
    });
    if (document.body) {
      this._observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  _stopObserver() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }
}

export const streamerModeController = new StreamerModeController();
export const streamerMode = streamerModeController;
