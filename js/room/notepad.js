/**
 * SeeMyGame - NotepadManager
 * 
 * Bloco de notas colaborativo em tempo real via WebRTC DataChannel.
 * Modelo Host-Authoritative com versionamento sequencial, debounce e exportação.
 */

export class NotepadManager {
  constructor(options = {}) {
    this.text = options.initialText || '';
    this.version = 0;
    this.lastAuthor = '';
    this.lastModified = null;
    this._isHost = false;
    this._isHostResolver = null;
    if (typeof options.isHost === 'function') {
      this._isHostResolver = options.isHost;
    } else {
      this._isHost = Boolean(options.isHost);
    }
    this.broadcast = options.broadcast || null;
    this.getLocalPeerId = options.getLocalPeerId || (() => 'me');
    this.getDisplayName = options.getDisplayName || (() => 'Jogador');
    this.getCoordinatorPeerId = options.getCoordinatorPeerId || (() => null);
    this.syncedCoordinatorPeerId = null;

    this.debounceMs = options.debounceMs || 300;
    this.debounceTimer = null;
    this.listeners = new Set();
    this.modalEl = null;
    this.textareaEl = null;
    this.statusEl = null;
  }

  setBroadcast(broadcast) {
    this.broadcast = broadcast;
  }

  setIsHost(isHost) {
    if (typeof isHost === 'function') {
      this._isHostResolver = isHost;
    } else {
      this._isHostResolver = null;
      this._isHost = Boolean(isHost);
    }
  }

  get isHost() {
    if (typeof this._isHostResolver === 'function') {
      try {
        return Boolean(this._isHostResolver());
      } catch (_) {
        return false;
      }
    }
    return Boolean(this._isHost);
  }

  set isHost(val) {
    if (typeof val === 'function') {
      this._isHostResolver = val;
    } else {
      this._isHostResolver = null;
      this._isHost = Boolean(val);
    }
  }

  getText() {
    return this.text;
  }

