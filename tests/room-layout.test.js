import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomLayoutController } from '../js/room/room-layout.js';

describe('RoomLayoutController (Grade, Destaque e Cinema/Hiperfoco)', () => {
  let controller;
  let gridEl;
  let card1;
  let card2;

  beforeEach(() => {
    document.body.innerHTML = '';
    gridEl = document.createElement('div');
    gridEl.id = 'video-grid';
    gridEl.className = 'video-grid';

    card1 = document.createElement('div');
    card1.id = 'card-peer-1';
    card1.className = 'video-card';
    card1.dataset.peerId = 'peer-1';

    card2 = document.createElement('div');
    card2.id = 'card-peer-2';
    card2.className = 'video-card';
    card2.dataset.peerId = 'peer-2';

    gridEl.appendChild(card1);
    gridEl.appendChild(card2);
    document.body.appendChild(gridEl);

    localStorage.clear();
    controller = new RoomLayoutController({ storageKey: 'test_layout' });
    controller.bindDOM({ gridEl });
  });

  afterEach(() => {
    controller.dispose();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('inicia no modo grade (grid) por padrão', () => {
    expect(controller.getLayoutMode()).toBe('grid');
    expect(gridEl.classList.contains('layout-grid')).toBe(true);
  });

  it('alterna para modo destaque (focus) destacando o cartão alvo e minimizando outros', () => {
    controller.setLayoutMode('focus', 'peer-1');
    expect(controller.getLayoutMode()).toBe('focus');
    expect(gridEl.classList.contains('layout-focus')).toBe(true);
    expect(card1.classList.contains('focused')).toBe(true);
    expect(card2.classList.contains('thumbnail-mode')).toBe(true);
  });

  it('alterna para modo cinema (hiperfoco) maximizando o alvo e ocultando outros', () => {
    controller.setLayoutMode('cinema', 'peer-2');
    expect(controller.getLayoutMode()).toBe('cinema');
    expect(gridEl.classList.contains('layout-cinema')).toBe(true);
    expect(card2.classList.contains('cinema-mode')).toBe(true);
    expect(card1.style.display).toBe('none');

    const floatingControls = document.getElementById('cinema-floating-controls');
    expect(floatingControls).not.toBeNull();
  });

  it('exitCinema() restaura o modo de visualização para grade', () => {
    controller.setLayoutMode('cinema', 'peer-1');
    expect(controller.getLayoutMode()).toBe('cinema');

    controller.exitCinema();
    expect(controller.getLayoutMode()).toBe('grid');
    expect(gridEl.classList.contains('layout-grid')).toBe(true);
    expect(card1.classList.contains('cinema-mode')).toBe(false);
    expect(card2.style.display).not.toBe('none');
    expect(document.getElementById('cinema-floating-controls')).toBeNull();
  });

  it('toggleFocus() alterna entre focus e grid', () => {
    controller.toggleFocus('peer-1');
    expect(controller.getLayoutMode()).toBe('focus');

    controller.toggleFocus('peer-1');
    expect(controller.getLayoutMode()).toBe('grid');
  });

  it('notifica listeners registrados ao mudar layout', () => {
    const listener = vi.fn();
    const unsub = controller.onLayoutChange(listener);

    controller.setLayoutMode('focus', 'peer-1');
    expect(listener).toHaveBeenCalledWith('focus', 'peer-1');

    unsub();
    controller.setLayoutMode('grid');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('atalho de teclado Escape sai do modo cinema', () => {
    controller.setLayoutMode('cinema', 'peer-1');
    expect(controller.getLayoutMode()).toBe('cinema');

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(escapeEvent);

    expect(controller.getLayoutMode()).toBe('grid');
  });

  it('ignora atalhos de teclado quando foco está em um campo de texto', () => {
    controller.setLayoutMode('cinema', 'peer-1');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    input.dispatchEvent(escapeEvent);

    // Escape não deve fechar cinema se acionado dentro de input
    expect(controller.getLayoutMode()).toBe('cinema');
  });

  it('reavalia layout e seleciona novo foco válido quando o cartão focado é removido no modo cinema', () => {
    controller.setLayoutMode('cinema', 'peer-2');
    expect(card2.classList.contains('cinema-mode')).toBe(true);
    expect(card1.style.display).toBe('none');

    // peer-2 interrompe a transmissão e seu cartão é removido do grid
    card2.remove();

    // A mutação deve redefinir o foco para o cartão restante (peer-1) e mantê-lo visível
    controller._handleCardsMutation();

    expect(controller.focusedMediaId).toBe('peer-1');
    expect(card1.classList.contains('cinema-mode')).toBe(true);
    expect(card1.style.display).toBe('');
  });
});
