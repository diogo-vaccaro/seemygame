import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StreamerModeController } from '../js/room/streamer-mode.js';

describe('StreamerModeController', () => {
  let controller;

  beforeEach(() => {
    localStorage.clear();
    document.body.className = '';
    document.title = 'SeeMyGame - Sala #geral';
    controller = new StreamerModeController();
  });

  afterEach(() => {
    controller.destroy();
  });

  it('inicia desativado por padrão', () => {
    controller.init();
    expect(controller.enabled).toBe(false);
    expect(document.body.classList.contains('streamer-mode-active')).toBe(false);
  });

  it('alterna o modo streamer e atualiza classes e título', () => {
    const badge = document.createElement('span');
    badge.id = 'room-header-badge';
    badge.textContent = 'Sala: #geral';
    document.body.appendChild(badge);

    const codeInput = document.createElement('input');
    codeInput.id = 'share-room-code-display';
    codeInput.value = 'geral-123';
    document.body.appendChild(codeInput);

    controller.init({ roomHeaderBadge: badge, shareRoomCodeDisplay: codeInput });

    controller.setStreamerMode(true);
    expect(controller.enabled).toBe(true);
    expect(document.body.classList.contains('streamer-mode-active')).toBe(true);
    expect(badge.textContent).toContain('Modo Streamer');
    expect(codeInput.value).toBe('••••••••');
    expect(document.title).toBe('SeeMyGame - Em Transmissão');

    controller.setStreamerMode(false);
    expect(controller.enabled).toBe(false);
    expect(document.body.classList.contains('streamer-mode-active')).toBe(false);
    expect(badge.textContent).toBe('Sala: #geral');
    expect(codeInput.value).toBe('geral-123');
    expect(document.title).toBe('SeeMyGame - Sala #geral');
  });

  it('persiste a preferência no localStorage', () => {
    controller.init();
    controller.setStreamerMode(true);
    expect(localStorage.getItem('seemygame_streamer_mode')).toBe('true');

    const novoController = new StreamerModeController();
    novoController.init();
    expect(novoController.enabled).toBe(true);
  });
});
