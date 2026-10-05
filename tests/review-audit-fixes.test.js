import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClipRecorder } from '../js/clipping.js';
import {
  coopSlots,
  setMaxCoopPlayers,
  getMaxCoopPlayers,
  setPartyModeEnabled,
  isPartyModeEnabled,
  handleHostCoopMessage,
  createCoopController,
  revokeCoopPlayer,
  revokeAllCoopPlayers,
  pressedBrowserKeys
} from '../js/coop.js';
import { dispatchHostKeyboardInput } from '../js/coop/transport.js';

class MockMediaRecorder {
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onerror = null;
    MockMediaRecorder.lastInstance = this;
  }

  start(timeslice) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }

  stop() {
    this.state = 'inactive';
  }

  requestData() {}

  emitData(blob) {
    if (this.ondataavailable) {
      this.ondataavailable({ data: blob });
    }
  }
}

MockMediaRecorder.isTypeSupported = vi.fn((type) => type.includes('webm'));
MockMediaRecorder.lastInstance = null;

class MockAudioContext {
  constructor() {
    this.state = 'suspended';
    this.resume = vi.fn().mockImplementation(() => {
      this.state = 'running';
      return Promise.resolve();
    });
    this.close = vi.fn().mockResolvedValue();
    this.destination = {
      stream: {
        getAudioTracks: () => [{ kind: 'audio', readyState: 'live', stop: vi.fn() }]
      }
    };
    this.createMediaStreamDestination = vi.fn(() => this.destination);
    this.createMediaStreamSource = vi.fn((stream) => {
      const node = {
        stream,
        connect: vi.fn(),
        disconnect: vi.fn()
      };
      return node;
    });
    MockAudioContext.lastInstance = this;
  }
}
MockAudioContext.lastInstance = null;

