import { it, expect, vi, afterEach } from 'vitest';
import { ClipRecorder } from '../js/clipping.js';
import { MockMediaStream, MockMediaStreamTrack } from './mocks/webrtc.mock.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

class Source extends MockMediaStream {
  constructor(tracks) { super(tracks); this.events = new EventTarget(); }
  addEventListener(...args) { this.events.addEventListener(...args); }
  removeEventListener(...args) { this.events.removeEventListener(...args); }
  change(type, track) {
    if (type === 'addtrack') this.addTrack(track); else this.removeTrack(track);
    const event = new Event(type); Object.defineProperty(event, 'track', { value: track });
    this.events.dispatchEvent(event);
  }
}
function setup() {
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('webkitAudioContext', undefined);
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const source = new Source([new MockMediaStreamTrack('video', 'video'), new MockMediaStreamTrack('audio', 'audio')]);
  const clip = new ClipRecorder();
  expect(clip.start(source)).toBe(true);
  return { source, clip };
}

it('restarts replay when a track is removed without a mixer and discards the obsolete recorder', () => {
  const { source, clip } = setup();
  try {
    const old = clip.mediaRecorder;
    const audio = source.getAudioTracks()[0];
    source.change('removetrack', audio);
    expect(clip.mediaRecorder).not.toBe(old);
    expect(old.state).toBe('inactive');
    expect(clip.isRecording).toBe(true);
    old.ondataavailable({ data: new Blob(['obsolete']) });
    expect(clip.chunks).toEqual([]);
    expect(audio.stop).not.toHaveBeenCalled();
  } finally { clip.dispose(); }
});

it('restarts a clean recorder after video removal even when audio mixing is active', () => {
  const { source, clip } = setup();
  try {
    const old = clip.mediaRecorder;
    clip._audioDestination = { stream: new MockMediaStream() };
    source.change('removetrack', source.getVideoTracks()[0]);
    expect(clip.mediaRecorder).not.toBe(old);
    expect(clip.recordingStream.getVideoTracks()).toHaveLength(0);
  } finally { clip.dispose(); }
});

it('marks replay as stopped and releases listeners when the replacement recorder fails', () => {
  const { source, clip } = setup();
  try {
    vi.stubGlobal('MediaRecorder', class { static isTypeSupported() { return true; } constructor() { throw new Error('unavailable encoder'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    source.change('addtrack', new MockMediaStreamTrack('video', 'replacement'));
    expect(clip.isRecording).toBe(false);
    expect(clip.mediaRecorder).toBe(null);
    expect(clip._streamAddTrackHandler).toBe(null);
    expect(clip.lastError.message).toBe('unavailable encoder');
  } finally { clip.dispose(); }
});
