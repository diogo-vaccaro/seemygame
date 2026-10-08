import { getAudioContext } from ".././audio.js";
import { isValidPeerId } from ".././shared/peer-id.js";
import { VAD_THRESHOLD, VAD_SILENCE_DELAY_MS, MAX_VOICE_PARTICIPANTS } from './shared.js';
/** VoiceManager: vad. State and lifetime remain owned by the composed engine. */
export const withVoiceManagerVad = Base => class extends Base {
initLocalVAD() {
    this.stopLocalVAD();
    if (!this.localStream || this.localStream.getAudioTracks().length === 0) return;

    try {
      const ctx = this.audioContextProvider();
      this.localVad.source = ctx.createMediaStreamSource(this.localStream);
      this.localVad.analyser = ctx.createAnalyser();
      this.localVad.analyser.fftSize = 64;
      this.localVad.source.connect(this.localVad.analyser);

      const buffer = new Uint8Array(this.localVad.analyser.frequencyBinCount);

      this.localVad.intervalId = setInterval(() => {
        if (!this.isInVoice || this.isMuted) {
          if (this.localVad.isSpeaking) {
            this.setLocalSpeaking(false);
          }
          return;
        }

        this.localVad.analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i];
        const avg = sum / buffer.length;

        const now = Date.now();
        if (avg >= VAD_THRESHOLD) {
          this.localVad.lastSpokeTime = now;
          if (!this.localVad.isSpeaking) {
            this.setLocalSpeaking(true);
          }
        } else if (this.localVad.isSpeaking && now - this.localVad.lastSpokeTime > VAD_SILENCE_DELAY_MS) {
          this.setLocalSpeaking(false);
        }
      }, 80);
    } catch (err) {
      console.warn('[Voice VAD] Erro ao inicializar VAD local:', err);
    }
  }

setLocalSpeaking(isSpeaking) {
    this.localVad.isSpeaking = isSpeaking;
    const me = this.participants.get(this.myPeerId);
    if (me) {
      me.isSpeaking = isSpeaking;
    }
    this.emit('speakingChange', { peerId: this.myPeerId, isSpeaking });
    this.emit('participantUpdate', this.getParticipantsList());
  }

stopLocalVAD() {
    if (this.localVad.intervalId) {
      clearInterval(this.localVad.intervalId);
      this.localVad.intervalId = null;
    }
    try {
      if (this.localVad.source) {
        this.localVad.source.disconnect();
        this.localVad.source = null;
      }
    } catch (e) {}
    try { this.localVad.analyser?.disconnect(); } catch (_) {}
    this.localVad.analyser = null;
    this.localVad.isSpeaking = false;
  }

initRemoteVAD(participant) {
    this.stopRemoteVAD(participant);
    if (!participant.stream || participant.stream.getAudioTracks().length === 0) return;

    try {
      const ctx = this.audioContextProvider();
      const source = ctx.createMediaStreamSource(participant.stream);
      const analyser = ctx.createAnalyser();
      participant.vadSource = source;
      participant.vadAnalyser = analyser;
      analyser.fftSize = 64;
      source.connect(analyser);

      const buffer = new Uint8Array(analyser.frequencyBinCount);
      let lastSpoke = 0;

      participant.vadInterval = setInterval(() => {
        analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i];
        const avg = sum / buffer.length;

        const now = Date.now();
        if (avg >= VAD_THRESHOLD) {
          lastSpoke = now;
          if (!participant.isSpeaking) {
            participant.isSpeaking = true;
            this.emit('speakingChange', { peerId: participant.peerId, isSpeaking: true });
            this.emit('participantUpdate', this.getParticipantsList());
          }
        } else if (participant.isSpeaking && now - lastSpoke > VAD_SILENCE_DELAY_MS) {
          participant.isSpeaking = false;
          this.emit('speakingChange', { peerId: participant.peerId, isSpeaking: false });
          this.emit('participantUpdate', this.getParticipantsList());
        }
      }, 80);
    } catch (err) {
      this.stopRemoteVAD(participant);
      console.warn(`[Remote VAD] Falha para ${participant.peerId}:`, err);
    }
  }

stopRemoteVAD(participant) {
    if (participant.vadInterval != null) clearInterval(participant.vadInterval);
    participant.vadInterval = null;
    for (const node of [participant.vadSource, participant.vadAnalyser]) {
      try { node?.disconnect(); } catch (_) {}
    }
    participant.vadSource = participant.vadAnalyser = null;
  }
};
