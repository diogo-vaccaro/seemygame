import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharedToolsService } from '../js/room/tools/shared-tools-service.js';

describe('SharedToolsService - Fundação Comum das Ferramentas da Sala', () => {
  let hostService;
  let clientService;
  let broadcastCalls;
  let sendToCalls;

  beforeEach(() => {
    broadcastCalls = [];
    sendToCalls = [];

    hostService = new SharedToolsService({
      isHost: () => true,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      getCoordinatorPeerId: () => 'host-peer',
      isReadonly: false,
      roomEpoch: 'room-epoch-1',
      broadcast: (msg) => broadcastCalls.push(msg)
    });

    clientService = new SharedToolsService({
      isHost: () => false,
      getLocalPeerId: () => 'guest-peer',
      getDisplayName: () => 'Convidado',
      getCoordinatorPeerId: () => 'host-peer',
      isReadonly: false,
      roomEpoch: 'room-epoch-1',
      broadcast: (msg) => broadcastCalls.push(msg),
      sendTo: (peerId, msg) => sendToCalls.push({ peerId, msg })
    });
  });

  afterEach(() => {
    hostService?.dispose();
    clientService?.dispose();
  });

  it('registra e versiona features independentemente', () => {
    hostService.registerFeature('test_feature');
    expect(hostService.getRevision('test_feature')).toBe(0);

    hostService.setRevision('test_feature', 5);
    expect(hostService.getRevision('test_feature')).toBe(5);
  });

  it('host aplica proposta localmente e incrementa revisão publicando TOOL_CONFIRM', async () => {
    let appliedPayload = null;
    hostService.registerFeature('notes', {
      applyProposal: (payload) => {
        appliedPayload = payload;
        return { success: true, payload: { ...payload, processed: true } };
      }
    });

    const res = await hostService.propose('notes', {
      entityId: 'note-1',
      payload: { text: 'Olá Mundo' }
    });

    expect(res.success).toBe(true);
    expect(res.revision).toBe(1);
    expect(appliedPayload.text).toBe('Olá Mundo');
    expect(hostService.getRevision('notes')).toBe(1);

    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0].type).toBe('TOOL_CONFIRM');
    expect(broadcastCalls[0].feature).toBe('notes');
    expect(broadcastCalls[0].revision).toBe(1);
    expect(broadcastCalls[0].payload.processed).toBe(true);
  });

  it('deduplica operações idempotentemente por opId retornando a mesma confirmação', () => {
    let callCount = 0;
    hostService.registerFeature('counter', {
      applyProposal: () => {
        callCount++;
        return { success: true, payload: { count: callCount } };
      }
    });

    const msg = {
      type: 'TOOL_PROPOSAL',
      feature: 'counter',
      opId: 'op-fixed-123',
      entityId: 'c1',
      baseRevision: 0,
      payload: {},
      senderPeerId: 'guest-1',
      roomEpoch: 'room-epoch-1'
    };

    const res1 = hostService._handleProposalAsHost(msg);
    expect(res1.success).toBe(true);
    expect(callCount).toBe(1);
    expect(res1.revision).toBe(1);

    // Repetir a mesma operação
    const res2 = hostService._handleProposalAsHost(msg);
    expect(res2.success).toBe(true);
    expect(res2.duplicated).toBe(true);
    expect(callCount).toBe(1); // Não executou novamente
    expect(res2.revision).toBe(1);
  });

  it('rejeita propostas de espectadores somente-leitura com readonly_not_permitted', async () => {
    const readonlyService = new SharedToolsService({
      isHost: false,
      getLocalPeerId: () => 'readonly-peer',
      isReadonly: true,
      roomEpoch: 'room-epoch-1'
    });
    readonlyService.registerFeature('notes');

    const res = await readonlyService.propose('notes', { payload: { text: 'Hack' } });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('readonly_not_permitted');
    readonlyService.dispose();
  });

  it('host rejeita proposta vinda de conexão com metadados de readonly-viewer', () => {
    hostService.registerFeature('notes', {
      applyProposal: vi.fn()
    });

    const mockConn = {
      peer: 'spammer-readonly',
      metadata: { role: 'readonly-viewer' },
      send: vi.fn()
    };

    const msg = {
      type: 'TOOL_PROPOSAL',
      feature: 'notes',
      opId: 'op-99',
      entityId: 'n1',
      baseRevision: 0,
      payload: { text: 'Não permitido' },
      senderPeerId: 'spammer-readonly',
      roomEpoch: 'room-epoch-1'
    };

    const res = hostService._handleProposalAsHost(msg, mockConn);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('readonly_not_permitted');
    expect(mockConn.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TOOL_REJECT',
      reason: 'readonly_not_permitted'
    }));
  });

  it('detecta conflito de revisão quando exigida revisão exata', () => {
    hostService.registerFeature('strict_doc', {
      getSnapshot: () => ({ text: 'Versão Atual' }),
      applyProposal: () => ({ success: true })
    });
    hostService.setRevision('strict_doc', 3);

    const mockConn = { peer: 'guest-2', send: vi.fn() };
    const msg = {
      type: 'TOOL_PROPOSAL',
      feature: 'strict_doc',
      opId: 'op-stale',
      entityId: 'doc1',
      baseRevision: 1, // Obsoleto (atual é 3)
      payload: { __requireExactRevision: true, text: 'Edição atrasada' },
      senderPeerId: 'guest-2',
      roomEpoch: 'room-epoch-1'
    };

    const res = hostService._handleProposalAsHost(msg, mockConn);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('conflict');
    expect(mockConn.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TOOL_REJECT',
      reason: 'conflict',
      currentRevision: 3,
      snapshot: { text: 'Versão Atual' }
    }));
  });

  it('rejeita mensagens com roomEpoch diferente da sessão ativa', () => {
    hostService.registerFeature('notes', { applyProposal: vi.fn() });

    const wrongEpochMsg = {
      type: 'TOOL_PROPOSAL',
      feature: 'notes',
      opId: 'op-wrong-epoch',
      roomEpoch: 'old-stale-session',
      payload: {}
    };

    const res = hostService._handleProposalAsHost(wrongEpochMsg);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('epoch_mismatch');
  });

  it('pausa escritas e avisa quando coordenador da sala está offline', async () => {
    clientService.registerFeature('notes');
    clientService.setCoordinatorOnline(false);

    const res = await clientService.propose('notes', { payload: { text: 'Teste' } });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('coordinator_offline');
  });

  it('cliente sincroniza snapshot autoritativo do coordenador via TOOL_SYNC', () => {
    let clientSnapshot = null;
    clientService.registerFeature('notes', {
      applySnapshot: (data) => { clientSnapshot = data; }
    });

    const syncMsg = {
      type: 'TOOL_SYNC',
      feature: 'notes',
      revision: 8,
      data: [{ id: 'n1', text: 'Sincronizado' }],
      roomEpoch: 'room-epoch-1'
    };

    const handled = clientService.handleRemoteMessage(syncMsg, 'host-peer');
    expect(handled).toBe(true);
    expect(clientService.getRevision('notes')).toBe(8);
    expect(clientSnapshot).toEqual([{ id: 'n1', text: 'Sincronizado' }]);
  });
});
