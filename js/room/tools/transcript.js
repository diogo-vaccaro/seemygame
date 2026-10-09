/**
 * SeeMyGame - TranscriptManager (Transcrição de Chamada e Legendas)
 * 
 * Transcrição acessível e colaborativa no navegador:
 * - Web Speech API local no microfone do próprio participante com consentimento explícito
 * - Identificação de locutor vinculada à conexão admitida (sem risco de falsa diarização)
 * - Transmissão de segmentos parciais e finais com carimbo de tempo
 * - Exportação para SRT, WebVTT e arquivo de texto
 * - Preservação estrita da privacidade de participantes que não aderiram
 */

export class TranscriptManager {
  constructor(options = {}) {
    this.service = options.service || null;
    this.getLocalPeerId = options.getLocalPeerId || (() => 'me');
    this.getDisplayName = options.getDisplayName || (() => 'Jogador');
    this.isHost = typeof options.isHost === 'function' ? options.isHost : () => Boolean(options.isHost);
    this.getIsReadonly = typeof options.getIsReadonly === 'function'
      ? options.getIsReadonly
      : () => Boolean(options.isReadonly);
    this.lang = options.lang || 'pt-BR';

    this.hasUserConsent = false;
    this.isListening = false;
    this.recognition = null;
    this.segments = []; // Array of segment objects
    this.activePartial = null;
    this.roomClockStart = options.roomClockStart || Date.now();
    this.listeners = new Set();

    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  setService(service) {
    this.service = service;
    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  _bindWithService(service) {
    service.registerFeature('transcript', {
      applyProposal: (payload, meta) => this._applyProposalOnHost(payload, meta),
      applyConfirm: (payload, meta) => this._applyConfirmOnClient(payload, meta),
      getSnapshot: () => this.getSnapshot(),
      applySnapshot: (snapshot) => this.applySnapshot(snapshot)
    });
  }

  grantConsent() {
    this.hasUserConsent = true;
    return true;
  }

  revokeConsent() {
    this.hasUserConsent = false;
    this.stopListening();
  }

  _applyProposalOnHost(payload, { authorPeerId }) {
    const { action, segment } = payload;
    if (action === 'add_segment' && segment) {
      const segId = segment.segmentId || `seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const cleanSegment = {
        segmentId: segId,
        speakerId: authorPeerId,
        speakerName: String(segment.speakerName || 'Jogador').slice(0, 32),
        startMs: Number(segment.startMs) || 0,
        endMs: Number(segment.endMs) || 0,
        text: String(segment.text || '').slice(0, 1000),
        final: Boolean(segment.final),
        provider: 'web-speech'
      };

      this.segments.push(cleanSegment);
      // Mantém buffer limitado para não estourar memória
      if (this.segments.length > 500) {
        this.segments.shift();
      }

      return {
        success: true,
        payload: { action: 'segment_added', segment: cleanSegment }
      };
    }
    return { success: false, reason: 'unknown_action' };
  }

  _applyConfirmOnClient(payload) {
    if (payload?.action === 'segment_added' && payload.segment) {
      const incoming = payload.segment;
      const idx = this.segments.findIndex(s => s.segmentId === incoming.segmentId);
      if (idx !== -1) {
        this.segments[idx] = incoming;
      } else {
        this.segments.push(incoming);
        if (this.segments.length > 500) this.segments.shift();
      }
      this._notify();
    }
  }

  getSnapshot() {
    return this.segments.slice(-100);
  }

  applySnapshot(snapshot) {
    if (Array.isArray(snapshot)) {
      this.segments = [...snapshot];
      this._notify();
    }
  }

  startListening() {
    if (!this.hasUserConsent) {
      throw new Error('[TranscriptManager] Consentimento explícito do usuário é obrigatório antes de iniciar a transcrição.');
    }
    if (this.getIsReadonly()) {
      throw new Error('[TranscriptManager] Espectador somente-leitura não pode emitir transcrição.');
    }
    if (this.isListening) return true;

    const SpeechRec = typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null;

    if (!SpeechRec) {
      console.warn('[TranscriptManager] Reconhecimento de fala não suportado neste navegador.');
      return false;
    }

    try {
      this.recognition = new SpeechRec();
      this.recognition.lang = this.lang;
      this.recognition.continuous = true;
      this.recognition.interimResults = true;

      let segmentStartMs = Date.now() - this.roomClockStart;

      this.recognition.onstart = () => {
        this.isListening = true;
        this._notify();
      };

      this.recognition.onresult = (event) => {
        let interimText = '';
        const nowMs = Date.now() - this.roomClockStart;

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const res = event.results[i];
          const transcript = res[0]?.transcript || '';

          if (res.isFinal) {
            this._publishSegment({
              startMs: segmentStartMs,
              endMs: nowMs,
              text: transcript.trim(),
              final: true
            });
            segmentStartMs = nowMs;
            this.activePartial = null;
          } else {
            interimText += transcript;
          }
        }

        if (interimText) {
          this.activePartial = {
            speakerId: this.getLocalPeerId(),
            speakerName: this.getDisplayName(),
            text: interimText.trim(),
            final: false
          };
          this._notify();
        }
      };

      this.recognition.onerror = (err) => {
        console.warn('[TranscriptManager] Erro no reconhecimento:', err.error);
        if (err.error === 'not-allowed' || err.error === 'service-not-allowed') {
          this.stopListening();
        }
      };

      this.recognition.onend = () => {
        if (this.isListening) {
          try { this.recognition?.start(); } catch (_) {}
        }
      };

      this.recognition.start();
      return true;
    } catch (err) {
      console.error('[TranscriptManager] Falha ao iniciar reconhecimento:', err);
      this.isListening = false;
      return false;
    }
  }

  stopListening() {
    this.isListening = false;
    if (this.recognition) {
      try { this.recognition.stop(); } catch (_) {}
      this.recognition = null;
    }
    this.activePartial = null;
    this._notify();
  }

  _publishSegment(segmentData) {
    const segment = {
      ...segmentData,
      speakerName: this.getDisplayName()
    };

    if (this.service) {
      this.service.propose('transcript', {
        payload: { action: 'add_segment', segment }
      }).catch(() => {});
    } else {
      // Local fallback
      const segId = `seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      this.segments.push({
        segmentId: segId,
        speakerId: this.getLocalPeerId(),
        ...segment,
        provider: 'web-speech'
      });
      this._notify();
    }
  }

  static formatTimeSRT(ms) {
    const totalSec = Math.floor(ms / 1000);
    const hours = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSec % 60).padStart(2, '0');
    const millis = String(Math.floor(ms % 1000)).padStart(3, '0');
    return `${hours}:${minutes}:${seconds},${millis}`;
  }

  static formatTimeVTT(ms) {
    const totalSec = Math.floor(ms / 1000);
    const hours = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSec % 60).padStart(2, '0');
    const millis = String(Math.floor(ms % 1000)).padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${millis}`;
  }

  exportSRT() {
    let srt = '';
    this.segments.forEach((seg, index) => {
      const start = TranscriptManager.formatTimeSRT(seg.startMs);
      const end = TranscriptManager.formatTimeSRT(Math.max(seg.startMs + 1000, seg.endMs));
      srt += `${index + 1}\n${start} --> ${end}\n${seg.speakerName}: ${seg.text}\n\n`;
    });
    return srt.trim();
  }

  exportVTT() {
    let vtt = 'WEBVTT\n\n';
    this.segments.forEach((seg, index) => {
      const start = TranscriptManager.formatTimeVTT(seg.startMs);
      const end = TranscriptManager.formatTimeVTT(Math.max(seg.startMs + 1000, seg.endMs));
      vtt += `${index + 1}\n${start} --> ${end}\n<v ${seg.speakerName}>${seg.text}\n\n`;
    });
    return vtt.trim();
  }

  exportText() {
    return this.segments.map(seg => `[${seg.speakerName}]: ${seg.text}`).join('\n');
  }

  downloadExport(format = 'srt') {
    if (typeof document === 'undefined') return false;
    let content = '';
    let ext = 'srt';
    let mime = 'text/plain';

    if (format === 'vtt') {
      content = this.exportVTT();
      ext = 'vtt';
      mime = 'text/vtt';
    } else if (format === 'txt') {
      content = this.exportText();
      ext = 'txt';
      mime = 'text/plain';
    } else {
      content = this.exportSRT();
      ext = 'srt';
      mime = 'text/plain';
    }

    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `seemygame-legendas-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    return true;
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notify() {
    const data = {
      segments: [...this.segments],
      activePartial: this.activePartial,
      isListening: this.isListening
    };
    this.listeners.forEach(fn => {
      try { fn(data); } catch (_) {}
    });
  }

  dispose() {
    this.stopListening();
    this.segments = [];
    this.listeners.clear();
  }
}
