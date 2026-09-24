import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as app from '../js/app.js';

describe('Confirmação de Recarga (F5 e Ctrl+R)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <!-- Modal de Confirmação de Recarga / Saída da Sala -->
      <div id="reload-confirm-modal" class="modal-overlay" style="display: none; z-index: 10002;" role="dialog" aria-modal="true" aria-labelledby="reload-confirm-title">
        <div class="modal-content" style="max-width: 460px;">
          <h3 id="reload-confirm-title">⚠️ Recarregar a Sala?</h3>
          <p id="reload-confirm-desc">Você está em uma sessão ativa na sala.</p>
          <div id="reload-confirm-warnings" style="display: none;"></div>
          <div class="modal-actions">
            <button id="reload-confirm-cancel-btn">Continuar na Sala</button>
            <button id="reload-confirm-ok-btn">Recarregar</button>
          </div>
        </div>
      </div>
    `;
    app.setConfirmedReload(false);
  });

  afterEach(() => {
    app.hideReloadConfirmationModal();
    app.setConfirmedReload(false);
    vi.restoreAllMocks();
  });

  it('handleReloadKeypress: deve interceptar tecla F5 e exibir o modal se estiver em modo sala', () => {
    const origLocation = window.location;
    delete window.location;
    window.location = new URL('http://localhost/room.html?room=gamer-room');

    try {
      const event = new KeyboardEvent('keydown', { key: 'F5', code: 'F5', cancelable: true });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      const handled = app.handleReloadKeypress(event);
      expect(handled).toBe(true);
      expect(preventSpy).toHaveBeenCalled();
      expect(app.isReloadConfirmationPending()).toBe(true);
    } finally {
      window.location = origLocation;
    }
  });

  it('handleReloadKeypress: deve interceptar Ctrl+R e exibir o modal se estiver em modo sala', () => {
    const origLocation = window.location;
    delete window.location;
    window.location = new URL('http://localhost/room.html?room=gamer-room');

    try {
      const event = new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', ctrlKey: true, cancelable: true });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      const handled = app.handleReloadKeypress(event);
      expect(handled).toBe(true);
      expect(preventSpy).toHaveBeenCalled();
      expect(app.isReloadConfirmationPending()).toBe(true);
    } finally {
      window.location = origLocation;
    }
  });

  it('handleReloadKeypress: não deve interceptar teclas normais como Enter ou Espaço', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', cancelable: true });
    const preventSpy = vi.spyOn(event, 'preventDefault');

    const handled = app.handleReloadKeypress(event);
    expect(handled).toBe(false);
    expect(preventSpy).not.toHaveBeenCalled();
    expect(app.isReloadConfirmationPending()).toBe(false);
  });

  it('showReloadConfirmationModal: botão "Continuar na Sala" fecha o modal sem recarregar', () => {
    app.showReloadConfirmationModal();
    expect(app.isReloadConfirmationPending()).toBe(true);

    const cancelBtn = document.getElementById('reload-confirm-cancel-btn');
    cancelBtn.click();

    expect(app.isReloadConfirmationPending()).toBe(false);
  });

  it('showReloadConfirmationModal: tecla Escape fecha o modal de confirmação', () => {
    app.showReloadConfirmationModal();
    expect(app.isReloadConfirmationPending()).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(app.isReloadConfirmationPending()).toBe(false);
  });

  it('showReloadConfirmationModal: botão "Recarregar" confirma e fecha o modal', () => {
    const reloadMock = vi.fn();
    const origLocation = window.location;
    delete window.location;
    window.location = { reload: reloadMock, pathname: '/room.html' };

    try {
      app.showReloadConfirmationModal();
      expect(app.isReloadConfirmationPending()).toBe(true);

      const okBtn = document.getElementById('reload-confirm-ok-btn');
      okBtn.click();

      expect(app.isReloadConfirmationPending()).toBe(false);
      expect(reloadMock).toHaveBeenCalled();
    } finally {
      window.location = origLocation;
    }
  });
});
