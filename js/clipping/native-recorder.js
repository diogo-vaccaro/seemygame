import { invokeDesktopCommand } from '../desktop/ipc.js';
const queues = new Map();
function enqueue(sessionId, operation) {
  const pending = (queues.get(sessionId) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(sessionId, pending);
  pending.finally(() => { if (queues.get(sessionId) === pending) queues.delete(sessionId); }).catch(() => {});
  return pending;
}

// Same registry contract, but Rust retains the already encoded H.264/Opus.
export class NativeReplayRecorder {
  constructor({ sessionId, maxDurationSeconds = 30 }) {
    this.sessionId = sessionId;
    this.maxDurationSeconds = maxDurationSeconds;
    this.isRecording = false;
    this.mimeType = 'video/mp4';
    this.lastError = null;
    this._generation = 0;
  }
  start() {
    const generation = ++this._generation;
    this.lastError = null;
    this.isRecording = false;
    this.ready = enqueue(this.sessionId, () => invokeDesktopCommand('start_native_replay', {
      sessionId: this.sessionId, seconds: this.maxDurationSeconds
    })).then(() => {
      if (generation === this._generation) this.isRecording = true;
    }).catch(error => { if (generation === this._generation) this.lastError = error; });
    return true;
  }
  stop() {
    ++this._generation;
    this.isRecording = false;
    this.stopped = enqueue(this.sessionId, () => invokeDesktopCommand('stop_native_replay', {
      sessionId: this.sessionId
    })).catch(() => {});
    return this.stopped;
  }
  async exportClip() {
    await this.ready;
    if (this.lastError) throw new Error(String(this.lastError));
    if (!this.isRecording) return null;
    const bytes = await invokeDesktopCommand('export_native_replay', { sessionId: this.sessionId });
    const blob = new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)], { type: this.mimeType });
    blob.fileName = `SeeMyGame-Clip-${Date.now()}.mp4`;
    this.lastClipBlob = blob;
    return blob;
  }
  flushPendingData() { return this.ready; }
  clear() {
    this.lastClipBlob = null;
    if (this.isRecording) this.start(); // Replaces the native tap and its history.
  }
  getRecentClipBlob() { return this.lastClipBlob || null; }
  hasRecentClip() { return Boolean(this.lastClipBlob); }
  dispose() { return this.stop(); }
}
