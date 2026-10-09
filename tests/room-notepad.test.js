import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotepadManager } from '../js/room/notepad.js';

describe('NotepadManager (Bloco de Notas Colaborativo P2P)', () => {
  let notepad;
  let broadcast;

  beforeEach(() => {
    vi.useFakeTimers();
    broadcast = vi.fn();
    notepad = new NotepadManager({
      isHost: true,
      broadcast,
      debounceMs: 200,
      getLocalPeerId: () => 'host-1',
      getCoordinatorPeerId: () => 'host-1',
      getDisplayName: () => 'HostGamer'
    });
  });

  afterEach(() => {
    notepad.dispose();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('permite definir e recuperar texto localmente', () => {
    notepad.setText('Código do lobby: 987654', 'HostGamer', { emit: false });
    expect(notepad.getText()).toBe('Código do lobby: 987654');
    expect(notepad.version).toBe(1);
  });

  it('emite NOTE_SYNC após debounce quando o host edita o texto', () => {
    notepad.setText('Senha da sala: 1234', 'HostGamer', { emit: true });
    expect(broadcast).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'NOTE_SYNC',
      text: 'Senha da sala: 1234',
      version: 1,
      lastAuthor: 'HostGamer'
    }));
  });

  it('quando não é host, emite NOTE_UPDATE para o host ordenar', () => {
    notepad.setIsHost(false);
    notepad.setText('IP do servidor: 192.168.1.50', 'Player2', { emit: true });

    vi.advanceTimersByTime(200);

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'NOTE_UPDATE',
      text: 'IP do servidor: 192.168.1.50',
      authorName: 'Player2'
    }));
  });

  it('host aceita NOTE_UPDATE remoto, incrementa versão e faz broadcast de NOTE_SYNC', () => {
    notepad.handleRemoteMessage({
      type: 'NOTE_UPDATE',
      text: 'Bans: Kassadin, Zed',
      authorName: 'Player2'
    }, 'peer-player-2');

    expect(notepad.getText()).toBe('Bans: Kassadin, Zed');
    expect(notepad.version).toBe(1);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'NOTE_SYNC',
      text: 'Bans: Kassadin, Zed',
      version: 1,
      lastAuthor: 'Player2'
    }));
  });

  it('cliente aceita NOTE_SYNC do host e atualiza texto e versão', () => {
    notepad.setIsHost(false);
    notepad.handleRemoteMessage({
      type: 'NOTE_SYNC',
      text: 'Regras da call atualizadas',
      version: 5,
      lastAuthor: 'HostMaster',
      lastModified: Date.now()
    }, 'host-1');

    expect(notepad.getText()).toBe('Regras da call atualizadas');
    expect(notepad.version).toBe(5);
  });

  it('host responde a NOTE_REQUEST_SYNC enviando o snapshot atual via NOTE_SYNC', () => {
    notepad.setText('Nota persistente', 'Host', { emit: false });
    notepad.handleRemoteMessage({ type: 'NOTE_REQUEST_SYNC' });

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'NOTE_SYNC',
      text: 'Nota persistente',
      version: 1
    }));
  });

  it('renderiza e manipula o modal acessível do bloco de notas', () => {
    notepad.openModal();
    const modal = document.getElementById('notepad-modal');
    expect(modal).not.toBeNull();
    expect(modal.style.display).toBe('flex');

    const textarea = document.getElementById('notepad-textarea');
    expect(textarea).not.toBeNull();

    textarea.value = 'Nova anotação de raid';
    textarea.dispatchEvent(new Event('input'));

    expect(notepad.getText()).toBe('Nova anotação de raid');

    notepad.closeModal();
    expect(modal.style.display).toBe('none');
  });

  it('suporta resolvedor de função dinâmica para isHost', () => {
    let coordinatorState = false;
    const dynamicNotepad = new NotepadManager({
      isHost: () => coordinatorState,
      broadcast
    });

    expect(dynamicNotepad.isHost).toBe(false);

    // Quando o coordenador é promovido ou detectado
    coordinatorState = true;
    expect(dynamicNotepad.isHost).toBe(true);

    dynamicNotepad.setText('Snapshot de mestre', 'Mestre', { emit: false });
    dynamicNotepad.handleRemoteMessage({ type: 'NOTE_REQUEST_SYNC' });

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'NOTE_SYNC',
      text: 'Snapshot de mestre'
    }));

    dynamicNotepad.dispose();
  });
});
