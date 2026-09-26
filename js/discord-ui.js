/**
 * SeeMyGame - Controlador de Interface Estilo Discord (Voz, Chat, Emojis e Sons)
 */

import { chatManager } from './chat.js';
import { voiceManager } from './voice.js';
import { SOUNDBOARD_PRESETS } from './soundboard.js';

export const EMOJI_REACTION_PRESETS = [
  { emoji: '🔥', name: 'Hype', desc: 'Jogada de mestre' },
  { emoji: '💀', name: 'RIP / F', desc: 'Não deu dessa vez' },
  { emoji: '🎯', name: 'Mira Boa', desc: 'Na mosca!' },
  { emoji: '👏', name: 'Palmas', desc: 'Boa, time!' },
  { emoji: '😂', name: 'Kkkk', desc: 'Rindo muito' },
  { emoji: 'GG', name: 'Good Game', desc: 'Partida lendária' },
  { emoji: '🚀', name: 'Decolou', desc: 'Voando alto' },
  { emoji: '❤️', name: 'Amei', desc: 'Muito carinho' },
];

export class DiscordUIController {
  constructor({
    onSendMessage,
    onJoinVoice,
    onLeaveVoice,
    onPlaySound,
    onSendReaction,
    onToggleMic,
    onToggleDeaf,
    onToggleStream,
    onOpenTuning,
    onOpenWhiteboard,
    onLeaveRoom,
  } = {}) {
    this.onSendMessage = onSendMessage || (() => {});
    this.onJoinVoice = onJoinVoice || (() => {});
    this.onLeaveVoice = onLeaveVoice || (() => {});
    this.onPlaySound = onPlaySound || (() => {});
    this.onSendReaction = onSendReaction || (() => {});
    this.onToggleMic = onToggleMic || (() => {});
    this.onToggleDeaf = onToggleDeaf || (() => {});
    this.onToggleStream = onToggleStream || (() => {});
    this.onOpenTuning = onOpenTuning || (() => {});
    this.onOpenWhiteboard = onOpenWhiteboard || (() => {});
    this.onLeaveRoom = onLeaveRoom || (() => {});
    this.activeTab = 'chat'; // 'chat' | 'voice' | 'emojis' | 'soundboard'
    this.isDrawerOpen = false;

    this.elements = {};
  }

  init() {
    if (typeof document === 'undefined') return;

    this.elements = {
      drawer: document.getElementById('discord-drawer'),
      toggleChatBtn: document.getElementById('toggle-chat-btn'),
      toggleVoiceBtn: document.getElementById('toggle-voice-btn'),
      toggleEmojisBtn: document.getElementById('toggle-emojis-btn'),
      toggleSoundBtn: document.getElementById('toggle-soundboard-btn'),
      railChatBtn: document.getElementById('rail-btn-chat'),
      railVoiceBtn: document.getElementById('rail-btn-voice'),
      railEmojisBtn: document.getElementById('rail-btn-emojis'),
      railSoundboardBtn: document.getElementById('rail-btn-soundboard'),
      chatBadge: document.getElementById('chat-unread-badge'),
      voiceBadge: document.getElementById('voice-badge'),
      railChatBadge: document.getElementById('rail-chat-badge'),
      railVoiceBadge: document.getElementById('rail-voice-badge'),
      closeBtn: document.getElementById('drawer-close-btn'),
      tabVoice: document.getElementById('tab-btn-voice'),
      tabChat: document.getElementById('tab-btn-chat'),
      tabEmojis: document.getElementById('tab-btn-emojis'),
      tabSoundboard: document.getElementById('tab-btn-soundboard'),
      panelVoice: document.getElementById('drawer-panel-voice'),
      panelChat: document.getElementById('drawer-panel-chat'),
      panelEmojis: document.getElementById('drawer-panel-emojis'),
      panelSoundboard: document.getElementById('drawer-panel-soundboard'),
      emojisGrid: document.getElementById('emojis-grid'),
      soundboardGrid: document.getElementById('soundboard-grid'),
      chatMessages: document.getElementById('chat-messages-container'),
      chatInput: document.getElementById('chat-input'),
      chatSendBtn: document.getElementById('chat-send-btn'),
      chatEmojiTriggerBtn: document.getElementById('chat-emoji-trigger-btn'),
      voiceParticipants: document.getElementById('voice-participants-list'),
      voiceMuteBtn: document.getElementById('voice-mute-btn'),
      voiceDeafBtn: document.getElementById('voice-deaf-btn'),
      voiceModeBtn: document.getElementById('voice-mode-btn'),
      voiceConnectBtn: document.getElementById('voice-connect-btn'),
      voiceStatusBar: document.getElementById('voice-status-bar'),

      // Elementos do Layout da Sala (Room-First)
      roomParticipantsList: document.getElementById('room-participants-list'),
      voiceStageGrid: document.getElementById('voice-stage-grid'),
      videoGrid: document.getElementById('video-grid'),
      sidebarMembersCount: document.getElementById('sidebar-members-count'),
      sidebarRoomName: document.getElementById('sidebar-room-name'),
      localUserName: document.getElementById('local-user-name'),
      localAvatar: document.getElementById('local-avatar'),
      dockMicBtn: document.getElementById('dock-mic-btn'),
      dockDeafBtn: document.getElementById('dock-deaf-btn'),
      dockStreamBtn: document.getElementById('dock-stream-btn'),
      dockTuningBtn: document.getElementById('dock-tuning-btn'),
      dockWhiteboardBtn: document.getElementById('dock-whiteboard-btn'),
      dockLeaveBtn: document.getElementById('dock-leave-btn'),
      quickMicBtn: document.getElementById('quick-mic-btn'),
      quickDeafBtn: document.getElementById('quick-deaf-btn'),
      quickTuningBtn: document.getElementById('quick-tuning-btn'),
      sidebarVoiceStatus: document.getElementById('sidebar-voice-status'),
      sidebarVoiceDot: document.getElementById('sidebar-voice-dot'),
      sidebarVoiceStatusContainer: document.getElementById('sidebar-voice-status-container'),
      bottomControlDock: document.getElementById('bottom-control-dock'),
      reactionsDock: document.getElementById('reactions-dock'),
      roomStage: document.getElementById('room-stage'),
    };

    this.bindEvents();
    this.bindChatEvents();
    this.bindVoiceEvents();
    this.bindRoomDockEvents();
    this.initSoundboard();
    this.initEmojis();
    this.initStageDockAutoHide();
  }

