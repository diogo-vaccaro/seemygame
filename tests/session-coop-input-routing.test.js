import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionContext } from '../js/core/session-context.js';
import { bindSessionMessageHandlers } from '../js/protocol/session-handlers.js';
import { sendSessionMessage } from '../js/protocol/transport.js';
import { handleHostCoopMessage } from '../js/coop/host.js';

const inputs = [
  { type: 'INPUT_KEY', action: 'down', code: 'KeyW' },
  { type: 'INPUT_MOUSE', action: 'move', x: .25, y: .5 },
  { type: 'INPUT_GAMEPAD', state: { buttons: [true, false], axes: [.2, -.3], triggers: [0, 0] } },
  { type: 'INPUT_RESET' }
];

describe.each(['streamer', 'room'])('Roteamento de inputs Co-op: sessão %s', role => {
  let session, broadcast, ports, controller, effects;
  beforeEach(() => {
    session = createSessionContext({ role });
    session.getPeerId = () => 'host';
    broadcast = vi.fn();
    effects = {
      INPUT_KEY: vi.fn(), INPUT_MOUSE: vi.fn(), INPUT_GAMEPAD: vi.fn(), INPUT_RESET: vi.fn()
    };
    ports = {
      coopSlots: new Map([[1, { peerId: 'player', slot: 1 }]]),
      partyModeEnabled: false, maxCoopPlayers: 1,
      isCompanionConnected: true, companionCapabilities: { mouse: true },
      dispatchHostKeyboardInput: effects.INPUT_KEY, dispatchHostMouseInput: effects.INPUT_MOUSE,
      dispatchHostGamepadInput: effects.INPUT_GAMEPAD, dispatchHostInputReset: effects.INPUT_RESET
    };
    controller = { handleHostCoopMessage: vi.fn((...args) => handleHostCoopMessage(ports, ...args)) };
    bindSessionMessageHandlers(session, { role, coopController: controller, broadcast });
  });
  afterEach(() => session.dispose());

  const receive = (payload, sender = 'player') => {
    let result;
    const source = { peer: sender };
    sendSessionMessage({ getPeerId: () => sender }, {
      open: true,
      send: envelope => { result = session.dispatcher.dispatch(envelope, source); }
    }, { ...payload, slot: payload.slot ?? 1 });
    return result;
  };

  it.each(inputs)('entrega $type do transporte P2P ao host autorizado, sem retransmitir', input => {
    expect(receive(input).handled).toBe(true);
    expect(controller.handleHostCoopMessage).toHaveBeenCalledOnce();
    expect(effects[input.type]).toHaveBeenCalledOnce();
    if (input.type === 'INPUT_KEY') expect(effects.INPUT_KEY).toHaveBeenCalledWith(expect.objectContaining(input), 1);
    if (input.type === 'INPUT_MOUSE' || input.type === 'INPUT_GAMEPAD') expect(effects[input.type]).toHaveBeenCalledWith(expect.objectContaining(input));
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(inputs)('preserva a rejeição de $type de outro participante', input => {
    receive(input, 'unauthorized-peer');
    expect(controller.handleHostCoopMessage).toHaveBeenCalledOnce();
    expect(effects[input.type]).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(inputs)('preserva a rejeição de $type em slot de outro jogador', input => {
    ports.maxCoopPlayers = 4;
    ports.coopSlots.set(2, { peerId: 'other-player', slot: 2 });
    receive({ ...input, slot: 2 });
    expect(effects[input.type]).not.toHaveBeenCalled();
  });

  it('permite o gamepad no slot 3 atribuído ao próprio remetente', () => {
    ports.maxCoopPlayers = 4;
    ports.coopSlots.delete(1);
    ports.coopSlots.set(3, { peerId: 'player', slot: 3 });
    receive({ ...inputs[2], slot: 3 });
    expect(effects.INPUT_GAMEPAD).toHaveBeenCalledWith(expect.objectContaining({ slot: 3, state: inputs[2].state }));
  });

  it('não entrega comandos sem conexão identificada ou com identidade de envelope forjada', () => {
    session.dispatcher.dispatch({ ...inputs[0], slot: 1 });
    session.dispatcher.dispatch({ ...inputs[0], slot: 1, senderPeerId: 'player' }, { peer: 'intruder' });
    expect(controller.handleHostCoopMessage).not.toHaveBeenCalled();
    expect(effects.INPUT_KEY).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('libera os registros no encerramento, sem afetar outra sessão', () => {
    const other = createSessionContext({ role });
    const otherHost = vi.fn();
    bindSessionMessageHandlers(other, { role, coopController: { handleHostCoopMessage: otherHost } });
    try {
      session.dispose();
      expect(receive(inputs[0]).handled).toBe(false);
      expect(controller.handleHostCoopMessage).not.toHaveBeenCalled();
      expect(other.dispatcher.dispatch({ ...inputs[0], slot: 1 }, { peer: 'player' }).handled).toBe(true);
      expect(otherHost).toHaveBeenCalledOnce();
    } finally { other.dispose(); }
  });

  it('mantém o pedido e a aprovação antes de receber um comando do jogador', () => {
    ports.coopSlots.clear();
    Object.assign(ports, {
      isCoopEnabled: true, getNextAvailableSlot: () => 1, nextCoopSlotGeneration: 0,
      onPromptCallback: ({ approve }) => approve(), isTauriEnvironment: () => false,
      companionCapabilities: {}, isCompanionConnected: false,
      sendMessage: (connection, message) => sendSessionMessage(session, connection, message),
      showToast: vi.fn(), broadcastSlotsUpdate: vi.fn(), notifyStateChange: vi.fn()
    });
    const connection = { peer: 'player', open: true, send: vi.fn() };
    session.dispatcher.dispatch({ type: 'COOP_REQUEST', preferredSlot: 1, senderPeerId: 'player' }, connection);
    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_RESPONSE', approved: true }));
    expect(ports.coopSlots.get(1).peerId).toBe('player');
    broadcast.mockClear();
    receive(inputs[0]);
    expect(effects.INPUT_KEY).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('Limite dos comandos Co-op na sessão viewer', () => {
  it.each(inputs)('$type não é executado nem retransmitido pelo espectador', input => {
    const session = createSessionContext({ role: 'viewer' });
    const controller = { handleHostCoopMessage: vi.fn(), handleViewerCoopMessage: vi.fn() };
    const broadcast = vi.fn();
    bindSessionMessageHandlers(session, { role: 'viewer', coopController: controller, broadcast });
    try {
      session.dispatcher.dispatch({ ...input, slot: 1 }, { peer: 'host' });
      expect(controller.handleHostCoopMessage).not.toHaveBeenCalled();
      expect(controller.handleViewerCoopMessage).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    } finally { session.dispose(); }
  });
});
