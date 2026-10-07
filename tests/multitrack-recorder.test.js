import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MultitrackRecorder } from '../js/room/multitrack-recorder.js';

describe('MultitrackRecorder', () => {
  let recorder;
  let mockRecorders = [];

  class MockMediaRecorder {
    static isTypeSupported(type) {
      return type.includes('webm');
    }

    constructor(stream, options = {}) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      this.mimeType = options.mimeType || 'video/webm';
      this.ondataavailable = null;
      this.onstop = null;
      mockRecorders.push(this);
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) {
        this.ondataavailable({ data: new Blob(['fake-media-bytes'], { type: this.mimeType }) });
      }
      if (this.onstop) {
        this.onstop();
      }
    }
  }

  beforeEach(() => {
    mockRecorders = [];
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    recorder = new MultitrackRecorder();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports supported when MediaRecorder is present', () => {
    expect(recorder.isSupported()).toBe(true);
  });

  it('starts multi-track recording across provided tracks simultaneously', async () => {
    const stream1 = {
      getVideoTracks: () => [{ id: 'v1' }],
      getAudioTracks: () => [{ id: 'a1' }],
      getTracks: () => [{ id: 'v1' }, { id: 'a1' }]
    };
    const stream2 = {
      getVideoTracks: () => [],
      getAudioTracks: () => [{ id: 'mic1' }],
      getTracks: () => [{ id: 'mic1' }]
    };

    const startListener = vi.fn();
    recorder.on('start', startListener);

    await recorder.startRecording({
      master: stream1,
      hostMic: stream2
    });

    expect(recorder.isRecording).toBe(true);
    expect(recorder.recorders.size).toBe(2);
    expect(startListener).toHaveBeenCalledWith(
      expect.objectContaining({
        tracks: ['master', 'hostMic']
      })
    );
  });

  it('stops recording and collects recorded blobs', async () => {
    const stream = {
      getVideoTracks: () => [{ id: 'v1' }],
      getTracks: () => [{ id: 'v1' }]
    };

    await recorder.startRecording({ master: stream });
    const blobs = await recorder.stopRecording();

    expect(recorder.isRecording).toBe(false);
    expect(blobs.has('master')).toBe(true);
    expect(blobs.get('master').size).toBeGreaterThan(0);
  });

  it('exports zip with manifest and track entries', async () => {
    const stream = {
      getVideoTracks: () => [{ id: 'v1' }],
      getTracks: () => [{ id: 'v1' }]
    };

    await recorder.startRecording({ master: stream });
    const res = await recorder.exportZip({
      filename: 'test-recording.zip',
      autoDownload: false
    });

    expect(res.blob).toBeDefined();
    expect(res.filename).toBe('test-recording.zip');
    expect(res.manifest.tracks).toHaveLength(1);
    expect(res.manifest.tracks[0].trackName).toBe('master');
  });
});
