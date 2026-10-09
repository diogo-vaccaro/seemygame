/**
 * SeeMyGame - TasksManager (Checklist Colaborativo)
 * 
 * Gerenciador de objetivos, etapas de configuração e tarefas de co-op:
 * - Operações atômicas de criação, edição por campo, alternância de conclusão, exclusão e reordenação
 * - Tombstones limitadas para evitar ressurreição de tarefas por operações atrasadas
 * - Limite rigoroso de até 100 tarefas, títulos até 160 chars e descrições até 2 KiB
 * - Filtros puramente locais por responsável e status sem mutação do estado compartilhado
 * - Suporte a participante atribuído desconectado marcado como "(Indisponível)"
 */

export const MAX_ROOM_TASKS = 100;
export const MAX_TASK_TITLE_CHARS = 160;
export const MAX_TASK_DESC_CHARS = 2048;
export const MAX_TOMBSTONES = 200;

export class TasksManager {
  constructor(options = {}) {
    this.service = options.service || null;
    this.getLocalPeerId = options.getLocalPeerId || (() => 'me');
    this.getDisplayName = options.getDisplayName || (() => 'Jogador');
    this.isHost = typeof options.isHost === 'function' ? options.isHost : () => Boolean(options.isHost);
    this.getIsReadonly = typeof options.getIsReadonly === 'function'
      ? options.getIsReadonly
      : () => Boolean(options.isReadonly);
    this.getActivePeers = options.getActivePeers || (() => []);

    this.tasks = new Map(); // id -> task
    this.tombstones = new Map(); // id -> deletedAt
    this.localFilter = {
      assignee: 'all', // 'all' | 'me' | peerId
      status: 'all' // 'all' | 'pending' | 'completed'
    };
    this.listeners = new Set();

    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  setService(service) {
    this.service = service;
    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  _bindWithService(service) {
    service.registerFeature('tasks', {
      applyProposal: (payload, meta) => this._applyProposalOnHost(payload, meta),
      applyConfirm: (payload, meta) => this._applyConfirmOnClient(payload, meta),
      getSnapshot: () => this.getSnapshot(),
      applySnapshot: (snapshot) => this.applySnapshot(snapshot)
    });
  }

  _recordTombstone(id) {
    this.tombstones.set(id, Date.now());
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldestKey = this.tombstones.keys().next().value;
      if (oldestKey) this.tombstones.delete(oldestKey);
    }
  }

  _applyProposalOnHost(payload, { authorPeerId, entityId }) {
    const { action } = payload;
    const now = Date.now();

    switch (action) {
      case 'create': {
        if (this.tasks.size >= MAX_ROOM_TASKS) {
          return { success: false, reason: 'task_limit_exceeded' };
        }

        const title = String(payload.title || '').trim().slice(0, MAX_TASK_TITLE_CHARS);
        if (!title) return { success: false, reason: 'empty_title' };

        const description = String(payload.description || '').slice(0, MAX_TASK_DESC_CHARS);
        const priority = ['low', 'normal', 'high'].includes(payload.priority) ? payload.priority : 'normal';
        const assigneePeerId = payload.assigneePeerId ? String(payload.assigneePeerId) : null;

        const id = entityId || `task_${now}_${Math.random().toString(36).slice(2, 7)}`;
        const order = this.tasks.size;

        const task = {
          id,
          title,
          description,
          assigneePeerId,
          priority,
          completed: false,
          order,
          createdBy: authorPeerId,
          revision: 1,
          updatedAt: now
        };

        this.tasks.set(id, task);
        return { success: true, payload: { action: 'create', task } };
      }

      case 'set_field': {
        if (this.tombstones.has(entityId)) {
          return { success: false, reason: 'task_deleted' };
        }
        const task = this.tasks.get(entityId);
        if (!task) return { success: false, reason: 'task_not_found' };

        const { field, value, baseRevision } = payload;
        // Detecção de conflito em edição do mesmo campo sobre revisão obsoleta
        if (baseRevision !== undefined && baseRevision < task.revision) {
          return { success: false, reason: 'stale_revision', currentRevision: task.revision };
        }

        let changed = false;
        if (field === 'title') {
          const t = String(value || '').trim().slice(0, MAX_TASK_TITLE_CHARS);
          if (t && t !== task.title) {
            task.title = t;
            changed = true;
          }
        } else if (field === 'description') {
          const d = String(value || '').slice(0, MAX_TASK_DESC_CHARS);
          if (d !== task.description) {
            task.description = d;
            changed = true;
          }
        } else if (field === 'assigneePeerId') {
          const a = value ? String(value) : null;
          if (a !== task.assigneePeerId) {
            task.assigneePeerId = a;
            changed = true;
          }
        } else if (field === 'priority') {
          const p = ['low', 'normal', 'high'].includes(value) ? value : 'normal';
          if (p !== task.priority) {
            task.priority = p;
            changed = true;
          }
        }

        if (changed) {
          task.revision++;
          task.updatedAt = now;
        }

        return { success: true, payload: { action: 'update', task: { ...task } } };
      }

      case 'complete': {
        if (this.tombstones.has(entityId)) {
          return { success: false, reason: 'task_deleted' };
        }
        const task = this.tasks.get(entityId);
        if (!task) return { success: false, reason: 'task_not_found' };

        const completed = Boolean(payload.completed);
        if (task.completed !== completed) {
          task.completed = completed;
          task.revision++;
          task.updatedAt = now;
        }

        return { success: true, payload: { action: 'update', task: { ...task } } };
      }

      case 'delete': {
        this._recordTombstone(entityId);
        this.tasks.delete(entityId);
        return { success: true, payload: { action: 'delete', id: entityId } };
      }

      case 'reorder': {
        const orderList = Array.isArray(payload.orderList) ? payload.orderList : [];
        orderList.forEach((id, index) => {
          const t = this.tasks.get(id);
          if (t) {
            t.order = index;
            t.updatedAt = now;
          }
        });
        return { success: true, payload: { action: 'reorder', orderList } };
      }

      default:
        return { success: false, reason: 'unknown_action' };
    }
  }

  _applyConfirmOnClient(payload) {
    if (!payload || !payload.action) return;
    const { action } = payload;

    switch (action) {
      case 'create':
      case 'update': {
        if (payload.task) {
          // Se recebemos atualização de tarefa já excluída via tombstone local, ignora
          if (this.tombstones.has(payload.task.id)) return;
          this.tasks.set(payload.task.id, payload.task);
        }
        break;
      }
      case 'delete': {
        this._recordTombstone(payload.id);
        this.tasks.delete(payload.id);
        break;
      }
      case 'reorder': {
        if (Array.isArray(payload.orderList)) {
          payload.orderList.forEach((id, index) => {
            const t = this.tasks.get(id);
            if (t) t.order = index;
          });
        }
        break;
      }
    }

    this._notify();
  }

  getSnapshot() {
    return {
      tasks: Array.from(this.tasks.values()),
      tombstones: Array.from(this.tombstones.entries())
    };
  }

  applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (Array.isArray(snapshot.tombstones)) {
      this.tombstones.clear();
      for (const [id, time] of snapshot.tombstones) {
        this.tombstones.set(id, time);
      }
    }
    if (Array.isArray(snapshot.tasks)) {
      this.tasks.clear();
      for (const task of snapshot.tasks) {
        if (task && task.id && !this.tombstones.has(task.id)) {
          this.tasks.set(task.id, { ...task });
        }
      }
    }
    this._notify();
  }

