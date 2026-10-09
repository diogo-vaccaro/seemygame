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
import { roomLayoutController } from './room-layout.js';
import { notepadManager } from './notepad.js';

function getVisibleRoomVideo() {
  const videos = [
    ...document.querySelectorAll('.video-card.active video'),
    ...document.querySelectorAll('.video-card video')
  ];
  return videos.find(video => {
    const rect = video.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) || null;
}

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
    this.domAbort = null;
  }

  bindSession(options = {}) {
    const {
      session = null,
      broadcast = null,
      chatManager = null,
      getPeerId = () => 'me',
      getDisplayName = () => 'Jogador',
      getActiveVideoStream = () => null,
      getVoiceStreams = () => ({}),
      isHost = null,
      getCoordinatorPeerId = () => null
    } = options;
    this.session = session;
    this.broadcast = broadcast;
    this.chatManager = chatManager;
    this.getPeerId = getPeerId;
    this.getDisplayName = getDisplayName;
    this.getActiveVideoStream = getActiveVideoStream;
    this.getVoiceStreams = getVoiceStreams;

    // Conectar broadcast nos managers
    annotateManager.setBroadcast(broadcast);
    annotateManager.getLocalPeerId = getPeerId;
    pollManager.setBroadcast(broadcast);

    notepadManager.setBroadcast(broadcast);
    notepadManager.getLocalPeerId = getPeerId;
    notepadManager.getDisplayName = getDisplayName;
    notepadManager.getCoordinatorPeerId = getCoordinatorPeerId;
    const resolveIsHost = () => Boolean(
      (typeof isHost === 'function' ? isHost() : isHost) ||
      session?.isMaster ||
      session?.role === 'streamer' ||
      (session?.getRole && session.getRole() === 'host') ||
      (session?.roomState?.roomManager?.isMaster)
    );
    notepadManager.setIsHost(resolveIsHost);

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
        d.register('ANNOTATE_REMOVE', (data) => annotateManager.handleRemoteMessage(data)),
        d.register('ANNOTATE_SYNC', (data) => annotateManager.handleRemoteMessage(data)),
        d.register('ANNOTATE_REQUEST_SYNC', (data) => annotateManager.handleRemoteMessage(data)),
        ...['POLL_CREATE', 'POLL_VOTE', 'POLL_END', 'POLL_SYNC_REQUEST', 'POLL_SYNC'].map(type =>
          d.register(type, (data, source) => pollManager.handleRemoteMessage(data, source?.peer))),
        d.register('NOTE_UPDATE', (data, source) => notepadManager.handleRemoteMessage(data, source?.peer)),
        d.register('NOTE_REQUEST_SYNC', (data, source) => notepadManager.handleRemoteMessage(data, source?.peer)),
        d.register('NOTE_SYNC', (data, source) => notepadManager.handleRemoteMessage(data, source?.peer))
      ];
      this.cleanups.push(() => unsubs.forEach(u => u()));
    }
  }

  bindDOM() {
    if (this.domAbort) return;
    this.domAbort = new AbortController();
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

    // 2. Botão de Ferramentas da Sala e Botão de Clipar no Dock Inferior
    const toolsBtn = document.getElementById('dock-room-tools-btn');
    if (toolsBtn) {
      const toggleMenu = (e) => {
        e.stopPropagation();
        this.toggleMenu();
      };
      toolsBtn.addEventListener('click', toggleMenu);
      this.cleanups.push(() => toolsBtn.removeEventListener('click', toggleMenu));
    }

    const clipDockBtn = document.getElementById('dock-clip-btn');
    if (clipDockBtn) {
      const onClipClick = () => this.triggerClip();
      clipDockBtn.addEventListener('click', onClipClick);
      this.cleanups.push(() => clipDockBtn.removeEventListener('click', onClipClick));
    }

    // 3. Fechar menu ao clicar fora ou tecla Escape
    const onDocClick = (e) => {
      if (this.isMenuOpen && this.menuEl && !this.menuEl.contains(e.target) && e.target !== toolsBtn) {
        this.closeMenu();
      }
    };
    const onDocKeydown = (e) => {
      const active = document.activeElement;
      const inInput = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable ||
        active.closest?.('.modal-overlay[style*="flex"], .modal-overlay[style*="block"]')
      );

      if (e.key === 'Escape') {
        if (this.isMenuOpen) this.closeMenu();
        this.closePollModal();
        this.closeMultitrackModal();
        notepadManager.closeModal();
      } else if (!inInput && e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this.triggerClip();
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

    // 5. Layouts e Bloco de Notas
    roomLayoutController.bindDOM();
    notepadManager.mountModal();
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
        <button type="button" class="room-tool-item" data-action="clip">
          <span class="tool-icon">🎬</span>
          <div class="tool-info">
            <strong>Clipar Últimos 30s (C)</strong>
            <small>Salva os últimos segundos em vídeo e áudio meme</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="annotate">
          <span class="tool-icon">✏️</span>
          <div class="tool-info">
            <strong>Anotar no Vídeo</strong>
            <small>Desenhe táticas diretamente sobre o stream</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="notepad">
          <span class="tool-icon">📝</span>
          <div class="tool-info">
            <strong>Bloco de Notas</strong>
            <small>Anotações e códigos sincronizados P2P</small>
          </div>
        </button>
        <button type="button" class="room-tool-item" data-action="layout">
          <span class="tool-icon">🖼️</span>
          <div class="tool-info">
            <strong>Alternar Layout (F)</strong>
            <small>Alterna entre Grade, Destaque e Cinema</small>
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
      case 'clip':
        this.triggerClip();
        break;
      case 'annotate':
        this.toggleAnnotate();
        break;
      case 'notepad':
        notepadManager.openModal();
        break;
      case 'layout':
        this.cycleLayout();
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

  triggerClip(sourceId = null) {
    if (this.session?.features?.clipEditor) {
      this.session.features.clipEditor.exportClip(sourceId);
      return true;
    }
    const clipBtn = document.getElementById('clip-btn');
    if (clipBtn) {
      clipBtn.click();
      return true;
    }
    const cardClipBtn = document.querySelector('.video-card.active .btn-card-clip, .video-card .btn-card-clip');
    if (cardClipBtn) {
      cardClipBtn.click();
      return true;
    }
    return false;
  }

  cycleLayout() {
    const current = roomLayoutController.getLayoutMode();
    if (current === 'grid') roomLayoutController.setLayoutMode('focus');
    else if (current === 'focus') roomLayoutController.setLayoutMode('cinema');
    else roomLayoutController.setLayoutMode('grid');
  }

  toggleAnnotate() {
    if (annotateManager.isActive && annotateManager.isEditing) {
      annotateManager.detach();
      return;
    }

    // Procurar vídeo principal ativo
    const activeVideo = getVisibleRoomVideo();
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
    const activeVideo = getVisibleRoomVideo();
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
      this.broadcast?.({ type: 'POLL_SYNC_REQUEST' });
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

    const signal = this.domAbort.signal;
    modal.querySelector('.poll-modal-close')?.addEventListener('click', () => this.closePollModal(), { signal });
    modal.querySelector('#poll-cancel-btn')?.addEventListener('click', () => this.closePollModal(), { signal });

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
        const options = [opt1?.value, opt2?.value, opt3?.value, opt4?.value].map(value => value?.trim()).filter(Boolean);
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
      }, { signal });
    }

    // Atualizar view do modal ao mudar estado da enquete
    this.cleanups.push(pollManager.onPollChange(() => {
      if (modal.style.display !== 'none') {
        this._updatePollModalView();
      }
    }));
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

    const signal = this.domAbort.signal;
    modal.querySelector('.multitrack-modal-close')?.addEventListener('click', () => this.closeMultitrackModal(), { signal });
    modal.querySelector('#multitrack-cancel-btn')?.addEventListener('click', () => this.closeMultitrackModal(), { signal });

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
          for (const [peerId, stream] of Object.entries(voiceStreams.participants)) tracks[`participant-${peerId}`] = stream;
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
    }, { signal });

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
    }, { signal });

    this.cleanups.push(multitrackRecorder.on('tick', ({ duration }) => {
      const timerEl = modal.querySelector('#multitrack-timer');
      if (timerEl) {
        const sec = Math.floor(duration / 1000);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        timerEl.textContent = `🔴 REC ${m}:${s < 10 ? '0' : ''}${s}`;
      }
    }));

    this.cleanups.push(multitrackRecorder.on('start', () => this._updateMultitrackModalUI()));
    this.cleanups.push(multitrackRecorder.on('stop', () => this._updateMultitrackModalUI()));
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
    this.closePollModal(); this.closeMultitrackModal();
    this.domAbort?.abort(); this.domAbort = null;
    this.cleanups.forEach(c => c());
    this.cleanups = [];
    const container = document.getElementById('poll-active-card-container');
    if (container?._pollTimerInterval) { clearInterval(container._pollTimerInterval); container._pollTimerInterval = null; }
    pollManager.dispose();
    annotateManager.clear(false); annotateManager.detach(); annotateManager.setBroadcast(null);
    annotateManager.streamStrokes.clear(); annotateManager.streamId = null; annotateManager.getLocalPeerId = () => null;
    this.session = this.broadcast = this.chatManager = null;
    return Promise.all([multitrackRecorder.dispose(), pipController.exitPip()]);
  }
}

export const roomToolsController = new RoomToolsController();
