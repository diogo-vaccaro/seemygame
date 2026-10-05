import { getAudioContext } from ".././audio.js";
import { isValidPeerId } from ".././shared/peer-id.js";
import { VAD_THRESHOLD, VAD_SILENCE_DELAY_MS, MAX_VOICE_PARTICIPANTS } from './shared.js';
/** VoiceManager: devices. State and lifetime remain owned by the composed engine. */
export const withVoiceManagerDevices = Base => class extends Base {
async setAudioInputDevice(deviceId) {
    this.selectedMicId = deviceId || '';
    try {
      if (typeof localStorage !== 'undefined') {
        if (this.selectedMicId) {
          localStorage.setItem('seemygame_audio_input_id', this.selectedMicId);
        } else {
          localStorage.removeItem('seemygame_audio_input_id');
        }
      }
    } catch (e) {}

    if (!this.isInVoice) return null;

    const generation = this.captureGeneration = (this.captureGeneration || 0) + 1;
    const isCurrent = () => this.isInVoice && this.captureGeneration === generation;

    try {
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (this.selectedMicId) {
        audioConstraints.deviceId = { ideal: this.selectedMicId };
      }

      let newStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
      } catch (e) {
        if (!isCurrent()) return null;
        console.warn('[Voice] Microfone falhou, voltando para o padrão:', e);
        if (this.selectedMicId) {
          this.selectedMicId = '';
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.removeItem('seemygame_audio_input_id');
            }
          } catch (_) {}
        }
        try {
          newStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
        } catch (stdErr) {
          if (!isCurrent()) return null;
          console.warn('[Voice] Captura com cancelamento de ruído falhou na troca de dispositivo, usando captura pura:', stdErr);
          newStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
        }
      }

      if (!isCurrent() || !newStream.getAudioTracks().length) {
        newStream.getTracks().forEach(track => track.stop());
        return null;
      }
      const previousTracks = new Set([
        ...(this.rawLocalStream?.getTracks() || []),
        ...(this.localStream?.getTracks() || []),
        ...(this.processedStream?.getTracks() || [])
      ]);
      this.stopLocalVAD();
      this.teardownLocalAudioProcessing();
      this.rawLocalStream = newStream;
      this.localStream = this.setupLocalAudioProcessing(newStream) || newStream;
      for (const currentStream of new Set([this.rawLocalStream, this.localStream])) {
        currentStream.getAudioTracks().forEach(track => { track.enabled = !this.isMuted; });
      }
      previousTracks.forEach(track => { try { track.stop(); } catch (_) {} });
      const newTrack = this.localStream.getAudioTracks()[0];

      // Reinicializa o analisador VAD local com a nova faixa
      this.initLocalVAD();

      // Notifica para atualização dos senders WebRTC nas conexões ativas
      this.emit('audioInputTrackChange', { newTrack, stream: this.localStream, deviceId: this.selectedMicId });
      return this.localStream;
    } catch (err) {
      if (!isCurrent()) return null;
      console.warn('[Voice] Falha ao alternar dispositivo de microfone:', err);
      throw err;
    }
  }

async setAudioOutputDevice(deviceId) {
    this.selectedSpeakerId = deviceId || '';
    try {
      if (typeof localStorage !== 'undefined') {
        if (this.selectedSpeakerId) {
          localStorage.setItem('seemygame_audio_output_id', this.selectedSpeakerId);
        } else {
          localStorage.removeItem('seemygame_audio_output_id');
        }
      }
    } catch (e) {}

    const updatePromises = [];
    for (const p of this.participants.values()) {
      if (p.audioElem && typeof p.audioElem.setSinkId === 'function') {
        updatePromises.push(
          p.audioElem.setSinkId(this.selectedSpeakerId).catch((err) => {
            console.warn('[Voice] Erro ao aplicar sinkId no participante:', err);
          })
        );
      }
    }

    if (typeof document !== 'undefined') {
      const mediaElements = document.querySelectorAll('video, audio');
      mediaElements.forEach((el) => {
        if (typeof el.setSinkId === 'function') {
          updatePromises.push(
            el.setSinkId(this.selectedSpeakerId).catch(() => {})
          );
        }
      });
    }

    await Promise.all(updatePromises);
    this.emit('audioOutputDeviceChange', { deviceId: this.selectedSpeakerId });
    return this.selectedSpeakerId;
  }
};