  async createTask({ title, description = '', assigneePeerId = null, priority = 'normal' }) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = {
      action: 'create',
      title,
      description,
      assigneePeerId,
      priority
    };

    if (this.service) {
      return this.service.propose('tasks', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async setTaskField(id, field, value) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const task = this.tasks.get(id);
    const baseRevision = task ? task.revision : 0;

    const payload = {
      action: 'set_field',
      field,
      value,
      baseRevision
    };

    if (this.service) {
      return this.service.propose('tasks', { entityId: id, baseRevision, payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId(), entityId: id });
  }

  async toggleComplete(id, completed = null) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const task = this.tasks.get(id);
    if (!task) return { success: false, reason: 'task_not_found' };

    const nextState = completed !== null ? Boolean(completed) : !task.completed;
    const payload = { action: 'complete', completed: nextState };

    if (this.service) {
      return this.service.propose('tasks', { entityId: id, payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId(), entityId: id });
  }

  async deleteTask(id) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const payload = { action: 'delete' };

    if (this.service) {
      return this.service.propose('tasks', { entityId: id, payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId(), entityId: id });
  }

  async reorderTasks(orderList) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const payload = { action: 'reorder', orderList };

    if (this.service) {
      return this.service.propose('tasks', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  setFilter(filterOptions = {}) {
    if (filterOptions.assignee !== undefined) {
      this.localFilter.assignee = filterOptions.assignee;
    }
    if (filterOptions.status !== undefined) {
      this.localFilter.status = filterOptions.status;
    }
    this._notify();
  }

  getTasksList({ applyFilter = true } = {}) {
    const list = Array.from(this.tasks.values()).sort((a, b) => a.order - b.order || a.updatedAt - b.updatedAt);
    if (!applyFilter) return list;

    const myPeerId = this.getLocalPeerId();
    return list.filter(task => {
      // Filtro de status
      if (this.localFilter.status === 'pending' && task.completed) return false;
      if (this.localFilter.status === 'completed' && !task.completed) return false;

      // Filtro de responsável
      if (this.localFilter.assignee === 'me') {
        if (task.assigneePeerId !== myPeerId) return false;
      } else if (this.localFilter.assignee !== 'all') {
        if (task.assigneePeerId !== this.localFilter.assignee) return false;
      }

      return true;
    });
  }

  isAssigneeActive(assigneePeerId) {
    if (!assigneePeerId) return true;
    const activePeers = this.getActivePeers();
    if (!Array.isArray(activePeers) || !activePeers.length) return true;
    return activePeers.includes(assigneePeerId) || assigneePeerId === this.getLocalPeerId();
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notify() {
    const tasks = this.getTasksList();
    this.listeners.forEach(fn => {
      try { fn(tasks); } catch (_) {}
    });
  }

  dispose() {
    this.tasks.clear();
    this.tombstones.clear();
    this.listeners.clear();
  }
}
