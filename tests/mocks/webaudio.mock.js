import { vi } from 'vitest';

export class MockAudioContext {
  constructor() {
    this.state = 'suspended';
  }

  async resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  async close() {
    this.state = 'closed';
    return Promise.resolve();
  }

  createMediaStreamSource(stream) {
    return {
      stream,
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  }

  createChannelSplitter(numberOfOutputs = 2) {
    return {
      numberOfOutputs,
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  }

  createAnalyser() {
    return {
      fftSize: 2048,
      get frequencyBinCount() {
        return this.fftSize / 2;
      },
      getByteFrequencyData: vi.fn((array) => {
        array.fill(120);
      }),
      getFloatTimeDomainData: vi.fn((array) => {
        array.fill(0.1);
      }),
      getByteTimeDomainData: vi.fn((array) => {
        array.fill(128);
      }),
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  }

  createBiquadFilter() {
    return {
      type: 'lowpass',
      frequency: { value: 350 },
      Q: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  }

  createGain() {
    return {
      gain: {
        value: 1,
        setTargetAtTime: vi.fn(),
        setValueAtTime: vi.fn()
      },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  }

  createMediaStreamDestination() {
    const track = { kind: 'audio', enabled: true, id: 'mock-processed-track', stop: vi.fn() };
    return {
      stream: {
        id: 'mock-processed-dest-stream',
        getTracks: () => [track],
        getAudioTracks: () => [track],
        getVideoTracks: () => []
      },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  }
}

