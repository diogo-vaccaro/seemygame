import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bindSessionMessageHandlers } from '../js/protocol/session-handlers.js';
import { MessageDispatcher } from '../js/core/message-dispatcher.js';
import { createSessionContext } from '../js/core/session-context.js';

describe('Somente-Leitura (/watch & readonly-viewer)', () => {
  let session;
  let dispatcher;

  beforeEach(() => {
    dispatcher = new MessageDispatcher();
    session = createSessionContext({ messageDispatcher: dispatcher });
  });

  it('rejeita COOP_REQUEST e envia COOP_DENY quando o peer é readonly-viewer', () => {
    const mockCoopController = {
      handleHostCoopMessage: vi.fn(),
      getCoopState: () => ({ activeHostPeerId: null })
    };
    const showToast = vi.fn();

    bindSessionMessageHandlers(session, {
      role: 'streamer',
      coopController: mockCoopController,
      showToast,
      isAuthorizedPeer: () => true
    });

    const mockConn = {
      peer: 'viewer-readonly-123',
      metadata: { role: 'readonly-viewer' },
      send: vi.fn()
    };

    dispatcher.dispatch({ type: 'COOP_REQUEST', slotIndex: 1 }, mockConn);

    expect(mockCoopController.handleHostCoopMessage).not.toHaveBeenCalled();
    expect(mockConn.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'COOP_DENY',
      reason: 'readonly_not_permitted'
    }));
  });

  it('descarta inputs de teclado, mouse e gamepad de conexões readonly-viewer', () => {
    const mockCoopController = {
      handleHostCoopMessage: vi.fn()
    };

    bindSessionMessageHandlers(session, {
      role: 'streamer',
      coopController: mockCoopController,
      isAuthorizedPeer: () => true
    });

    const mockConn = {
      peer: 'viewer-readonly-123',
      metadata: { role: 'readonly-viewer' }
    };

    dispatcher.dispatch({ type: 'INPUT_KEY', key: 'Space', state: 'down' }, mockConn);
    dispatcher.dispatch({ type: 'INPUT_MOUSE', x: 0.5, y: 0.5 }, mockConn);
    dispatcher.dispatch({ type: 'INPUT_GAMEPAD', button: 0, pressed: true }, mockConn);

    expect(mockCoopController.handleHostCoopMessage).not.toHaveBeenCalled();
  });

  it('rejeita sinais de entrada na sala de voz (VOICE_JOINED) de conexões readonly-viewer', () => {
    const mockVoiceManager = {
      updateParticipantState: vi.fn()
    };
    const showToast = vi.fn();

    bindSessionMessageHandlers(session, {
      role: 'streamer',
      voiceManager: mockVoiceManager,
      showToast,
      isAuthorizedPeer: () => true
    });

    const mockConn = {
      peer: 'viewer-readonly-123',
      metadata: { role: 'readonly-viewer' }
    };

    dispatcher.dispatch({
      type: 'VOICE_SIGNAL',
      action: 'VOICE_JOINED',
      peerId: 'viewer-readonly-123',
      name: 'Espectador Passivo'
    }, mockConn);

    expect(showToast).not.toHaveBeenCalled();
  });

  it('answerVoiceCall rejeita chamadas de áudio recebidas de peers readonly-viewer', () => {
    const handlers = bindSessionMessageHandlers(session, {
      role: 'streamer',
      voiceManager: { isInVoice: true, localStream: {} },
      isAuthorizedPeer: () => true
    });

    const mockCall = {
      peer: 'viewer-readonly-123',
      metadata: { role: 'readonly-viewer' },
      close: vi.fn()
    };

    const answered = handlers.answerVoiceCall(mockCall);
    expect(answered).toBe(false);
    expect(mockCall.close).toHaveBeenCalled();
  });

  it('answerVoiceCall rejeita chamada de áudio mesmo quando metadata.role é omitido se o peer registrado for somente-leitura', () => {
    const mockConnections = [
      { peer: 'viewer-readonly-999', metadata: { role: 'readonly-viewer' } }
    ];

    const handlers = bindSessionMessageHandlers(session, {
      role: 'streamer',
      voiceManager: { isInVoice: true, localStream: {} },
      isAuthorizedPeer: () => true,
      getDataConnections: () => mockConnections,
      getPeerRole: (id) => mockConnections.find(c => c.peer === id)?.metadata?.role
    });

    // Chamada sem metadata.role explícito (apenas VOICE_CHAT)
    const mockCall = {
      peer: 'viewer-readonly-999',
      metadata: { type: 'VOICE_CHAT' },
      close: vi.fn()
    };

    const answered = handlers.answerVoiceCall(mockCall);
    expect(answered).toBe(false);
    expect(mockCall.close).toHaveBeenCalled();
  });
});
