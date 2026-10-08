import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomToolsController } from '../js/room/room-tools.js';

describe('RoomToolsController Integração (Clipping, Bloco de Notas e Layout)', () => {
  let controller;
  let dockBtn;
  let mockClipEditor;

  beforeEach(() => {
    document.body.innerHTML = '';
    dockBtn = document.createElement('button');
    dockBtn.id = 'dock-room-tools-btn';
    document.body.appendChild(dockBtn);

    const clipDockBtn = document.createElement('button');
    clipDockBtn.id = 'dock-clip-btn';
    document.body.appendChild(clipDockBtn);

    mockClipEditor = {
      exportClip: vi.fn()
    };

    controller = new RoomToolsController();
    controller.bindSession({
      session: {
        features: { clipEditor: mockClipEditor },
        isMaster: true
      }
    });
    controller.bindDOM();
  });

  afterEach(() => {
    controller.closeMenu();
    document.body.innerHTML = '';
  });

  it('exibe opções de Clipar, Bloco de Notas e Alternar Layout no menu de ferramentas', () => {
    controller.openMenu();
    const menu = document.getElementById('room-tools-menu');
    expect(menu).not.toBeNull();

    const clipItem = menu.querySelector('[data-action="clip"]');
    const notepadItem = menu.querySelector('[data-action="notepad"]');
    const layoutItem = menu.querySelector('[data-action="layout"]');

    expect(clipItem).not.toBeNull();
    expect(notepadItem).not.toBeNull();
    expect(layoutItem).not.toBeNull();
  });

  it('acionar ação "clip" no menu chama exportClip no editor de clipes', () => {
    controller.executeAction('clip');
    expect(mockClipEditor.exportClip).toHaveBeenCalled();
  });

  it('clicar no botão dock-clip-btn dispara a gravação de clipe', () => {
    const btn = document.getElementById('dock-clip-btn');
    btn.click();
    expect(mockClipEditor.exportClip).toHaveBeenCalled();
  });

  it('tecla "c" fora de campos de texto aciona o clipping', () => {
    const event = new KeyboardEvent('keydown', { key: 'c', bubbles: true });
    document.dispatchEvent(event);

    expect(mockClipEditor.exportClip).toHaveBeenCalled();
  });

  it('tecla "c" dentro de campo de texto não dispara o clipping', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const event = new KeyboardEvent('keydown', { key: 'c', bubbles: true });
    input.dispatchEvent(event);

    expect(mockClipEditor.exportClip).not.toHaveBeenCalled();
  });
});
