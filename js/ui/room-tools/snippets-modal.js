/**
 * SeeMyGame - SnippetsModal UI
 * Modal acessível para visualização, edição, cópia e exportação de Snippets de código.
 */

import { ALLOWED_LANGUAGES } from '../../room/tools/snippets.js';

export class SnippetsModalUI {
  constructor(manager) {
    this.manager = manager;
    this.modalEl = null;
    this.selectedSnippetId = null;
    this.isEditing = false;
    this.unsubChange = null;
  }

  mount() {
    if (typeof document === 'undefined') return null;
    let modal = document.getElementById('snippets-modal');
    if (modal) {
      this.modalEl = modal;
      this._bindEvents();
      return modal;
    }

    modal = document.createElement('div');
    modal.id = 'snippets-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'snippets-modal-title');

    modal.innerHTML = `
      <div class="modal-content snippets-modal-content" style="max-width: 720px; width: 94%; display: flex; flex-direction: column; gap: 14px; background: var(--bg-card, #12151f); border-radius: 14px; border: 1px solid var(--border-color, rgba(255,255,255,0.12)); padding: 20px; box-shadow: var(--shadow-panel, 0 16px 40px rgba(0,0,0,0.6));">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.3rem;">📋</span>
            <h3 id="snippets-modal-title" style="margin: 0; font-size: 1.15rem; color: var(--text-main, #fff);">Snippets de Código & Binds</h3>
            <span class="badge-status-p2p" style="font-size: 11px; background: rgba(56, 189, 248, 0.18); color: #38bdf8; padding: 2px 8px; border-radius: 10px; font-weight: 600;">P2P Sincronizado</span>
          </div>
          <button type="button" id="snippets-close-btn" class="drawer-close-btn" aria-label="Fechar" style="background: none; border: none; color: var(--text-muted, #94a3b8); font-size: 18px; cursor: pointer;">✕</button>
        </div>

        <div id="snippets-offline-warning" style="display: none; padding: 8px 12px; border-radius: 8px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; font-size: 12px;">
          ⚠️ Coordenador da sala desconectado. Edições temporariamente pausadas.
        </div>

        <div style="display: flex; gap: 14px; min-height: 280px; max-height: 55vh;">
          <!-- Barra lateral de lista de snippets -->
          <div style="width: 220px; display: flex; flex-direction: column; gap: 8px; border-right: 1px solid rgba(255,255,255,0.08); padding-right: 12px;">
            <button type="button" id="snippet-new-btn" class="btn-primary" style="padding: 6px 12px; font-size: 12.5px; border-radius: 6px; cursor: pointer;">+ Novo Snippet</button>
            <div id="snippets-list-container" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;" role="listbox" aria-label="Lista de Snippets"></div>
          </div>

          <!-- Área de visualização/edição -->
          <div style="flex: 1; display: flex; flex-direction: column; gap: 10px;">
            <div id="snippet-view-container" style="display: flex; flex-direction: column; gap: 10px; height: 100%;">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <div>
                  <h4 id="snippet-active-title" style="margin: 0; font-size: 1.05rem; color: var(--text-main, #fff);">Nenhum selecionado</h4>
                  <span id="snippet-active-lang" style="font-size: 11px; color: var(--text-muted, #94a3b8); text-transform: uppercase;"></span>
                </div>
                <div style="display: flex; gap: 6px;">
                  <button type="button" id="snippet-edit-btn" class="btn-secondary" style="padding: 4px 8px; font-size: 12px;">✏️ Editar</button>
                  <button type="button" id="snippet-copy-btn" class="btn-secondary" style="padding: 4px 8px; font-size: 12px;">📋 Copiar</button>
                  <button type="button" id="snippet-export-btn" class="btn-secondary" style="padding: 4px 8px; font-size: 12px;">💾 Baixar</button>
                  <button type="button" id="snippet-dup-btn" class="btn-secondary" style="padding: 4px 8px; font-size: 12px;">📑 Duplicar</button>
                  <button type="button" id="snippet-delete-btn" class="btn-secondary" style="padding: 4px 8px; font-size: 12px; color: #f87171;">🗑️ Excluir</button>
                </div>
              </div>

              <!-- Pré-visualização segura em texto plano / código (sem script execution) -->
              <pre id="snippet-code-display" tabindex="0" style="flex: 1; margin: 0; padding: 12px; border-radius: 8px; background: rgba(0,0,0,0.35); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); color: #e2e8f0; font-family: monospace; font-size: 12.5px; line-height: 1.5; overflow: auto; white-space: pre-wrap; word-break: break-all;"></pre>
            </div>

            <div id="snippet-edit-container" style="display: none; flex-direction: column; gap: 10px; height: 100%;">
              <div style="display: flex; gap: 8px;">
                <input type="text" id="snippet-input-title" placeholder="Título do Snippet" maxlength="100" style="flex: 1; padding: 6px 10px; background: rgba(0,0,0,0.3); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 6px; color: var(--text-main, #fff); font-size: 13px;" />
                <select id="snippet-select-lang" style="padding: 6px 10px; background: rgba(0,0,0,0.3); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 6px; color: var(--text-main, #fff); font-size: 12px;">
                  ${ALLOWED_LANGUAGES.map(l => `<option value="${l}">${l}</option>`).join('')}
                </select>
              </div>

              <textarea id="snippet-input-content" placeholder="Insira o bind, script ou configuração..." style="flex: 1; min-height: 160px; padding: 10px; background: rgba(0,0,0,0.35); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 8px; color: #e2e8f0; font-family: monospace; font-size: 12.5px; line-height: 1.5; resize: none;"></textarea>

              <div style="display: flex; justify-content: flex-end; gap: 8px;">
                <button type="button" id="snippet-cancel-edit-btn" class="btn-secondary" style="padding: 6px 12px; font-size: 12px;">Cancelar</button>
                <button type="button" id="snippet-save-btn" class="btn-primary" style="padding: 6px 14px; font-size: 12px;">Salvar Snippet</button>
              </div>
            </div>
          </div>
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

    this.modalEl.querySelector('#snippets-close-btn')?.addEventListener('click', () => this.close());

    this.modalEl.querySelector('#snippet-new-btn')?.addEventListener('click', () => {
      this.isEditing = true;
      this.selectedSnippetId = null;
      this._showEditForm('', 'plaintext', '');
    });

    this.modalEl.querySelector('#snippet-copy-btn')?.addEventListener('click', async () => {
      if (this.selectedSnippetId) {
        const ok = await this.manager.copyToClipboard(this.selectedSnippetId);
        const btn = this.modalEl.querySelector('#snippet-copy-btn');
        if (btn) {
          btn.textContent = ok ? '✅ Copiado!' : '❌ Erro';
          setTimeout(() => { btn.textContent = '📋 Copiar'; }, 1500);
        }
      }
    });

    this.modalEl.querySelector('#snippet-export-btn')?.addEventListener('click', () => {
      if (this.selectedSnippetId) {
        this.manager.exportFile(this.selectedSnippetId);
      }
    });

    this.modalEl.querySelector('#snippet-dup-btn')?.addEventListener('click', async () => {
      if (this.selectedSnippetId) {
        await this.manager.duplicateSnippet(this.selectedSnippetId);
      }
    });

    this.modalEl.querySelector('#snippet-delete-btn')?.addEventListener('click', async () => {
      if (this.selectedSnippetId) {
        await this.manager.deleteSnippet(this.selectedSnippetId);
        this.selectedSnippetId = null;
        this.render();
      }
    });

    this.modalEl.querySelector('#snippet-edit-btn')?.addEventListener('click', async () => {
      if (!this.selectedSnippetId) return;
      const res = await this.manager.requestEditLease(this.selectedSnippetId);
      if (res?.success) {
        const s = this.manager.getSnippet(this.selectedSnippetId);
        this.isEditing = true;
        this._showEditForm(s.title, s.language, s.content);
      } else {
        alert(res?.reason === 'already_leased' ? 'Outro participante está editando este snippet no momento.' : 'Não foi possível obter licença de edição.');
      }
    });

    this.modalEl.querySelector('#snippet-cancel-edit-btn')?.addEventListener('click', () => {
      if (this.selectedSnippetId) {
        this.manager.releaseEditLease(this.selectedSnippetId);
      }
      this.isEditing = false;
      this.render();
    });

    this.modalEl.querySelector('#snippet-save-btn')?.addEventListener('click', async () => {
      const title = this.modalEl.querySelector('#snippet-input-title')?.value;
      const language = this.modalEl.querySelector('#snippet-select-lang')?.value;
      const content = this.modalEl.querySelector('#snippet-input-content')?.value;

      if (this.selectedSnippetId) {
        await this.manager.updateSnippet(this.selectedSnippetId, { title, language, content, releaseLease: true });
      } else {
        const res = await this.manager.createSnippet({ title, language, content });
        if (res?.success && res.payload?.snippet) {
          this.selectedSnippetId = res.payload.snippet.id;
        }
      }
      this.isEditing = false;
      this.render();
    });

    this.unsubChange = this.manager.onChange(() => this.render());
  }

  _showEditForm(title, lang, content) {
    const viewContainer = this.modalEl.querySelector('#snippet-view-container');
    const editContainer = this.modalEl.querySelector('#snippet-edit-container');
    if (viewContainer) viewContainer.style.display = 'none';
    if (editContainer) {
      editContainer.style.display = 'flex';
      this.modalEl.querySelector('#snippet-input-title').value = title;
      this.modalEl.querySelector('#snippet-select-lang').value = lang;
      this.modalEl.querySelector('#snippet-input-content').value = content;
    }
  }

  render() {
    if (!this.modalEl) return;
    const list = this.manager.getSnippetsList();
    const listContainer = this.modalEl.querySelector('#snippets-list-container');
    const viewContainer = this.modalEl.querySelector('#snippet-view-container');
    const editContainer = this.modalEl.querySelector('#snippet-edit-container');

    if (this.isEditing) return;

    if (editContainer) editContainer.style.display = 'none';
    if (viewContainer) viewContainer.style.display = 'flex';

    if (listContainer) {
      listContainer.innerHTML = '';
      if (!list.length) {
        listContainer.innerHTML = '<span style="font-size: 11.5px; color: var(--text-muted, #94a3b8); padding: 8px 4px;">Nenhum snippet criado ainda.</span>';
      } else {
        list.forEach(snippet => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'snippet-list-item';
          const isSelected = snippet.id === this.selectedSnippetId;
          item.style.cssText = `text-align: left; padding: 8px 10px; border-radius: 6px; background: ${isSelected ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${isSelected ? '#38bdf8' : 'rgba(255,255,255,0.06)'}; color: var(--text-main, #fff); font-size: 12px; cursor: pointer; display: flex; flex-direction: column; gap: 2px;`;
          item.innerHTML = `
            <strong style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(snippet.title)}</strong>
            <span style="font-size: 10px; color: var(--text-muted, #94a3b8); text-transform: uppercase;">${escapeHtml(snippet.language)}</span>
          `;
          item.addEventListener('click', () => {
            this.selectedSnippetId = snippet.id;
            this.render();
          });
          listContainer.appendChild(item);
        });
      }
    }

    if (!this.selectedSnippetId && list.length > 0) {
      this.selectedSnippetId = list[0].id;
    }

    const current = this.selectedSnippetId ? this.manager.getSnippet(this.selectedSnippetId) : null;
    const titleEl = this.modalEl.querySelector('#snippet-active-title');
    const langEl = this.modalEl.querySelector('#snippet-active-lang');
    const codeEl = this.modalEl.querySelector('#snippet-code-display');

    if (current) {
      if (titleEl) titleEl.textContent = current.title;
      if (langEl) langEl.textContent = current.language;
      if (codeEl) codeEl.textContent = current.content;
    } else {
      if (titleEl) titleEl.textContent = 'Nenhum selecionado';
      if (langEl) langEl.textContent = '';
      if (codeEl) codeEl.textContent = '// Selecione ou crie um snippet na barra lateral.';
    }
  }

  open() {
    this.mount();
    if (this.modalEl) {
      this.modalEl.style.display = 'flex';
      this.isEditing = false;
      this.render();
    }
  }

  close() {
    if (this.modalEl) {
      this.modalEl.style.display = 'none';
      if (this.selectedSnippetId && this.isEditing) {
        this.manager.releaseEditLease(this.selectedSnippetId);
      }
      this.isEditing = false;
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
