import { getAudioContext } from ".././audio.js";
import { isValidPeerId } from ".././shared/peer-id.js";
import { VAD_THRESHOLD, VAD_SILENCE_DELAY_MS, MAX_VOICE_PARTICIPANTS } from './shared.js';
/** VoiceManager: capture. State and lifetime remain owned by the composed engine. */
export const withVoiceManagerCapture = Base => class extends Base {
async joinVoice({ peerId, name = 'Você', role = 'host', customStream = null, inputDeviceId = null } = {}) {
    if (this.isInVoice) return this.localStream;

    const generation = this.captureGeneration = (this.captureGeneration || 0) + 1;
    this.myPeerId = peerId;
    this.myName = name;
    this.myRole = role;
    if (inputDeviceId !== null && inputDeviceId !== undefined) {
      this.selectedMicId = inputDeviceId;
    }

    try {
      if (customStream) {
        this.rawLocalStream = customStream;
        this.localStream = this.setupLocalAudioProcessing(customStream) || customStream;
      } else if (navigator?.mediaDevices?.getUserMedia) {
        const audioConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        if (this.selectedMicId) {
          audioConstraints.deviceId = { ideal: this.selectedMicId };
        }

        try {
          const userStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false,
          });
          if (generation !== this.captureGeneration) { userStream.getTracks().forEach(track => track.stop()); return null; }
          this.rawLocalStream = userStream;
          const processed = this.setupLocalAudioProcessing(userStream);
          this.localStream = processed || userStream;
        } catch (deviceErr) {
          if (generation !== this.captureGeneration) return null;
          console.warn('[Voice] Microfone preferencial indisponível, usando padrão:', deviceErr);
          if (this.selectedMicId) {
            this.selectedMicId = '';
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.removeItem('seemygame_audio_input_id');
              }
            } catch (_) {}
          }
          let userStream;
          try {
            userStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: false,
            });
          } catch (stdErr) {
            if (generation !== this.captureGeneration) return null;
            console.warn('[Voice] Captura com cancelamento de ruído falhou, usando captura pura (audio: true):', stdErr);
            userStream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: false,
            });
          }
          if (generation !== this.captureGeneration) { userStream.getTracks().forEach(track => track.stop()); return null; }
          this.rawLocalStream = userStream;
          const processed = this.setupLocalAudioProcessing(userStream);
          this.localStream = processed || userStream;
        }
      } else {
        throw new Error('getUserMedia não suportado neste ambiente');
      }

      this.isInVoice = true;

      // SEGURANÇA / PRIVACIDADE (A07): Se estiver em modo PTT e a tecla não estiver ativa,
      // inicializa o microfone mutado para não vazar áudio ao entrar ou reconectar
      if (this.voiceMode === 'ptt' && !this.isPttActive) {
        this.isMuted = true;
      }

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

      // Registra a si mesmo como participante local
      this.participants.set(this.myPeerId, {
        peerId: this.myPeerId,
        name: this.myName,
        role: this.myRole,
        isMuted: this.isMuted,
        isDeafened: this.isDeafened,
        isSpeaking: false,
        isLocal: true,
      });

      this.initLocalVAD();

      this.emit('voiceJoined', { stream: this.localStream, peerId: this.myPeerId });
      this.emit('voiceStateChange', this.getLocalVoiceState());
      this.emit('participantUpdate', this.getParticipantsList());

      return this.localStream;
    } catch (err) {
      if (generation !== this.captureGeneration) return null;
      console.warn('[Voice] Falha ao acessar microfone:', err);
      this.isInVoice = false;
      throw err;
    }
  }

setupLocalAudioProcessing(stream) {
    if (!stream || stream.getAudioTracks().length === 0) return stream;
    try {
      const ctx = this.audioContextProvider();
      if (ctx && typeof ctx.createMediaStreamSource === 'function' && typeof ctx.createGain === 'function' && typeof ctx.createMediaStreamDestination === 'function') {
        this.teardownLocalAudioProcessing();
        this.localSourceNode = ctx.createMediaStreamSource(stream);
        this.localGainNode = ctx.createGain();
        if (this.localGainNode.gain) {
          this.localGainNode.gain.value = this.inputVolume / 100;
        }
        const dest = ctx.createMediaStreamDestination();
        this.localSourceNode.connect(this.localGainNode);
        this.localGainNode.connect(dest);
        this.processedStream = dest.stream;
        return this.processedStream;
      }
    } catch (err) {
      console.warn('[Voice] Falha ao configurar ganho do microfone:', err);
    }
    return stream;
  }

teardownLocalAudioProcessing() {
    try {
      if (this.localSourceNode && typeof this.localSourceNode.disconnect === 'function') {
        this.localSourceNode.disconnect();
      }
    } catch (_) {}
    try {
      if (this.localGainNode && typeof this.localGainNode.disconnect === 'function') {
        this.localGainNode.disconnect();
      }
    } catch (_) {}
    this.localSourceNode = null;
    this.localGainNode = null;
    this.processedStream = null;
  }

leaveVoice() {
    this.captureGeneration = (this.captureGeneration || 0) + 1;
    this.stopLocalVAD();
    this.teardownLocalAudioProcessing();

    if (this.rawLocalStream) {
      this.rawLocalStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch (e) {}
      });
      this.rawLocalStream = null;
    }

    if (this.localStream && this.localStream !== this.rawLocalStream) {
      this.localStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch (e) {}
      });
      this.localStream = null;
    }

    // Fecha elementos de áudio dos participantes remotos
    for (const p of this.participants.values()) {
      if (p.gainNode) {
        try { p.gainNode.disconnect(); } catch (e) {}
      }
      if (p.sourceNode) {
        try { p.sourceNode.disconnect(); } catch (e) {}
      }
      if (p.audioElem) {
        try {
          p.audioElem.pause();
          p.audioElem.srcObject = null;
          p.audioElem.remove();
        } catch (e) {}
      }
      if (p.vadInterval) {
        clearInterval(p.vadInterval);
      }
    }

    this.participants.clear();
    this.isInVoice = false;
    if (this.voiceMode === 'ptt') {
      this.isMuted = true;
      this.isPttActive = false;
    } else {
      this.isMuted = false;
    }
    this.isDeafened = false;

    this.emit('voiceLeft');
    this.emit('voiceStateChange', this.getLocalVoiceState());
    this.emit('participantUpdate', []);
  }
};
