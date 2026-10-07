/**
 * SeeMyGame - RoomToolsController
 * Orquestrador da suíte de ferramentas da sala:
 * - Telestrator (Anotações ao vivo sobre o vídeo)
 * - Enquetes em tempo real (Polls) com publicação no chat
 * - Gravação multitrack isolada e exportação em ZIP
 * - Modo Streamer (Anti-sniping e mascaramento de senhas)
 * - Picture-in-Picture flutuante
 */

import { streamerMode } from './streamer-mode.js';
import { pipController } from './pip-controller.js';
import { annotateManager } from './annotate.js';
import { pollManager } from './poll-manager.js';
import { multitrackRecorder } from './multitrack-recorder.js';

export class RoomToolsController {
  constructor() {
    this.session = null;
    this.broadcast = null;
    this.chatManager = null;
    this.getPeerId = null;
    this.getDisplayName = null;
    this.getActiveVideoStream = null;
    this.getVoiceStreams = null;

    this.isMenuOpen = false;
    this.menuEl = null;
    this.cleanups = [];
  }

  bindSession({
    session = null,
    broadcast = null,
    chatManager = null,
    getPeerId = () => 'me',
    getDisplayName = () => 'Jogador',
    getActiveVideoStream = () => null,
    getVoiceStreams = () => ({})
  } = {}) {
    this.session = session;
    this.broadcast = broadcast;
    this.chatManager = chatManager;
    this.getPeerId = getPeerId;
    this.getDisplayName = getDisplayName;
    this.getActiveVideoStream = getActiveVideoStream;
    this.getVoiceStreams = getVoiceStreams;

    // Conectar broadcast nos managers
    if (broadcast) {
      annotateManager.setBroadcast(broadcast);
      pollManager.setBroadcast(broadcast);
    }

    // Publicação automática de enquetes no chat
    pollManager.setOnChatAnnounce((summaryText) => {
      if (!this.chatManager) return;
      if (typeof this.chatManager.sendMessage === 'function') {
        this.chatManager.sendMessage(summaryText);
      } else if (typeof this.chatManager.createMessage === 'function') {
        const msg = this.chatManager.createMessage({
          senderId: this.getPeerId ? this.getPeerId() : 'system',
          senderName: '📊 Enquete',
          role: 'system',
          text: summaryText,
          channel: this.chatManager.getActiveChannel ? this.chatManager.getActiveChannel() : 'geral',
          isSystem: true
        });
        const stored = msg && this.chatManager.addMessage(msg);
        if (stored && this.broadcast) {
          this.broadcast({ type: 'CHAT_MESSAGE', message: stored });
        }
      }
    });

    // Registrar handlers no session.dispatcher se disponível
    if (session?.dispatcher) {
      const d = session.dispatcher;
      const unsubs = [
        d.register('ANNOTATE_DRAW', (data) => annotateManager.handleRemoteMessage(data)),
        d.register('ANNOTATE_CLEAR', (data) => annotateManager.handleRemoteMessage(data)),
        d.register('ANNOTATE_SYNC', (data) => annotateManager.handleRemoteMessage(data)),
        d.register('ANNOTATE_REQUEST_SYNC', (data) => annotateManager.handleRemoteMessage(data)),
        d.register('POLL_CREATE', (data) => pollManager.handleRemoteMessage(data)),
        d.register('POLL_VOTE', (data) => pollManager.handleRemoteMessage(data)),
        d.register('POLL_END', (data) => pollManager.handleRemoteMessage(data)),
        d.register('POLL_SYNC_REQUEST', (data) => pollManager.handleRemoteMessage(data)),
        d.register('POLL_SYNC', (data) => pollManager.handleRemoteMessage(data))
      ];
      this.cleanups.push(() => unsubs.forEach(u => u()));
    }
  }

