import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedToolsService } from '../js/room/tools/shared-tools-service.js';
import { TasksManager, MAX_ROOM_TASKS } from '../js/room/tools/tasks.js';

describe('TasksManager - Checklist Colaborativo', () => {
  let hostService;
  let tasks;

  beforeEach(() => {
    hostService = new SharedToolsService({
      isHost: () => true,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      roomEpoch: 'epoch-1'
    });

    tasks = new TasksManager({
      service: hostService,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      isHost: () => true,
      getIsReadonly: () => false,
      getActivePeers: () => ['host-peer', 'active-peer']
    });
  });

  afterEach(() => {
    tasks.dispose();
    hostService.dispose();
  });

  it('cria tarefa com prioridade normal e status pendente', async () => {
    const res = await tasks.createTask({
      title: 'Configurar áudio Discord',
      description: 'Ativar cancelamento de ruído Krisp',
      priority: 'high'
    });

    expect(res.success).toBe(true);
    const list = tasks.getTasksList();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Configurar áudio Discord');
    expect(list[0].completed).toBe(false);
    expect(list[0].priority).toBe('high');
  });

  it('altera campos individualmente mantendo idempotência e incrementando revisão', async () => {
    const res = await tasks.createTask({ title: 'Meta 1' });
    const taskId = res.payload.task.id;

    await tasks.setTaskField(taskId, 'title', 'Meta 1 Atualizada');
    await tasks.setTaskField(taskId, 'priority', 'high');

    const updated = tasks.tasks.get(taskId);
    expect(updated.title).toBe('Meta 1 Atualizada');
    expect(updated.priority).toBe('high');
    expect(updated.revision).toBe(3);
  });

  it('alterna conclusão da tarefa de forma idempotente', async () => {
    const res = await tasks.createTask({ title: 'Tarefa' });
    const taskId = res.payload.task.id;

    await tasks.toggleComplete(taskId, true);
    expect(tasks.tasks.get(taskId).completed).toBe(true);

    // Chamar novamente com true é idempotente
    await tasks.toggleComplete(taskId, true);
    expect(tasks.tasks.get(taskId).completed).toBe(true);

    await tasks.toggleComplete(taskId, false);
    expect(tasks.tasks.get(taskId).completed).toBe(false);
  });

  it('grava tombstone ao excluir e impede ressurreição por operação atrasada', async () => {
    const res = await tasks.createTask({ title: 'Tarefa Temporária' });
    const taskId = res.payload.task.id;

    await tasks.deleteTask(taskId);
    expect(tasks.tasks.has(taskId)).toBe(false);

    // Operação atrasada tentando atualizar a tarefa excluída
    const lateOp = await tasks._applyProposalOnHost(
      { action: 'set_field', field: 'title', value: 'Ressuscitar' },
      { authorPeerId: 'other-peer', entityId: taskId }
    );
    expect(lateOp.success).toBe(false);
    expect(lateOp.reason).toBe('task_deleted');
    expect(tasks.tasks.has(taskId)).toBe(false);
  });

  it('aplica filtros locais sem alterar a lista de tarefas compartilhada', async () => {
    await tasks.createTask({ title: 'T1', assigneePeerId: 'host-peer' });
    const t2 = await tasks.createTask({ title: 'T2', assigneePeerId: 'other-peer' });
    await tasks.toggleComplete(t2.payload.task.id, true);

    expect(tasks.getTasksList({ applyFilter: false })).toHaveLength(2);

    // Filtrar somente pendentes
    tasks.setFilter({ status: 'pending' });
    expect(tasks.getTasksList({ applyFilter: true })).toHaveLength(1);
    expect(tasks.getTasksList({ applyFilter: true })[0].title).toBe('T1');

    // Filtrar minhas tarefas
    tasks.setFilter({ status: 'all', assignee: 'me' });
    expect(tasks.getTasksList({ applyFilter: true })).toHaveLength(1);
    expect(tasks.getTasksList({ applyFilter: true })[0].title).toBe('T1');
  });

  it('identifica responsável desconectado como não ativo', () => {
    expect(tasks.isAssigneeActive('active-peer')).toBe(true);
    expect(tasks.isAssigneeActive('offline-peer-123')).toBe(false);
  });

  it('rejeita criação caso atinja o limite máximo de 100 tarefas', async () => {
    for (let i = 0; i < MAX_ROOM_TASKS; i++) {
      tasks.tasks.set(`t_${i}`, { id: `t_${i}`, title: `T${i}` });
    }
    const res = await tasks.createTask({ title: 'Tarefa 101' });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('task_limit_exceeded');
  });
});
