/**
 * SeeMyGame - HandsModalUI
 * Modal acessível para fila de fala, levantamento de mãos e moderação.
 */

export class HandsModalUI {
  constructor(manager) {
    this.manager = manager;
    this.modalEl = null;
    this.unsubChange = null;
  }

  mount() {
    if (typeof document === 'undefined') return null;
    let modal = document.getElementById('hands-modal');
    if (modal) {
      this.modalEl = modal;
      this._bindEvents();
      return modal;
    }

    modal = document.createElement('div');
    modal.id = 'hands-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'hands-modal-title');

    modal.innerHTML = `
      <div class="modal-content hands-modal-content" style="max-width: 580px; width: 94%; display: flex; flex-direction: column; gap: 14px; background: var(--bg-card, #12151f); border-radius: 14px; border: 1px solid var(--border-color, rgba(255,255,255,0.12)); padding: 20px; box-shadow: var(--shadow-panel, 0 16px 40px rgba(0,0,0,0.6));">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.3rem;">✋</span>
            <h3 id="hands-modal-title" style="margin: 0; font-size: 1.15rem; color: var(--text-main, #fff);">Fila de Fala & Moderação</h3>
          </div>
          <button type="button" id="hands-close-btn" class="drawer-close-btn" aria-label="Fechar" style="background: none; border: none; color: var(--text-muted, #94a3b8); font-size: 18px; cursor: pointer;">✕</button>
        </div>

        <!-- Seção do Orador Atual -->
        <div id="hands-current-speaker-box" style="padding: 12px 16px; border-radius: 10px; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.25); display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.2rem;">🎙️</span>
            <div>
              <div style="font-size: 11px; color: #38bdf8; font-weight: 600; text-transform: uppercase;">Palavra Concedida</div>
              <strong id="hands-current-speaker-name" style="font-size: 13.5px; color: #fff;">Nenhum orador no momento</strong>
            </div>
          </div>
          <button type="button" id="hands-revoke-btn" class="btn-secondary" style="padding: 5px 10px; font-size: 11.5px; color: #f87171; display: none;">Revogar Palavra</button>
        </div>

        <!-- Controles de Ação do Usuário e Política do Host -->
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
          <button type="button" id="hands-toggle-btn" class="btn-primary" style="padding: 8px 16px; font-size: 13px; border-radius: 8px; cursor: pointer;">
            ✋ Levantar a Mão
          </button>

          <div id="hands-host-controls" style="display: flex; align-items: center; gap: 8px;">
            <button type="button" id="hands-next-btn" class="btn-secondary" style="padding: 6px 12px; font-size: 12px;">Passar p/ Próximo</button>
            <select id="hands-policy-select" style="padding: 5px 8px; font-size: 11.5px; border-radius: 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff;">
              <option value="open">Modo Aberto (Voz livre)</option>
              <option value="moderated">Modo Moderado (Somente orador)</option>
            </select>
          </div>
        </div>

        <!-- Lista da Fila de Espera -->
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div style="font-size: 12px; color: var(--text-muted, #94a3b8); font-weight: 600;">
            Fila de Espera (<span id="hands-queue-count">0</span>)
          </div>
          <div id="hands-queue-list" style="display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; min-height: 100px;" role="list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modalEl = modal;
    this._bindEvents();
    return modal;
  }

  _bindEvents() {
    if (!this.modalEl) return;

    this.modalEl.querySelector('#hands-close-btn')?.addEventListener('click', () => this.close());

    this.modalEl.querySelector('#hands-toggle-btn')?.addEventListener('click', async () => {
      const isRaised = this.manager.hasRequestedHand();
      if (isRaised) {
        await this.manager.cancelHand();
      } else {
        await this.manager.requestHand();
      }
    });

    this.modalEl.querySelector('#hands-next-btn')?.addEventListener('click', () => {
      this.manager.nextSpeaker();
    });

    this.modalEl.querySelector('#hands-revoke-btn')?.addEventListener('click', () => {
      this.manager.revokeSpeaker();
    });

    this.modalEl.querySelector('#hands-policy-select')?.addEventListener('change', (e) => {
      this.manager.setPolicy(e.target.value);
    });

    this.unsubChange = this.manager.onChange(() => this.render());
  }

  render() {
    if (!this.modalEl) return;
    const isHost = this.manager.isHost();
    const isRaised = this.manager.hasRequestedHand();
    const queue = this.manager.getQueue();
    const currentSpeakerId = this.manager.currentSpeakerPeerId;
    const currentSpeakerName = this.manager.currentSpeakerName;

    // Botão de levantar/baixar mão
    const toggleBtn = this.modalEl.querySelector('#hands-toggle-btn');
    if (toggleBtn) {
      if (isRaised) {
        toggleBtn.textContent = '👇 Baixar a Mão';
        toggleBtn.style.background = 'rgba(239, 68, 68, 0.2)';
        toggleBtn.style.color = '#fca5a5';
      } else {
        toggleBtn.textContent = '✋ Levantar a Mão';
        toggleBtn.style.background = '';
        toggleBtn.style.color = '';
      }
    }

    // Host controls
    const hostControls = this.modalEl.querySelector('#hands-host-controls');
    if (hostControls) {
      hostControls.style.display = isHost ? 'flex' : 'none';
      const policySelect = this.modalEl.querySelector('#hands-policy-select');
      if (policySelect) policySelect.value = this.manager.policy;
    }

    // Orador atual
    const speakerNameEl = this.modalEl.querySelector('#hands-current-speaker-name');
    const revokeBtn = this.modalEl.querySelector('#hands-revoke-btn');
    if (speakerNameEl) {
      speakerNameEl.textContent = currentSpeakerId ? (currentSpeakerName || `Peer ${currentSpeakerId.slice(-4)}`) : 'Nenhum orador no momento';
    }
    if (revokeBtn) {
      revokeBtn.style.display = (isHost && currentSpeakerId) ? 'block' : 'none';
    }

    // Fila
    const countEl = this.modalEl.querySelector('#hands-queue-count');
    if (countEl) countEl.textContent = String(queue.length);

    const listEl = this.modalEl.querySelector('#hands-queue-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (!queue.length) {
      listEl.innerHTML = '<span style="font-size: 12px; color: var(--text-muted, #94a3b8); padding: 12px 4px;">Nenhum participante na fila.</span>';
      return;
    }

    queue.forEach((entry, idx) => {
      const item = document.createElement('div');
      item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);';

      const isMe = entry.peerId === this.manager.getLocalPeerId();
      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-weight: 700; font-size: 12px; color: #38bdf8; width: 20px;">#${idx + 1}</span>
          <span style="font-size: 13px; color: #fff;">${escapeHtml(entry.displayName)} ${isMe ? '(Você)' : ''}</span>
        </div>
        ${isHost ? `<button type="button" class="btn-grant-speaker btn-primary" data-peer="${entry.peerId}" style="padding: 4px 8px; font-size: 11px; border-radius: 6px;">Conceder Voz</button>` : ''}
      `;

      if (isHost) {
        item.querySelector('.btn-grant-speaker')?.addEventListener('click', () => {
          this.manager.grantSpeaker(entry.peerId, entry.displayName);
        });
      }

      listEl.appendChild(item);
    });
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