  bindEvents() {
    const {
      toggleChatBtn,
      toggleVoiceBtn,
      toggleEmojisBtn,
      toggleSoundBtn,
      railChatBtn,
      railVoiceBtn,
      railEmojisBtn,
      railSoundboardBtn,
      closeBtn,
      tabVoice,
      tabChat,
      tabEmojis,
      tabSoundboard,
      chatInput,
      chatSendBtn,
      chatEmojiTriggerBtn,
      voiceMuteBtn,
      voiceDeafBtn,
      voiceModeBtn,
      voiceConnectBtn,
    } = this.elements;

    // Abertura / Alternância do Drawer (Topo)
    if (toggleChatBtn) {
      toggleChatBtn.addEventListener('click', () => this.toggleDrawer('chat'));
    }
    if (toggleVoiceBtn) {
      toggleVoiceBtn.addEventListener('click', () => this.toggleDrawer('voice'));
    }
    if (toggleEmojisBtn) {
      toggleEmojisBtn.addEventListener('click', () => this.toggleDrawer('emojis'));
    }
    if (toggleSoundBtn) {
      toggleSoundBtn.addEventListener('click', () => this.toggleDrawer('soundboard'));
    }

    // Mini-Rail Lateral Discord (Margem Esquerda)
    if (railChatBtn) {
      railChatBtn.addEventListener('click', () => this.toggleDrawer('chat'));
    }
    if (railVoiceBtn) {
      railVoiceBtn.addEventListener('click', () => this.toggleDrawer('voice'));
    }
    if (railEmojisBtn) {
      railEmojisBtn.addEventListener('click', () => this.toggleDrawer('emojis'));
    }
    if (railSoundboardBtn) {
      railSoundboardBtn.addEventListener('click', () => this.toggleDrawer('soundboard'));
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closeDrawer());
    }

    // Abas de Canais
    if (tabChat) {
      tabChat.addEventListener('click', () => this.switchTab('chat'));
    }
    if (tabVoice) {
      tabVoice.addEventListener('click', () => this.switchTab('voice'));
    }
    if (tabEmojis) {
      tabEmojis.addEventListener('click', () => this.switchTab('emojis'));
    }
    if (tabSoundboard) {
      tabSoundboard.addEventListener('click', () => this.switchTab('soundboard'));
    }

    // Botão de Emoji no Chat
    if (chatEmojiTriggerBtn) {
      chatEmojiTriggerBtn.addEventListener('click', () => {
        this.switchTab('emojis');
      });
    }

