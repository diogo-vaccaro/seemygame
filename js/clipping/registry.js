import { ClipRecorder } from './engine.js';
import { NativeReplayRecorder } from './native-recorder.js';
export class ClipRecorderRegistry {
  constructor(options = {}) {
    let savedDuration = 30;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const item = window.localStorage.getItem('seemygame_clip_duration');
        if (item !== null) {
          const parsed = Number(item);
          if (!isNaN(parsed) && parsed >= 0) savedDuration = parsed;
        }
      }
    } catch (_) {}
    this.options = { maxDurationSeconds: savedDuration, ...options };
    this.sources = new Map();
    let preferences = {};
    try { preferences = JSON.parse(window.localStorage.getItem('seemygame_replay_preferences') || '{}'); } catch (_) {}
    this.preferences = { enabled: true, recordLocal: false, profile: 'source', codec: 'auto', ...preferences, ...options.preferences };
    this.selectedSourceId = null;
    this.onChange = null;
    this.recorders = new Map();
    this.activeSourceId = null;
    this._compatRecordingOverride = null;
  }

  setMaxDurationSeconds(seconds) {
    const parsed = Number(seconds);
    const val = isNaN(parsed) || parsed < 0 ? 30 : parsed;
    this.options = { ...this.options, maxDurationSeconds: val };
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('seemygame_clip_duration', String(val));
      }
    } catch (_) {}
    for (const recorder of this.recorders.values()) {
      if (recorder) {
        recorder.maxDurationSeconds = val;
        if (val > 0 && Array.isArray(recorder.chunks)) {
          const now = Date.now();
          const cutoff = now - (val * 1000);
          recorder.chunks = recorder.chunks.filter((item) => item === recorder.initializationChunk || item.timestamp >= cutoff);
        }
      }
    }
    if (this.getRecorder()?.sessionId) this._startSelected();
    return val;
  }

  getMaxDurationSeconds() {
    return this.options?.maxDurationSeconds !== undefined ? this.options.maxDurationSeconds : 30;
  }

  _normalizeSourceId(sourceId = 'default') {
    return sourceId === null || sourceId === undefined || sourceId === ''
      ? 'default'
      : String(sourceId);
  }

  getRecorder(sourceId = null) {
    if (sourceId !== null && sourceId !== undefined && sourceId !== '') {
      const normalized = String(sourceId);
      const found = this.recorders.get(normalized);
      if (found) return found;
      return null; // Never export a different person's stream by accident.
    }

    if (this.activeSourceId && this.recorders.has(this.activeSourceId)) {
      return this.recorders.get(this.activeSourceId);
    }

    for (const recorder of this.recorders.values()) {
      if (recorder && recorder.isRecording) return recorder;
    }

    return this.recorders.values().next().value || null;
  }

  get isRecording() {
    if (this._compatRecordingOverride !== null) return this._compatRecordingOverride;
    return Array.from(this.recorders.values()).some((recorder) => recorder.isRecording);
  }

  // Kept for compatibility with integrations that used the original
  // singleton in tests or UI adapters.
  set isRecording(value) {
    this._compatRecordingOverride = Boolean(value);
    const active = this.getRecorder();
    if (active) active.isRecording = Boolean(value);
  }

  get chunks() {
    return this.getRecorder()?.chunks || [];
  }

  get mediaRecorder() {
    return this.getRecorder()?.mediaRecorder || null;
  }

  start(stream, sourceId = 'default') {
    const id = this._normalizeSourceId(sourceId);
    const unchanged = this.sources.get(id) === stream;
    this.sources.set(id, stream);
    if (!this.preferences.enabled || (id === 'local-me' && !this.preferences.recordLocal)) {
      this.onChange?.(); return false;
    }
    if (this.selectedSourceId && this.selectedSourceId !== id) { this.onChange?.(); return false; }
    const current = this.recorders.get(id);
    const native = this.options.getNativeContext?.(id);
    const sameBackend = Boolean(current?.sessionId) === Boolean(native?.sessionId) &&
      (!native?.sessionId || current?.sessionId === native.sessionId);
    if (unchanged && current && sameBackend && !current.lastError &&
        (current.isRecording || current.ready)) return true;
    this.selectedSourceId = id;
    return this._startSelected();
  }

  _startSelected() {
    const id = this.selectedSourceId;
    const stream = this.sources.get(id);
    if (!stream || !this.preferences.enabled || (id === 'local-me' && !this.preferences.recordLocal)) return false;
    const previous = this.recorders.get(id);
    previous?.stop();
    const native = this.options.getNativeContext?.(id);
    const recorder = native ? new NativeReplayRecorder({ ...native, maxDurationSeconds: this.getMaxDurationSeconds() })
      : new ClipRecorder({ ...this.options, profile: this.preferences.profile, codec: this.preferences.codec,
        videoBitsPerSecond: this.preferences.profile === 'light' ? 1000000 : 2500000 });
    if (!recorder.start(stream)) {
      this.recorders.delete(id);
      this.lastError = recorder.lastError || new Error('Não foi possível iniciar o replay');
      this.onChange?.(); return false;
    }
    this.lastError = null;

    this.recorders.set(id, recorder);
    if (recorder.ready?.then) {
      recorder.ready = recorder.ready.then(() => {
        if (this.recorders.get(id) !== recorder) return;
        this.lastError = recorder.lastError || null;
        this.onChange?.();
      });
    }
    this.activeSourceId = id;
    this._compatRecordingOverride = null;
    this.onChange?.();
    return true;
  }

  selectSource(sourceId) {
    const id = this._normalizeSourceId(sourceId);
    if (!this.sources.has(id)) return false;
    if (id === 'local-me' && !this.preferences.recordLocal) return false;
    this._stopRecorders(); this.selectedSourceId = id;
    return this._startSelected();
  }

  setPreferences(changes) {
    const profile = ['light', 'balanced', 'source'].includes(changes.profile) ? changes.profile : this.preferences.profile;
    const codec = ['auto', 'vp8', 'vp9', 'h264'].includes(changes.codec) ? changes.codec : this.preferences.codec;
    this.preferences = { ...this.preferences, ...changes, profile, codec };
    try { window.localStorage.setItem('seemygame_replay_preferences', JSON.stringify(this.preferences)); } catch (_) {}
    this._stopRecorders();
    if (!this.sources.has(this.selectedSourceId) || (this.selectedSourceId === 'local-me' && !this.preferences.recordLocal)) {
      this.selectedSourceId = [...this.sources.keys()].find(id => id !== 'local-me' || this.preferences.recordLocal) || null;
    }
    const result = this._startSelected(); this.onChange?.(); return result;
  }

  _stopRecorders() {
    this.lastError = null;
    const pending = [...this.recorders.values()].map(recorder => recorder.stop());
    this.recorders.clear(); this.activeSourceId = null; this._compatRecordingOverride = null;
    return Promise.allSettled(pending);
  }

  isRecordingFor(sourceId) {
    return Boolean(this.recorders.get(this._normalizeSourceId(sourceId))?.isRecording);
  }

  stop(sourceId = null) {
    if (sourceId === null || sourceId === undefined) {
      const pending = this._stopRecorders(); this.sources.clear(); this.selectedSourceId = null;
      this.activeSourceId = null;
      this._compatRecordingOverride = false;
      this.onChange?.();
      return pending;
    }

    const id = this._normalizeSourceId(sourceId);
    const recorder = this.recorders.get(id);
    const pending = recorder?.stop();
    this.recorders.delete(id);
    this.sources.delete(id);
    if (this.activeSourceId === id) {
      this.activeSourceId = this.recorders.keys().next().value || null;
    }
    if (this.selectedSourceId === id) {
      this.selectedSourceId = [...this.sources.keys()].find(key => key !== 'local-me' || this.preferences.recordLocal) || null;
      this._startSelected();
    }
    this.onChange?.();
    return pending;
  }

  async exportClip(customFilename = null, sourceId = null) {
    const recorder = this.getRecorder(sourceId);
    if (!recorder) return null;
    await recorder.flushPendingData();
    return recorder.exportClip(customFilename);
  }

  async exportClipFor(sourceId, customFilename = null) {
    return this.exportClip(customFilename, sourceId);
  }

  getRecentClipBlob(sourceId = null) {
    return this.getRecorder(sourceId)?.getRecentClipBlob() || null;
  }

  hasRecentClip(sourceId = null) {
    return Boolean(this.getRecorder(sourceId)?.hasRecentClip());
  }

  clear(sourceId = null) {
    if (sourceId === null || sourceId === undefined) {
      this.recorders.forEach((recorder) => recorder.clear());
      return;
    }
    this.getRecorder(sourceId)?.clear();
  }
}

