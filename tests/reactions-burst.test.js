import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FloatingReactionsManager } from '../js/reactions.js';
import { ReactionsPlugin } from '../js/plugins/reactions-plugin.js';
import { MessageDispatcher } from '../js/core/message-dispatcher.js';

describe('Reações Flutuantes (Rajadas & Atalhos 1-8)', () => {
  let manager;
  let overlay;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    overlay = document.createElement('div');
    overlay.id = 'reactions-overlay';
    document.body.appendChild(overlay);

    manager = new FloatingReactionsManager({ container: overlay, maxConcurrent: 20 });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('spawnBurst() instancia múltiplos emojis com offsets e delays', () => {
    manager.spawnBurst({ emoji: '🔥', count: 4, originX: 50, senderName: 'Player1' });

    // Primeiro elemento disparado imediatamente no timer 0
    vi.advanceTimersByTime(10);
    expect(overlay.querySelectorAll('.floating-reaction').length).toBe(1);

    // Avançar tempo para os demais da rajada (4 no total, disparados a cada ~65ms)
    vi.advanceTimersByTime(250);
    expect(overlay.querySelectorAll('.floating-reaction').length).toBe(4);
  });

  it('canSendBurst() respeita taxa de envio (cooldown) para rajadas', () => {
    expect(manager.canSendBurst()).toBe(true);
    expect(manager.canSendBurst()).toBe(false);

    vi.advanceTimersByTime(1300);
    expect(manager.canSendBurst()).toBe(true);
  });

  it('atalhos numéricos 1 a 8 disparam reações com o emoji correspondente', () => {
    const dispatcher = new MessageDispatcher();
    const broadcast = vi.fn();
    const plugin = new ReactionsPlugin({ manager });

    plugin.context = {
      dispatcher,
      broadcastDataMessage: broadcast,
      getDisplayName: () => 'Jogador1',
      coopController: { isCapturingInput: () => false }
    };

    plugin.setupListeners();

    // Disparar tecla '1' (🔥)
    const event1 = new KeyboardEvent('keydown', { key: '1', bubbles: true });
    document.dispatchEvent(event1);

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'EMOJI_REACTION',
      emoji: '🔥'
    }));

    // Disparar tecla '6' (GG)
    vi.advanceTimersByTime(300);
    const event6 = new KeyboardEvent('keydown', { key: '6', bubbles: true });
    document.dispatchEvent(event6);

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'EMOJI_REACTION',
      emoji: 'GG'
    }));

    plugin.destroy();
  });

  it('ignora atalhos de reação quando o usuário está digitando em campos de texto', () => {
    const broadcast = vi.fn();
    const plugin = new ReactionsPlugin({ manager });

    plugin.context = {
      dispatcher: new MessageDispatcher(),
      broadcastDataMessage: broadcast,
      coopController: { isCapturingInput: () => false }
    };

    plugin.setupListeners();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const event = new KeyboardEvent('keydown', { key: '1', bubbles: true });
    input.dispatchEvent(event);

    expect(broadcast).not.toHaveBeenCalled();

    plugin.destroy();
  });

  it('ignora atalhos de reação quando o controle Co-op Player 2 está capturando teclado', () => {
    const broadcast = vi.fn();
    const plugin = new ReactionsPlugin({ manager });

    plugin.context = {
      dispatcher: new MessageDispatcher(),
      broadcastDataMessage: broadcast,
      coopController: { isCapturingInput: () => true } // Modo controle de jogo ativo
    };

    plugin.setupListeners();

    const event = new KeyboardEvent('keydown', { key: '2', bubbles: true });
    document.dispatchEvent(event);

    expect(broadcast).not.toHaveBeenCalled();

    plugin.destroy();
  });

  it('Shift + Digit1 físico (onde event.key é "!" e code é "Digit1") dispara rajada de reações', () => {
    const broadcast = vi.fn();
    const plugin = new ReactionsPlugin({ manager });

    plugin.context = {
      dispatcher: new MessageDispatcher(),
      broadcastDataMessage: broadcast,
      getDisplayName: () => 'ProGamer',
      coopController: { isCapturingInput: () => false }
    };

    plugin.setupListeners();

    // Evento disparado pelo teclado físico quando Shift está pressionado (key='!', code='Digit1')
    const shiftEvent = new KeyboardEvent('keydown', {
      key: '!',
      code: 'Digit1',
      shiftKey: true,
      bubbles: true
    });
    document.dispatchEvent(shiftEvent);

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'EMOJI_BURST',
      emoji: '🔥',
      count: 4
    }));

    plugin.destroy();
  });
});
