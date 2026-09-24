import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setCoopEnabled,
  getCoopState,
  handleHostCoopMessage,
  revokePlayer2,
  releaseCoopControl,
  requestCoopControl,
  handleViewerCoopMessage,
  registerCoopPromptHandler,
  applyRadialDeadzone,
  triggerGamepadRumble,
  isTauriEnvironment,
  setMaxCoopPlayers,
  getMaxCoopPlayers,
  setPartyModeEnabled,
  isPartyModeEnabled,
  getCoopSlots,
  getNextAvailableSlot,
  revokeCoopPlayer,
  revokeAllCoopPlayers,
  registerCoopBroadcastHandler,
  getGamepadMapping,
  setGamepadMappingPreset,
  swapGamepadButtons,
  resetGamepadMapping,
  applyButtonMapping
} from '../js/coop.js';

describe('Módulo: coop.js', () => {
  beforeEach(() => {
    setCoopEnabled(true);
    setMaxCoopPlayers(1);
    setPartyModeEnabled(false);
    revokeAllCoopPlayers();
  });

  afterEach(() => {
    delete window.__TAURI__;
  });

  it('deve alternar estado de coop habilitado / desabilitado', () => {
    setCoopEnabled(false);
    expect(getCoopState().isCoopEnabled).toBe(false);

    setCoopEnabled(true);
    expect(getCoopState().isCoopEnabled).toBe(true);
  });

  it('deve recusar COOP_REQUEST se Co-op estiver desabilitado', () => {
    setCoopEnabled(false);
    const mockConn = { send: vi.fn() };

    handleHostCoopMessage('peer-viewer-1', { type: 'COOP_REQUEST' }, mockConn);

    expect(mockConn.send).toHaveBeenCalledWith({
      type: 'COOP_RESPONSE',
      approved: false,
      reason: expect.stringContaining('desativou')
    });
  });

  it('deve disparar prompt de autorização para o streamer aprovar Player 2', () => {
    const mockConn = { send: vi.fn() };
    let promptData = null;

    registerCoopPromptHandler((data) => {
      promptData = data;
    });

    handleHostCoopMessage('viewer-player-2', { type: 'COOP_REQUEST' }, mockConn);

    expect(promptData).not.toBeNull();
    expect(promptData.peerId).toBe('viewer-player-2');

    // Host aprova
    promptData.approve();

    expect(mockConn.send).toHaveBeenCalledWith({
      type: 'COOP_RESPONSE',
      approved: true
    });
    expect(getCoopState().activePlayer2PeerId).toBe('viewer-player-2');
  });

  it('deve recusar novo Player 2 se já houver um conectado', () => {
    const mockConn1 = { send: vi.fn() };
    const mockConn2 = { send: vi.fn() };

    registerCoopPromptHandler(({ approve }) => approve());

    handleHostCoopMessage('p2-first', { type: 'COOP_REQUEST' }, mockConn1);
    expect(getCoopState().activePlayer2PeerId).toBe('p2-first');

    handleHostCoopMessage('p2-second', { type: 'COOP_REQUEST' }, mockConn2);
    expect(mockConn2.send).toHaveBeenCalledWith({
      type: 'COOP_RESPONSE',
      approved: false,
      reason: expect.stringContaining('Já existe um Player 2')
    });
  });

  it('deve permitir revogar Player 2 via killswitch / revokePlayer2', () => {
    const mockConn = { send: vi.fn() };
    registerCoopPromptHandler(({ approve }) => approve());

    handleHostCoopMessage('p2-target', { type: 'COOP_REQUEST' }, mockConn);
    expect(getCoopState().activePlayer2PeerId).toBe('p2-target');

    revokePlayer2();
    expect(getCoopState().activePlayer2PeerId).toBeNull();
    expect(mockConn.send).toHaveBeenCalledWith({ type: 'COOP_REVOKE' });
  });

  it('deve despachar eventos de teclado disparados pelo Player 2 autorizado', () => {
    const mockConn = { send: vi.fn() };
    registerCoopPromptHandler(({ approve }) => approve());
    handleHostCoopMessage('p2-gamer', { type: 'COOP_REQUEST' }, mockConn);

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    handleHostCoopMessage('p2-gamer', {
      type: 'INPUT_KEY',
      action: 'down',
      key: 'w',
      code: 'KeyW',
      keyCode: 87
    }, mockConn);

    expect(dispatchSpy).toHaveBeenCalled();
    const event = dispatchSpy.mock.calls[0][0];
    expect(event.type).toBe('keydown');
    expect(event.key).toBe('w');

    dispatchSpy.mockRestore();
  });

  it('deve ignorar inputs de espectadores não autorizados', () => {
    const mockConn = { send: vi.fn() };
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    handleHostCoopMessage('unauthorized-user', {
      type: 'INPUT_KEY',
      action: 'down',
      key: 'a'
    }, mockConn);

    expect(dispatchSpy).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it('lado do espectador: deve tratar resposta aprovada e iniciar escutas', () => {
    const mockCard = document.createElement('div');
    const mockVideo = document.createElement('video');
    mockCard.appendChild(mockVideo);

    handleViewerCoopMessage({ type: 'COOP_RESPONSE', approved: true }, 'host-id-1', mockCard);
    expect(getCoopState().isPlayer2).toBe(true);

    releaseCoopControl();
    expect(getCoopState().isPlayer2).toBe(false);
  });

  it('lado do espectador: deve atualizar estado do botão ao receber COOP_CONFIG', () => {
    const mockCard = document.createElement('div');
    const coopBtn = document.createElement('button');
    coopBtn.id = 'btn-coop-host-id-1';
    coopBtn.className = 'card-btn card-btn-coop';
    mockCard.appendChild(coopBtn);

    // Streamer desativa co-op
    handleViewerCoopMessage({ type: 'COOP_CONFIG', enabled: false }, 'host-id-1', mockCard);
    expect(coopBtn.disabled).toBe(true);
    expect(coopBtn.classList.contains('btn-disabled')).toBe(true);

    // Streamer reativa co-op
    handleViewerCoopMessage({ type: 'COOP_CONFIG', enabled: true }, 'host-id-1', mockCard);
    expect(coopBtn.disabled).toBe(false);
    expect(coopBtn.classList.contains('btn-disabled')).toBe(false);
  });

  it('lado do espectador: deve ignorar captura de teclas se o alvo for campo de texto editável (A13)', () => {
    const mockCard = document.createElement('div');
    const mockVideo = document.createElement('video');
    mockCard.appendChild(mockVideo);

    const mockConn = { send: vi.fn() };
    requestCoopControl('host-123', mockConn);
    handleViewerCoopMessage({ type: 'COOP_RESPONSE', approved: true }, 'host-123', mockCard);

    // Cria um input de chat e foca nele
    const input = document.createElement('input');
    document.body.appendChild(input);

    const eventOnInput = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true });
    input.dispatchEvent(eventOnInput);

    // Não deve ter enviado INPUT_KEY através da DataConnection
    expect(mockConn.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'INPUT_KEY' }));

    // Agora pressiona dentro da área de vídeo explicitamente autorizada
    const eventOnDiv = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true });
    mockCard.dispatchEvent(eventOnDiv);

    // Deve ter enviado INPUT_KEY
    expect(mockConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'INPUT_KEY', key: 'w' }));

    releaseCoopControl();
    document.body.removeChild(input);
  });

  // ==========================================
  // NOVOS TESTES DE GAMEPAD VIRTUAL & HAPTICS
  // ==========================================

  it('applyRadialDeadzone: filtra drift interno e preserva amplitude externa', () => {
    // Valores pequenos dentro da zona morta de 0.08 devem zerar
    const inside = applyRadialDeadzone(0.04, -0.05, 0.08);
    expect(inside.x).toBe(0);
    expect(inside.y).toBe(0);

    // Valores no limite máximo devem normalizar para 1
    const maxVal = applyRadialDeadzone(1.0, 0, 0.08);
    expect(maxVal.x).toBe(1);
    expect(maxVal.y).toBe(0);

    // Eixo Y negativo (empurrar analógico para cima)
    const upVal = applyRadialDeadzone(0, -1.0, 0.08);
    expect(upVal.x).toBe(0);
    expect(upVal.y).toBe(-1);
  });

  it('triggerGamepadRumble: aciona vibrationActuator.playEffect com parâmetros corretos', async () => {
    const mockPlayEffect = vi.fn().mockResolvedValue('complete');
    const originalGetGamepads = navigator.getGamepads;

    navigator.getGamepads = vi.fn().mockReturnValue([
      {
        connected: true,
        vibrationActuator: {
          playEffect: mockPlayEffect
        }
      }
    ]);

    const result = await triggerGamepadRumble(0.8, 0.4, 300, 0);
    expect(result).toBe(true);
    expect(mockPlayEffect).toHaveBeenCalledWith('dual-rumble', {
      startDelay: 0,
      duration: 300,
      strongMagnitude: 0.8,
      weakMagnitude: 0.4
    });

    navigator.getGamepads = originalGetGamepads;
  });

  it('handleViewerCoopMessage: processa mensagem GAMEPAD_RUMBLE e aciona vibração', () => {
    const mockPlayEffect = vi.fn().mockResolvedValue('complete');
    const originalGetGamepads = navigator.getGamepads;

    navigator.getGamepads = vi.fn().mockReturnValue([
      {
        connected: true,
        vibrationActuator: {
          playEffect: mockPlayEffect
        }
      }
    ]);

    handleViewerCoopMessage({
      type: 'GAMEPAD_RUMBLE',
      strongMagnitude: 0.9,
      weakMagnitude: 0.3,
      durationMs: 400
    }, 'host-1', null);

    expect(mockPlayEffect).toHaveBeenCalledWith('dual-rumble', {
      startDelay: 0,
      duration: 400,
      strongMagnitude: 0.9,
      weakMagnitude: 0.3
    });

    navigator.getGamepads = originalGetGamepads;
  });

  it('despacho de gamepad no host com Tauri Desktop invoca update_virtual_gamepad', () => {
    const mockInvoke = vi.fn().mockResolvedValue(undefined);
    window.__TAURI__ = {
      core: { invoke: mockInvoke }
    };

    expect(isTauriEnvironment()).toBe(true);

    const mockConn = { send: vi.fn() };
    registerCoopPromptHandler(({ approve }) => approve());
    handleHostCoopMessage('p2-pad', { type: 'COOP_REQUEST' }, mockConn);

    // Host Tauri deve ter plugado o controle virtual no slot 1
    expect(mockInvoke).toHaveBeenCalledWith('plug_virtual_gamepad', { slot: 1 });

    // Envia dados de gamepad do Player 2
    handleHostCoopMessage('p2-pad', {
      type: 'INPUT_GAMEPAD',
      slot: 1,
      state: {
        buttons: [true, false, false, false],
        triggers: [0.85, 0.0],
        axes: [0.1, -0.9, 0.0, 0.0]
      }
    }, mockConn);

    expect(mockInvoke).toHaveBeenCalledWith('update_virtual_gamepad', {
      slot: 1,
      report: {
        buttons: [true, false, false, false],
        triggers: [0.85, 0.0],
        axes: [0.1, -0.9, 0.0, 0.0]
      }
    });

    // Revoga o controle
    revokePlayer2();
    expect(mockInvoke).toHaveBeenCalledWith('unplug_virtual_gamepad', { slot: 1 });
  });

  describe('Co-op 4 Players e Modo Party (Multi-Slot)', () => {
    it('deve alternar entre modo 2P e 4P e aceitar até 3 convidados no modo padrão', () => {
      setMaxCoopPlayers(4);
      expect(getMaxCoopPlayers()).toBe(4);

      const conn1 = { send: vi.fn() };
      const conn2 = { send: vi.fn() };
      const conn3 = { send: vi.fn() };
      const conn4 = { send: vi.fn() };

      registerCoopPromptHandler(({ approve }) => approve());

      // P2 (slot 1)
      handleHostCoopMessage('guest-1', { type: 'COOP_REQUEST', name: 'Alice' }, conn1);
      expect(conn1.send).toHaveBeenCalledWith({ type: 'COOP_RESPONSE', approved: true });
      expect(conn1.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_CAPABILITIES', slot: 1 }));

      // P3 (slot 2)
      handleHostCoopMessage('guest-2', { type: 'COOP_REQUEST', name: 'Bob' }, conn2);
      expect(conn2.send).toHaveBeenCalledWith({ type: 'COOP_RESPONSE', approved: true });
      expect(conn2.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_CAPABILITIES', slot: 2 }));

      // P4 (slot 3)
      handleHostCoopMessage('guest-3', { type: 'COOP_REQUEST', name: 'Charlie' }, conn3);
      expect(conn3.send).toHaveBeenCalledWith({ type: 'COOP_RESPONSE', approved: true });
      expect(conn3.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_CAPABILITIES', slot: 3 }));

      // 4º convidado tenta entrar -> deve ser recusado pois slot 0 está reservado para o Host local
      handleHostCoopMessage('guest-4', { type: 'COOP_REQUEST', name: 'Dave' }, conn4);
      expect(conn4.send).toHaveBeenCalledWith(expect.objectContaining({
        approved: false,
        reason: expect.stringContaining('ocupados')
      }));

      const state = getCoopState();
      expect(state.activeSlotsCount).toBe(3);
      expect(state.slots).toHaveLength(4);
      expect(state.slots[0].isHost).toBe(true);
      expect(state.slots[1].name).toBe('Alice');
      expect(state.slots[2].name).toBe('Bob');
      expect(state.slots[3].name).toBe('Charlie');
    });

    it('Modo Party deve abrir o slot 0 (Player 1) para 4 convidados remotos', () => {
      setMaxCoopPlayers(4);
      setPartyModeEnabled(true);
      expect(isPartyModeEnabled()).toBe(true);

      const conn1 = { send: vi.fn() };
      const conn2 = { send: vi.fn() };
      const conn3 = { send: vi.fn() };
      const conn4 = { send: vi.fn() };
      const conn5 = { send: vi.fn() };

      registerCoopPromptHandler(({ approve }) => approve());

      // Entram 4 convidados ocupando slots 0, 1, 2, 3
      handleHostCoopMessage('party-1', { type: 'COOP_REQUEST', name: 'P1-Remote' }, conn1);
      handleHostCoopMessage('party-2', { type: 'COOP_REQUEST', name: 'P2-Remote' }, conn2);
      handleHostCoopMessage('party-3', { type: 'COOP_REQUEST', name: 'P3-Remote' }, conn3);
      handleHostCoopMessage('party-4', { type: 'COOP_REQUEST', name: 'P4-Remote' }, conn4);

      expect(conn1.send).toHaveBeenCalledWith({ type: 'COOP_RESPONSE', approved: true });
      expect(conn1.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_CAPABILITIES', slot: 0 }));
      expect(conn2.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_CAPABILITIES', slot: 1 }));
      expect(conn3.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_CAPABILITIES', slot: 2 }));
      expect(conn4.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_CAPABILITIES', slot: 3 }));

      // 5º convidado
      handleHostCoopMessage('party-5', { type: 'COOP_REQUEST' }, conn5);
      expect(conn5.send).toHaveBeenCalledWith(expect.objectContaining({
        approved: false,
        reason: expect.stringContaining('ocupados')
      }));

      expect(getCoopState().activeSlotsCount).toBe(4);
    });

    it('deve isolar inputs de múltiplos jogadores e rejeitar spoofing de slot', () => {
      setMaxCoopPlayers(4);
      const mockInvoke = vi.fn().mockResolvedValue(undefined);
      window.__TAURI__ = { core: { invoke: mockInvoke } };

      const connP2 = { send: vi.fn() };
      const connP3 = { send: vi.fn() };

      registerCoopPromptHandler(({ approve }) => approve());
      handleHostCoopMessage('peer-p2', { type: 'COOP_REQUEST' }, connP2);
      handleHostCoopMessage('peer-p3', { type: 'COOP_REQUEST' }, connP3);

      mockInvoke.mockClear();

      // P2 envia input legítimo para o slot 1
      handleHostCoopMessage('peer-p2', {
        type: 'INPUT_GAMEPAD',
        slot: 1,
        state: { buttons: [true], triggers: [0], axes: [0, 0, 0, 0] }
      }, connP2);
      expect(mockInvoke).toHaveBeenCalledWith('update_virtual_gamepad', expect.objectContaining({ slot: 1 }));

      mockInvoke.mockClear();

      // P2 tenta enviar comando se passando pelo slot 2 (spoofing / trapaça) -> deve ser ignorado
      handleHostCoopMessage('peer-p2', {
        type: 'INPUT_GAMEPAD',
        slot: 2,
        state: { buttons: [true], triggers: [0], axes: [0, 0, 0, 0] }
      }, connP2);
      expect(mockInvoke).not.toHaveBeenCalled();

      // P3 envia input legítimo para o slot 2
      handleHostCoopMessage('peer-p3', {
        type: 'INPUT_GAMEPAD',
        slot: 2,
        state: { buttons: [false, true], triggers: [0], axes: [0, 0, 0, 0] }
      }, connP3);
      expect(mockInvoke).toHaveBeenCalledWith('update_virtual_gamepad', expect.objectContaining({ slot: 2 }));
    });

    it('deve permitir ejetar individualmente um jogador (revokeCoopPlayer) sem afetar os demais', () => {
      setMaxCoopPlayers(4);
      const mockInvoke = vi.fn().mockResolvedValue(undefined);
      window.__TAURI__ = { core: { invoke: mockInvoke } };

      const conn1 = { send: vi.fn(), open: true };
      const conn2 = { send: vi.fn(), open: true };

      registerCoopPromptHandler(({ approve }) => approve());
      handleHostCoopMessage('peer-1', { type: 'COOP_REQUEST' }, conn1); // slot 1
      handleHostCoopMessage('peer-2', { type: 'COOP_REQUEST' }, conn2); // slot 2

      expect(getCoopState().activeSlotsCount).toBe(2);

      // Ejeta apenas o jogador do slot 2
      revokeCoopPlayer(2);
      expect(mockInvoke).toHaveBeenCalledWith('unplug_virtual_gamepad', { slot: 2 });
      expect(conn2.send).toHaveBeenCalledWith({ type: 'COOP_REVOKE' });
      expect(conn1.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'COOP_REVOKE' }));

      // Slot 2 agora está vago, mas Slot 1 continua ocupado
      expect(getCoopState().activeSlotsCount).toBe(1);
      expect(getNextAvailableSlot()).toBe(2);
    });

    it('deve desconectar todos os controles no botão de pânico geral (revokeAllCoopPlayers)', () => {
      setMaxCoopPlayers(4);
      const mockInvoke = vi.fn().mockResolvedValue(undefined);
      window.__TAURI__ = { core: { invoke: mockInvoke } };

      const conn1 = { send: vi.fn(), open: true };
      const conn2 = { send: vi.fn(), open: true };

      registerCoopPromptHandler(({ approve }) => approve());
      handleHostCoopMessage('peer-1', { type: 'COOP_REQUEST' }, conn1);
      handleHostCoopMessage('peer-2', { type: 'COOP_REQUEST' }, conn2);

      revokeAllCoopPlayers();

      expect(mockInvoke).toHaveBeenCalledWith('unplug_all_virtual_gamepads');
      expect(getCoopState().activeSlotsCount).toBe(0);
    });

    it('deve emitir broadcast de COOP_SLOTS_UPDATE para a malha da sala ao alterar slots', () => {
      setMaxCoopPlayers(4);
      const broadcastSpy = vi.fn();
      registerCoopBroadcastHandler(broadcastSpy);

      const conn = { send: vi.fn() };
      registerCoopPromptHandler(({ approve }) => approve());

      handleHostCoopMessage('peer-broadcast', { type: 'COOP_REQUEST', name: 'Gamer' }, conn);

      expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'COOP_SLOTS_UPDATE',
        slots: expect.any(Array)
      }));
    });

    it('desconexão de peer (COOP_PEER_DISCONNECTED) deve liberar o slot automaticamente', () => {
      setMaxCoopPlayers(4);
      const conn = { send: vi.fn() };
      registerCoopPromptHandler(({ approve }) => approve());

      handleHostCoopMessage('peer-leaver', { type: 'COOP_REQUEST' }, conn);
      expect(getCoopState().activeSlotsCount).toBe(1);

      // Peer desconectou do WebSocket / WebRTC
      handleHostCoopMessage('peer-leaver', { type: 'COOP_PEER_DISCONNECTED' }, conn);
      expect(getCoopState().activeSlotsCount).toBe(0);
    });
  });

  describe('Remapeamento de Botões de Gamepad (Layouts Xbox e Nintendo Switch)', () => {
    beforeEach(() => {
      resetGamepadMapping();
    });

    it('getGamepadMapping deve iniciar no padrão Xbox (identidade)', () => {
      const mapping = getGamepadMapping();
      expect(mapping.preset).toBe('xbox');
      expect(mapping.map[0]).toBe(0); // A -> A
      expect(mapping.map[1]).toBe(1); // B -> B
      expect(mapping.map[2]).toBe(2); // X -> X
      expect(mapping.map[3]).toBe(3); // Y -> Y
    });

    it('setGamepadMappingPreset deve aplicar layout Nintendo Switch invertendo A/B e X/Y', () => {
      setGamepadMappingPreset('nintendo');
      const mapping = getGamepadMapping();
      expect(mapping.preset).toBe('nintendo');
      expect(mapping.map[0]).toBe(1); // Físico B (0) aciona A (1)
      expect(mapping.map[1]).toBe(0); // Físico A (1) aciona B (0)
      expect(mapping.map[2]).toBe(3); // Físico Y (2) aciona X (3)
      expect(mapping.map[3]).toBe(2); // Físico X (3) aciona Y (2)
    });

    it('swapGamepadButtons deve inverter dois botões arbitrários e mudar para preset custom', () => {
      swapGamepadButtons(4, 5); // Inverte bumpers LB e RB
      const mapping = getGamepadMapping();
      expect(mapping.preset).toBe('custom');
      expect(mapping.map[4]).toBe(5);
      expect(mapping.map[5]).toBe(4);
    });

    it('applyButtonMapping deve reorganizar array booleano de botões conforme o mapa ativo', () => {
      // No padrão Xbox
      const raw = new Array(17).fill(false);
      raw[0] = true; // Botão 0 pressionado
      let applied = applyButtonMapping(raw);
      expect(applied[0]).toBe(true);
      expect(applied[1]).toBe(false);

      // Alterna para Nintendo
      setGamepadMappingPreset('nintendo');
      applied = applyButtonMapping(raw);
      // No layout Nintendo, físico 0 deve acionar índice 1
      expect(applied[0]).toBe(false);
      expect(applied[1]).toBe(true);
    });

    it('resetGamepadMapping deve restaurar o layout para Xbox padrão', () => {
      setGamepadMappingPreset('nintendo');
      expect(getGamepadMapping().preset).toBe('nintendo');

      resetGamepadMapping();
      expect(getGamepadMapping().preset).toBe('xbox');
      expect(getGamepadMapping().map[0]).toBe(0);
    });
  });
});
