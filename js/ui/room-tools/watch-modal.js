/**
 * SeeMyGame - WatchModalUI
 * Modal acessível para co-visualização sincronizada (Watch Together).
 */

export class WatchModalUI {
  constructor(controller) {
    this.controller = controller;
    this.modalEl = null;
    this.unsubChange = null;
    this.timeUpdateTimer = null;
  }

  mount() {
    if (typeof document === 'undefined') return null;
    let modal = document.getElementById('watch-together-modal');
    if (modal) {
      this.modalEl = modal;
      this._bindEvents();
      return modal;
    }

    modal = document.createElement('div');
    modal.id = 'watch-together-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'watch-modal-title');

    modal.innerHTML = `
      <div class="modal-content watch-modal-content" style="max-width: 820px; width: 95%; display: flex; flex-direction: column; gap: 14px; background: var(--bg-card, #12151f); border-radius: 14px; border: 1px solid var(--border-color, rgba(255,255,255,0.12)); padding: 20px; box-shadow: var(--shadow-panel, 0 16px 40px rgba(0,0,0,0.6));">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.3rem;">🍿</span>
            <h3 id="watch-modal-title" style="margin: 0; font-size: 1.15rem; color: var(--text-main, #fff);">Watch Together</h3>
            <span id="watch-status-badge" class="badge-status-p2p" style="font-size: 11px; background: rgba(56, 189, 248, 0.18); color: #38bdf8; padding: 2px 8px; border-radius: 10px; font-weight: 600;">Sincronizado</span>
          </div>
          <button type="button" id="watch-close-btn" class="drawer-close-btn" aria-label="Fechar" style="background: none; border: none; color: var(--text-muted, #94a3b8); font-size: 18px; cursor: pointer;">✕</button>
        </div>

        <!-- Barra de Carregamento de URL -->
        <div id="watch-load-bar" style="display: flex; gap: 8px;">
          <input type="url" id="watch-url-input" placeholder="Cole o link do YouTube ou URL direta de MP4..." style="flex: 1; padding: 7px 12px; font-size: 12.5px; border-radius: 6px; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.1); color: #fff;" />
          <button type="button" id="watch-load-btn" class="btn-primary" style="padding: 7px 14px; font-size: 12px; border-radius: 6px; cursor: pointer;">Carregar</button>
        </div>

        <!-- Área de Reprodução do Vídeo -->
        <div id="watch-player-container" style="width: 100%; height: 380px; background: #000; border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; position: relative;">
          <div id="watch-empty-placeholder" style="color: var(--text-muted, #94a3b8); font-size: 13px; text-align: center; padding: 20px;">
            Cole um link do YouTube ou vídeo MP4 acima para assistir junto com a sala.
          </div>
        </div>

        <!-- Barra de Controles do Player -->
        <div id="watch-controls-bar" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">
          <div style="display: flex; align-items: center; gap: 10px;">
            <button type="button" id="watch-playpause-btn" class="btn-primary" style="padding: 6px 12px; font-size: 13px; border-radius: 6px;">▶️ Play</button>
            <span id="watch-time-display" style="font-size: 12px; color: var(--text-muted, #94a3b8); font-family: monospace;">00:00</span>
          </div>

          <div style="flex: 1; display: flex; align-items: center; gap: 8px; margin: 0 10px;">
            <input type="range" id="watch-seek-slider" min="0" max="100" value="0" step="1" style="flex: 1; accent-color: var(--accent-cyan, #00d2d3); cursor: pointer;" />
          </div>

          <div id="watch-controller-info" style="font-size: 11px; color: var(--text-muted, #94a3b8);">
            Controlador: <span id="watch-controller-name" style="color: #fff; font-weight: 600;">Host</span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modalEl = modal;
    this.controller.setContainer(modal.querySelector('#watch-player-container'));
    this._bindEvents();
    return modal;
  }

  _bindEvents() {
    if (!this.modalEl) return;

    this.modalEl.querySelector('#watch-close-btn')?.addEventListener('click', () => this.close());

    this.modalEl.querySelector('#watch-load-btn')?.addEventListener('click', async () => {
      const url = this.modalEl.querySelector('#watch-url-input')?.value;
      if (url) {
        const res = await this.controller.loadMedia(url);
        if (res?.success === false) {
          alert('URL inválida ou formato não suportado. Utilize links do YouTube ou MP4 HTTPS.');
        }
      }
    });

    this.modalEl.querySelector('#watch-playpause-btn')?.addEventListener('click', () => {
      if (this.controller.paused) {
        this.controller.play();
      } else {
        this.controller.pause();
      }
    });

    const seekSlider = this.modalEl.querySelector('#watch-seek-slider');
    seekSlider?.addEventListener('change', (e) => {
      this.controller.seek(Number(e.target.value));
    });

    this.unsubChange = this.controller.onChange(() => this.render());
  }

  render() {
    if (!this.modalEl) return;
    const canControl = this.controller.canIControl();
    const isPaused = this.controller.paused;
    const placeholder = this.modalEl.querySelector('#watch-empty-placeholder');

    if (this.controller.mediaId && placeholder) {
      placeholder.style.display = 'none';
    }

    const playPauseBtn = this.modalEl.querySelector('#watch-playpause-btn');
    if (playPauseBtn) {
      playPauseBtn.textContent = isPaused ? '▶️ Play' : '⏸️ Pausar';
      playPauseBtn.disabled = !canControl;
      playPauseBtn.style.opacity = canControl ? '1' : '0.5';
    }

    const seekSlider = this.modalEl.querySelector('#watch-seek-slider');
    if (seekSlider) {
      seekSlider.disabled = !canControl;
    }

    const loadBar = this.modalEl.querySelector('#watch-load-bar');
    if (loadBar) {
      loadBar.style.display = canControl ? 'flex' : 'none';
    }

    const ctrlName = this.modalEl.querySelector('#watch-controller-name');
    if (ctrlName) {
      ctrlName.textContent = this.controller.controllerPeerId
        ? `Peer ${this.controller.controllerPeerId.slice(-4)}`
        : 'Host';
    }
  }

  _startTimeTicker() {
    this._stopTimeTicker();
    this.timeUpdateTimer = setInterval(() => {
      if (!this.modalEl) return;
      const current = this.controller.calculateEstimatedPosition();
      const timeDisplay = this.modalEl.querySelector('#watch-time-display');
      if (timeDisplay) {
        const mins = String(Math.floor(current / 60)).padStart(2, '0');
        const secs = String(Math.floor(current % 60)).padStart(2, '0');
        timeDisplay.textContent = `${mins}:${secs}`;
      }
    }, 1000);
  }

  _stopTimeTicker() {
    if (this.timeUpdateTimer) {
      clearInterval(this.timeUpdateTimer);
      this.timeUpdateTimer = null;
    }
  }

  open() {
    this.mount();
    if (this.modalEl) {
      this.modalEl.style.display = 'flex';
      this._startTimeTicker();
      this.render();
    }
  }

  close() {
    this._stopTimeTicker();
    if (this.modalEl) {
      this.modalEl.style.display = 'none';
    }
  }

  destroy() {
    this._stopTimeTicker();
    if (this.unsubChange) this.unsubChange();
    if (this.modalEl?.parentElement) {
      this.modalEl.parentElement.removeChild(this.modalEl);
    }
    this.modalEl = null;
  }
}
