import { getAudioContext } from ".././audio.js";
import { isValidPeerId } from ".././shared/peer-id.js";
import { VAD_THRESHOLD, VAD_SILENCE_DELAY_MS, MAX_VOICE_PARTICIPANTS } from './shared.js';
/** VoiceManager: participants. State and lifetime remain owned by the composed engine. */
export const withVoiceManagerParticipants = Base => class extends Base {
getLocalVoiceState() {
    return {
      isInVoice: this.isInVoice,
      isMuted: this.isMuted,
      isDeafened: this.isDeafened,
      voiceMode: this.voiceMode,
      isPttActive: this.isPttActive,
      inputVolume: this.inputVolume,
      outputVolume: this.outputVolume,
      peerId: this.myPeerId,
      name: this.myName,
      role: this.myRole,
    };
  }

addRemoteParticipant(peerId, optionsOrStream = {}) {
    if (!isValidPeerId(peerId) || peerId === this.myPeerId) return false;
    if (!this.participants.has(peerId) && this.participants.size >= MAX_VOICE_PARTICIPANTS) return false;

    let name = 'Amigo';
    let role = 'viewer';
    let stream = null;

    if (optionsOrStream && (typeof optionsOrStream.getTracks === 'function' || optionsOrStream._tracks)) {
      stream = optionsOrStream;
    } else if (typeof optionsOrStream === 'object' && optionsOrStream !== null) {
      name = optionsOrStream.name || 'Amigo';
      role = optionsOrStream.role || 'viewer';
      stream = optionsOrStream.stream || null;
    }

    if (this.participants.has(peerId)) {
      this.removeRemoteParticipant(peerId);
    }

    let audioElem = null;
    let gainNode = null;
    let sourceNode = null;
    let sourceAudioElem = null;
    let streamToPlay = stream;

    if (stream && typeof document !== 'undefined') {
      try {
        const ctx = this.audioContextProvider();
        if (ctx && typeof ctx.createMediaStreamSource === 'function' && typeof ctx.createGain === 'function' && typeof ctx.createMediaStreamDestination === 'function') {
          sourceNode = ctx.createMediaStreamSource(stream);
          gainNode = ctx.createGain();
          const dest = ctx.createMediaStreamDestination();
          sourceNode.connect(gainNode);
          gainNode.connect(dest);
          if (dest.stream) {
            streamToPlay = dest.stream;
          }
        }
      } catch (err) {
        console.warn('[Voice] Falha ao configurar GainNode para áudio remoto:', err);
      }

      audioElem = document.createElement('audio');
      audioElem.autoplay = true;
      audioElem.muted = this.isDeafened;
      audioElem.srcObject = streamToPlay;
      audioElem.style.display = 'none';
      if (this.selectedSpeakerId && typeof audioElem.setSinkId === 'function') {
        audioElem.setSinkId(this.selectedSpeakerId).catch((err) => {
          console.warn('[Voice] Falha ao configurar saída de áudio para participante:', err);
        });
      }
      document.body.appendChild(audioElem);
      if (streamToPlay !== stream) {
        // Chromium starts decoding RTC audio when a media element consumes the
        // original stream. Keep that consumer silent; the mixer owns playback.
        sourceAudioElem = document.createElement('audio');
        sourceAudioElem.autoplay = true; sourceAudioElem.muted = true;
        sourceAudioElem.srcObject = stream; sourceAudioElem.style.display = 'none';
        document.body.appendChild(sourceAudioElem);
        try { sourceAudioElem.play()?.catch?.(() => {}); } catch (_) {}
      }
      try {
        const playPromise = audioElem.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      } catch (_) {}
    }

    const participant = {
      peerId,
      name,
      role,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      isLocal: false,
      stream,
      audioElem,
      gainNode,
      sourceNode,
      sourceAudioElem,
      vadInterval: null,
    };

    if (stream) {
      this.initRemoteVAD(participant);
    }

    this.participants.set(peerId, participant);
    this.applyParticipantVolume(peerId);
    this.emit('participantUpdate', this.getParticipantsList());
    return true;
  }

removeRemoteParticipant(peerId) {
    const p = this.participants.get(peerId);
    if (p) {
      if (p.gainNode) {
        try { p.gainNode.disconnect(); } catch (e) {}
      }
      if (p.sourceNode) {
        try { p.sourceNode.disconnect(); } catch (e) {}
      }
      for (const element of [p.audioElem, p.sourceAudioElem]) {
        if (!element) continue;
        try {
          element.pause();
          element.srcObject = null;
          element.remove();
        } catch (e) {}
      }
      this.stopRemoteVAD(p);
      this.participants.delete(peerId);
      this.emit('participantUpdate', this.getParticipantsList());
    }
  }

updateParticipantState(peerId, { isMuted, isDeafened, isSpeaking } = {}) {
    const p = this.participants.get(peerId);
    if (!p) return;

    if (typeof isMuted === 'boolean') p.isMuted = isMuted;
    if (typeof isDeafened === 'boolean') p.isDeafened = isDeafened;
    if (typeof isSpeaking === 'boolean') {
      const changed = p.isSpeaking !== isSpeaking;
      p.isSpeaking = isSpeaking;
      if (changed) {
        this.emit('speakingChange', { peerId, isSpeaking });
      }
    }

    this.emit('participantUpdate', this.getParticipantsList());
  }

getParticipantsList() {
    return Array.from(this.participants.values()).map((p) => ({
      peerId: p.peerId,
      name: p.name,
      role: p.role,
      isMuted: p.isMuted,
      isDeafened: p.isDeafened,
      isSpeaking: p.isSpeaking,
      isLocal: Boolean(p.isLocal),
      stream: p.stream || null,
      audioElem: p.audioElem || null,
      userVolume: this.getUserVolume(p.peerId),
      isLocallyMuted: this.isUserLocallyMuted(p.peerId),
    }));
  }
};
