import { vi } from 'vitest';

export class MockMediaStreamTrack {
  constructor(kind = 'video', id = 'track-1') {
    this.id = id;
    this.kind = kind;
    this.enabled = true;
    this.readyState = 'live';
    this.contentHint = '';
    this.onended = null;
    this.stop = vi.fn(() => {
      this.readyState = 'ended';
    });
  }
}

export class MockMediaStream {
  constructor(tracks = []) {
    this.id = 'stream-' + Math.random().toString(36).substr(2, 9);
    this._tracks = [...tracks];
  }

  get active() {
    return this._tracks.length > 0 && this._tracks.some(t => t.readyState === 'live');
  }

  getVideoTracks() {
    return this._tracks.filter(t => t.kind === 'video');
  }

  getAudioTracks() {
    return this._tracks.filter(t => t.kind === 'audio');
  }

  getTracks() {
    return [...this._tracks];
  }

  addTrack(track) {
    this._tracks.push(track);
  }

  removeTrack(track) {
    this._tracks = this._tracks.filter(t => t !== track);
  }
}

export class MockRTCRtpSender {
  constructor(track = null) {
    this.track = track;
    this._params = {
      encodings: [{}]
    };
  }

  getParameters() {
    return JSON.parse(JSON.stringify(this._params));
  }

  async setParameters(params) {
    this._params = JSON.parse(JSON.stringify(params));
    return Promise.resolve();
  }

  async replaceTrack(track) {
    this.track = track;
    return Promise.resolve();
  }

  static getCapabilities(kind) {
    if (kind === 'video') {
      return {
        codecs: [
          { mimeType: 'video/VP8', clockRate: 90000 },
          { mimeType: 'video/H264', clockRate: 90000 },
          { mimeType: 'video/AV1', clockRate: 90000 }
        ]
      };
    }
    return { codecs: [] };
  }
}

export class MockRTCPeerConnection extends EventTarget {
  constructor() {
    super();
    this.connectionState = 'connected';
    this._sdpHooked = false;
    this._senders = [];
    this._transceivers = [];
  }

  addTransceiver(trackOrKind, init = {}) {
    const transceiver = {
      direction: init.direction || 'sendrecv',
      sender: new MockRTCRtpSender(),
      receiver: { track: new MockMediaStreamTrack(typeof trackOrKind === 'string' ? trackOrKind : 'video') }
    };
    this._transceivers.push(transceiver);
    return transceiver;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
    return Promise.resolve(desc);
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    return Promise.resolve(desc);
  }

  async addIceCandidate(candidate) {
    return Promise.resolve();
  }

  close() {
    this.connectionState = 'closed';
  }

  getSenders() {
    return this._senders;
  }

  getTransceivers() {
    return this._transceivers;
  }

  async getStats() {
    return Promise.resolve(new Map());
  }
}
