import { initLegacyBindings } from '../js/app.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleIncomingP2PMessage,
  initTacticalPing,
  initFloatingReactions,
  initAdaptiveBitrate,
  initFacecam,
  initGamerFeatures,
  toggleFacecam,
  openClipPostModal,
  closeClipPostModal,
  initWhiteboard,
} from '../js/app.js';
import { tacticalPingManager } from '../js/ping.js';
import { floatingReactionsManager } from '../js/reactions.js';
import { soundboardManager } from '../js/soundboard.js';
import { adaptiveBitrateController } from '../js/abr.js';
import { clipRecorder } from '../js/clipping.js';
import { whiteboardManager } from '../js/whiteboard.js';

describe('Integração de Recursos Gamer Profissionais (app.js)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    document.body.innerHTML = `
      <div id="toast-container"></div>
      <div id="video-grid">
        <canvas id="ping-canvas" width="1280" height="720"></canvas>
        <div id="reactions-overlay"></div>
        <div id="reactions-dock" style="display: none;">
          <button class="reaction-dock-btn" data-emoji="🔥">🔥</button>
          <button class="reaction-dock-btn" data-emoji="GG">GG</button>
          <div class="ping-mode-bar">
            <button id="ping-mode-btn" class="ping-mode-btn active">📍 Ping</button>
            <button id="danger-mode-btn" class="ping-mode-btn">⚠️ Alerta</button>
          </div>
        </div>
        <div id="facecam-container" style="display: none;">
          <div class="facecam-header">
            <span>Facecam</span>
            <button id="facecam-close-btn">✕</button>
          </div>
          <video id="facecam-video"></video>
        </div>
        <video id="test-remote-video"></video>
      </div>
      <button id="clip-btn"><span>🎬</span> Clipa isso!</button>
      <button id="abr-toggle-btn" class="active"><span>⚡</span> ABR (Auto)</button>
      <button id="pip-btn"><span>📺</span> PiP</button>
      <button id="toggle-facecam-btn"><span>📷</span> Ligar Câmera</button>

      <div id="clip-post-modal" style="display: none;">
        <button id="clip-post-close-btn">✕</button>
        <video id="clip-preview-video"></video>
        <button id="clip-download-video-btn">Baixar Vídeo</button>
        <span id="clip-audio-status"></span>
        <input type="range" id="clip-trim-start-slider" value="0">
        <input type="range" id="clip-trim-end-slider" value="3">
        <span id="clip-trim-start-val">0.0s</span>
        <span id="clip-trim-end-val">3.0s</span>
        <span id="clip-trim-duration-val">3.0s</span>
        <button class="btn-preset-quick" data-preset-range="first3">Primeiros 3s</button>
        <button class="btn-preset-quick" data-preset-range="last3">Últimos 3s</button>
        <button class="btn-preset-quick" data-preset-range="last5">Últimos 5s</button>
        <button class="btn-preset-quick" data-preset-range="all">Tudo</button>
        <div id="clip-effects-grid"></div>
        <button id="clip-preview-audio-btn">Ouvir Prévia</button>
        <button id="clip-download-wav-btn">Baixar WAV</button>
        <button id="clip-broadcast-voice-btn">Tocar na Voz</button>
      </div>

      <button id="toggle-whiteboard-btn"><span>🎨</span> Lousa</button>

      <div id="whiteboard-modal" style="display: none;">
        <button id="wb-close-btn">✕</button>
        <div id="whiteboard-tools-group">
          <button class="wb-tool-btn active" data-tool="pencil">✏️</button>
          <button class="wb-tool-btn" data-tool="rectangle">⬜</button>
          <button class="wb-tool-btn" data-tool="circle">⭕</button>
          <button class="wb-tool-btn" data-tool="eraser">🧼</button>
        </div>
        <div id="wb-stroke-palette">
          <button class="wb-color-dot active" data-color="#ffffff"></button>
          <button class="wb-color-dot" data-color="#ef4444"></button>
          <button class="wb-color-dot" data-color="#10b981"></button>
        </div>
        <div id="wb-width-group">
          <button class="wb-opt-btn" data-width="2">Fina</button>
          <button class="wb-opt-btn active" data-width="4">Média</button>
          <button class="wb-opt-btn" data-width="8">Grossa</button>
        </div>
        <div id="wb-fill-group">
          <button class="wb-opt-btn active" data-fill="none">Vazio</button>
          <button class="wb-opt-btn" data-fill="semi">Semi</button>
        </div>
        <div id="wb-rough-group">
          <button class="wb-opt-btn active" data-rough="true">Rascunho</button>
          <button class="wb-opt-btn" data-rough="false">Preciso</button>
        </div>
        <div id="wb-bg-group">
          <button class="wb-opt-btn active" data-bg="dark">Dark</button>
          <button class="wb-opt-btn" data-bg="transparent">Overlay</button>
        </div>
        <button id="wb-undo-btn">↩️</button>
        <button id="wb-redo-btn">↪️</button>
        <button id="wb-clear-btn">🗑️</button>
        <button id="wb-export-btn">💾</button>
        <button id="wb-chat-btn">💬</button>
        <canvas id="whiteboard-canvas" width="1280" height="720"></canvas>
      </div>
    `;
  });

  afterEach(() => {
    tacticalPingManager.clear();
  });

  describe('Mensagens P2P de Recursos Gamer', () => {
    it('deve processar TACTICAL_PING e registrar no tacticalPingManager', () => {
      const addPingSpy = vi.spyOn(tacticalPingManager, 'addPing');
      const pingData = {
        type: 'TACTICAL_PING',
        ping: { x: 0.4, y: 0.6, type: 'danger', senderName: 'PlayerX' }
      };

      handleIncomingP2PMessage(pingData, null);

      expect(addPingSpy).toHaveBeenCalledWith(pingData.ping);
    });

    it('deve processar TACTICAL_LASER e adicionar ponto no tacticalPingManager', () => {
      const addLaserSpy = vi.spyOn(tacticalPingManager, 'addLaserPoint');
      const laserData = {
        type: 'TACTICAL_LASER',
        point: { x: 0.25, y: 0.35, color: '#00ffff' }
      };

      handleIncomingP2PMessage(laserData, null);

      expect(addLaserSpy).toHaveBeenCalledWith({ ...laserData.point, senderId: 'local' });
    });

    it('deve processar EMOJI_REACTION e instanciar reação flutuante', () => {
      const spawnSpy = vi.spyOn(floatingReactionsManager, 'spawnReaction');
      const reactionData = {
        type: 'EMOJI_REACTION',
        emoji: '🔥',
        xPercent: 50,
        senderName: 'Torcedor'
      };

      handleIncomingP2PMessage(reactionData, null);

      expect(spawnSpy).toHaveBeenCalledWith({
        emoji: '🔥',
        xPercent: 50,
        senderName: 'Torcedor'
      });
    });

    it('deve processar SOUNDBOARD_PLAY e tocar o efeito de som solicitado', () => {
      const playSpy = vi.spyOn(soundboardManager, 'playSound').mockReturnValue(true);
      const soundData = {
        type: 'SOUNDBOARD_PLAY',
        soundId: 'victory',
        senderName: 'Capitão'
      };

      handleIncomingP2PMessage(soundData, null);

      expect(playSpy).toHaveBeenCalledWith('victory');
    });

    it('deve processar SOUNDBOARD_PLAY_CUSTOM e disparar notificação com áudio', () => {
      const customData = {
        type: 'SOUNDBOARD_PLAY_CUSTOM',
        audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
        effectName: '🐿️ Esquilo',
        senderName: 'Streamer'
      };

      expect(() => handleIncomingP2PMessage(customData, null)).not.toThrow();
    });

    it('deve processar WHITEBOARD_ELEMENT_ADD e adicionar elemento na lousa', () => {
      const addElementSpy = vi.spyOn(whiteboardManager, 'addElement');
      const data = {
        type: 'WHITEBOARD_ELEMENT_ADD',
        element: { id: 'wb-remote-1', type: 'circle', startX: 10, startY: 10, endX: 50, endY: 50 }
      };

      handleIncomingP2PMessage(data, null);
      expect(addElementSpy).toHaveBeenCalledWith(data.element, false);
    });

    it('deve processar WHITEBOARD_CLEAR e limpar a lousa', () => {
      const clearSpy = vi.spyOn(whiteboardManager, 'clear');
      handleIncomingP2PMessage({ type: 'WHITEBOARD_CLEAR' }, null);
      expect(clearSpy).toHaveBeenCalledWith(false);
    });

    it('deve processar WHITEBOARD_CURSOR e atualizar cursor multiplayer', () => {
      const cursorSpy = vi.spyOn(whiteboardManager, 'updateRemoteCursor');
      const cursorData = {
        type: 'WHITEBOARD_CURSOR',
        x: 0.5,
        y: 0.5,
        userName: 'PlayerX',
        color: '#ef4444'
      };

      handleIncomingP2PMessage(cursorData, { peer: 'peer-cursor' });
      expect(cursorSpy).toHaveBeenCalledWith('peer-cursor', {
        x: 0.5,
        y: 0.5,
        userName: 'PlayerX',
        color: '#ef4444'
      });
    });

    it('deve processar WHITEBOARD_SYNC e carregar elementos na lousa', () => {
      const syncSpy = vi.spyOn(whiteboardManager, 'setElements');
      const elements = [{ id: '1', type: 'line', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }];
      handleIncomingP2PMessage({ type: 'WHITEBOARD_SYNC', elements }, null);
      expect(syncSpy).toHaveBeenCalledWith(elements);
    });
  });

  describe('Tactical Ping Canvas & Interação', () => {
    it('initTacticalPing deve associar o canvas e alternar entre modos ping e danger', () => {
      initTacticalPing();

      const pingBtn = document.getElementById('ping-mode-btn');
      const dangerBtn = document.getElementById('danger-mode-btn');

      expect(pingBtn.classList.contains('active')).toBe(true);

      dangerBtn.click();
      expect(dangerBtn.classList.contains('active')).toBe(true);
      expect(pingBtn.classList.contains('active')).toBe(false);

      pingBtn.click();
      expect(pingBtn.classList.contains('active')).toBe(true);
      expect(dangerBtn.classList.contains('active')).toBe(false);
    });

    it('clique no canvas deve disparar addPing com coordenadas relativas normalizadas', () => {
      initTacticalPing();
      const canvas = document.getElementById('ping-canvas');
      const addPingSpy = vi.spyOn(tacticalPingManager, 'addPing');

      canvas.getBoundingClientRect = () => ({
        left: 100,
        top: 50,
        width: 1000,
        height: 500,
      });

      const pointerEvent = new MouseEvent('pointerdown', {
        clientX: 600,
        clientY: 300,
        button: 0,
      });

      canvas.dispatchEvent(pointerEvent);

      expect(addPingSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          x: 0.5,
          y: 0.5,
          type: 'ping'
        })
      );
    });

    it('clique sobre botão ou cabeçalho de controle NÃO deve disparar addPing', () => {
      initTacticalPing();
      const canvas = document.getElementById('ping-canvas');
      const addPingSpy = vi.spyOn(tacticalPingManager, 'addPing');

      const headerBtn = document.createElement('button');
      headerBtn.className = 'card-btn';
      document.body.appendChild(headerBtn);

      const origElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn(() => headerBtn);

      try {
        const pointerEvent = new MouseEvent('pointerdown', {
          clientX: 200,
          clientY: 20,
          button: 0,
        });
        canvas.dispatchEvent(pointerEvent);

        expect(addPingSpy).not.toHaveBeenCalled();
      } finally {
        document.elementFromPoint = origElementFromPoint;
        headerBtn.remove();
      }
    });
  });

  describe('Reações Rápidas e Adaptive Bitrate', () => {
    it('clicar em botão do reactions-dock deve chamar spawnReaction', () => {
      initFloatingReactions();
      const spawnSpy = vi.spyOn(floatingReactionsManager, 'spawnReaction');
      const reactionBtn = document.querySelector('.reaction-dock-btn');

      reactionBtn.click();

      expect(spawnSpy).toHaveBeenCalled();
    });

    it('initAdaptiveBitrate deve permitir alternar estado ativo do ABR', () => {
      initAdaptiveBitrate();
      const btn = document.getElementById('abr-toggle-btn');

      expect(adaptiveBitrateController.isEnabled).toBe(true);

      btn.click();
      expect(adaptiveBitrateController.isEnabled).toBe(false);

      btn.click();
      expect(adaptiveBitrateController.isEnabled).toBe(true);
    });
  });

  describe('Facecam Overlay', () => {
    it('toggleFacecam deve iniciar getUserMedia e exibir o container de facecam', async () => {
      const mockTrack = { stop: vi.fn(), kind: 'video' };
      const mockStream = {
        getTracks: () => [mockTrack],
        getVideoTracks: () => [mockTrack],
      };

      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      };

      const container = document.getElementById('facecam-container');
      const videoEl = document.getElementById('facecam-video');
      const toggleBtn = document.getElementById('toggle-facecam-btn');

      initFacecam();
      expect(container.style.display).toBe('none');
      expect(toggleBtn.textContent).toContain('Ligar Câmera');

      await toggleFacecam();

      expect(container.style.display).toBe('flex');
      expect(toggleBtn.classList.contains('active')).toBe(true);
      expect(toggleBtn.textContent).toContain('Desligar Facecam');
      expect(videoEl.srcObject).toBe(mockStream);

      await toggleFacecam();

      expect(container.style.display).toBe('none');
      expect(mockTrack.stop).toHaveBeenCalled();
      expect(toggleBtn.classList.contains('active')).toBe(false);
      expect(toggleBtn.textContent).toContain('Ligar Câmera');
    });

    it('clicar no botão toggle-facecam-btn deve alternar estado e atualizar texto sem duplicar listeners', async () => {
      const mockTrack = { stop: vi.fn(), kind: 'video' };
      const mockStream = {
        getTracks: () => [mockTrack],
        getVideoTracks: () => [mockTrack],
      };

      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      };

      const container = document.getElementById('facecam-container');
      const toggleBtn = document.getElementById('toggle-facecam-btn');

      // Chama initFacecam duas vezes para garantir que listeners não sejam duplicados
      initFacecam();
      initFacecam();

      toggleBtn.click();
      await new Promise(r => setTimeout(r, 10));

      expect(container.style.display).toBe('flex');
      expect(toggleBtn.classList.contains('active')).toBe(true);
      expect(toggleBtn.textContent).toContain('Desligar Facecam');

      toggleBtn.click();
      await new Promise(r => setTimeout(r, 10));

      expect(container.style.display).toBe('none');
      expect(mockTrack.stop).toHaveBeenCalled();
      expect(toggleBtn.classList.contains('active')).toBe(false);
      expect(toggleBtn.textContent).toContain('Ligar Câmera');
    });
  });

  describe('Clipping e PiP via Botões', () => {
    it('clique em #clip-btn com gravação inativa deve alertar o usuário', () => {
      initGamerFeatures();
      const clipBtn = document.getElementById('clip-btn');

      clipRecorder.isRecording = false;
      const exportSpy = vi.spyOn(clipRecorder, 'exportClip');

      clipBtn.click();

      expect(exportSpy).not.toHaveBeenCalled();
    });

    it('clique em #clip-btn com gravação ativa deve chamar exportClip', async () => {
      initGamerFeatures();
      const clipBtn = document.getElementById('clip-btn');

      clipRecorder.isRecording = true;
      const exportSpy = vi.spyOn(clipRecorder, 'exportClip').mockResolvedValue({
        blob: new Blob(['clip'], { type: 'video/webm' }),
        fileName: 'clip-test.webm'
      });

      clipBtn.click();

      expect(exportSpy).toHaveBeenCalled();
      clipRecorder.isRecording = false;
    });

    it('pressionar a tecla C deve acionar #clip-btn quando a gravação estiver ativa', async () => {
      initGamerFeatures();
      const clipBtn = document.getElementById('clip-btn');
      clipBtn.style.display = 'inline-flex';
      const clickSpy = vi.spyOn(clipBtn, 'click');

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));

      expect(clickSpy).toHaveBeenCalled();
    });

    it('clique em #pip-btn deve invocar requestPictureInPicture no vídeo', async () => {
      initGamerFeatures();
      const pipBtn = document.getElementById('pip-btn');
      const videoEl = document.getElementById('test-remote-video');

      document.pictureInPictureEnabled = true;
      videoEl.requestPictureInPicture = vi.fn().mockResolvedValue({});

      pipBtn.click();

      expect(videoEl.requestPictureInPicture).toHaveBeenCalled();
    });
  });

  describe('Modal Pós-Clipping e Gerador de Áudio Meme', () => {
    it('clique em #clip-btn com gravação ativa deve abrir #clip-post-modal', async () => {
      initGamerFeatures();
      const clipBtn = document.getElementById('clip-btn');
      const modal = document.getElementById('clip-post-modal');

      clipRecorder.isRecording = true;
      const fakeBlob = new Blob(['clip'], { type: 'video/webm' });
      fakeBlob.fileName = 'clip-test.webm';
      vi.spyOn(clipRecorder, 'exportClip').mockResolvedValue(fakeBlob);

      clipBtn.click();
      await new Promise(r => setTimeout(r, 10));

      expect(modal.style.display).toBe('flex');
      clipRecorder.isRecording = false;
    });

    it('openClipPostModal deve renderizar chips de efeitos sonoros', async () => {
      const fakeBlob = new Blob(['clip'], { type: 'video/webm' });
      await openClipPostModal(fakeBlob);

      const modal = document.getElementById('clip-post-modal');
      expect(modal.style.display).toBe('flex');

      const grid = document.getElementById('clip-effects-grid');
      const chips = grid.querySelectorAll('.clip-effect-chip');
      expect(chips.length).toBeGreaterThanOrEqual(8);

      // Clicar no chip de esquilo
      const chipmunkChip = Array.from(chips).find(c => c.dataset.effectId === 'chipmunk');
      expect(chipmunkChip).toBeDefined();
      chipmunkChip.click();
      expect(chipmunkChip.classList.contains('active')).toBe(true);
    });

    it('sliders de trimming e atalhos rápidos devem atualizar os labels de tempo', async () => {
      const fakeBlob = new Blob(['clip'], { type: 'video/webm' });
      await openClipPostModal(fakeBlob);

      const startSlider = document.getElementById('clip-trim-start-slider');
      const endSlider = document.getElementById('clip-trim-end-slider');
      const startVal = document.getElementById('clip-trim-start-val');
      const endVal = document.getElementById('clip-trim-end-val');
      const durationVal = document.getElementById('clip-trim-duration-val');

      endSlider.value = '9.5';
      startSlider.value = '5.0';
      startSlider.oninput();
      expect(startVal.textContent).toBe('5.0s');
      expect(endVal.textContent).toBe('9.5s');
      expect(durationVal.textContent).toBe('4.5s');

      // Testar botão de atalho rápido
      const btnFirst3 = document.querySelector('.btn-preset-quick[data-preset-range="first3"]');
      btnFirst3.click();
      expect(startSlider.value).toBe('0');
      expect(startVal.textContent).toBe('0.0s');
    });

    it('closeClipPostModal e botão de fechar devem ocultar o modal', async () => {
      const fakeBlob = new Blob(['clip'], { type: 'video/webm' });
      await openClipPostModal(fakeBlob);
      const modal = document.getElementById('clip-post-modal');
      expect(modal.style.display).toBe('flex');

      const closeBtn = document.getElementById('clip-post-close-btn');
      closeBtn.click();
      expect(modal.style.display).toBe('none');

      await openClipPostModal(fakeBlob);
      expect(modal.style.display).toBe('flex');
      closeClipPostModal();
      expect(modal.style.display).toBe('none');
    });

    it('openClipPostModal deve carregar preview no elemento <video> e closeClipPostModal deve pausar e limpar', async () => {
      const fakeBlob = new Blob(['clip-video-content'], { type: 'video/webm' });
      const previewVideo = document.getElementById('clip-preview-video');
      await openClipPostModal(fakeBlob);
      expect(previewVideo.src).toBeTruthy();
      expect(previewVideo._blobUrl).toBeTruthy();

      closeClipPostModal();
      expect(previewVideo.pause).toHaveBeenCalled();
      expect(previewVideo._blobUrl).toBeNull();
    });
  });

  describe('Lousa Interativa Colaborativa (Excalidraw Style)', () => {
    it('clicar em #toggle-whiteboard-btn deve alternar abertura da lousa', () => {
      initWhiteboard();
      const toggleBtn = document.getElementById('toggle-whiteboard-btn');
      const modal = document.getElementById('whiteboard-modal');

      expect(modal.style.display).toBe('none');

      toggleBtn.click();
      expect(modal.style.display).toBe('flex');

      toggleBtn.click();
      expect(modal.style.display).toBe('none');
    });

    it('botões de ferramentas da lousa devem atualizar selectedTool e classe active', () => {
      initWhiteboard();
      const rectBtn = document.querySelector('.wb-tool-btn[data-tool="rectangle"]');
      rectBtn.click();

      expect(whiteboardManager.selectedTool).toBe('rectangle');
      expect(rectBtn.classList.contains('active')).toBe(true);
    });

    it('paleta de cores e modo de fundo devem atualizar parâmetros do whiteboardManager', () => {
      initWhiteboard();
      const redDot = document.querySelector('.wb-color-dot[data-color="#ef4444"]');
      redDot.click();
      expect(whiteboardManager.currentColor).toBe('#ef4444');

      const overlayBtn = document.querySelector('#wb-bg-group .wb-opt-btn[data-bg="transparent"]');
      overlayBtn.click();
      expect(whiteboardManager.backgroundMode).toBe('transparent');
    });

    it('botão de fechar lousa #wb-close-btn deve ocultar o modal', () => {
      initWhiteboard();
      const toggleBtn = document.getElementById('toggle-whiteboard-btn');
      const closeBtn = document.getElementById('wb-close-btn');
      const modal = document.getElementById('whiteboard-modal');

      toggleBtn.click();
      expect(modal.style.display).toBe('flex');

      closeBtn.click();
      expect(modal.style.display).toBe('none');
    });
  });
});

initLegacyBindings();
