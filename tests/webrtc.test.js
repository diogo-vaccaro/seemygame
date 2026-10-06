import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tuneSdpForGaming,
  hookPeerConnectionSdp,
  applyTransceiverOptimizations,
  applySenderOptimizations,
  applySenderOptimizationsWhenReady,
  updateSenderBitrate,
  swapStreamAudioTrack
} from '../js/webrtc.js';
import {
  MockRTCPeerConnection,
  MockRTCRtpSender,
  MockMediaStreamTrack
} from './mocks/webrtc.mock.js';

describe('Módulo: webrtc.js', () => {
  const sampleSdp = [
    'v=0',
    'o=- 123456 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'
  ].join('\r\n');

  describe('tuneSdpForGaming', () => {
    it('deve retornar o próprio valor se o SDP for nulo ou vazio', () => {
      expect(tuneSdpForGaming(null, 7500000)).toBeNull();
      expect(tuneSdpForGaming('', 7500000)).toBe('');
      expect(tuneSdpForGaming(undefined, 7500000)).toBeUndefined();
    });

    it('deve injetar parâmetros Opus Gamer estéreo na seção de áudio', () => {
      const tuned = tuneSdpForGaming(sampleSdp, 7500000);
      expect(tuned).toContain('stereo=1');
      expect(tuned).toContain('sprop-stereo=1');
      expect(tuned).toContain('maxaveragebitrate=128000');
      expect(tuned).toContain('cbr=1');
      expect(tuned).toContain('usedtx=0');
      expect(tuned).toContain('maxplaybackrate=48000');
    });

    it('não deve duplicar parâmetros Opus se já estiverem presentes', () => {
      const tunedOnce = tuneSdpForGaming(sampleSdp, 7500000);
      const tunedTwice = tuneSdpForGaming(tunedOnce, 7500000);
      expect((tunedTwice.match(/maxaveragebitrate=128000/g) || []).length).toBe(1);
      expect(tunedTwice).toBe(tunedOnce);
    });

    it('deve injetar piso e limites de bitrate na seção de vídeo H.264', () => {
      const bitrate = 8000000;
      const kbps = Math.round(bitrate / 1000);
      const tuned = tuneSdpForGaming(sampleSdp, bitrate);

      expect(tuned).toContain('x-google-min-bitrate=1000');
      expect(tuned).toContain(`x-google-start-bitrate=${Math.round(kbps * 0.7)}`);
      expect(tuned).toContain(`x-google-max-bitrate=${Math.round(kbps * 1.3)}`);
    });

    it('deve adicionar limites de banda b=AS e b=TIAS na seção de vídeo', () => {
      const bitrate = 6000000;
      const kbps = 6000;
      const tuned = tuneSdpForGaming(sampleSdp, bitrate);

      expect(tuned).toContain(`b=AS:${kbps}`);
      expect(tuned).toContain(`b=TIAS:${bitrate}`);
    });

    it('não deve duplicar b=AS se já existir no SDP', () => {
      const sdpWithAS = sampleSdp.replace('m=video 9 UDP/TLS/RTP/SAVPF 96', 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\nb=AS:5000');
      const tuned = tuneSdpForGaming(sdpWithAS, 7500000);
      const asMatches = (tuned.match(/b=AS:/g) || []).length;
      expect(asMatches).toBe(1);
    });

    it('deve posicionar b=AS e b=TIAS estritamente após a linha c= conforme a RFC 8866', () => {
      const tuned = tuneSdpForGaming(sampleSdp, 7500000);
      // Na seção de vídeo, c= deve preceder b=AS
      const cIndex = tuned.lastIndexOf('c=IN IP4 0.0.0.0');
      const bIndex = tuned.indexOf('b=AS:7500');
      expect(cIndex).toBeGreaterThan(-1);
      expect(bIndex).toBeGreaterThan(cIndex);
    });
  });

  describe('hookPeerConnectionSdp', () => {
    let pc;

    beforeEach(() => {
      pc = new MockRTCPeerConnection();
    });

    it('não deve lançar erro se o objeto PeerConnection for nulo ou indefinido', () => {
      expect(() => hookPeerConnectionSdp(null)).not.toThrow();
      expect(() => hookPeerConnectionSdp(undefined)).not.toThrow();
    });

    it('deve marcar o peerConnection como _sdpHooked e interceptar setLocalDescription', async () => {
      hookPeerConnectionSdp(pc, 7500000);
      expect(pc._sdpHooked).toBe(true);

      const desc = { type: 'offer', sdp: sampleSdp };
      await pc.setLocalDescription(desc);

      expect(desc.sdp).toContain('stereo=1');
      expect(desc.sdp).toContain('x-google-min-bitrate=1000');
    });

    it('não deve reinstalar o hook se _sdpHooked já estiver ativo', () => {
      hookPeerConnectionSdp(pc, 7500000);
      const firstSetLocal = pc.setLocalDescription;
      hookPeerConnectionSdp(pc, 8000000);
      expect(pc.setLocalDescription).toBe(firstSetLocal);
    });

    it('deve suportar getBitrateBps como uma função dinâmica', async () => {
      const getBitrate = vi.fn(() => 10000000);
      hookPeerConnectionSdp(pc, getBitrate);

      const desc = { type: 'offer', sdp: sampleSdp };
      await pc.setLocalDescription(desc);

      expect(getBitrate).toHaveBeenCalled();
      expect(desc.sdp).toContain('b=AS:10000');
      expect(desc.sdp).toContain('b=TIAS:10000000');
    });

    it('deve usar o valor padrão de 7500000 caso getBitrateBps não seja fornecido', async () => {
      hookPeerConnectionSdp(pc);

      const desc = { type: 'offer', sdp: sampleSdp };
      await pc.setLocalDescription(desc);

      expect(desc.sdp).toContain('b=AS:7500');
      expect(desc.sdp).toContain('b=TIAS:7500000');
    });
  });

  describe('applyTransceiverOptimizations', () => {
    it('deve retornar sem erro se pc for nulo ou não possuir getTransceivers', () => {
      expect(() => applyTransceiverOptimizations(null)).not.toThrow();
      expect(() => applyTransceiverOptimizations({})).not.toThrow();
    });

    it('deve configurar jitterBufferTarget = 0 e playoutDelayHint = 0 nos receptores', () => {
      const receiver = { jitterBufferTarget: 100, playoutDelayHint: 50 };
      const transceiver = { receiver };
      const pc = {
        getTransceivers: () => [transceiver]
      };

      applyTransceiverOptimizations(pc, 'ultra-low');

      expect(receiver.jitterBufferTarget).toBe(0);
      expect(receiver.playoutDelayHint).toBe(0);
    });

    it('deve configurar jitterBufferTarget = 50ms e playoutDelayHint = 0.05s no modo stable', () => {
      const receiver = { jitterBufferTarget: 0, playoutDelayHint: 0 };
      const transceiver = { receiver };
      const pc = {
        getTransceivers: () => [transceiver]
      };

      applyTransceiverOptimizations(pc, 'stable');

      expect(receiver.jitterBufferTarget).toBe(50);
      expect(receiver.playoutDelayHint).toBe(0.05);
    });

    it('deve priorizar codecs H.264 em setCodecPreferences no transceiver de envio', () => {
      const mockSetCodecPreferences = vi.fn();
      const transceiver = {
        sender: {},
        setCodecPreferences: mockSetCodecPreferences
      };
      const pc = {
        getTransceivers: () => [transceiver]
      };

      applyTransceiverOptimizations(pc);

      expect(mockSetCodecPreferences).toHaveBeenCalled();
      const orderedCodecs = mockSetCodecPreferences.mock.calls[0][0];
      expect(orderedCodecs[0].mimeType).toBe('video/H264');
    });

    it('não deve tentar aplicar preferências de codecs de vídeo em transceivers de áudio', () => {
      const mockSetCodecPreferences = vi.fn();
      const audioTrack = new MockMediaStreamTrack('audio');
      const audioTransceiver = {
        sender: { track: audioTrack },
        setCodecPreferences: mockSetCodecPreferences
      };
      const pc = {
        getTransceivers: () => [audioTransceiver]
      };

      applyTransceiverOptimizations(pc);

      expect(mockSetCodecPreferences).not.toHaveBeenCalled();
    });
  });

  describe('applySenderOptimizations', () => {
    it('não deve lançar erro se pc for nulo', async () => {
      await expect(applySenderOptimizations(null, 7500000)).resolves.not.toThrow();
    });

    it('deve configurar trava de 60 FPS, contentHint motion e degradationPreference maintain-resolution por padrão', async () => {
      const videoTrack = new MockMediaStreamTrack('video');
      const sender = new MockRTCRtpSender(videoTrack);
      const setParamsSpy = vi.spyOn(sender, 'setParameters');

      const pc = {
        getSenders: () => [sender]
      };

      await applySenderOptimizations(pc, 9000000, 60);

      expect(videoTrack.contentHint).toBe('motion');
      expect(setParamsSpy).toHaveBeenCalled();

      const passedParams = setParamsSpy.mock.calls[0][0];
      expect(passedParams.degradationPreference).toBe('maintain-resolution');
      expect(passedParams.encodings[0].maxFramerate).toBe(60);
      expect(passedParams.encodings[0].maxBitrate).toBe(9000000);
      expect(passedParams.encodings[0].priority).toBe('high');
      expect(passedParams.encodings[0].networkPriority).toBe('high');
    });

    it('deve permitir configurar explicitamente degradationPreference para maintain-framerate ou balanced', async () => {
      const videoTrack = new MockMediaStreamTrack('video');
      const sender = new MockRTCRtpSender(videoTrack);
      const setParamsSpy = vi.spyOn(sender, 'setParameters');

      const pc = {
        getSenders: () => [sender]
      };

      await applySenderOptimizations(pc, 9000000, 60, 1, 'maintain-framerate');
      expect(setParamsSpy.mock.calls[0][0].degradationPreference).toBe('maintain-framerate');

      setParamsSpy.mockClear();
      await applySenderOptimizations(pc, 9000000, 60, 1, 'balanced');
      expect(setParamsSpy.mock.calls[0][0].degradationPreference).toBe('balanced');
    });

    it('não deve modificar senders de faixas que não sejam de vídeo', async () => {
      const audioTrack = new MockMediaStreamTrack('audio');
      const sender = new MockRTCRtpSender(audioTrack);
      const setParamsSpy = vi.spyOn(sender, 'setParameters');

      const pc = {
        getSenders: () => [sender]
      };

      await applySenderOptimizations(pc, 7500000, 60);

      expect(setParamsSpy).not.toHaveBeenCalled();
      expect(audioTrack.contentHint).toBe('');
    });

    it('deve retornar false e não chamar setParameters se os encodings ainda não tiverem sido negociados', async () => {
      const videoTrack = new MockMediaStreamTrack('video');
      const sender = new MockRTCRtpSender(videoTrack);
      sender._params = { encodings: [] }; // Encodings vazios antes do negotiation
      const setParamsSpy = vi.spyOn(sender, 'setParameters');

      const pc = {
        getSenders: () => [sender]
      };

      const result = await applySenderOptimizations(pc, 7500000, 60);
      expect(result).toBe(false);
      expect(setParamsSpy).not.toHaveBeenCalled();
    });

    it('deve configurar scaleResolutionDownBy quando fornecido fator de escala maior que 1', async () => {
      const videoTrack = new MockMediaStreamTrack('video');
      const sender = new MockRTCRtpSender(videoTrack);
      const setParamsSpy = vi.spyOn(sender, 'setParameters');

      const pc = {
        getSenders: () => [sender]
      };

      await applySenderOptimizations(pc, 5000000, 60, 1.5);

      expect(setParamsSpy).toHaveBeenCalled();
      const passedParams = setParamsSpy.mock.calls[0][0];
      expect(passedParams.encodings[0].scaleResolutionDownBy).toBe(1.5);
    });

    it('applySenderOptimizationsWhenReady deve aplicar assim que signalingstatechange mudar para stable', async () => {
      const videoTrack = new MockMediaStreamTrack('video');
      const sender = new MockRTCRtpSender(videoTrack);
      sender._params = { encodings: [] }; // Inicialmente não negociado
      const setParamsSpy = vi.spyOn(sender, 'setParameters');

      class MockPCWithEvents extends EventTarget {
        constructor() {
          super();
          this.signalingState = 'have-local-offer';
          this.connectionState = 'connecting';
        }
        getSenders() { return [sender]; }
      }

      const pc = new MockPCWithEvents();
      const cleanup = applySenderOptimizationsWhenReady(pc, 7500000, 60);

      expect(setParamsSpy).not.toHaveBeenCalled();

      // Simula a chegada do answer e estabilização
      sender._params = { encodings: [{}] };
      pc.signalingState = 'stable';
      pc.dispatchEvent(new Event('signalingstatechange'));

      // Aguarda tick de microtask
      await new Promise(r => setTimeout(r, 10));

      expect(setParamsSpy).toHaveBeenCalled();
      cleanup();
    });
  });

  describe('swapStreamAudioTrack', () => {
    it('deve retornar false se pc for nulo', async () => {
      const result = await swapStreamAudioTrack(null, null);
      expect(result).toBe(false);
    });

    it('deve invocar replaceTrack no sender de áudio existente', async () => {
      const oldAudioTrack = new MockMediaStreamTrack('audio', 'old-audio');
      const newAudioTrack = new MockMediaStreamTrack('audio', 'new-mic');
      const sender = new MockRTCRtpSender(oldAudioTrack);
      const replaceSpy = vi.spyOn(sender, 'replaceTrack');

      const pc = {
        getSenders: () => [sender]
      };

      const result = await swapStreamAudioTrack(pc, newAudioTrack);
      expect(result).toBe(true);
      expect(replaceSpy).toHaveBeenCalledWith(newAudioTrack);
    });

    it('deve permitir mutar passando newTrack = null', async () => {
      const oldAudioTrack = new MockMediaStreamTrack('audio', 'old-audio');
      const sender = new MockRTCRtpSender(oldAudioTrack);
      const replaceSpy = vi.spyOn(sender, 'replaceTrack');

      const pc = {
        getSenders: () => [sender]
      };

      const result = await swapStreamAudioTrack(pc, null);
      expect(result).toBe(true);
      expect(replaceSpy).toHaveBeenCalledWith(null);
    });

    it('deve localizar o sender de áudio através do transceiver se a track inicial for nula', async () => {
      const newAudioTrack = new MockMediaStreamTrack('audio', 'new-mic');
      const audioSender = new MockRTCRtpSender(null);
      const replaceSpy = vi.spyOn(audioSender, 'replaceTrack');

      const pc = {
        getSenders: () => [audioSender],
        getTransceivers: () => [{
          mid: 'audio_0',
          sender: audioSender
        }]
      };

      const result = await swapStreamAudioTrack(pc, newAudioTrack);
      expect(result).toBe(true);
      expect(replaceSpy).toHaveBeenCalledWith(newAudioTrack);
    });
  });

  describe('updateSenderBitrate', () => {
    it('deve atualizar maxBitrate no sender de vídeo sem lançar erro', async () => {
      const videoTrack = new MockMediaStreamTrack('video', 'test-screen');
      const sender = new MockRTCRtpSender(videoTrack);
      sender.parameters = { encodings: [{ maxBitrate: 2000000 }] };
      const setParamsSpy = vi.spyOn(sender, 'setParameters');

      const pc = {
        getSenders: () => [sender]
      };

      const ok = await updateSenderBitrate(pc, 5000000);
      expect(ok).toBe(true);
      expect(setParamsSpy).toHaveBeenCalled();
      expect(sender.getParameters().encodings[0].maxBitrate).toBe(5000000);
    });

    it('deve retornar false caso pc seja nulo ou não haja sender de vídeo', async () => {
      expect(await updateSenderBitrate(null, 5000000)).toBe(false);
      expect(await updateSenderBitrate({ getSenders: () => [] }, 5000000)).toBe(false);
    });
  });
});
