/**
 * SeeMyGame - RoomLayoutController
 * 
 * Gerencia a alternância dinâmica de layouts na sala de transmissão:
 * - 'grid': Grade padrão balanceada entre todos os streams
 * - 'focus': Destaque (um vídeo amplo e carrossel de miniaturas para os outros)
 * - 'cinema': Hiperfoco (vídeo ocupa 100% da viewport com interface autohide e chat overlay)
 */

export class RoomLayoutController {
  constructor(options = {}) {
    this.storageKey = options.storageKey || 'seemygame_room_layout';
    this.mode = this._loadSavedMode() || 'grid'; // 'grid' | 'focus' | 'cinema'
    this.focusedMediaId = null;
    this.gridEl = options.gridEl || null;
    this.headerEl = options.headerEl || null;
    this.dockEl = options.dockEl || null;
    this.drawerEl = options.drawerEl || null;
    this.listeners = new Set();
    this.boundKeyHandler = null;
    this.cardsObserver = null;
    this.cinemaExitBtn = null;
    this.cinemaChatBtn = null;
  }

  _loadSavedMode() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const saved = window.localStorage.getItem(this.storageKey);
        if (saved && ['grid', 'focus', 'cinema'].includes(saved)) {
          return saved;
        }
      }
    } catch (_) {}
    return 'grid';
  }

  _saveMode(mode) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(this.storageKey, mode);
      }
    } catch (_) {}
  }

  getLayoutMode() {
    return this.mode;
  }

  setLayoutMode(mode, targetMediaId = null) {
    if (!['grid', 'focus', 'cinema'].includes(mode)) return;
    this.mode = mode;
    this._saveMode(mode);

    if (targetMediaId) {
      this.focusedMediaId = targetMediaId;
    } else if (!this.focusedMediaId) {
      this.focusedMediaId = this._findDefaultMediaId();
    }

    this.applyLayoutToDOM();
    this._notifyListeners();
  }

  setFocusedMediaId(mediaId) {
    this.focusedMediaId = mediaId;
    if (this.mode !== 'grid') {
      this.applyLayoutToDOM();
    }
  }

  toggleFocus(mediaId = null) {
    if (this.mode === 'focus') {
      if (!mediaId || mediaId === this.focusedMediaId) {
        this.setLayoutMode('grid');
      } else {
        this.setLayoutMode('focus', mediaId);
      }
    } else {
      this.setLayoutMode('focus', mediaId);
    }
  }

  toggleCinema(mediaId = null) {
    if (this.mode === 'cinema') {
      this.setLayoutMode('grid');
    } else {
      this.setLayoutMode('cinema', mediaId);
    }
  }

  exitCinema() {
    if (this.mode === 'cinema') {
      this.setLayoutMode('grid');
    }
  }

  _findDefaultMediaId() {
    if (typeof document === 'undefined') return null;
    const root = this.gridEl || document;
    const cards = root.querySelectorAll('.video-card');
    for (const card of cards) {
      const id = card.id ? card.id.replace('card-', '') : card.dataset?.peerId;
      if (id) return id;
    }
    return null;
  }

  bindDOM({ gridEl = null, headerEl = null, dockEl = null, drawerEl = null } = {}) {
    if (typeof document === 'undefined') return;
    this.gridEl = gridEl || document.getElementById('video-grid') || document.querySelector('.video-grid');
    this.headerEl = headerEl || document.querySelector('header') || document.getElementById('room-header');
    this.dockEl = dockEl || document.getElementById('bottom-control-dock') || document.querySelector('.bottom-control-dock');
    this.drawerEl = drawerEl || document.getElementById('discord-drawer');

    this._bindKeyboardShortcuts();
    this._bindMutationObserver();
    this.applyLayoutToDOM();
  }

  _bindMutationObserver() {
    if (!this.gridEl || typeof MutationObserver === 'undefined') return;
    if (this.cardsObserver) {
      this.cardsObserver.disconnect();
    }
    this.cardsObserver = new MutationObserver(() => {
      this._handleCardsMutation();
    });
    this.cardsObserver.observe(this.gridEl, { childList: true });
  }

  _handleCardsMutation() {
    if (!this.gridEl) return;
    const cards = Array.from(this.gridEl.querySelectorAll('.video-card'));
    const cardIds = cards.map(c => (c.id ? c.id.replace('card-', '') : c.dataset?.peerId)).filter(Boolean);

    if (!this.focusedMediaId || !cardIds.includes(this.focusedMediaId)) {
      this.focusedMediaId = this._findDefaultMediaId();
    }
    this.applyLayoutToDOM();
  }

  _bindKeyboardShortcuts() {
    if (typeof document === 'undefined') return;
    if (this.boundKeyHandler) {
      document.removeEventListener('keydown', this.boundKeyHandler);
    }

    this.boundKeyHandler = (e) => {
      // Ignorar se o foco estiver dentro de campos de entrada ou modais
      const active = document.activeElement;
      if (active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable ||
        active.closest('.modal-overlay[style*="flex"], .modal-overlay[style*="block"]')
      )) {
        return;
      }

      if (e.key === 'Escape') {
        if (this.mode === 'cinema') {
          this.exitCinema();
        }
      } else if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Toggle de foco no vídeo principal
        this.toggleFocus();
      }
    };

    document.addEventListener('keydown', this.boundKeyHandler);
  }

  applyLayoutToDOM() {
    if (!this.gridEl || typeof document === 'undefined') return;

    // Resetar classes no grid
    this.gridEl.classList.remove('layout-grid', 'layout-focus', 'layout-cinema');
    this.gridEl.classList.add(`layout-${this.mode}`);

    // Remover controles de cinema se existirem
    this._removeCinemaFloatingControls();

    const cards = Array.from(this.gridEl.querySelectorAll('.video-card'));
    const cardIds = cards.map(c => (c.id ? c.id.replace('card-', '') : c.dataset?.peerId)).filter(Boolean);
    if (!this.focusedMediaId || !cardIds.includes(this.focusedMediaId)) {
      this.focusedMediaId = this._findDefaultMediaId();
    }

    if (this.mode === 'grid') {
      cards.forEach((card) => {
        card.classList.remove('focused', 'thumbnail-mode', 'cinema-mode');
        card.style.display = '';
      });
      if (this.headerEl) this.headerEl.style.display = '';
      if (this.dockEl) this.dockEl.style.display = '';
    } else if (this.mode === 'focus') {
      cards.forEach((card) => {
        const id = card.id ? card.id.replace('card-', '') : card.dataset?.peerId;
        const isTarget = id === this.focusedMediaId || (cards.length === 1);
        card.classList.remove('cinema-mode');
        if (isTarget) {
          card.classList.add('focused');
          card.classList.remove('thumbnail-mode');
        } else {
          card.classList.remove('focused');
          card.classList.add('thumbnail-mode');
        }
        card.style.display = '';
      });
      if (this.headerEl) this.headerEl.style.display = '';
      if (this.dockEl) this.dockEl.style.display = '';
    } else if (this.mode === 'cinema') {
      cards.forEach((card) => {
        const id = card.id ? card.id.replace('card-', '') : card.dataset?.peerId;
        const isTarget = id === this.focusedMediaId || (cards.length === 1);
        card.classList.remove('focused', 'thumbnail-mode');
        if (isTarget) {
          card.classList.add('cinema-mode');
          card.style.display = '';
        } else {
          card.classList.remove('cinema-mode');
          card.style.display = 'none';
        }
      });

      this._createCinemaFloatingControls();
    }
  }

  _createCinemaFloatingControls() {
    if (typeof document === 'undefined') return;
    this._removeCinemaFloatingControls();

    const controls = document.createElement('div');
    controls.id = 'cinema-floating-controls';
    controls.className = 'cinema-floating-controls';

    controls.innerHTML = `
      <button type="button" class="cinema-ctrl-btn" id="cinema-toggle-chat-btn" title="Alternar Chat em Overlay">
        💬 Chat
      </button>
      <button type="button" class="cinema-ctrl-btn cinema-exit-btn" id="cinema-exit-btn" title="Sair do Modo Cinema (Esc)">
        ✕ Sair do Cinema
      </button>
    `;

    controls.querySelector('#cinema-exit-btn')?.addEventListener('click', () => {
      this.exitCinema();
    });

    controls.querySelector('#cinema-toggle-chat-btn')?.addEventListener('click', () => {
      if (this.drawerEl) {
        this.drawerEl.classList.toggle('cinema-open');
        this.drawerEl.classList.toggle('open');
      }
    });

    document.body.appendChild(controls);
  }

  _removeCinemaFloatingControls() {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('cinema-floating-controls');
    if (existing) existing.remove();
    if (this.drawerEl) {
      this.drawerEl.classList.remove('cinema-open');
    }
  }

  onLayoutChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notifyListeners() {
    this.listeners.forEach((fn) => {
      try { fn(this.mode, this.focusedMediaId); } catch (_) {}
    });
  }

  dispose() {
    if (this.cardsObserver) {
      this.cardsObserver.disconnect();
      this.cardsObserver = null;
    }
    if (this.boundKeyHandler && typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.boundKeyHandler);
      this.boundKeyHandler = null;
    }
    this._removeCinemaFloatingControls();
    this.listeners.clear();
  }
}

export const roomLayoutController = new RoomLayoutController();
