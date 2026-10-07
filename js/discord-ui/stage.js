import { SOUNDBOARD_PRESETS } from ".././soundboard.js";
import { EMOJI_REACTION_PRESETS } from './shared.js';
import { createParticipantVolumePopover } from '../ui/participant-controls.js';
/** DiscordUIController: stage. State and lifetime remain owned by the composed engine. */
export const withDiscordUIControllerStage = Base => class extends Base {
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
      if (!this.voiceManager.isInVoice) {
        if (this.elements.roomChannels) return;
        this.onJoinVoice();
        return;
      }
      const isMuted = this.voiceManager.toggleMute();
      this.onToggleMic(isMuted);
    };

    const handleDeafToggle = () => {
      if (!this.voiceManager.isInVoice) {
        if (this.elements.roomChannels) return;
        this.onJoinVoice();
        return;
      }
      const isDeaf = this.voiceManager.toggleDeafen();
      this.onToggleDeaf(isDeaf);
    };

    if (dockMicBtn) this.listen(dockMicBtn, 'click', handleMicToggle);
    if (quickMicBtn) this.listen(quickMicBtn, 'click', handleMicToggle);

    if (dockDeafBtn) this.listen(dockDeafBtn, 'click', handleDeafToggle);
    if (quickDeafBtn) this.listen(quickDeafBtn, 'click', handleDeafToggle);

    if (this.elements.sidebarVoiceStatusContainer && !this.elements.roomChannels) {
      this.listen(this.elements.sidebarVoiceStatusContainer, 'click', () => {
        if (!this.voiceManager.isInVoice) {
          this.onJoinVoice();
        } else {
          this.openDrawer('voice');
        }
      });
    }

    if (dockStreamBtn) this.listen(dockStreamBtn, 'click', () => this.onToggleStream());
    if (dockTuningBtn) this.listen(dockTuningBtn, 'click', () => this.onOpenTuning());
    if (quickTuningBtn) this.listen(quickTuningBtn, 'click', () => this.onOpenTuning());
    if (dockWhiteboardBtn) this.listen(dockWhiteboardBtn, 'click', () => this.onOpenWhiteboard());
    if (dockLeaveBtn) this.listen(dockLeaveBtn, 'click', () => this.onLeaveRoom());
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
    this._cleanupFns.push(() => {
      if (hideTimeout !== null) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
    });

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
      this.listen(bottomControlDock, 'mouseenter', () => {
        isHoveringDock = true;
        showDocks();
        if (hideTimeout) clearTimeout(hideTimeout);
      });
      this.listen(bottomControlDock, 'mouseleave', () => {
        isHoveringDock = false;
        resetTimer();
      });
      this.listen(bottomControlDock, 'focusin', () => {
        showDocks();
        if (hideTimeout) clearTimeout(hideTimeout);
      });
      this.listen(bottomControlDock, 'focusout', () => {
        resetTimer();
      });
    }

    if (reactionsDock) {
      this.listen(reactionsDock, 'mouseenter', () => {
        isHoveringReactions = true;
        showDocks();
        if (hideTimeout) clearTimeout(hideTimeout);
      });
      this.listen(reactionsDock, 'mouseleave', () => {
        isHoveringReactions = false;
        resetTimer();
      });
    }

    const stage = roomStage || (typeof document !== 'undefined' ? document.getElementById('room-stage') : null);
    if (stage) {
      this.listen(stage, 'mousemove', resetTimer);
      this.listen(stage, 'mousedown', resetTimer);
      this.listen(stage, 'touchstart', resetTimer, { passive: true });
    }
    if (typeof window !== 'undefined') {
      this.listen(window, 'keydown', resetTimer);
      this.listen(window, 'mousemove', (e) => {
        // Se o mouse estiver sobre o palco, reseta o timer
        if (stage && stage.contains(e.target)) {
          resetTimer();
        }
      });
    }

    resetTimer();
  }

updateRoomPresence(members) {
    this.renderRoomChannels();
    const { roomParticipantsList, voiceStageGrid, sidebarMembersCount } = this.elements;
    const onlineCount = document.querySelector('#viewer-count strong');
    if (onlineCount && Array.isArray(members)) onlineCount.textContent = String(members.length);
    const self = members?.find(member => member.peerId === this.roomManager?.myPeerId);
    if (self && this.elements.localUserName) this.elements.localUserName.textContent = self.name || 'Você';
    if (self && this.elements.localAvatar) this.elements.localAvatar.textContent = (self.name || 'V').charAt(0).toUpperCase();

    if (sidebarMembersCount && Array.isArray(members)) {
      sidebarMembersCount.textContent = `${members.length} online`;
    }

    if (roomParticipantsList && Array.isArray(members)) {
      roomParticipantsList.innerHTML = '';
      members.filter(m => !this.elements.roomChannels || !m.voiceChannelId).forEach((m) => {
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

        if (this.voiceManager && m.peerId && m.peerId !== this.roomManager?.myPeerId) {
          const volPopover = createParticipantVolumePopover({
            peerId: m.peerId,
            name: m.name || 'Amigo',
            voiceManager: this.voiceManager
          });
          if (volPopover) icons.appendChild(volPopover);
        }

        item.appendChild(avatarWrapper);
        item.appendChild(info);
        item.appendChild(icons);
        roomParticipantsList.appendChild(item);
      });
    }

    if (voiceStageGrid && Array.isArray(members)) {
      voiceStageGrid.innerHTML = '';
      const stageMembers = this.elements.roomChannels ? members.filter(m => this.roomManager.voiceChannelId && m.voiceChannelId === this.roomManager.voiceChannelId) : members;
      if (this.elements.roomChannels && !this.roomManager.voiceChannelId) {
        const lobby = document.createElement('div'); lobby.className = 'room-lobby-welcome';
        const label = document.createElement('span'); label.className = 'room-lobby-eyebrow'; label.textContent = 'SEU PONTO DE ENCONTRO';
        const title = document.createElement('h1'); title.textContent = 'Você está no lobby';
        const text = document.createElement('p'); text.textContent = 'Converse pelo chat, compartilhe seu jogo ou entre em uma sala de voz com os amigos.';
        const note = document.createElement('small'); note.textContent = 'Microfone e áudio da conversa desligados';
        lobby.append(label, title, text, note); voiceStageGrid.append(lobby);
      }
      stageMembers.forEach((m) => {
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

        if (this.voiceManager && m.peerId && m.peerId !== this.roomManager?.myPeerId) {
          const volPopover = createParticipantVolumePopover({
            peerId: m.peerId,
            name: m.name || 'Amigo',
            voiceManager: this.voiceManager
          });
          if (volPopover) tile.appendChild(volPopover);
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
      reactionsDock.style.display = this.elements.roomChannels && !hasActiveStreams ? 'none' : 'flex';
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
};
