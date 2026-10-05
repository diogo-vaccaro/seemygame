import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Fase 3: Separação de Entrypoints de Páginas (js/entries)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `
      <div id="toast-container"></div>
      <div id="terms-modal" class="modal-overlay" style="display:none;"></div>
      <main id="video-grid" class="video-grid"></main>
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('viewer-entry.js', () => {
    it('deve exportar flags e isolar recursos pesados de streamer', async () => {
      const viewerEntry = await import('../js/entries/viewer-entry.js');
      expect(viewerEntry.isViewerPage).toBe(true);
      expect(viewerEntry.isHost).toBe(false);
      expect(typeof viewerEntry.initViewerApp).toBe('function');
      expect(typeof viewerEntry.connectToStreamer).toBe('function');
      expect(viewerEntry.watchingHosts).toBeInstanceOf(Map);
    });

    it('deve extrair targetStreamerId da hash da URL', async () => {
      const viewerEntry = await import('../js/entries/viewer-entry.js');
      delete window.location;
      window.location = new URL('http://localhost/viewer.html#watch=streamer-alpha-99');

      const id = viewerEntry.getTargetStreamerId();
      expect(id).toBe('streamer-alpha-99');
    });

    it('deve inicializar aplicação de espectador e registrar plugins com role viewer', async () => {
      const viewerEntry = await import('../js/entries/viewer-entry.js');
      const app = await viewerEntry.initViewerApp({ targetStreamerId: null });

      expect(app.isViewer).toBe(true);
      expect(typeof app.connect).toBe('function');
      expect(typeof app.requestCoop).toBe('function');
      expect(typeof app.releaseCoop).toBe('function');
      expect(typeof app.submitPin).toBe('function');
      app.dispose();
    });

    it('promptViewerPin e hideViewerPinModal devem controlar modal de senha do espectador', async () => {
      const viewerEntry = await import('../js/entries/viewer-entry.js');
      document.body.innerHTML = `
        <div id="pin-prompt-modal" style="display:none;">
          <input type="password" id="viewer-pin-input">
          <div id="viewer-pin-error" style="display:none;"></div>
        </div>
      `;

      viewerEntry.promptViewerPin('host-abc', 'PIN incorreto');
      const modal = document.getElementById('pin-prompt-modal');
      const err = document.getElementById('viewer-pin-error');
      expect(modal.style.display).toBe('flex');
      expect(err.style.display).toBe('block');
      expect(err.textContent).toBe('PIN incorreto');

      viewerEntry.hideViewerPinModal();
      expect(modal.style.display).toBe('none');
      expect(err.style.display).toBe('none');
    });

    it('submitViewerPin deve validar entrada e enviar REQUEST_STREAM com PIN', async () => {
      const viewerEntry = await import('../js/entries/viewer-entry.js');
      document.body.innerHTML = `
        <div id="pin-prompt-modal" style="display:none;">
          <input type="password" id="viewer-pin-input">
          <div id="viewer-pin-error" style="display:none;"></div>
        </div>
      `;

      // Sem conexão e vazio
      expect(viewerEntry.submitViewerPin('')).toBe(false);
      const err = document.getElementById('viewer-pin-error');
      expect(err.textContent).toContain('digite o PIN');

      // Com conexão ativa
      const mockConn = {
        peer: 'streamer-test',
        open: true,
        send: vi.fn()
      };
      viewerEntry.viewerState.activeConn = mockConn;
      viewerEntry.promptViewerPin('streamer-test');
      expect(viewerEntry.submitViewerPin('1234')).toBe(true);
      expect(mockConn.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'REQUEST_STREAM',
        pin: '1234'
      }));
      viewerEntry.viewerState.activeConn = null;
    });
  });

  describe('streamer-entry.js', () => {
    it('deve exportar flags e métodos de controle do host', async () => {
      const streamerEntry = await import('../js/entries/streamer-entry.js');
      expect(streamerEntry.isStreamerPage).toBe(true);
      expect(streamerEntry.isHost).toBe(true);
      expect(typeof streamerEntry.initStreamerApp).toBe('function');
      expect(typeof streamerEntry.startCapture).toBe('function');
      expect(typeof streamerEntry.stopCapture).toBe('function');
      expect(typeof streamerEntry.setQualityProfile).toBe('function');
      expect(typeof streamerEntry.setStreamerPin).toBe('function');
      expect(typeof streamerEntry.getStreamerPin).toBe('function');
    });

    it('setQualityProfile deve atualizar bitrate e fps alvo no streamerState', async () => {
      const streamerEntry = await import('../js/entries/streamer-entry.js');
      streamerEntry.setQualityProfile('ultra');

      expect(streamerEntry.streamerState.currentProfile).toBe('ultra');
      expect(streamerEntry.streamerState.fpsTarget).toBe(60);
      expect(streamerEntry.streamerState.targetBitrateBps).toBeGreaterThan(0);
    });

    it('setStreamerPin deve sincronizar com admissionGate e persistir em localStorage', async () => {
      const streamerEntry = await import('../js/entries/streamer-entry.js');
      streamerEntry.setStreamerPin('segredo99');

      expect(streamerEntry.streamerState.streamerPin).toBe('segredo99');
      expect(streamerEntry.streamerState.admissionGate.roomPin).toBe('segredo99');
      expect(localStorage.getItem('seemygame_streamer_pin')).toBe('segredo99');

      streamerEntry.setStreamerPin(null);
      expect(streamerEntry.streamerState.streamerPin).toBeNull();
      expect(streamerEntry.streamerState.admissionGate.roomPin).toBeNull();
      expect(localStorage.getItem('seemygame_streamer_pin')).toBeNull();
    });

    it('AdmissionGate no streamerState deve autorizar e revogar espectadores', async () => {
      const streamerEntry = await import('../js/entries/streamer-entry.js');
      streamerEntry.setStreamerPin('pin123');

      expect(streamerEntry.streamerState.admissionGate.isAuthenticated('viewer-1')).toBe(false);
      expect(streamerEntry.streamerState.admissionGate.validateAuthAttempt({ pin: 'errado' })).toBe(false);
      expect(streamerEntry.streamerState.admissionGate.validateAuthAttempt({ pin: 'pin123' })).toBe(true);

      streamerEntry.streamerState.admissionGate.authenticate('viewer-1');
      expect(streamerEntry.streamerState.admissionGate.isAuthenticated('viewer-1')).toBe(true);

      streamerEntry.streamerState.admissionGate.revoke('viewer-1');
      expect(streamerEntry.streamerState.admissionGate.isAuthenticated('viewer-1')).toBe(false);
      streamerEntry.setStreamerPin(null);
    });
  });

  describe('Handshake E2E de Admissão com PIN entre Streamer e Viewer', () => {
    it('deve executar o handshake completo: desafio de PIN, rejeição com PIN incorreto e aceite com PIN correto', async () => {
      const streamerEntry = await import('../js/entries/streamer-entry.js');
      const viewerEntry = await import('../js/entries/viewer-entry.js');

      document.body.innerHTML = `
        <div id="pin-prompt-modal" style="display:none;">
          <input type="password" id="viewer-pin-input">
          <div id="viewer-pin-error" style="display:none;"></div>
        </div>
      `;

      // 1. Host configura PIN secreto
      streamerEntry.setStreamerPin('ultra-secret-pin');

      // 2. Instancia Mock de conexões
      const viewerEvents = {};
      const streamerEvents = {};

      const streamerConn = {
        peer: 'viewer-alice',
        open: true,
        on: (ev, cb) => { streamerEvents[ev] = cb; },
        send: vi.fn((data) => {
          if (viewerEvents['data']) viewerEvents['data'](data);
        })
      };

      const viewerConn = {
        peer: 'streamer-bob',
        open: true,
        on: (ev, cb) => { viewerEvents[ev] = cb; },
        send: vi.fn((data) => {
          if (streamerEvents['data']) streamerEvents['data'](data);
        })
      };

      // 3. Mock de PeerJS global
      const origPeer = globalThis.Peer;
      globalThis.Peer = class MockPeer {
        constructor() {
          this.events = {};
          this.id = 'streamer-bob';
        }
        on(ev, cb) {
          this.events[ev] = cb;
          if (ev === 'open') setTimeout(() => cb('streamer-bob'), 0);
        }
        emit(ev, ...args) {
          if (this.events[ev]) this.events[ev](...args);
        }
        call() { return null; }
        destroy() {}
      };

      // 4. Inicializa streamer
      const streamerApp = await streamerEntry.initStreamerApp();
      const streamerPeer = await streamerEntry.initStreamerPeer(null, streamerApp.session);

      // 5. Inicializa viewer
      const viewerApp = await viewerEntry.initViewerApp({ targetStreamerId: null });
      viewerEntry.viewerState.activeConn = viewerConn;
      viewerEntry.viewerState.peer = { id: 'viewer-alice' };

      // Registra listener de dados no viewer
      viewerConn.on('data', (data) => {
        if (data.type === 'PIN_REQUIRED') {
          viewerEntry.promptViewerPin('streamer-bob', data.error);
        } else if (data.type === 'PIN_ACCEPTED') {
          viewerEntry.viewerState.isAuthenticated = true;
          viewerEntry.hideViewerPinModal();
        }
      });

      // Simula conexão P2P estabelecida entre os dois
      streamerPeer.emit('connection', streamerConn);
      streamerEvents['open']();

      // Streamer deve ter enviado PIN_REQUIRED
      expect(streamerConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'PIN_REQUIRED' }));
      const modal = document.getElementById('pin-prompt-modal');
      expect(modal.style.display).toBe('flex');
      expect(streamerEntry.streamerState.admissionGate.isAuthenticated('viewer-alice')).toBe(false);

      // 6. Viewer envia PIN incorreto
      viewerEntry.submitViewerPin('pin-errado');
      expect(streamerConn.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'PIN_REQUIRED',
        error: 'PIN incorreto. Tente novamente.'
      }));
      const err = document.getElementById('viewer-pin-error');
      expect(err.textContent).toBe('PIN incorreto. Tente novamente.');
      expect(streamerEntry.streamerState.admissionGate.isAuthenticated('viewer-alice')).toBe(false);

      // 7. Viewer envia PIN correto
      viewerEntry.submitViewerPin('ultra-secret-pin');
      expect(streamerConn.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'PIN_ACCEPTED' }));
      expect(modal.style.display).toBe('none');
      expect(viewerEntry.viewerState.isAuthenticated).toBe(true);
      expect(streamerEntry.streamerState.admissionGate.isAuthenticated('viewer-alice')).toBe(true);

      // Cleanup
      streamerApp.dispose();
      viewerApp.dispose();
      streamerEntry.setStreamerPin(null);
      globalThis.Peer = origPeer;
    });
  });

  describe('room-entry.js', () => {
    it('deve exportar flags e métodos de Room multi-usuário', async () => {
      const roomEntry = await import('../js/entries/room-entry.js');
      expect(roomEntry.isRoomPage).toBe(true);
      expect(typeof roomEntry.initRoomApp).toBe('function');
      expect(typeof roomEntry.getRoomInfoFromUrl).toBe('function');
      expect(typeof roomEntry.initGreenRoomLobby).toBe('function');
    });

    it('getRoomInfoFromUrl deve extrair roomId e PIN da URL hash', async () => {
      const roomEntry = await import('../js/entries/room-entry.js');
      delete window.location;
      window.location = new URL('http://localhost/room.html#room=campeonato-fifa&pin=9876&key=abcdef1234567890abcdef12');

      const info = roomEntry.getRoomInfoFromUrl();
      expect(info.roomId).toBe('campeonato-fifa');
      expect(info.roomPin).toBe('9876');
      expect(info.roomKey).toBe('abcdef1234567890abcdef12');
    });
  });

  describe('lobby-entry.js', () => {
    it('deve exportar flags e utilitários de lobby e preflight', async () => {
      const lobbyEntry = await import('../js/entries/lobby-entry.js');
      expect(lobbyEntry.isLobbyPage).toBe(true);
      expect(typeof lobbyEntry.initLobbyApp).toBe('function');
      expect(typeof lobbyEntry.initGreenRoomPreflight).toBe('function');
      expect(typeof lobbyEntry.initDesktopAlwaysOnTop).toBe('function');
    });

    it('initLobbyApp deve configurar listeners do formulário', async () => {
      document.body.innerHTML = `
        <div id="toast-container"></div>
        <form id="lobby-form">
          <input id="lobby-user-name" value="Jogador1">
          <input id="lobby-room-id" value="">
          <button id="lobby-create-random-btn" type="button">Criar</button>
          <button id="lobby-join-btn" type="submit">Entrar</button>
        </form>
      `;

      const lobbyEntry = await import('../js/entries/lobby-entry.js');
      const app = lobbyEntry.initLobbyApp();
      expect(app.active).toBe(true);

      const randomBtn = document.getElementById('lobby-create-random-btn');
      const roomIdInput = document.getElementById('lobby-room-id');
      randomBtn.click();

      expect(roomIdInput.value.length).toBeGreaterThan(0);
      app.dispose();
      expect(app.session.isDisposed).toBe(true);
    });
  });

  describe('Ciclo de vida e Idempotência (init -> dispose -> init)', () => {
    it('viewerEntry deve suportar ciclo init -> dispose -> init sem vazamentos', async () => {
      const viewerEntry = await import('../js/entries/viewer-entry.js');
      const app1 = await viewerEntry.initViewerApp({ targetStreamerId: null });
      expect(app1.session.isDisposed).toBe(false);

      app1.dispose();
      expect(app1.session.isDisposed).toBe(true);

      const app2 = await viewerEntry.initViewerApp({ targetStreamerId: null });
      expect(app2.session.isDisposed).toBe(false);
      app2.dispose();
      expect(app2.session.isDisposed).toBe(true);
    });

    it('streamerEntry deve suportar ciclo init -> dispose -> init sem vazamentos', async () => {
      const streamerEntry = await import('../js/entries/streamer-entry.js');
      const app1 = await streamerEntry.initStreamerApp();
      expect(app1.session.isDisposed).toBe(false);

      app1.dispose();
      expect(app1.session.isDisposed).toBe(true);

      const app2 = await streamerEntry.initStreamerApp();
      expect(app2.session.isDisposed).toBe(false);
      app2.dispose();
      expect(app2.session.isDisposed).toBe(true);
    });

    it('roomEntry deve suportar ciclo init -> dispose -> init sem vazamentos', async () => {
      const roomEntry = await import('../js/entries/room-entry.js');
      const app1 = await roomEntry.initRoomApp();
      expect(app1.session.isDisposed).toBe(false);

      app1.dispose();
      expect(app1.session.isDisposed).toBe(true);

      const app2 = await roomEntry.initRoomApp();
      expect(app2.session.isDisposed).toBe(false);
      app2.dispose();
      expect(app2.session.isDisposed).toBe(true);
    });
  });

  describe('Fachada unificada em app.js', () => {
    it('deve re-exportar os inicializadores de cada entrypoint mantendo compatibilidade total', async () => {
      const app = await import('../js/app.js'); app.initLegacyBindings();
      expect(typeof app.initViewerApp).toBe('function');
      expect(typeof app.initStreamerApp).toBe('function');
      expect(typeof app.initRoomApp).toBe('function');
      expect(typeof app.initLobbyApp).toBe('function');
    });
  });

  describe('Integração de Gamepad Tester e Tuning nos Entrypoints (M1)', () => {
    it('room-entry.js deve montar setupGamepadTesterModal, setupTuningModal e responder a botões de tuning e gamepad', async () => {
      document.body.innerHTML = `
        <div id="toast-container"></div>
        <div id="terms-modal" class="modal-overlay" style="display:none;"></div>
        <button id="dock-tuning-btn">Tuning</button>
        <button id="quick-tuning-btn">⚙️</button>
        <div id="tuning-modal" class="modal-overlay" style="display: none;">
          <button id="close-tuning-modal-btn">✕</button>
          <button id="open-gamepad-tester-btn">Testar Gamepad</button>
          <button id="save-tuning-btn">Salvar</button>
        </div>
        <div id="gamepad-tester-modal" class="modal-overlay" style="display: none;">
          <button id="close-gamepad-tester-btn">✕</button>
          <button id="done-gamepad-tester-btn">Concluído</button>
          <select id="gamepad-select"></select>
          <canvas id="gamepad-3d-canvas" width="420" height="250"></canvas>
        </div>
      `;

      const roomEntry = await import('../js/entries/room-entry.js');
      const app = await roomEntry.initRoomApp();

      const tuningModal = document.getElementById('tuning-modal');
      const gamepadModal = document.getElementById('gamepad-tester-modal');
      const openGamepadBtn = document.getElementById('open-gamepad-tester-btn');
      const closeTuningBtn = document.getElementById('close-tuning-modal-btn');
      const saveTuningBtn = document.getElementById('save-tuning-btn');
      const closeGamepadBtn = document.getElementById('close-gamepad-tester-btn');

      // Verifica marcação de montagem idempotente no gamepad modal
      expect(gamepadModal.dataset.testerMounted).toBe('true');
      expect(tuningModal.dataset.tuningMounted).toBe('true');

      // Abre tuning modal via onOpenTuning do controlador se instanciado, ou exibição direta
      tuningModal.style.display = 'flex';
      expect(tuningModal.style.display).toBe('flex');

      // Clica para abrir Gamepad Tester dentro do Tuning Modal
      openGamepadBtn.click();
      expect(gamepadModal.style.display).toBe('flex');

      // Fecha Gamepad Tester
      closeGamepadBtn.click();
      expect(gamepadModal.style.display).toBe('none');

      // Fecha Tuning Modal via botão Fechar
      closeTuningBtn.click();
      expect(tuningModal.style.display).toBe('none');

      // Reabre e fecha via Salvar
      tuningModal.style.display = 'flex';
      saveTuningBtn.click();
      expect(tuningModal.style.display).toBe('none');

      app.dispose();
    });

    it('streamer-entry.js deve chamar setupGamepadTesterModal ao inicializar', async () => {
      document.body.innerHTML = `
        <div id="toast-container"></div>
        <div id="terms-modal" class="modal-overlay" style="display:none;"></div>
        <div id="gamepad-tester-modal" class="modal-overlay" style="display: none;">
          <select id="gamepad-select"></select>
          <button id="close-gamepad-tester-btn">✕</button>
        </div>
      `;

      const streamerEntry = await import('../js/entries/streamer-entry.js');
      const app = await streamerEntry.initStreamerApp();

      const gamepadModal = document.getElementById('gamepad-tester-modal');
      expect(gamepadModal.dataset.testerMounted).toBe('true');

      app.dispose();
    });

    it('viewer-entry.js deve chamar setupGamepadTesterModal ao inicializar', async () => {
      document.body.innerHTML = `
        <div id="toast-container"></div>
        <div id="terms-modal" class="modal-overlay" style="display:none;"></div>
        <div id="gamepad-tester-modal" class="modal-overlay" style="display: none;">
          <select id="gamepad-select"></select>
          <button id="close-gamepad-tester-btn">✕</button>
        </div>
      `;

      const viewerEntry = await import('../js/entries/viewer-entry.js');
      const app = await viewerEntry.initViewerApp({ targetStreamerId: null });

      const gamepadModal = document.getElementById('gamepad-tester-modal');
      expect(gamepadModal.dataset.testerMounted).toBe('true');

      app.dispose();
    });
  });
});
