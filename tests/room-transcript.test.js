import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedToolsService } from '../js/room/tools/shared-tools-service.js';
import { TranscriptManager } from '../js/room/tools/transcript.js';

describe('TranscriptManager - Transcrição de Chamada e Legendas', () => {
  let hostService;
  let transcript;

  beforeEach(() => {
    hostService = new SharedToolsService({
      isHost: () => true,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      roomEpoch: 'epoch-1'
    });

    transcript = new TranscriptManager({
      service: hostService,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      isHost: () => true,
      getIsReadonly: () => false
    });
  });

  afterEach(() => {
    transcript.dispose();
    hostService.dispose();
  });

  it('exige consentimento explícito do usuário antes de iniciar reconhecimento', () => {
    expect(transcript.hasUserConsent).toBe(false);
    expect(() => transcript.startListening()).toThrow(/consentimento/i);

    transcript.grantConsent();
    expect(transcript.hasUserConsent).toBe(true);

    transcript.revokeConsent();
    expect(transcript.hasUserConsent).toBe(false);
  });

  it('adiciona e distribui segmentos com autor identificado', async () => {
    transcript.grantConsent();

    const res = await transcript._applyProposalOnHost({
      action: 'add_segment',
      segment: {
        speakerName: 'Jogador 1',
        startMs: 1000,
        endMs: 3500,
        text: 'Avançando pelo bomb A',
        final: true
      }
    }, { authorPeerId: 'player-1' });

    expect(res.success).toBe(true);
    expect(transcript.segments).toHaveLength(1);
    expect(transcript.segments[0].speakerId).toBe('player-1');
    expect(transcript.segments[0].speakerName).toBe('Jogador 1');
    expect(transcript.segments[0].text).toBe('Avançando pelo bomb A');
  });

  it('formata timestamps e exporta legendas no padrão SRT', () => {
    expect(TranscriptManager.formatTimeSRT(0)).toBe('00:00:00,000');
    expect(TranscriptManager.formatTimeSRT(65432)).toBe('00:01:05,432');

    transcript.segments = [
      { speakerName: 'Gamer', startMs: 1000, endMs: 3000, text: 'Primeira frase' },
      { speakerName: 'Host', startMs: 3500, endMs: 5000, text: 'Segunda frase' }
    ];

    const srt = transcript.exportSRT();
    expect(srt).toContain('1\n00:00:01,000 --> 00:00:03,000\nGamer: Primeira frase');
    expect(srt).toContain('2\n00:00:03,500 --> 00:00:05,000\nHost: Segunda frase');
  });

  it('exporta legendas no padrão WebVTT', () => {
    transcript.segments = [
      { speakerName: 'Gamer', startMs: 1000, endMs: 3000, text: 'Frase VTT' }
    ];

    const vtt = transcript.exportVTT();
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('<v Gamer>Frase VTT');
  });

  it('rejeita emissão de transcrição por espectadores somente-leitura', () => {
    const readonlyTranscript = new TranscriptManager({
      service: hostService,
      getLocalPeerId: () => 'ro-peer',
      getIsReadonly: () => true
    });
    readonlyTranscript.grantConsent();

    expect(() => readonlyTranscript.startListening()).toThrow(/somente-leitura/i);
    readonlyTranscript.dispose();
  });
});