  setText(newText, authorName = null, { emit = true } = {}) {
    this.text = String(newText ?? '');
    this.lastAuthor = authorName || this.getDisplayName();
    this.lastModified = Date.now();

    if (this.isHost) {
      this.version++;
    }

    this._notifyChange();

    if (emit && this.broadcast) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (this.isHost) {
          this.broadcast({
            type: 'NOTE_SYNC',
            text: this.text,
            version: this.version,
            lastAuthor: this.lastAuthor,
            lastModified: this.lastModified
          });
        } else {
          this.broadcast({
            type: 'NOTE_UPDATE',
            text: this.text,
            authorName: this.lastAuthor
          });
        }
      }, this.debounceMs);
    }
  }

  clear(authorName = null) {
    this.setText('', authorName || this.getDisplayName(), { emit: true });
  }

  async copyToClipboard() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(this.text);
        return true;
      } catch (_) {}
    }
    return false;
  }

  exportFile(format = 'txt') {
    if (typeof document === 'undefined') return;
    const ext = format === 'md' ? 'md' : 'txt';
    const mime = format === 'md' ? 'text/markdown' : 'text/plain';
    const blob = new Blob([this.text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `seemygame-notas-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  requestSync() {
    if (this.broadcast) {
      this.broadcast({ type: 'NOTE_REQUEST_SYNC' });
    }
  }

  handleRemoteMessage(data, senderPeerId = null) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'NOTE_UPDATE') {
      if (!this.isHost) return;
      const incomingText = String(data.text ?? '');
      const author = String(data.authorName || 'Amigo').slice(0, 32);

      if (this.isHost) {
        this.text = incomingText;
        this.version++;
        this.lastAuthor = author;
        this.lastModified = Date.now();
        this._notifyChange();

        // Host retransmite o snapshot oficial para todos os membros
        if (this.broadcast) {
          this.broadcast({
            type: 'NOTE_SYNC',
            text: this.text,
            version: this.version,
            lastAuthor: this.lastAuthor,
            lastModified: this.lastModified
          });
        }
      }
    } else if (data.type === 'NOTE_REQUEST_SYNC') {
      if (this.isHost && this.broadcast) {
        this.broadcast({
          type: 'NOTE_SYNC',
          text: this.text,
          version: this.version,
          lastAuthor: this.lastAuthor,
          lastModified: this.lastModified
        });
      }
    } else if (data.type === 'NOTE_SYNC') {
      const coordinator = this.getCoordinatorPeerId();
      if (this.isHost || !coordinator || senderPeerId !== coordinator) return;
      if (!Number.isSafeInteger(data.version) || data.version < 0) return;
      if (this.syncedCoordinatorPeerId !== coordinator) {
        this.version = 0;
        this.syncedCoordinatorPeerId = coordinator;
      }
      if (data.version >= this.version || !this.version) {
        this.text = String(data.text ?? '');
        this.version = Number(data.version) || this.version;
        this.lastAuthor = String(data.lastAuthor || 'Host').slice(0, 32);
        this.lastModified = Number(data.lastModified) || Date.now();
        this._notifyChange();
      }
    }
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notifyChange() {
    if (this.textareaEl && this.textareaEl.value !== this.text) {
      const start = this.textareaEl.selectionStart;
      const end = this.textareaEl.selectionEnd;
      this.textareaEl.value = this.text;
      try { this.textareaEl.setSelectionRange(start, end); } catch (_) {}
    }
    this._updateStatusUI();
    this.listeners.forEach((fn) => {
      try { fn(this.text, { author: this.lastAuthor, version: this.version }); } catch (_) {}
    });
  }

  _updateStatusUI() {
    if (this.statusEl) {
      const charCount = this.text.length;
      const authorInfo = this.lastAuthor ? ` • Última edição: ${this.lastAuthor}` : '';
      this.statusEl.textContent = `${charCount} caracteres${authorInfo}`;
    }
  }

  mountModal() {
    if (typeof document === 'undefined') return null;
    let modal = document.getElementById('notepad-modal');
    if (modal) {
      this.modalEl = modal;
      this.textareaEl = modal.querySelector('#notepad-textarea');
      this.statusEl = modal.querySelector('#notepad-status-info');
      this._bindModalEvents();
      return modal;
    }

    modal = document.createElement('div');
    modal.id = 'notepad-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'notepad-modal-title');

    modal.innerHTML = `
      <div class="modal-content notepad-modal-content" style="max-width: 600px; width: 92%; display: flex; flex-direction: column; gap: 12px; background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 18px; box-shadow: var(--shadow-panel);">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 1.2rem;">📝</span>
            <h3 id="notepad-modal-title" style="margin: 0; font-size: 1.1rem; color: var(--text-main);">Bloco de Notas da Sala</h3>
            <span style="font-size: 11px; background: rgba(16, 185, 129, 0.2); color: #6ee7b7; padding: 2px 8px; border-radius: 10px; font-weight: 600;">Sincronizado P2P</span>
          </div>
          <button type="button" id="notepad-close-btn" class="drawer-close-btn" aria-label="Fechar modal" style="background: none; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer;">✕</button>
        </div>

        <textarea id="notepad-textarea" placeholder="Digite aqui códigos de partida, senhas de servidor, estratégias ou avisos da call..." style="width: 100%; min-height: 220px; max-height: 50vh; resize: vertical; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); color: var(--text-main); padding: 12px; font-family: monospace; font-size: 13px; line-height: 1.5; outline: none;"></textarea>

        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--text-muted);">
          <span id="notepad-status-info">0 caracteres</span>
          <div style="display: flex; gap: 8px;">
            <button type="button" id="notepad-copy-btn" class="btn-secondary" style="padding: 5px 10px; font-size: 12px;">📋 Copiar Tudo</button>
            <button type="button" id="notepad-export-btn" class="btn-secondary" style="padding: 5px 10px; font-size: 12px;">💾 Exportar (.txt)</button>
            <button type="button" id="notepad-clear-btn" class="btn-secondary" style="padding: 5px 10px; font-size: 12px; color: #f87171;">🗑️ Limpar</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modalEl = modal;
    this.textareaEl = modal.querySelector('#notepad-textarea');
    this.statusEl = modal.querySelector('#notepad-status-info');
    this._bindModalEvents();

    return modal;
  }

  _bindModalEvents() {
    if (!this.modalEl) return;

    this.modalEl.querySelector('#notepad-close-btn')?.addEventListener('click', () => {
      this.closeModal();
    });

    if (this.textareaEl) {
      this.textareaEl.value = this.text;
      this.textareaEl.addEventListener('input', () => {
        this.setText(this.textareaEl.value, this.getDisplayName(), { emit: true });
      });
    }

    this.modalEl.querySelector('#notepad-copy-btn')?.addEventListener('click', async () => {
      const ok = await this.copyToClipboard();
      const btn = this.modalEl.querySelector('#notepad-copy-btn');
      if (btn) {
        btn.textContent = ok ? '✅ Copiado!' : '❌ Erro ao copiar';
        setTimeout(() => { btn.textContent = '📋 Copiar Tudo'; }, 1500);
      }
    });

    this.modalEl.querySelector('#notepad-export-btn')?.addEventListener('click', () => {
      this.exportFile('txt');
    });

    this.modalEl.querySelector('#notepad-clear-btn')?.addEventListener('click', () => {
      if (typeof window !== 'undefined' && window.confirm && window.confirm('Deseja realmente limpar as anotações da sala?')) {
        this.clear();
      }
    });

    this._updateStatusUI();
  }

  openModal() {
    this.mountModal();
    if (this.modalEl) {
      this.modalEl.style.display = 'flex';
      if (this.textareaEl) {
        this.textareaEl.value = this.text;
        this.textareaEl.focus();
      }
      this._updateStatusUI();
    }
    if (!this.isHost) {
      this.requestSync();
    }
  }

  closeModal() {
    if (this.modalEl) {
      this.modalEl.style.display = 'none';
    }
  }

  dispose() {
    this.getCoordinatorPeerId = () => null;
    this.syncedCoordinatorPeerId = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.listeners.clear();
    if (this.modalEl && this.modalEl.parentElement) {
      this.modalEl.parentElement.removeChild(this.modalEl);
      this.modalEl = null;
    }
  }
}

export const notepadManager = new NotepadManager();