    // Atalho Escape para fechar
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isDrawerOpen) {
          this.closeDrawer();
        }
      });
    }

    // Envio de chat
    const handleSend = () => {
      if (!chatInput) return;
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      this.onSendMessage(text);
      chatInput.focus();
    };

    if (chatSendBtn) {
      chatSendBtn.addEventListener('click', handleSend);
    }
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
    }

    // Controles de voz
    if (voiceMuteBtn) {
      voiceMuteBtn.addEventListener('click', () => {
        voiceManager.toggleMute();
      });
    }
    if (voiceDeafBtn) {
      voiceDeafBtn.addEventListener('click', () => {
        voiceManager.toggleDeafen();
      });
    }
    if (voiceModeBtn) {
      voiceModeBtn.addEventListener('click', () => {
        const nextMode = voiceManager.voiceMode === 'vad' ? 'ptt' : 'vad';
        voiceManager.setVoiceMode(nextMode);
      });
    }
    if (voiceConnectBtn) {
      voiceConnectBtn.addEventListener('click', () => {
        if (voiceManager.isInVoice) {
          this.onLeaveVoice();
        } else {
          this.onJoinVoice();
        }
      });
    }
  }

  toggleDrawer(tab = 'chat') {
    if (this.isDrawerOpen && this.activeTab === tab) {
      this.closeDrawer();
    } else {
      this.openDrawer(tab);
    }
  }

  openDrawer(tab = 'chat') {
    this.isDrawerOpen = true;
    if (this.elements.drawer) {
      this.elements.drawer.classList.add('open');
    }
    this.switchTab(tab);
    chatManager.setChatOpen(true);
    this.updateChatBadge(0);
  }

  closeDrawer() {
    this.isDrawerOpen = false;
    if (this.elements.drawer) {
      this.elements.drawer.classList.remove('open');
    }
    const {
      toggleChatBtn,
      toggleVoiceBtn,
      toggleEmojisBtn,
      toggleSoundBtn,
      railChatBtn,
      railVoiceBtn,
      railEmojisBtn,
      railSoundboardBtn,
    } = this.elements;

    if (toggleChatBtn) toggleChatBtn.classList.remove('active');
    if (toggleVoiceBtn) toggleVoiceBtn.classList.remove('active');
    if (toggleEmojisBtn) toggleEmojisBtn.classList.remove('active');
    if (toggleSoundBtn) toggleSoundBtn.classList.remove('active');

    if (railChatBtn) railChatBtn.classList.remove('active');
    if (railVoiceBtn) railVoiceBtn.classList.remove('active');
    if (railEmojisBtn) railEmojisBtn.classList.remove('active');
    if (railSoundboardBtn) railSoundboardBtn.classList.remove('active');

    chatManager.setChatOpen(false);
  }

  switchTab(tab) {
    this.activeTab = tab;
    const {
      tabVoice,
      tabChat,
      tabEmojis,
      tabSoundboard,
      panelVoice,
      panelChat,
      panelEmojis,
      panelSoundboard,
      toggleChatBtn,
      toggleVoiceBtn,
      toggleEmojisBtn,
      toggleSoundBtn,
      railChatBtn,
      railVoiceBtn,
      railEmojisBtn,
      railSoundboardBtn,
    } = this.elements;

    if (tabChat) tabChat.classList.toggle('active', tab === 'chat');
    if (tabVoice) tabVoice.classList.toggle('active', tab === 'voice');
    if (tabEmojis) tabEmojis.classList.toggle('active', tab === 'emojis');
    if (tabSoundboard) tabSoundboard.classList.toggle('active', tab === 'soundboard');

    if (panelChat) panelChat.style.display = tab === 'chat' ? 'flex' : 'none';
    if (panelVoice) panelVoice.style.display = tab === 'voice' ? 'flex' : 'none';
    if (panelEmojis) panelEmojis.style.display = tab === 'emojis' ? 'flex' : 'none';
    if (panelSoundboard) panelSoundboard.style.display = tab === 'soundboard' ? 'flex' : 'none';

    if (toggleChatBtn) toggleChatBtn.classList.toggle('active', tab === 'chat');
    if (toggleVoiceBtn) toggleVoiceBtn.classList.toggle('active', tab === 'voice');
    if (toggleEmojisBtn) toggleEmojisBtn.classList.toggle('active', tab === 'emojis');
    if (toggleSoundBtn) toggleSoundBtn.classList.toggle('active', tab === 'soundboard');

    if (railChatBtn) railChatBtn.classList.toggle('active', tab === 'chat');
    if (railVoiceBtn) railVoiceBtn.classList.toggle('active', tab === 'voice');
    if (railEmojisBtn) railEmojisBtn.classList.toggle('active', tab === 'emojis');
    if (railSoundboardBtn) railSoundboardBtn.classList.toggle('active', tab === 'soundboard');

    if (tab === 'chat') {
      chatManager.markChannelAsRead();
      this.updateChatBadge(0);
      if (this.elements.chatInput) this.elements.chatInput.focus();
    }
  }

  initSoundboard() {
    const grid = this.elements.soundboardGrid;
    if (!grid) return;
    grid.innerHTML = '';
    SOUNDBOARD_PRESETS.forEach((preset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'soundboard-btn';
      btn.dataset.soundId = preset.id;
      btn.innerHTML = `
        <span class="sound-emoji">${preset.icon || preset.emoji || '🔊'}</span>
        <span class="sound-name">${preset.name}</span>
      `;
      btn.addEventListener('click', () => {
        this.onPlaySound(preset.id);
      });
      grid.appendChild(btn);
    });
  }

  initEmojis() {
    const grid = this.elements.emojisGrid;
    if (!grid) return;
    grid.innerHTML = '';
    EMOJI_REACTION_PRESETS.forEach((preset) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'emoji-reaction-card';
      card.dataset.emoji = preset.emoji;
      card.setAttribute('data-emoji', preset.emoji);
      card.title = `Disparar reação ${preset.emoji} (${preset.name})`;
      card.innerHTML = `
        <span class="emoji-icon">${preset.emoji}</span>
        <span class="emoji-name">${preset.name}</span>
        <span class="emoji-desc">${preset.desc}</span>
      `;
      card.addEventListener('click', () => {
        this.onSendReaction(preset.emoji);
      });
      grid.appendChild(card);
    });
  }

  bindChatEvents() {
    chatManager.on('message', (msg) => {
      this.renderChatMessage(msg);
    });

    chatManager.on('unread', ({ total }) => {
      if (!this.isDrawerOpen || this.activeTab !== 'chat') {
        this.updateChatBadge(total);
      }
    });
  }

  renderChatMessage(msg) {
    const container = this.elements.chatMessages;
    if (!container || !msg) return;

    if (msg.isSystem) {
      const sysEl = document.createElement('div');
      sysEl.className = 'chat-message-system';
      sysEl.textContent = `ℹ️ ${msg.text}`;
      container.appendChild(sysEl);
    } else {
      const item = document.createElement('div');
      item.className = 'chat-message-item';

      const initial = (msg.senderName || 'U').charAt(0).toUpperCase();

      const avatar = document.createElement('div');
      avatar.className = 'chat-message-avatar';
      avatar.textContent = initial;

      const body = document.createElement('div');
      body.className = 'chat-message-body';

      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';

      const author = document.createElement('span');
      author.className = 'chat-author';
      author.textContent = msg.senderName || 'Amigo';

      const roleBadge = document.createElement('span');
      const safeRole = ['host', 'player2', 'viewer', 'system'].includes(msg.role) ? msg.role : 'viewer';
      roleBadge.className = `chat-role-badge ${safeRole}`;
      roleBadge.textContent = (msg.role || 'espectador').toUpperCase();

      const time = document.createElement('span');
      time.className = 'chat-timestamp';
      time.textContent = msg.formattedTime || '';

      meta.appendChild(author);
      meta.appendChild(roleBadge);
      meta.appendChild(time);

      const content = document.createElement('div');
      content.className = 'chat-content';
      content.textContent = msg.text || '';

      body.appendChild(meta);
      body.appendChild(content);

      item.appendChild(avatar);
      item.appendChild(body);
      container.appendChild(item);
    }

    // Auto-scroll para a mensagem mais recente
    container.scrollTop = container.scrollHeight;
  }

  updateChatBadge(count) {
    const badges = [this.elements.chatBadge, this.elements.railChatBadge];
    badges.forEach((badge) => {
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    });
  }

  bindVoiceEvents() {
    voiceManager.on('participantUpdate', (participants) => {
      this.renderVoiceParticipants(participants);
    });

    voiceManager.on('speakingChange', ({ peerId, isSpeaking }) => {
      const avatar = document.getElementById(`voice-avatar-${peerId}`);
      if (avatar) {
        if (isSpeaking) {
          avatar.classList.add('speaking');
        } else {
          avatar.classList.remove('speaking');
        }
      }
    });

    voiceManager.on('voiceStateChange', (state) => {
      this.updateVoiceControls(state);
    });
  }

  renderVoiceParticipants(participants) {
    const list = this.elements.voiceParticipants;
    const badges = [this.elements.voiceBadge, this.elements.railVoiceBadge];

    badges.forEach((badge) => {
      if (!badge) return;
      if (participants && participants.length > 0) {
        badge.textContent = participants.length;
        badge.style.display = 'inline-block';
        badge.classList.add('voice-active-badge');
      } else {
        badge.style.display = 'none';
      }
    });

    if (!list) return;

    if (!participants || participants.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 24px 12px; font-size: 13px;">
          Ninguém na sala de voz no momento.<br>
          <small>Clique em "Entrar na Voz" abaixo para conversar com microfone.</small>
        </div>
      `;
      return;
    }

    list.innerHTML = '';
    participants.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'voice-user-card';

      const initial = (p.name || 'U').charAt(0).toUpperCase();
      const muteIcon = p.isMuted ? '🔇' : '🎙️';
      const deafIcon = p.isDeafened ? '🎧❌' : '';

      const info = document.createElement('div');
      info.className = 'voice-user-info';

      const avatar = document.createElement('div');
      if (p.peerId) avatar.id = `voice-avatar-${p.peerId}`;
      avatar.className = `avatar-circle ${p.isSpeaking ? 'speaking' : ''}`;
      avatar.textContent = initial;

      const userName = document.createElement('div');
      userName.className = 'voice-user-name';
      userName.textContent = (p.name || 'Amigo') + ' ';

      const roleBadge = document.createElement('span');
      const safeRole = ['host', 'player2', 'viewer', 'member', 'system'].includes(p.role) ? p.role : 'viewer';
      roleBadge.className = `chat-role-badge ${safeRole}`;
      roleBadge.textContent = (p.role || 'membro').toUpperCase();
      userName.appendChild(roleBadge);

      info.appendChild(avatar);
      info.appendChild(userName);

      const icons = document.createElement('div');
      icons.className = 'voice-user-icons';

      const muteSpan = document.createElement('span');
      muteSpan.title = p.isMuted ? 'Microfone Mutado' : 'Microfone Ativo';
      muteSpan.textContent = muteIcon;
      icons.appendChild(muteSpan);

      if (deafIcon) {
        const deafSpan = document.createElement('span');
        deafSpan.title = 'Ensurdecido';
        deafSpan.textContent = deafIcon;
        icons.appendChild(deafSpan);
      }

      card.appendChild(info);
      card.appendChild(icons);
      list.appendChild(card);
    });
  }

  updateVoiceControls(state) {
    const { voiceMuteBtn, voiceDeafBtn, voiceModeBtn, voiceConnectBtn, voiceStatusBar } = this.elements;

    if (voiceConnectBtn) {
      voiceConnectBtn.style.display = 'inline-flex';
      if (state.isInVoice) {
        voiceConnectBtn.textContent = '📞 Desconectar';
        voiceConnectBtn.className = 'voice-dock-btn leave-btn';
      } else {
        voiceConnectBtn.textContent = '📞 Entrar na Voz';
        voiceConnectBtn.className = 'voice-dock-btn join-btn';
      }
    }

    if (this.elements.sidebarVoiceStatus) {
      if (state.isInVoice) {
        this.elements.sidebarVoiceStatus.textContent = '🟢 Voz Conectada';
        this.elements.sidebarVoiceStatus.style.color = 'var(--accent-green)';
        if (this.elements.sidebarVoiceDot) {
          this.elements.sidebarVoiceDot.style.background = 'var(--accent-green)';
        }
      } else {
        this.elements.sidebarVoiceStatus.textContent = '⚪ Entrar na Voz';
        this.elements.sidebarVoiceStatus.style.color = 'var(--text-muted)';
        if (this.elements.sidebarVoiceDot) {
          this.elements.sidebarVoiceDot.style.background = 'var(--text-muted)';
        }
      }
    }

    if (voiceMuteBtn) {
      voiceMuteBtn.disabled = !state.isInVoice;
      if (state.isMuted) {
        voiceMuteBtn.innerHTML = '<span>🔇</span> Desmutar';
        voiceMuteBtn.classList.add('active');
      } else {
        voiceMuteBtn.innerHTML = '<span>🎙️</span> Mutar';
        voiceMuteBtn.classList.remove('active');
      }
    }

    if (voiceDeafBtn) {
      voiceDeafBtn.disabled = !state.isInVoice;
      if (state.isDeafened) {
        voiceDeafBtn.innerHTML = '<span>🎧❌</span> Desensurdecer';
        voiceDeafBtn.classList.add('active');
      } else {
        voiceDeafBtn.innerHTML = '<span>🎧</span> Ensurdecer';
        voiceDeafBtn.classList.remove('active');
      }
    }

    if (voiceModeBtn) {
      voiceModeBtn.disabled = !state.isInVoice;
      if (state.voiceMode === 'ptt') {
        voiceModeBtn.innerHTML = '<span>🎙️</span> PTT (Caps)';
        voiceModeBtn.classList.add('active');
        voiceModeBtn.title = 'Modo Push-to-Talk ativo (segure Caps Lock ou Ctrl Direito para falar)';
      } else {
        voiceModeBtn.innerHTML = '<span>🎤</span> VAD (Auto)';
        voiceModeBtn.classList.remove('active');
        voiceModeBtn.title = 'Modo Detecção de Voz (VAD) contínuo ativo';
      }
    }

    if (voiceStatusBar) {
      if (state.isInVoice) {
        voiceStatusBar.innerHTML = '<span>🟢 Voz Conectada</span> <span>Canal de Baixa Latência</span>';
        voiceStatusBar.style.color = 'var(--accent-green)';
        voiceStatusBar.style.background = 'rgba(16, 185, 129, 0.1)';
        voiceStatusBar.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      } else {
        voiceStatusBar.innerHTML = '<span>⚪ Desconectado da Voz</span> <span>Clique abaixo para entrar</span>';
        voiceStatusBar.style.color = 'var(--text-muted)';
        voiceStatusBar.style.background = 'rgba(255, 255, 255, 0.04)';
        voiceStatusBar.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      }
    }

    // Sincroniza botões do Dock inferior e Quick actions
    const { dockMicBtn, quickMicBtn, dockDeafBtn, quickDeafBtn } = this.elements;
    if (dockMicBtn) {
      if (state.isMuted) {
        dockMicBtn.innerHTML = '<span>🔇</span> <span class="dock-label">Desmutar</span>';
        dockMicBtn.classList.add('is-muted');
      } else {
        dockMicBtn.innerHTML = '<span>🎙️</span> <span class="dock-label">Microfone</span>';
        dockMicBtn.classList.remove('is-muted');
      }
    }
    if (quickMicBtn) {
      quickMicBtn.classList.toggle('active-muted', Boolean(state.isMuted));
      quickMicBtn.innerHTML = state.isMuted ? '🔇' : '🎙️';
    }

    if (dockDeafBtn) {
      if (state.isDeafened) {
        dockDeafBtn.innerHTML = '<span>🎧❌</span> <span class="dock-label">Desensurdecer</span>';
        dockDeafBtn.classList.add('is-muted');
      } else {
        dockDeafBtn.innerHTML = '<span>🎧</span> <span class="dock-label">Áudio</span>';
        dockDeafBtn.classList.remove('is-muted');
      }
    }
    if (quickDeafBtn) {
      quickDeafBtn.classList.toggle('active-muted', Boolean(state.isDeafened));
      quickDeafBtn.innerHTML = state.isDeafened ? '🎧❌' : '🎧';
    }
  }

  bindRoomDockEvents() {
    const {
      dockMicBtn,
      dockDeafBtn,
      dockStreamBtn,
      dockTuningBtn,
      dockWhiteboardBtn,
      dockLeaveBtn,
      quickMicBtn,
      quickDeafBtn,
      quickTuningBtn,
    } = this.elements;

    const handleMicToggle = () => {
      if (!voiceManager.isInVoice) {
        this.onJoinVoice();
        return;
      }
      const isMuted = voiceManager.toggleMute();
      this.onToggleMic(isMuted);
    };

    const handleDeafToggle = () => {
      if (!voiceManager.isInVoice) {
        this.onJoinVoice();
        return;
      }
      const isDeaf = voiceManager.toggleDeafen();
      this.onToggleDeaf(isDeaf);
    };

    if (dockMicBtn) dockMicBtn.addEventListener('click', handleMicToggle);
    if (quickMicBtn) quickMicBtn.addEventListener('click', handleMicToggle);

    if (dockDeafBtn) dockDeafBtn.addEventListener('click', handleDeafToggle);
    if (quickDeafBtn) quickDeafBtn.addEventListener('click', handleDeafToggle);

    if (this.elements.sidebarVoiceStatusContainer) {
      this.elements.sidebarVoiceStatusContainer.addEventListener('click', () => {
        if (!voiceManager.isInVoice) {
          this.onJoinVoice();
        } else {
          this.openDrawer('voice');
        }
      });
    }

    if (dockStreamBtn) dockStreamBtn.addEventListener('click', () => this.onToggleStream());
    if (dockTuningBtn) dockTuningBtn.addEventListener('click', () => this.onOpenTuning());
    if (quickTuningBtn) quickTuningBtn.addEventListener('click', () => this.onOpenTuning());
    if (dockWhiteboardBtn) dockWhiteboardBtn.addEventListener('click', () => this.onOpenWhiteboard());
    if (dockLeaveBtn) dockLeaveBtn.addEventListener('click', () => this.onLeaveRoom());
  }

  setStreamingState(isStreaming) {
    this.isStreaming = Boolean(isStreaming);
    const { dockStreamBtn, bottomControlDock } = this.elements;
    if (!this.isStreaming && bottomControlDock) {
      bottomControlDock.classList.remove('dock-hidden');
    }
    if (dockStreamBtn) {
      if (isStreaming) {
        dockStreamBtn.innerHTML = '<span>⏹️</span> <span class="dock-label">Parar Stream</span>';
        dockStreamBtn.classList.add('is-streaming');
      } else {
        dockStreamBtn.innerHTML = '<span>🚀</span> <span class="dock-label">Transmitir Jogo</span>';
        dockStreamBtn.classList.remove('is-streaming');
      }
    }
  }

  initStageDockAutoHide() {
    const { bottomControlDock, reactionsDock, roomStage } = this.elements;
    if (!bottomControlDock && !reactionsDock) return;

    let hideTimeout = null;
    let isHoveringDock = false;
    let isHoveringReactions = false;
    const INACTIVITY_MS = 3500;

    const isAnyModalOpen = () => {
      if (typeof document === 'undefined') return false;
      const openModals = document.querySelectorAll('.modal-overlay');
      for (const modal of openModals) {
        if (modal.style.display && modal.style.display !== 'none') {
          return true;
        }
      }
      return false;
    };

    const hasLiveVideoOnStage = () => {
      if (this.isStreaming || this.hasActiveStreams) return true;
      if (typeof document !== 'undefined') {
        const videoGrid = this.elements?.videoGrid || document.getElementById('video-grid');
        if (videoGrid && videoGrid.style.display !== 'none' && videoGrid.querySelector('video, .video-card')) {
          return true;
        }
      }
      return false;
    };

    const showDocks = () => {
      if (bottomControlDock) bottomControlDock.classList.remove('dock-hidden');
      if (reactionsDock) reactionsDock.classList.remove('dock-hidden');
    };

    const hideDocks = () => {
      if (!hasLiveVideoOnStage() || isHoveringDock || isHoveringReactions || isAnyModalOpen()) {
        resetTimer();
        return;
      }
      if (bottomControlDock) bottomControlDock.classList.add('dock-hidden');
      if (reactionsDock) reactionsDock.classList.add('dock-hidden');
    };

    const resetTimer = () => {
      showDocks();
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      hideTimeout = setTimeout(hideDocks, INACTIVITY_MS);
    };

    if (bottomControlDock) {
      bottomControlDock.addEventListener('mouseenter', () => {
        isHoveringDock = true;
        showDocks();
        if (hideTimeout) clearTimeout(hideTimeout);
      });
      bottomControlDock.addEventListener('mouseleave', () => {
        isHoveringDock = false;
        resetTimer();
      });
      bottomControlDock.addEventListener('focusin', () => {
        showDocks();
        if (hideTimeout) clearTimeout(hideTimeout);
      });
      bottomControlDock.addEventListener('focusout', () => {
        resetTimer();
      });
    }

    if (reactionsDock) {
      reactionsDock.addEventListener('mouseenter', () => {
        isHoveringReactions = true;
        showDocks();
        if (hideTimeout) clearTimeout(hideTimeout);
      });
      reactionsDock.addEventListener('mouseleave', () => {
        isHoveringReactions = false;
        resetTimer();
      });
    }

    const stage = roomStage || (typeof document !== 'undefined' ? document.getElementById('room-stage') : null);
    if (stage) {
      stage.addEventListener('mousemove', resetTimer);
      stage.addEventListener('mousedown', resetTimer);
      stage.addEventListener('touchstart', resetTimer, { passive: true });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', resetTimer);
      window.addEventListener('mousemove', (e) => {
        // Se o mouse estiver sobre o palco, reseta o timer
        if (stage && stage.contains(e.target)) {
          resetTimer();
        }
      });
    }

    resetTimer();
  }

  updateRoomPresence(members) {
    const { roomParticipantsList, voiceStageGrid, sidebarMembersCount } = this.elements;

    if (sidebarMembersCount && Array.isArray(members)) {
      sidebarMembersCount.textContent = `${members.length} online`;
    }

    if (roomParticipantsList && Array.isArray(members)) {
      roomParticipantsList.innerHTML = '';
      members.forEach((m) => {
        const initial = (m.name || 'A').charAt(0).toUpperCase();
        const item = document.createElement('div');
        item.className = 'participant-item';
        if (m.peerId) item.id = `participant-item-${m.peerId}`;

        const isSpeaking = m.isSpeaking ? 'speaking' : '';
        const muteIcon = m.isMuted ? '🔇' : '';
        const deafIcon = m.isDeafened ? '🎧❌' : '';

        const avatarWrapper = document.createElement('div');
        avatarWrapper.className = 'participant-avatar-wrapper';
        const avatar = document.createElement('div');
        avatar.className = `participant-avatar ${isSpeaking}`;
        if (m.peerId) avatar.id = `sidebar-avatar-${m.peerId}`;
        avatar.textContent = initial;
        avatarWrapper.appendChild(avatar);

        const info = document.createElement('div');
        info.className = 'participant-info';

        const nameRow = document.createElement('div');
        nameRow.className = 'participant-name-row';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'participant-name';
        nameSpan.textContent = m.name || 'Amigo';
        nameRow.appendChild(nameSpan);

        const badges = document.createElement('div');
        badges.className = 'participant-badges';
        if (m.isMaster) {
          const hostBadge = document.createElement('span');
          hostBadge.className = 'badge-host-tag';
          hostBadge.textContent = 'HOST';
          badges.appendChild(hostBadge);
        }
        if (m.isStreaming) {
          const liveBadge = document.createElement('span');
          liveBadge.className = 'badge-live-tag';
          liveBadge.textContent = 'AO VIVO';
          badges.appendChild(liveBadge);
        }

        info.appendChild(nameRow);
        info.appendChild(badges);

        const icons = document.createElement('div');
        icons.className = 'participant-icons';
        if (muteIcon) {
          const mSpan = document.createElement('span');
          mSpan.textContent = muteIcon;
          icons.appendChild(mSpan);
        }
        if (deafIcon) {
          const dSpan = document.createElement('span');
          dSpan.textContent = deafIcon;
          icons.appendChild(dSpan);
        }

        item.appendChild(avatarWrapper);
        item.appendChild(info);
        item.appendChild(icons);
        roomParticipantsList.appendChild(item);
      });
    }

    if (voiceStageGrid && Array.isArray(members)) {
      voiceStageGrid.innerHTML = '';
      members.forEach((m) => {
        const initial = (m.name || 'A').charAt(0).toUpperCase();
        const tile = document.createElement('div');
        tile.className = `voice-tile ${m.isSpeaking ? 'speaking' : ''}`;
        if (m.peerId) tile.id = `stage-tile-${m.peerId}`;

        const avatar = document.createElement('div');
        avatar.className = 'voice-tile-avatar';
        avatar.textContent = initial;

        const name = document.createElement('div');
        name.className = 'voice-tile-name';
        name.textContent = m.name || 'Amigo';

        tile.appendChild(avatar);
        tile.appendChild(name);

        if (m.isStreaming) {
          const live = document.createElement('div');
          live.className = 'badge-live-tag';
          live.style.marginTop = '6px';
          live.textContent = 'AO VIVO';
          tile.appendChild(live);
        }

        voiceStageGrid.appendChild(tile);
      });
    }
  }

  syncStageView(hasActiveStreams) {
    this.hasActiveStreams = Boolean(hasActiveStreams);
    const { voiceStageGrid, videoGrid, bottomControlDock, reactionsDock } = this.elements;
    if (!this.hasActiveStreams && !this.isStreaming && bottomControlDock) {
      bottomControlDock.classList.remove('dock-hidden');
    }
    if (reactionsDock) {
      reactionsDock.style.display = 'flex';
    }
    if (videoGrid && voiceStageGrid) {
      if (hasActiveStreams) {
        videoGrid.style.display = 'flex';
        voiceStageGrid.style.display = 'none';
      } else {
        videoGrid.style.display = 'none';
        voiceStageGrid.style.display = 'flex';
      }
    }
  }
}

