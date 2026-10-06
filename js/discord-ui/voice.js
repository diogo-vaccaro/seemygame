import { SOUNDBOARD_PRESETS } from ".././soundboard.js";
import { EMOJI_REACTION_PRESETS } from './shared.js';
/** DiscordUIController: voice. State and lifetime remain owned by the composed engine. */
export const withDiscordUIControllerVoice = Base => class extends Base {
bindVoiceEvents() {
    const heldPttKeys = new Set();
    const pttKey = code => code === 'CapsLock' || code === 'ControlRight';
    const releasePtt = () => {
      heldPttKeys.clear();
      if (this.voiceManager.isPttActive) this.voiceManager.setPttActive(false);
    };
    this._cleanupFns.push(releasePtt);
    this.listen(window, 'keydown', event => {
      if (!pttKey(event.code) || event.isComposing || document.hidden ||
          !this.voiceManager.isInVoice || this.voiceManager.voiceMode !== 'ptt' || this.voiceManager.isDeafened ||
          event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      event.preventDefault();
      if (heldPttKeys.has(event.code)) return;
      heldPttKeys.add(event.code);
      this.voiceManager.setPttActive(true);
    });
    this.listen(window, 'keyup', event => {
      if (!heldPttKeys.delete(event.code)) return;
      event.preventDefault();
      if (this.voiceManager.voiceMode === 'ptt') this.voiceManager.setPttActive(heldPttKeys.size > 0 && this.voiceManager.isInVoice && !this.voiceManager.isDeafened);
    });
    this.listen(window, 'blur', releasePtt);
    this.listen(window, 'pagehide', releasePtt);
    this.listen(document, 'visibilitychange', () => { if (document.hidden) releasePtt(); });
    this._cleanupFns.push(() => this._voiceRenderController?.abort());
    this.observe(this.voiceManager, 'participantUpdate', (participants) => {
      this.renderVoiceParticipants(participants);
    });

    this.observe(this.voiceManager, 'speakingChange', ({ peerId, isSpeaking }) => {
      const avatar = document.getElementById(`voice-avatar-${peerId}`);
      if (avatar) {
        if (isSpeaking) {
          avatar.classList.add('speaking');
        } else {
          avatar.classList.remove('speaking');
        }
      }
    });

    this.observe(this.voiceManager, 'voiceStateChange', (state) => {
      if (!state.isInVoice || state.voiceMode !== 'ptt' || state.isDeafened) heldPttKeys.clear();
      this.updateVoiceControls(state);
    });

    this.observe(this.voiceManager, 'inputVolumeChange', ({ volume }) => {
      if (this.elements.voiceSelfMicSlider) this.elements.voiceSelfMicSlider.value = volume;
      if (this.elements.voiceSelfMicVal) this.elements.voiceSelfMicVal.textContent = `${volume}%`;
    });

    this.observe(this.voiceManager, 'outputVolumeChange', ({ volume }) => {
      if (this.elements.voiceSelfOutputSlider) this.elements.voiceSelfOutputSlider.value = volume;
      if (this.elements.voiceSelfOutputVal) this.elements.voiceSelfOutputVal.textContent = `${volume}%`;
    });
  }

renderVoiceParticipants(participants) {
    this._voiceRenderController?.abort();
    this._voiceRenderController = new AbortController();
    const listenerOptions = { signal: this._voiceRenderController.signal };
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

      const topRow = document.createElement('div');
      topRow.className = 'voice-user-card-top';

      const info = document.createElement('div');
      info.className = 'voice-user-info';

      const avatar = document.createElement('div');
      if (p.peerId) avatar.id = `voice-avatar-${p.peerId}`;
      avatar.className = `avatar-circle ${p.isSpeaking ? 'speaking' : ''}`;
      avatar.textContent = initial;

      const userName = document.createElement('div');
      userName.className = 'voice-user-name';
      userName.textContent = (p.name || 'Amigo') + ' ';

      if (p.isLocal) {
        const youBadge = document.createElement('span');
        youBadge.className = 'voice-you-badge';
        youBadge.textContent = '(Você)';
        userName.appendChild(youBadge);
      }

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

      topRow.appendChild(info);
      topRow.appendChild(icons);
      card.appendChild(topRow);

      // Controle de volume individual para amigos remotos
      if (!p.isLocal && p.peerId) {
        const userVol = typeof p.userVolume === 'number' ? p.userVolume : this.voiceManager.getUserVolume(p.peerId);
        const isLocallyMuted = Boolean(p.isLocallyMuted ?? this.voiceManager.isUserLocallyMuted(p.peerId));

        const volRow = document.createElement('div');
        volRow.className = 'voice-user-volume-row';

        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = `voice-user-mute-btn ${isLocallyMuted ? 'muted' : ''}`;
        muteBtn.title = isLocallyMuted ? 'Desmutar este amigo para você' : 'Mutar este amigo só para você';
        muteBtn.setAttribute('aria-label', muteBtn.title);
        muteBtn.textContent = isLocallyMuted ? '🔇' : '🔊';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '200';
        slider.step = '1';
        slider.value = String(userVol);
        slider.className = 'voice-user-volume-slider';
        slider.title = `Volume de ${p.name || 'Amigo'}: ${userVol}%`;
        slider.setAttribute('aria-label', `Volume de ${p.name || 'Amigo'}`);

        const valSpan = document.createElement('span');
        valSpan.className = 'voice-user-volume-val';
        valSpan.textContent = `${userVol}%`;

        muteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const currentMute = this.voiceManager.isUserLocallyMuted(p.peerId);
          const nextMute = !currentMute;
          this.voiceManager.setUserMuted(p.peerId, nextMute);
          muteBtn.textContent = nextMute ? '🔇' : '🔊';
          muteBtn.classList.toggle('muted', nextMute);
          muteBtn.title = nextMute ? 'Desmutar este amigo para você' : 'Mutar este amigo só para você';
          muteBtn.setAttribute('aria-label', muteBtn.title);
        }, listenerOptions);

        slider.addEventListener('input', (e) => {
          e.stopPropagation();
          const newVol = parseInt(e.target.value, 10) || 0;
          this.voiceManager.setUserVolume(p.peerId, newVol);
          valSpan.textContent = `${newVol}%`;
          slider.title = `Volume de ${p.name || 'Amigo'}: ${newVol}%`;
          if (newVol === 0) {
            muteBtn.textContent = '🔇';
          } else if (!this.voiceManager.isUserLocallyMuted(p.peerId)) {
            muteBtn.textContent = '🔊';
          }
        }, listenerOptions);

        volRow.appendChild(muteBtn);
        volRow.appendChild(slider);
        volRow.appendChild(valSpan);
        card.appendChild(volRow);
      } else if (p.isLocal) {
        const selfRow = document.createElement('div');
        selfRow.className = 'voice-user-volume-row voice-self-indicator-row';
        selfRow.innerHTML = `
          <span class="voice-self-mic-badge">🎙️ Ganho Mic: <strong>${this.voiceManager.inputVolume}%</strong></span>
        `;
        card.appendChild(selfRow);
      }

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
    if (this.elements.roomChannels) this.renderRoomChannels();

    if (this.elements.voiceSelfMicSlider && typeof state.inputVolume === 'number') {
      this.elements.voiceSelfMicSlider.value = state.inputVolume;
      if (this.elements.voiceSelfMicVal) this.elements.voiceSelfMicVal.textContent = `${state.inputVolume}%`;
    }
    if (this.elements.voiceSelfOutputSlider && typeof state.outputVolume === 'number') {
      this.elements.voiceSelfOutputSlider.value = state.outputVolume;
      if (this.elements.voiceSelfOutputVal) this.elements.voiceSelfOutputVal.textContent = `${state.outputVolume}%`;
    }
  }
};
