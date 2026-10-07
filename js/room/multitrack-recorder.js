/**
 * SeeMyGame - MultitrackRecorder
 * Gravação simultânea de faixas isoladas (Master, Vídeo Limpo, Microfone do Host, Áudios de Participantes)
 * com exportação compactada em ZIP contendo manifest.json e as faixas sincronizadas.
 */

import { ZipBuilder } from '../utils/zip-builder.js';

export class MultitrackRecorder {
  constructor() {
    this.isRecording = false;
    this.startTime = 0;
    this.endTime = 0;
    this.recorders = new Map();
    this.recordedBlobs = new Map();
    this.tickInterval = null;
    this.listeners = new Set();
  }

  isSupported() {
    return typeof MediaRecorder !== 'undefined';
  }

  getBestMimeType(hasVideo = true) {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return hasVideo ? 'video/webm' : 'audio/webm';
    }

    if (hasVideo) {
      const videoCandidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=h264,opus',
        'video/webm'
      ];
      for (const mime of videoCandidates) {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
      }
      return 'video/webm';
    } else {
      const audioCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus'
      ];
      for (const mime of audioCandidates) {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
      }
      return 'audio/webm';
    }
  }

  async startRecording(trackStreams = {}, options = {}) {
    if (this.isRecording) {
      throw new Error('Uma gravação já está em andamento.');
    }

    const validEntries = Object.entries(trackStreams).filter(([_, stream]) => {
      return stream && (typeof stream.getTracks === 'function' ? stream.getTracks().length > 0 : true);
    });

    if (validEntries.length === 0) {
      throw new Error('Nenhuma faixa de mídia ativa foi fornecida para gravar.');
    }

    this.recorders.clear();
    this.recordedBlobs.clear();
    this.startTime = Date.now();
    this.endTime = 0;

    const timeSlice = options.timeSlice || 1000;

    for (const [name, stream] of validEntries) {
      const hasVideo = typeof stream.getVideoTracks === 'function' && stream.getVideoTracks().length > 0;
      const mimeType = this.getBestMimeType(hasVideo);

      const recorderOptions = {};
      if (mimeType) recorderOptions.mimeType = mimeType;
      if (hasVideo && options.videoBitsPerSecond) {
        recorderOptions.videoBitsPerSecond = options.videoBitsPerSecond;
      }
      if (options.audioBitsPerSecond) {
        recorderOptions.audioBitsPerSecond = options.audioBitsPerSecond;
      }

      let recorder;
      try {
        recorder = new MediaRecorder(stream, recorderOptions);
      } catch (err) {
        // Fallback simples sem options estritas
        console.warn(`[MultitrackRecorder] Fallback para opções padrão na faixa ${name}:`, err);
        recorder = new MediaRecorder(stream);
      }

      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      this.recorders.set(name, {
        recorder,
        chunks,
        stream,
        mimeType: recorder.mimeType || mimeType,
        hasVideo
      });
    }

    // Inicia todos os recorders de forma síncrona/imediata
    for (const [name, entry] of this.recorders.entries()) {
      try {
        entry.recorder.start(timeSlice);
      } catch (err) {
        console.error(`[MultitrackRecorder] Falha ao iniciar gravação da faixa ${name}:`, err);
      }
    }

    this.isRecording = true;
    this._startTick();
    this.notify('start', {
      startTime: this.startTime,
      tracks: Array.from(this.recorders.keys())
    });

    return true;
  }

  async stopRecording() {
    if (!this.isRecording) {
      return this.recordedBlobs;
    }

    this._stopTick();
    this.endTime = Date.now();
    this.isRecording = false;

    const stopPromises = [];

    for (const [name, entry] of this.recorders.entries()) {
      const { recorder, chunks, mimeType } = entry;
      const p = new Promise((resolve) => {
        if (recorder.state === 'inactive') {
          const blob = new Blob(chunks, { type: mimeType });
          this.recordedBlobs.set(name, { blob, mimeType, size: blob.size });
          resolve();
          return;
        }

        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType });
          this.recordedBlobs.set(name, { blob, mimeType, size: blob.size });
          resolve();
        };

        try {
          recorder.stop();
        } catch (_) {
          const blob = new Blob(chunks, { type: mimeType });
          this.recordedBlobs.set(name, { blob, mimeType, size: blob.size });
          resolve();
        }
      });
      stopPromises.push(p);
    }

    await Promise.all(stopPromises);
    this.notify('stop', {
      duration: this.getDuration(),
      tracks: Array.from(this.recordedBlobs.keys())
    });

    return this.recordedBlobs;
  }

  getDuration() {
    if (this.isRecording) {
      return Date.now() - this.startTime;
    }
    if (this.startTime > 0 && this.endTime > 0) {
      return this.endTime - this.startTime;
    }
    return 0;
  }

  async exportZip(options = {}) {
    if (this.isRecording) {
      await this.stopRecording();
    }

    if (this.recordedBlobs.size === 0) {
      throw new Error('Nenhuma faixa gravada disponível para exportação.');
    }

    this.notify('exporting', { status: 'building' });

    const zip = new ZipBuilder();
    const manifestTracks = [];

    for (const [name, info] of this.recordedBlobs.entries()) {
      const ext = info.mimeType && info.mimeType.includes('audio') ? 'webm' : 'webm';
      const filename = `tracks/${name}.${ext}`;
      zip.addFile(filename, info.blob);
      manifestTracks.push({
        trackName: name,
        filename,
        mimeType: info.mimeType,
        size: info.size
      });
    }

    const durationSec = Math.round(this.getDuration() / 1000);
    const manifest = {
      app: 'SeeMyGame',
      version: '1.0',
      createdAt: new Date(this.startTime || Date.now()).toISOString(),
      durationSeconds: durationSec,
      tracks: manifestTracks,
      metadata: options.metadata || {}
    };

    zip.addFile('manifest.json', JSON.stringify(manifest, null, 2));

    const zipBlob = await zip.buildBlob();
    const defaultName = `SeeMyGame-Multitrack-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const finalFilename = options.filename || defaultName;

    if (options.autoDownload !== false && typeof window !== 'undefined') {
      zip.download(finalFilename, zipBlob);
    }

    this.notify('exported', { filename: finalFilename, size: zipBlob.size });
    return {
      blob: zipBlob,
      filename: finalFilename,
      manifest
    };
  }

  _startTick() {
    this._stopTick();
    this.tickInterval = setInterval(() => {
      this.notify('tick', { duration: this.getDuration() });
    }, 1000);
  }

  _stopTick() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  on(event, listener) {
    if (typeof listener === 'function') {
      this.listeners.add({ event, listener });
    }
    return () => this.off(event, listener);
  }

  off(event, listener) {
    for (const item of this.listeners) {
      if (item.event === event && item.listener === listener) {
        this.listeners.delete(item);
      }
    }
  }

  notify(event, data) {
    for (const item of this.listeners) {
      if (item.event === event || item.event === '*') {
        try {
          item.listener(data);
        } catch (err) {
          console.error(`[MultitrackRecorder] Erro no listener '${event}':`, err);
        }
      }
    }
  }
}

export const multitrackRecorder = new MultitrackRecorder();
