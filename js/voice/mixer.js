import { getAudioContext } from ".././audio.js";
import { isValidPeerId } from ".././shared/peer-id.js";
import { VAD_THRESHOLD, VAD_SILENCE_DELAY_MS, MAX_VOICE_PARTICIPANTS } from './shared.js';
/** VoiceManager: mixer. State and lifetime remain owned by the composed engine. */
export const withVoiceManagerMixer = Base => class extends Base {
toggleMute() {
    return this.setMuted(!this.isMuted);
  }

setMuted(muted) {
    this.isMuted = Boolean(muted);
    if (this.rawLocalStream) {
      this.rawLocalStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
    }
    if (this.localStream && this.localStream !== this.rawLocalStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
    }
    if (this.processedStream) {
      this.processedStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
    }

    const me = this.participants.get(this.myPeerId);
    if (me) {
      me.isMuted = this.isMuted;
      if (this.isMuted && me.isSpeaking) {
        me.isSpeaking = false;
        this.emit('speakingChange', { peerId: this.myPeerId, isSpeaking: false });
      }
    }

    this.emit('voiceStateChange', this.getLocalVoiceState());
    this.emit('participantUpdate', this.getParticipantsList());
    return this.isMuted;
  }

toggleDeaf() {
    return this.setDeafened(!this.isDeafened);
  }

toggleDeafen() {
    return this.toggleDeaf();
  }

setVoiceMode(mode) {
    const nextMode = mode === 'ptt' ? 'ptt' : 'vad';
    if (this.voiceMode !== nextMode) this.isPttActive = false;
    this.voiceMode = nextMode;
    if (this.voiceMode === 'ptt' && !this.isPttActive) {
      this.setMuted(true);
    } else if (this.voiceMode === 'vad') {
      this.setMuted(false);
    }
    this.emit('voiceStateChange', this.getLocalVoiceState());
    return this.voiceMode;
  }

setPttActive(active) {
    if (this.voiceMode !== 'ptt') return false;
    this.isPttActive = Boolean(active);
    this.setMuted(!this.isPttActive);
    return this.isPttActive;
  }

setDeafened(deafened) {
    this.isDeafened = Boolean(deafened);

    // Atualiza ganho e mudo de todos os participantes remotos
    for (const peerId of this.participants.keys()) {
      this.applyParticipantVolume(peerId);
    }

    // Padrão Discord: se ensurdecer, muta o microfone automaticamente
    if (this.isDeafened && !this.isMuted) {
      this.setMuted(true);
    }

    const me = this.participants.get(this.myPeerId);
    if (me) {
      me.isDeafened = this.isDeafened;
    }

    this.emit('voiceStateChange', this.getLocalVoiceState());
    this.emit('participantUpdate', this.getParticipantsList());
    return this.isDeafened;
  }

setInputVolume(volume) {
    const clamped = Math.max(0, Math.min(200, Math.round(Number(volume) || 0)));
    this.inputVolume = clamped;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('seemygame_voice_input_volume', String(clamped));
      }
    } catch (_) {}

    if (this.localGainNode && this.localGainNode.gain) {
      const targetGain = clamped / 100;
      this.localGainNode.gain.value = targetGain;
      try {
        if (typeof this.localGainNode.gain.setTargetAtTime === 'function') {
          const ctx = this.audioContextProvider();
          this.localGainNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.01);
        }
      } catch (_) {}
    }

    this.emit('inputVolumeChange', { volume: clamped });
    this.emit('voiceStateChange', this.getLocalVoiceState());
    return clamped;
  }

setOutputVolume(volume) {
    const clamped = Math.max(0, Math.min(200, Math.round(Number(volume) || 0)));
    this.outputVolume = clamped;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('seemygame_voice_output_volume', String(clamped));
      }
    } catch (_) {}

    for (const peerId of this.participants.keys()) {
      this.applyParticipantVolume(peerId);
    }

    this.emit('outputVolumeChange', { volume: clamped });
    this.emit('voiceStateChange', this.getLocalVoiceState());
    return clamped;
  }

getUserVolume(peerId) {
    if (!peerId) return 100;
    if (this.userVolumes.has(peerId)) {
      return this.userVolumes.get(peerId);
    }
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(`seemygame_user_volume_${peerId}`);
        if (saved !== null && !isNaN(Number(saved))) {
          const vol = Math.max(0, Math.min(200, Math.round(Number(saved))));
          this.userVolumes.set(peerId, vol);
          return vol;
        }
      }
    } catch (_) {}
    return 100;
  }

setUserVolume(peerId, volume) {
    if (!peerId) return 100;
    const clamped = Math.max(0, Math.min(200, Math.round(Number(volume) || 0)));
    this.userVolumes.set(peerId, clamped);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`seemygame_user_volume_${peerId}`, String(clamped));
      }
    } catch (_) {}
    this.applyParticipantVolume(peerId);
    this.emit('userVolumeChange', { peerId, volume: clamped });
    this.emit('participantUpdate', this.getParticipantsList());
    return clamped;
  }

isUserLocallyMuted(peerId) {
    if (!peerId) return false;
    if (this.userMutes.has(peerId)) {
      return this.userMutes.get(peerId);
    }
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(`seemygame_user_mute_${peerId}`);
        if (saved !== null) {
          const muted = saved === 'true';
          this.userMutes.set(peerId, muted);
          return muted;
        }
      }
    } catch (_) {}
    return false;
  }

setUserMuted(peerId, isMuted) {
    if (!peerId) return false;
    const muted = Boolean(isMuted);
    this.userMutes.set(peerId, muted);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`seemygame_user_mute_${peerId}`, String(muted));
      }
    } catch (_) {}
    this.applyParticipantVolume(peerId);
    this.emit('userMuteChange', { peerId, isMuted: muted });
    this.emit('participantUpdate', this.getParticipantsList());
    return muted;
  }

applyParticipantVolume(peerId) {
    const p = this.participants.get(peerId);
    if (!p || p.isLocal || !p.audioElem) return;

    const userVol = this.getUserVolume(peerId);
    const isLocallyMuted = this.isUserLocallyMuted(peerId);
    const isDeaf = Boolean(this.isDeafened);

    const shouldMute = isDeaf || isLocallyMuted || userVol === 0 || this.outputVolume === 0;
    const effectiveMultiplier = (userVol / 100) * (this.outputVolume / 100);

    if (p.gainNode && p.gainNode.gain) {
      const targetGain = shouldMute ? 0 : effectiveMultiplier;
      p.gainNode.gain.value = targetGain;
      try {
        if (typeof p.gainNode.gain.setTargetAtTime === 'function') {
          const ctx = this.audioContextProvider();
          p.gainNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.01);
        }
      } catch (_) {}
    }

    try {
      p.audioElem.muted = shouldMute;
      if (!p.gainNode) {
        p.audioElem.volume = Math.max(0, Math.min(1.0, effectiveMultiplier));
      } else {
        p.audioElem.volume = 1.0;
      }
    } catch (e) {
      console.warn(`[Voice] Erro ao aplicar volume em ${peerId}:`, e);
    }
  }
};