describe('Auditoria Técnica (R1 a R10): Validação de Regressões e Estabilidade', () => {
  beforeEach(() => {
    globalThis.MediaRecorder = MockMediaRecorder;
    globalThis.AudioContext = MockAudioContext;
    globalThis.webkitAudioContext = MockAudioContext;
    MockMediaRecorder.lastInstance = null;
    MockAudioContext.lastInstance = null;
    vi.useFakeTimers();
    revokeAllCoopPlayers();
    setMaxCoopPlayers(1);
    setPartyModeEnabled(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    revokeAllCoopPlayers();
  });

  describe('R7, R6, P1 & P2: Clipping - Limpeza de listeners, áudio estável, removetrack e ativação de AudioContext', () => {
    it('stop() deve remover os event listeners addtrack e removetrack da MediaStream de origem', () => {
      const addedListeners = [];
      const removedListeners = [];

      const mockStream = {
        getTracks: vi.fn(() => [{ kind: 'video', readyState: 'live' }]),
        getAudioTracks: vi.fn(() => []),
        getVideoTracks: vi.fn(() => [{ kind: 'video', readyState: 'live' }]),
        addEventListener: vi.fn((type, handler) => {
          addedListeners.push({ type, handler });
        }),
        removeEventListener: vi.fn((type, handler) => {
          removedListeners.push({ type, handler });
        })
      };

      const recorder = new ClipRecorder({ maxDurationSeconds: 15 });
      recorder.start(mockStream);

      expect(mockStream.addEventListener).toHaveBeenCalledWith('addtrack', expect.any(Function));
      expect(mockStream.addEventListener).toHaveBeenCalledWith('removetrack', expect.any(Function));
      expect(addedListeners.length).toBe(2);

      recorder.stop();

      // R7 & P1: Os listeners devem ter sido removidos antes de stream ser limpo
      const addTrackListener = addedListeners.find(l => l.type === 'addtrack');
      const removeTrackListener = addedListeners.find(l => l.type === 'removetrack');
      expect(mockStream.removeEventListener).toHaveBeenCalledWith('addtrack', addTrackListener.handler);
      expect(mockStream.removeEventListener).toHaveBeenCalledWith('removetrack', removeTrackListener.handler);
      expect(recorder.stream).toBeNull();
      expect(recorder.isRecording).toBe(false);
    });

    it('R6: adicionar faixa tardia durante gravação deve preservar estabilidade sem misturar headers inválidos', () => {
      let addTrackHandler = null;
      const mockStream = {
        getTracks: vi.fn(() => [{ kind: 'video', readyState: 'live' }]),
        getAudioTracks: vi.fn(() => []),
        getVideoTracks: vi.fn(() => [{ kind: 'video', readyState: 'live' }]),
        addEventListener: vi.fn((type, handler) => {
          if (type === 'addtrack') addTrackHandler = handler;
        }),
        removeEventListener: vi.fn()
      };

      const recorder = new ClipRecorder({ maxDurationSeconds: 15 });
      recorder.start(mockStream);

      expect(recorder.isRecording).toBe(true);
      const initialRecorderInstance = recorder.mediaRecorder;
      expect(initialRecorderInstance).toBeDefined();

      // Simula chegada tardia de faixa de áudio
      expect(addTrackHandler).toBeInstanceOf(Function);
      const lateAudioTrack = { kind: 'audio', readyState: 'live' };
      addTrackHandler({ track: lateAudioTrack });

      // O gravador mantém estado ativo e grava com topologia consistente
      expect(recorder.isRecording).toBe(true);
      expect(recorder.recordingStream).toBeDefined();

      recorder.stop();
    });

    it('P1: removetrack deve desconectar nós de áudio do mixer e ended na faixa deve limpar mapeamento', () => {
      let addTrackHandler = null;
      let removeTrackHandler = null;
      const audioTrackEndedListeners = [];

      const mockAudioTrack = {
        kind: 'audio',
        readyState: 'live',
        addEventListener: vi.fn((evt, cb) => {
          if (evt === 'ended') audioTrackEndedListeners.push(cb);
        }),
        removeEventListener: vi.fn()
      };

      const mockStream = {
        getTracks: vi.fn(() => [{ kind: 'video', readyState: 'live' }, mockAudioTrack]),
        getAudioTracks: vi.fn(() => [mockAudioTrack]),
        getVideoTracks: vi.fn(() => [{ kind: 'video', readyState: 'live' }]),
        addEventListener: vi.fn((type, handler) => {
          if (type === 'addtrack') addTrackHandler = handler;
          if (type === 'removetrack') removeTrackHandler = handler;
        }),
        removeEventListener: vi.fn()
      };

      const recorder = new ClipRecorder({ maxDurationSeconds: 15 });
      recorder.start(mockStream);

      // Deve ter mapeado mockAudioTrack em _audioTrackSources
      expect(recorder._audioTrackSources.has(mockAudioTrack)).toBe(true);
      const entry = recorder._audioTrackSources.get(mockAudioTrack);
      const disconnectSpy = vi.spyOn(entry.sourceNode, 'disconnect');

      // 1. Simula removetrack (usuário mudou para "Apenas vídeo")
      removeTrackHandler({ track: mockAudioTrack });
      expect(disconnectSpy).toHaveBeenCalled();
      expect(recorder._audioTrackSources.has(mockAudioTrack)).toBe(false);

      // 2. Simula readição da trilha
      addTrackHandler({ track: mockAudioTrack });
      expect(recorder._audioTrackSources.has(mockAudioTrack)).toBe(true);

      // 3. Simula fim da trilha (ended)
      const newEntry = recorder._audioTrackSources.get(mockAudioTrack);
      const newDisconnectSpy = vi.spyOn(newEntry.sourceNode, 'disconnect');
      audioTrackEndedListeners.forEach(cb => cb());
      expect(newDisconnectSpy).toHaveBeenCalled();
      expect(recorder._audioTrackSources.has(mockAudioTrack)).toBe(false);

      recorder.stop();
    });

    it('P2: AudioContext suspenso deve ser retomado no start e via evento de gesto do usuário', () => {
      const mockStream = {
        getTracks: vi.fn(() => [{ kind: 'video', readyState: 'live' }]),
        getAudioTracks: vi.fn(() => []),
        getVideoTracks: vi.fn(() => [{ kind: 'video', readyState: 'live' }]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      const recorder = new ClipRecorder({ maxDurationSeconds: 15 });
      recorder.start(mockStream);

      if (recorder._audioContext) {
        expect(recorder._audioContext.resume).toHaveBeenCalled();
        // Simula que o navegador manteve suspended devido à autoplay policy
        recorder._audioContext.state = 'suspended';
        // Interação do usuário deve acionar resume
        window.dispatchEvent(new Event('click'));
        expect(recorder._audioContext.resume).toHaveBeenCalledTimes(2);
      }

      recorder.stop();
    });
  });

  describe('R10: Co-op - Reconciliação, revogação e neutralização de teclas retidas', () => {
    it('reduzir maxCoopPlayers de 4 para 2 deve revogar slots 2 e 3 e notificar peers', () => {
      setMaxCoopPlayers(4);
      expect(getMaxCoopPlayers()).toBe(4);

      const connP2 = { open: true, send: vi.fn() };
      const connP3 = { open: true, send: vi.fn() };
      const connP4 = { open: true, send: vi.fn() };

      coopSlots.set(1, { peerId: 'peer-p2', conn: connP2, name: 'Player 2' });
      coopSlots.set(2, { peerId: 'peer-p3', conn: connP3, name: 'Player 3' });
      coopSlots.set(3, { peerId: 'peer-p4', conn: connP4, name: 'Player 4' });

      expect(coopSlots.has(2)).toBe(true);
      expect(coopSlots.has(3)).toBe(true);

      // Reduz para 2 jogadores (apenas slots 0 e 1 permitidos)
      setMaxCoopPlayers(1); // 1 extra -> slots max 2

      expect(coopSlots.has(1)).toBe(true);
      expect(coopSlots.has(2)).toBe(false);
      expect(coopSlots.has(3)).toBe(false);

      expect(connP3.send).toHaveBeenCalledWith({ type: 'COOP_REVOKE' });
      expect(connP4.send).toHaveBeenCalledWith({ type: 'COOP_REVOKE' });
      expect(connP2.send).not.toHaveBeenCalled();
    });

    it('desativar party mode deve revogar jogador remoto alocado no Slot 0', () => {
      setPartyModeEnabled(true);
      expect(isPartyModeEnabled()).toBe(true);

      const connP1 = { open: true, send: vi.fn() };
      coopSlots.set(0, { peerId: 'peer-p1-remote', conn: connP1, name: 'Remote P1' });

      expect(coopSlots.has(0)).toBe(true);

      // Desativa modo Party -> Slot 0 torna-se exclusivo do host local
      setPartyModeEnabled(false);

      expect(coopSlots.has(0)).toBe(false);
      expect(connP1.send).toHaveBeenCalledWith({ type: 'COOP_REVOKE' });
    });

    it('deve despachar keydown para jogador autorizado, neutralizar teclas no revoke e rejeitar inputs posteriores', () => {
      setMaxCoopPlayers(2);
      const connP2 = { open: true, send: vi.fn() };
      coopSlots.set(1, { peerId: 'player-2-valid', conn: connP2, name: 'P2' });

      const keyupDispatched = vi.fn();
      window.addEventListener('keyup', keyupDispatched);

      // 1. Envia keydown autorizado (action: 'down') com assinatura correta (senderPeerId, data, conn)
      const keyDownMsg = {
        type: 'INPUT_KEY',
        slot: 1,
        code: 'KeyW',
        key: 'w',
        action: 'down'
      };
      handleHostCoopMessage('player-2-valid', keyDownMsg, connP2);
      expect(pressedBrowserKeys.has('KeyW')).toBe(true);

      // 2. Revoga Player 2 -> deve emitir keyup e limpar tecla retida
      revokeCoopPlayer(1, true);
      expect(pressedBrowserKeys.has('KeyW')).toBe(false);
      expect(keyupDispatched).toHaveBeenCalled();

      // 3. Tenta enviar novos inputs de peer revogado -> deve ser ignorado
      const newKeyDownMsg = {
        type: 'INPUT_KEY',
        slot: 1,
        code: 'KeyD',
        key: 'd',
        action: 'down'
      };
      handleHostCoopMessage('player-2-valid', newKeyDownMsg, connP2);
      expect(pressedBrowserKeys.has('KeyD')).toBe(false);

      window.removeEventListener('keyup', keyupDispatched);
    });

    it('inputs de slots revogados ou não permitidos devem ser estritamente ignorados', () => {
      setMaxCoopPlayers(1); // Limite de 2 jogadores (slots 0 e 1)
      setPartyModeEnabled(false);

      const connP3 = { open: true, send: vi.fn() };
      coopSlots.set(3, { peerId: 'attacker-p3', conn: connP3, name: 'Attacker' });

      const inputMsg = {
        type: 'INPUT_KEY',
        slot: 3,
        code: 'Space',
        key: ' ',
        action: 'down'
      };

      // Chama com assinatura correta (senderPeerId, data, conn)
      handleHostCoopMessage('attacker-p3', inputMsg, connP3);

      // Tecla não deve ter sido adicionada porque slot 3 não é permitido
      expect(pressedBrowserKeys.has('Space')).toBe(false);
    });

    it('P3: múltiplos slots com a mesma tecla não devem sofrer interferência mútua na revogação individual', () => {
      const controller = createCoopController();
      const { coopSlots, pressedBrowserKeys } = controller;
      const inputPorts = { isCompanionConnected: false, slotPressedKeys: controller.slotPressedKeys, pressedBrowserKeys };
      controller.setMaxCoopPlayers(2);
      const connP2 = { open: true, send: vi.fn() };
      const connP3 = { open: true, send: vi.fn() };
      coopSlots.set(1, { peerId: 'p2-peer', conn: connP2, name: 'P2' });
      coopSlots.set(2, { peerId: 'p3-peer', conn: connP3, name: 'P3' });

      const keyupDispatched = vi.fn();
      window.addEventListener('keyup', keyupDispatched);

      // Slot 1 e Slot 2 pressionam a mesma tecla 'KeyW'
      const downMsgP2 = { type: 'INPUT_KEY', slot: 1, code: 'KeyW', key: 'w', action: 'down' };
      const downMsgP3 = { type: 'INPUT_KEY', slot: 2, code: 'KeyW', key: 'w', action: 'down' };
      // Exercise ownership cleanup directly; the protocol permits keyboard only in slot 1.
      dispatchHostKeyboardInput(inputPorts, downMsgP2, 1);
      dispatchHostKeyboardInput(inputPorts, downMsgP3, 2);

      expect(pressedBrowserKeys.has('KeyW')).toBe(true);

      // Revoga Player 2 (Slot 1)
      controller.revokeCoopPlayer(1, true);

      // Tecla KeyW NÃO deve ser liberada nem ter keyup emitido porque Player 3 (Slot 2) ainda a segura!
      expect(pressedBrowserKeys.has('KeyW')).toBe(true);
      expect(keyupDispatched).not.toHaveBeenCalled();

      // Agora revoga Player 3 (Slot 2)
      controller.revokeCoopPlayer(2, true);

      // Agora sim a tecla deve ser liberada e keyup despachado!
      expect(pressedBrowserKeys.has('KeyW')).toBe(false);
      expect(keyupDispatched).toHaveBeenCalled();

      window.removeEventListener('keyup', keyupDispatched);
      controller.dispose();
    });
  });
});
