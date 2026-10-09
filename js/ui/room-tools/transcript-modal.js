/**
 * SeeMyGame - TranscriptModalUI
 * Modal acessível para transcrição de voz, legendas ao vivo e exportação SRT/VTT.
 */

export class TranscriptModalUI {
  constructor(manager) {
    this.manager = manager;
    this.modalEl = null;
    this.overlayEl = null;
    this.isOverlayActive = false;
    this.unsubChange = null;
  }

  mount() {
    if (typeof document === 'undefined') return null;
    let modal = document.getElementById('transcript-modal');
    if (modal) {
      this.modalEl = modal;
      this._bindEvents();
      return modal;
    }

    modal = document.createElement('div');
    modal.id = 'transcript-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'transcript-modal-title');

    modal.innerHTML = `
      <div class="modal-content transcript-modal-content" style="max-width: 680px; width: 94%; display: flex; flex-direction: column; gap: 14px; background: var(--bg-card, #12151f); border-radius: 14px; border: 1px solid var(--border-color, rgba(255,255,255,0.12)); padding: 20px; box-shadow: var(--shadow-panel, 0 16px 40px rgba(0,0,0,0.6)); max-height: 80vh;">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.3rem;">💬</span>
            <h3 id="transcript-modal-title" style="margin: 0; font-size: 1.15rem; color: var(--text-main, #fff);">Transcrição & Legendas da Call</h3>
          </div>
          <button type="button" id="transcript-close-btn" class="drawer-close-btn" aria-label="Fechar" style="background: none; border: none; color: var(--text-muted, #94a3b8); font-size: 18px; cursor: pointer;">✕</button>
        </div>

        <!-- Banner de Consentimento e Privacidade -->
        <div id="transcript-consent-box" style="padding: 12px 14px; border-radius: 8px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2); display: flex; flex-direction: column; gap: 8px;">
          <div style="font-size: 12px; color: #bae6fd;">
            🔒 <strong>Privacidade de Áudio:</strong> O reconhecimento ocorre no navegador a partir do seu microfone. Nenhum áudio de quem não conceder consentimento é capturado ou enviado a servidores externos.
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 8px;">
            <button type="button" id="transcript-consent-btn" class="btn-primary" style="padding: 6px 12px; font-size: 12px; border-radius: 6px;">Concordar e Habilitar</button>
          </div>
        </div>

        <!-- Controles de Ativação -->
        <div id="transcript-controls-box" style="display: none; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <button type="button" id="transcript-toggle-mic-btn" class="btn-primary" style="padding: 7px 14px; font-size: 12.5px; border-radius: 6px;">
              🎙️ Iniciar Legendas
            </button>
            <button type="button" id="transcript-toggle-overlay-btn" class="btn-secondary" style="padding: 7px 12px; font-size: 12px; border-radius: 6px;">
              📺 Legendas na Tela: Desligado
            </button>
          </div>

          <div style="display: flex; gap: 6px;">
            <button type="button" id="transcript-export-srt" class="btn-secondary" style="padding: 5px 10px; font-size: 11.5px;">Baixar .SRT</button>
            <button type="button" id="transcript-export-vtt" class="btn-secondary" style="padding: 5px 10px; font-size: 11.5px;">Baixar .VTT</button>
            <button type="button" id="transcript-export-txt" class="btn-secondary" style="padding: 5px 10px; font-size: 11.5px;">Baixar .TXT</button>
          </div>
        </div>

        <!-- Histórico de Legendas -->
        <div id="transcript-segments-list" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 220px; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08);" role="log" aria-live="polite"></div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modalEl = modal;
    this._bindEvents();
    return modal;
  }

  _bindEvents() {
    if (!this.modalEl) return;

    this.modalEl.querySelector('#transcript-close-btn')?.addEventListener('click', () => this.close());

    this.modalEl.querySelector('#transcript-consent-btn')?.addEventListener('click', () => {
      this.manager.grantConsent();
      this.render();
    });

    this.modalEl.querySelector('#transcript-toggle-mic-btn')?.addEventListener('click', () => {
      if (this.manager.isListening) {
        this.manager.stopListening();
      } else {
        this.manager.startListening();
      }
      this.render();
    });

    this.modalEl.querySelector('#transcript-toggle-overlay-btn')?.addEventListener('click', () => {
      this.isOverlayActive = !this.isOverlayActive;
      this._updateOverlay();
      this.render();
    });

    this.modalEl.querySelector('#transcript-export-srt')?.addEventListener('click', () => {
      this.manager.downloadExport('srt');
    });

    this.modalEl.querySelector('#transcript-export-vtt')?.addEventListener('click', () => {
      this.manager.downloadExport('vtt');
    });

    this.modalEl.querySelector('#transcript-export-txt')?.addEventListener('click', () => {
      this.manager.downloadExport('txt');
    });

    this.unsubChange = this.manager.onChange(() => this.render());
  }

  render() {
    if (!this.modalEl) return;
    const consentBox = this.modalEl.querySelector('#transcript-consent-box');
    const controlsBox = this.modalEl.querySelector('#transcript-controls-box');

    if (this.manager.hasUserConsent) {
      if (consentBox) consentBox.style.display = 'none';
      if (controlsBox) controlsBox.style.display = 'flex';
    } else {
      if (consentBox) consentBox.style.display = 'flex';
      if (controlsBox) controlsBox.style.display = 'none';
    }

    const toggleMicBtn = this.modalEl.querySelector('#transcript-toggle-mic-btn');
    if (toggleMicBtn) {
      if (this.manager.isListening) {
        toggleMicBtn.textContent = '⏹️ Parar Transcrição';
        toggleMicBtn.style.background = 'rgba(239, 68, 68, 0.2)';
        toggleMicBtn.style.color = '#fca5a5';
      } else {
        toggleMicBtn.textContent = '🎙️ Iniciar Legendas';
        toggleMicBtn.style.background = '';
        toggleMicBtn.style.color = '';
      }
    }

    const toggleOverlayBtn = this.modalEl.querySelector('#transcript-toggle-overlay-btn');
    if (toggleOverlayBtn) {
      toggleOverlayBtn.textContent = `📺 Legendas na Tela: ${this.isOverlayActive ? 'Ligado' : 'Desligado'}`;
    }

    const listEl = this.modalEl.querySelector('#transcript-segments-list');
    if (listEl) {
      listEl.innerHTML = '';
      if (!this.manager.segments.length && !this.manager.activePartial) {
        listEl.innerHTML = '<span style="font-size: 12px; color: var(--text-muted, #94a3b8);">Nenhuma fala registrada na chamada ainda.</span>';
      } else {
        this.manager.segments.forEach(seg => {
          const item = document.createElement('div');
          item.style.cssText = 'font-size: 12.5px; line-height: 1.4; color: #e2e8f0;';
          item.innerHTML = `<strong style="color: #38bdf8;">${escapeHtml(seg.speakerName)}:</strong> ${escapeHtml(seg.text)}`;
          listEl.appendChild(item);
        });

        if (this.manager.activePartial) {
          const partial = document.createElement('div');
          partial.style.cssText = 'font-size: 12.5px; line-height: 1.4; color: #94a3b8; font-style: italic;';
          partial.innerHTML = `<strong style="color: #0284c7;">${escapeHtml(this.manager.activePartial.speakerName)}:</strong> ${escapeHtml(this.manager.activePartial.text)}...`;
          listEl.appendChild(partial);
        }

        listEl.scrollTop = listEl.scrollHeight;
      }
    }

    this._updateOverlay();
  }

  _updateOverlay() {
    if (typeof document === 'undefined') return;
    if (!this.isOverlayActive) {
      if (this.overlayEl?.parentElement) {
        this.overlayEl.parentElement.removeChild(this.overlayEl);
      }
      this.overlayEl = null;
      return;
    }

    if (!this.overlayEl) {
      this.overlayEl = document.createElement('div');
      this.overlayEl.id = 'room-captions-overlay';
      this.overlayEl.style.cssText = 'position: fixed; bottom: 85px; left: 50%; transform: translateX(-50%); max-width: 80%; background: rgba(0,0,0,0.75); color: #fff; padding: 10px 18px; border-radius: 12px; font-size: 15px; font-weight: 500; text-align: center; pointer-events: none; z-index: 999; backdrop-filter: blur(8px);';
      document.body.appendChild(this.overlayEl);
    }

    const latest = this.manager.activePartial || this.manager.segments[this.manager.segments.length - 1];
    if (latest) {
      this.overlayEl.textContent = `${latest.speakerName}: ${latest.text}`;
      this.overlayEl.style.display = 'block';
    } else {
      this.overlayEl.style.display = 'none';
    }
  }

  open() {
    this.mount();
    if (this.modalEl) {
      this.modalEl.style.display = 'flex';
      this.render();
    }
  }

  close() {
    if (this.modalEl) {
      this.modalEl.style.display = 'none';
    }
  }

  destroy() {
    if (this.unsubChange) this.unsubChange();
    if (this.overlayEl?.parentElement) {
      this.overlayEl.parentElement.removeChild(this.overlayEl);
    }
    this.overlayEl = null;
    if (this.modalEl?.parentElement) {
      this.modalEl.parentElement.removeChild(this.modalEl);
    }
    this.modalEl = null;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
