import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageDispatcher } from '../js/core/message-dispatcher.js';
import { RoomToolsPlugin } from '../js/plugins/room-tools-plugin.js';

describe('RoomToolsPlugin - Ciclo de Vida e Mensageria P2P', () => {
  let dispatcher;
  let context;

  beforeEach(() => {
    dispatcher = new MessageDispatcher();
    context = {
      dispatcher,
      broadcastDataMessage: vi.fn(),
      getConnection: vi.fn(),
      getPeerId: () => 'my-peer',
      getDisplayName: () => 'Gamer',
      getCoordinatorPeerId: () => 'coord-peer',
      isHost: () => true,
      isReadonly: () => false,
      role: 'room',
      roomEpoch: 'epoch-test'
    };
  });

  it('registra os 5 tipos de mensagens do protocolo de ferramentas e cria a suíte', () => {
    const plugin = new RoomToolsPlugin();
    plugin.init(context);

    expect(plugin.suite).not.toBeNull();
    expect(plugin.suite.snippets).toBeDefined();
    expect(plugin.suite.tasks).toBeDefined();
    expect(plugin.suite.hands).toBeDefined();
    expect(plugin.suite.watchTogether).toBeDefined();
    expect(plugin.suite.transcript).toBeDefined();

    const registered = dispatcher.getMetrics().registeredTypes;
    expect(registered).toBeGreaterThanOrEqual(5);

    plugin.destroy();
    expect(dispatcher.getMetrics().registeredTypes).toBe(0);
    expect(plugin.suite).toBeNull();
  });

  it('despacha mensagem TOOL_CONFIRM para a suíte através do MessageDispatcher', () => {
    const plugin = new RoomToolsPlugin();
    plugin.init(context);

    const handleRemoteSpy = vi.spyOn(plugin.suite.service, 'handleRemoteMessage');

    dispatcher.dispatch({
      type: 'TOOL_CONFIRM',
      feature: 'snippets',
      opId: 'op-1',
      entityId: 's1',
      revision: 1,
      authorPeerId: 'coord-peer',
      payload: { action: 'create', snippet: { id: 's1', title: 'Test' } },
      roomEpoch: 'epoch-test'
    }, { peer: 'coord-peer' });

    expect(handleRemoteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TOOL_CONFIRM', feature: 'snippets' }),
      'coord-peer',
      expect.anything()
    );

    plugin.destroy();
  });
});
