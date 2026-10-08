import { getAudioContext } from './audio.js';
import { isValidPeerId } from './shared/peer-id.js';
import { VAD_THRESHOLD, VAD_SILENCE_DELAY_MS, MAX_VOICE_PARTICIPANTS } from './voice/shared.js';
export * from './voice/shared.js';
import { withVoiceManagerCapture } from './voice/capture.js';
import { withVoiceManagerMixer } from './voice/mixer.js';
import { withVoiceManagerParticipants } from './voice/participants.js';
import { withVoiceManagerVad } from './voice/vad.js';
import { withVoiceManagerDevices } from './voice/devices.js';
export class VoiceManager extends withVoiceManagerDevices(withVoiceManagerVad(withVoiceManagerParticipants(withVoiceManagerMixer(withVoiceManagerCapture(class {}))))) {
constructor(options = {}) {
    super();
    this.audioContextProvider = options.audioContextProvider || getAudioContext;
    this.isInVoice = false;
    this.isMuted = false;
    this.isManuallyMuted = false;
    this.isDeafened = false;
    this.voiceMode = 'vad'; // 'vad' | 'ptt'
    this.isPttActive = false;
    this.localStream = null;
    this.myPeerId = null;
    this.myName = 'Você';
    this.myRole = 'host';

    // Map: peerId -> { peerId, name, role, isMuted, isDeafened, isSpeaking, stream, audioElem, analyser, vadTimer }
    this.participants = new Map();

    this.localVad = {
      source: null,
      analyser: null,
      intervalId: null,
      lastSpokeTime: 0,
      isSpeaking: false,
    };

    this.selectedMicId = '';
    this.selectedSpeakerId = '';
    try {
      this.selectedMicId = localStorage.getItem('seemygame_audio_input_id') || '';
      this.selectedSpeakerId = localStorage.getItem('seemygame_audio_output_id') || '';
    } catch (_) { /* Device preferences must not prevent session initialization. */ }

    // Controles de Volume (Estilo Discord)
    let savedInputVol = 100;
    let savedOutputVol = 100;
    try {
      if (typeof localStorage !== 'undefined') {
        const inp = localStorage.getItem('seemygame_voice_input_volume');
        if (inp !== null && !isNaN(Number(inp))) savedInputVol = Math.max(0, Math.min(200, Math.round(Number(inp))));
        const out = localStorage.getItem('seemygame_voice_output_volume');
        if (out !== null && !isNaN(Number(out))) savedOutputVol = Math.max(0, Math.min(200, Math.round(Number(out))));
      }
    } catch (_) {}

    this.inputVolume = savedInputVol; // 0 - 200% (Ganho do microfone)
    this.outputVolume = savedOutputVol; // 0 - 200% (Volume master de saída)
    this.userVolumes = new Map(); // peerId -> volume (0 - 200%)
    this.userMutes = new Map(); // peerId -> boolean (mutado localmente)

    this.localGainNode = null;
    this.localSourceNode = null;
    this.rawLocalStream = null;
    this.processedStream = null;

    this.listeners = {
      participantUpdate: new Set(),
      speakingChange: new Set(),
      voiceStateChange: new Set(),
      voiceJoined: new Set(),
      voiceLeft: new Set(),
      audioInputTrackChange: new Set(),
      audioOutputDeviceChange: new Set(),
      inputVolumeChange: new Set(),
      outputVolumeChange: new Set(),
      userVolumeChange: new Set(),
      userMuteChange: new Set(),
    };
  }

on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].add(callback);
    }
  }

off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].delete(callback);
    }
  }

emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => {
        try {
          cb(data);
        } catch (e) {
          console.error(`Erro no listener de voz (${event}):`, e);
        }
      });
    }
  }
}
export const voiceManager = new VoiceManager();
