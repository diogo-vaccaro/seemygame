/**
 * SeeMyGame - TasksModalUI
 * Modal acessível para gerenciamento colaborativo de tarefas e checklist.
 */

export class TasksModalUI {
  constructor(manager) {
    this.manager = manager;
    this.modalEl = null;
    this.unsubChange = null;
  }

  mount() {
    if (typeof document === 'undefined') return null;
    let modal = document.getElementById('tasks-modal');
    if (modal) {
      this.modalEl = modal;
      this._bindEvents();
      return modal;
    }

    modal = document.createElement('div');
    modal.id = 'tasks-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'tasks-modal-title');

    modal.innerHTML = `
      <div class="modal-content tasks-modal-content" style="max-width: 680px; width: 94%; display: flex; flex-direction: column; gap: 14px; background: var(--bg-card, #12151f); border-radius: 14px; border: 1px solid var(--border-color, rgba(255,255,255,0.12)); padding: 20px; box-shadow: var(--shadow-panel, 0 16px 40px rgba(0,0,0,0.6)); max-height: 80vh;">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.3rem;">✅</span>
            <h3 id="tasks-modal-title" style="margin: 0; font-size: 1.15rem; color: var(--text-main, #fff);">Checklist da Sala</h3>
            <span id="tasks-count-badge" class="badge-status-p2p" style="font-size: 11px; background: rgba(16, 185, 129, 0.18); color: #34d399; padding: 2px 8px; border-radius: 10px; font-weight: 600;">0 concluídas</span>
          </div>
          <button type="button" id="tasks-close-btn" class="drawer-close-btn" aria-label="Fechar" style="background: none; border: none; color: var(--text-muted, #94a3b8); font-size: 18px; cursor: pointer;">✕</button>
        </div>

        <!-- Filtros locais -->
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn-filter" data-status="all" style="padding: 4px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.08); color: #fff;">Todas</button>
            <button type="button" class="btn-filter" data-status="pending" style="padding: 4px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: var(--text-muted, #94a3b8);">Pendentes</button>
            <button type="button" class="btn-filter" data-status="completed" style="padding: 4px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: var(--text-muted, #94a3b8);">Concluídas</button>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <label for="tasks-filter-assignee" style="font-size: 11px; color: var(--text-muted, #94a3b8);">Responsável:</label>
            <select id="tasks-filter-assignee" style="padding: 3px 8px; font-size: 11px; border-radius: 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff;">
              <option value="all">Todos</option>
              <option value="me">Minhas tarefas</option>
            </select>
          </div>
        </div>

        <!-- Formulário rápido para adicionar tarefa -->
        <form id="task-add-form" style="display: flex; gap: 8px; align-items: center;">
          <input type="text" id="task-input-title" placeholder="Nova tarefa da sala (ex: configurar bind, escolher mapa)..." maxlength="160" required style="flex: 1; padding: 7px 12px; font-size: 12.5px; border-radius: 6px; background: rgba(0,0,0,0.35); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); color: #fff;" />
          <select id="task-select-priority" style="padding: 7px 10px; font-size: 12px; border-radius: 6px; background: rgba(0,0,0,0.35); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); color: #fff;">
            <option value="normal">Normal</option>
            <option value="high">Alta</option>
            <option value="low">Baixa</option>
          </select>
          <button type="submit" class="btn-primary" style="padding: 7px 14px; font-size: 12.5px; border-radius: 6px; cursor: pointer;">Adicionar</button>
        </form>

        <!-- Lista de Tarefas -->
        <div id="tasks-list-container" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 200px;" role="list" aria-label="Lista de Tarefas"></div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modalEl = modal;
    this._bindEvents();
    return modal;
  }

  _bindEvents() {
    if (!this.modalEl) return;

    this.modalEl.querySelector('#tasks-close-btn')?.addEventListener('click', () => this.close());

    this.modalEl.querySelector('#task-add-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = this.modalEl.querySelector('#task-input-title');
      const prioritySelect = this.modalEl.querySelector('#task-select-priority');
      const title = input?.value?.trim();
      const priority = prioritySelect?.value || 'normal';

      if (title) {
        await this.manager.createTask({ title, priority });
        if (input) input.value = '';
      }
    });

    this.modalEl.querySelectorAll('.btn-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        this.modalEl.querySelectorAll('.btn-filter').forEach(b => {
          b.style.background = 'transparent';
          b.style.color = '#94a3b8';
        });
        btn.style.background = 'rgba(255,255,255,0.08)';
        btn.style.color = '#fff';
        this.manager.setFilter({ status: btn.dataset.status });
      });
    });

    this.modalEl.querySelector('#tasks-filter-assignee')?.addEventListener('change', (e) => {
      this.manager.setFilter({ assignee: e.target.value });
    });

    this.unsubChange = this.manager.onChange(() => this.render());
  }

  render() {
    if (!this.modalEl) return;
    const tasks = this.manager.getTasksList({ applyFilter: true });
    const allTasks = this.manager.getTasksList({ applyFilter: false });
    const completedCount = allTasks.filter(t => t.completed).length;

    const countBadge = this.modalEl.querySelector('#tasks-count-badge');
    if (countBadge) {
      countBadge.textContent = `${completedCount}/${allTasks.length} concluídas`;
    }

    const listEl = this.modalEl.querySelector('#tasks-list-container');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (!tasks.length) {
      listEl.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 160px; color: var(--text-muted, #94a3b8); font-size: 13px;">
          Nenhuma tarefa encontrada neste filtro.
        </div>
      `;
      return;
    }

    const priorityColors = {
      high: '#f87171',
      normal: '#60a5fa',
      low: '#94a3b8'
    };

    tasks.forEach(task => {
      const item = document.createElement('div');
      item.className = `task-card-item ${task.completed ? 'completed' : ''}`;
      item.style.cssText = `display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; opacity: ${task.completed ? '0.6' : '1'};`;

      const isAssigneeActive = this.manager.isAssigneeActive(task.assigneePeerId);
      const assigneeLabel = task.assigneePeerId
        ? (isAssigneeActive ? `👤 ${task.assigneePeerId.slice(-4)}` : `👤 ${task.assigneePeerId.slice(-4)} (Indisponível)`)
        : '';

      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
          <input type="checkbox" class="task-checkbox" data-id="${task.id}" ${task.completed ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;" />
          <span style="font-size: 13px; color: var(--text-main, #fff); text-decoration: ${task.completed ? 'line-through' : 'none'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${escapeHtml(task.title)}
          </span>
          <span style="font-size: 10px; color: ${priorityColors[task.priority] || '#94a3b8'}; border: 1px solid ${priorityColors[task.priority] || '#94a3b8'}40; padding: 1px 6px; border-radius: 8px; text-transform: uppercase;">
            ${task.priority}
          </span>
          ${assigneeLabel ? `<span style="font-size: 10.5px; color: ${isAssigneeActive ? '#38bdf8' : '#f87171'};">${assigneeLabel}</span>` : ''}
        </div>
        <button type="button" class="btn-delete-task" data-id="${task.id}" style="background: none; border: none; color: #f87171; font-size: 14px; cursor: pointer; padding: 2px 6px;">🗑️</button>
      `;

      item.querySelector('.task-checkbox')?.addEventListener('change', (e) => {
        this.manager.toggleComplete(task.id, e.target.checked);
      });

      item.querySelector('.btn-delete-task')?.addEventListener('click', () => {
        this.manager.deleteTask(task.id);
      });

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