  bindDOM() {
    // 1. Botão do Modo Streamer no Header
    const streamerBtn = document.getElementById('streamer-mode-btn');
    if (streamerBtn && (!streamerMode.elements || streamerMode.elements.toggleBtn !== streamerBtn)) {
      const updateStreamerUI = (active) => {
        streamerBtn.classList.toggle('active', active);
        streamerBtn.setAttribute('aria-pressed', String(active));
      };
      const unsub = streamerMode.onChange(updateStreamerUI);
      this.cleanups.push(unsub);

      const onClick = () => streamerMode.toggle();
      streamerBtn.addEventListener('click', onClick);
      this.cleanups.push(() => streamerBtn.removeEventListener('click', onClick));
    }

    // 2. Botão de Ferramentas da Sala no Dock Inferior
    const toolsBtn = document.getElementById('dock-room-tools-btn');
    if (toolsBtn) {
      const toggleMenu = (e) => {
        e.stopPropagation();
        this.toggleMenu();
      };
      toolsBtn.addEventListener('click', toggleMenu);
      this.cleanups.push(() => toolsBtn.removeEventListener('click', toggleMenu));
    }

    // 3. Fechar menu ao clicar fora ou tecla Escape
    const onDocClick = (e) => {
      if (this.isMenuOpen && this.menuEl && !this.menuEl.contains(e.target) && e.target !== toolsBtn) {
        this.closeMenu();
      }
    };
    const onDocKeydown = (e) => {
      if (e.key === 'Escape') {
        if (this.isMenuOpen) this.closeMenu();
        this.closePollModal();
        this.closeMultitrackModal();
      }
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKeydown);
    this.cleanups.push(() => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKeydown);
    });

    // 4. Modal de Enquete e Modal Multitrack
    this._bindPollModal();
    this._bindMultitrackModal();
  }

  toggleMenu() {
    if (this.isMenuOpen) {
      this.closeMenu();
    } else {
      this.openMenu();
    }
  }

  openMenu() {
    this.closeMenu();
    const dock = document.getElementById('bottom-control-dock') || document.body;
    const menu = document.createElement('div');
    menu.id = 'room-tools-menu';
    menu.className = 'room-tools-menu glass-panel';
    menu.setAttribute('role', 'menu');

    menu.innerHTML = `
      <div class="room-tools-header">
        <span>🛠️ Ferramentas da Sala</span>
        <button type="button" class="room-tools-close" aria-label="Fechar">✖️</button>
      </div>
      <div class="room-tools-list">
        <button type="button" class="room-tool-item" data-action="annotate">
          <span class="tool-icon">✏️</span>
          <div class="tool-info">
            <strong>Anotar no Vídeo</strong>
            <small>Desenhe táticas diretamente sobre o stream</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="poll">
          <span class="tool-icon">📊</span>
          <div class="tool-info">
            <strong>Enquetes ao Vivo</strong>
            <small>Crie votações rápidas com resultado no chat</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="multitrack">
          <span class="tool-icon">⏺️</span>
          <div class="tool-info">
            <strong>Gravação Multitrack</strong>
            <small>Grave streams e microfones em ZIP isolado</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="streamer">
          <span class="tool-icon">🕶️</span>
          <div class="tool-info">
            <strong>Modo Streamer</strong>
            <small>Mascara senhas e evita stream-sniping</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="pip">
          <span class="tool-icon">📺</span>
          <div class="tool-info">
            <strong>Picture-in-Picture</strong>
            <small>Destacar transmissão em janela flutuante</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="whiteboard">
          <span class="tool-icon">🎨</span>
          <div class="tool-info">
            <strong>Lousa Colaborativa</strong>
            <small>Abrir quadro branco compartilhado</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="soundboard">
          <span class="tool-icon">📻</span>
          <div class="tool-info">
            <strong>Mesa de Sons</strong>
            <small>Efeitos de áudio e memes para o canal de voz</small>
          </div>
        </button>
      </div>
    `;

    menu.querySelector('.room-tools-close')?.addEventListener('click', () => this.closeMenu());

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (!item) return;
      const action = item.dataset.action;
      this.closeMenu();
      this.executeAction(action);
    });

    document.body.appendChild(menu);
    this.menuEl = menu;
    this.isMenuOpen = true;
  }

  closeMenu() {
    if (this.menuEl) {
      if (this.menuEl.parentElement) {
        this.menuEl.parentElement.removeChild(this.menuEl);
      }
      this.menuEl = null;
    }
    this.isMenuOpen = false;
  }

  executeAction(action) {
    switch (action) {
      case 'annotate':
        this.toggleAnnotate();
        break;
      case 'poll':
        this.openPollModal();
        break;
      case 'multitrack':
        this.openMultitrackModal();
        break;
      case 'streamer':
        streamerMode.toggle();
        break;
      case 'pip':
        this.togglePip();
        break;
      case 'whiteboard':
        document.getElementById('dock-whiteboard-btn')?.click();
        break;
      case 'soundboard':
        document.getElementById('toggle-soundboard-btn')?.click();
        break;
    }
  }

  toggleAnnotate() {
    if (annotateManager.isActive) {
      annotateManager.detach();
      return;
    }

    // Procurar vídeo principal ativo
    const activeVideo = document.querySelector('.video-card.active video, .video-card video, #video-grid video, video');
    if (!activeVideo) {
      if (typeof window !== 'undefined' && window.alert) {
        window.alert('Nenhuma transmissão de vídeo ativa na sala para fazer anotações.');
      }
      return;
    }

    const container = activeVideo.closest('.video-card') || activeVideo.parentElement;
    annotateManager.attach(container, activeVideo);
    annotateManager.createToolbar(container);
  }

  togglePip() {
    const activeVideo = document.querySelector('.video-card.active video, .video-card video, #video-grid video, video');
    if (!activeVideo) {
      if (typeof window !== 'undefined' && window.alert) {
        window.alert('Nenhuma transmissão de vídeo ativa para Picture-in-Picture.');
      }
      return;
    }
    const container = activeVideo.closest('.video-card') || activeVideo.parentElement;
    pipController.toggleVideoPip(activeVideo, container);
  }

  openPollModal() {
    this.closeMultitrackModal();
    const modal = document.getElementById('poll-modal');
    if (modal) {
      modal.style.display = 'flex';
      this._updatePollModalView();
    }
  }

  closePollModal() {
    const modal = document.getElementById('poll-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  }

  _bindPollModal() {
    const modal = document.getElementById('poll-modal');
    if (!modal) return;

    modal.querySelector('.poll-modal-close')?.addEventListener('click', () => this.closePollModal());
    modal.querySelector('#poll-cancel-btn')?.addEventListener('click', () => this.closePollModal());

    const form = modal.querySelector('#poll-create-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const questionInput = modal.querySelector('#poll-question-input');
        const opt1 = modal.querySelector('#poll-opt-1');
        const opt2 = modal.querySelector('#poll-opt-2');
        const opt3 = modal.querySelector('#poll-opt-3');
        const opt4 = modal.querySelector('#poll-opt-4');
        const durationSelect = modal.querySelector('#poll-duration-select');

        const question = questionInput?.value?.trim();
        const options = [opt1?.value, opt2?.value, opt3?.value, opt4?.value].filter(Boolean);
        const durationSeconds = Math.max(5, parseInt(durationSelect?.value || '60', 10) || 60);

        if (!question || options.length < 2) {
          alert('Informe a pergunta e pelo menos 2 opções.');
          return;
        }

        const creatorId = this.getPeerId ? this.getPeerId() : 'me';
        const creatorName = this.getDisplayName ? this.getDisplayName() : 'Jogador';

        pollManager.createPoll({
          question,
          options,
          durationSeconds,
          creatorId,
          creatorName
        });

        // Limpar form
        if (questionInput) questionInput.value = '';
        if (opt1) opt1.value = '';
        if (opt2) opt2.value = '';
        if (opt3) opt3.value = '';
        if (opt4) opt4.value = '';

        this._updatePollModalView();
      });
    }

    // Atualizar view do modal ao mudar estado da enquete
    pollManager.onPollChange(() => {
      if (modal.style.display !== 'none') {
        this._updatePollModalView();
      }
    });
  }

  _updatePollModalView() {
    const modal = document.getElementById('poll-modal');
    if (!modal) return;

    const createSection = modal.querySelector('#poll-create-section');
    const activeSection = modal.querySelector('#poll-active-section');
    const container = modal.querySelector('#poll-active-card-container');

    if (pollManager.currentPoll && pollManager.currentPoll.isActive) {
      if (createSection) createSection.style.display = 'none';
      if (activeSection) activeSection.style.display = 'block';
      if (container) {
        pollManager.renderPollCard(container, this.getPeerId ? this.getPeerId() : 'me');
      }
    } else {
      if (createSection) createSection.style.display = 'block';
      if (activeSection) activeSection.style.display = 'none';
    }
  }

  openMultitrackModal() {
    this.closePollModal();
    const modal = document.getElementById('multitrack-modal');
    if (modal) {
      modal.style.display = 'flex';
      this._updateMultitrackModalUI();
    }
  }

  closeMultitrackModal() {
    const modal = document.getElementById('multitrack-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  }

  _bindMultitrackModal() {
    const modal = document.getElementById('multitrack-modal');
    if (!modal) return;

    modal.querySelector('.multitrack-modal-close')?.addEventListener('click', () => this.closeMultitrackModal());
    modal.querySelector('#multitrack-cancel-btn')?.addEventListener('click', () => this.closeMultitrackModal());

    const startBtn = modal.querySelector('#multitrack-start-btn');
    const stopBtn = modal.querySelector('#multitrack-stop-btn');

    startBtn?.addEventListener('click', async () => {
      try {
        const tracks = {};
        const masterStream = this.getActiveVideoStream ? this.getActiveVideoStream() : null;
        if (masterStream) {
          tracks.master = masterStream;
        }

        const voiceStreams = this.getVoiceStreams ? this.getVoiceStreams() : {};
        if (voiceStreams.localMic) {
          tracks.hostMic = voiceStreams.localMic;
        }
        if (voiceStreams.participants) {
          tracks.participants = voiceStreams.participants;
        }

        // Se nenhuma track específica foi obtida por helpers, tenta capturar streams do DOM
        if (Object.keys(tracks).length === 0) {
          const videoEl = document.querySelector('video');
          if (videoEl && videoEl.srcObject) {
            tracks.master = videoEl.srcObject;
          }
        }

        if (Object.keys(tracks).length === 0) {
          alert('Nenhuma faixa de stream ou microfone ativa encontrada para gravar.');
          return;
        }

        await multitrackRecorder.startRecording(tracks);
        this._updateMultitrackModalUI();
      } catch (err) {
        alert('Erro ao iniciar gravação multitrack: ' + err.message);
      }
    });

    stopBtn?.addEventListener('click', async () => {
      try {
        stopBtn.disabled = true;
        stopBtn.textContent = '📦 Gerando ZIP...';
        await multitrackRecorder.exportZip({
          autoDownload: true
        });
        alert('Gravação concluída! O download do arquivo .ZIP multitrack foi iniciado.');
        this._updateMultitrackModalUI();
      } catch (err) {
        alert('Erro ao exportar gravação: ' + err.message);
      } finally {
        stopBtn.disabled = false;
        stopBtn.textContent = '⏹️ Parar & Baixar ZIP';
      }
    });

    multitrackRecorder.on('tick', ({ duration }) => {
      const timerEl = modal.querySelector('#multitrack-timer');
      if (timerEl) {
        const sec = Math.floor(duration / 1000);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        timerEl.textContent = `🔴 REC ${m}:${s < 10 ? '0' : ''}${s}`;
      }
    });

    multitrackRecorder.on('start', () => this._updateMultitrackModalUI());
    multitrackRecorder.on('stop', () => this._updateMultitrackModalUI());
  }

  _updateMultitrackModalUI() {
    const modal = document.getElementById('multitrack-modal');
    if (!modal) return;

    const startBtn = modal.querySelector('#multitrack-start-btn');
    const stopBtn = modal.querySelector('#multitrack-stop-btn');
    const timerEl = modal.querySelector('#multitrack-timer');
    const statusEl = modal.querySelector('#multitrack-status-badge');

    if (multitrackRecorder.isRecording) {
      if (startBtn) startBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'inline-flex';
      if (timerEl) timerEl.style.display = 'inline-block';
      if (statusEl) {
        statusEl.className = 'status-badge status-badge-recording';
        statusEl.textContent = 'Gravando em andamento';
      }
    } else {
      if (startBtn) startBtn.style.display = 'inline-flex';
      if (stopBtn) stopBtn.style.display = 'none';
      if (timerEl) timerEl.style.display = 'none';
      if (statusEl) {
        statusEl.className = 'status-badge status-badge-idle';
        statusEl.textContent = 'Pronto para gravar';
      }
    }
  }

  dispose() {
    this.closeMenu();
    this.cleanups.forEach(c => c());
    this.cleanups = [];
  }
}

export const roomToolsController = new RoomToolsController();
