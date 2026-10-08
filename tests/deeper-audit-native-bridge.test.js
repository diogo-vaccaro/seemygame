import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockRTCPeerConnection, MockMediaStream, MockMediaStreamTrack } from './mocks/webrtc.mock.js';
const desktop = vi.hoisted(() => ({
  isDesktopApp: () => true, createNativeCapturePeer: vi.fn(async () => ({ sdp: 'v=0', type: 'answer' })),
  closeNativeCapturePeer: vi.fn(async () => {}), addNativeCaptureIceCandidate: vi.fn(async () => {}),
  stopNativeCapture: vi.fn(async () => {}), listenNativeCaptureBridge: vi.fn(async () => () => {}), logDiagnostic: vi.fn()
}));
vi.mock('../js/desktop.js', () => desktop);
import { createNativeWebRtcBridge } from '../js/native-webrtc.js';
let pc, bridge;
class Connection extends MockRTCPeerConnection {
  constructor() { super(); pc = this; this.iceGatheringState = 'complete'; this.createOffer = vi.fn(async () => ({ sdp: 'v=0', type: 'offer' })); }
  async setRemoteDescription(answer) {
    await super.setRemoteDescription(answer);
    const track = new MockMediaStreamTrack('video');
    const event = new Event('track'); event.track = track; event.streams = [new MockMediaStream([track])];
    this.dispatchEvent(event);
  }
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('RTCPeerConnection', Connection); bridge = createNativeWebRtcBridge(); });
afterEach(async () => { await bridge.closeStream('deep-native'); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
it('closes all resources if installing the native event subscription fails', async () => {
  desktop.listenNativeCaptureBridge.mockRejectedValueOnce(new Error('IPC listener failed'));
  expect(await bridge.createStream({ sessionId: 'deep-native' }).catch(error => error)).toBeInstanceOf(Error);
  expect(pc.connectionState).toBe('closed');
  expect(desktop.closeNativeCapturePeer).toHaveBeenCalledWith('deep-native');
});
it('closes all resources if initializing the native transceiver fails', async () => {
  vi.spyOn(Connection.prototype, 'addTransceiver').mockImplementationOnce(() => { throw new Error('transceiver failed'); });
  await expect(bridge.createStream({ sessionId: 'deep-native' })).rejects.toThrow('transceiver failed');
  expect(pc.connectionState).toBe('closed');
  expect(desktop.stopNativeCapture).toHaveBeenCalledWith('deep-native');
});
it('unsubscribes a listener installed after cancellation without starting negotiation', async () => {
  let install;
  const unlisten = vi.fn();
  desktop.listenNativeCaptureBridge.mockImplementationOnce(() => new Promise(resolve => { install = resolve; }));
  const pending = bridge.createStream({ sessionId: 'deep-native' }).catch(error => error);
  await bridge.closeStream('deep-native');
  install(unlisten); await vi.advanceTimersByTimeAsync(0);
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(pc.createOffer).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(11000); await pending;
});
it('cancellation removes the hidden first-frame video immediately', async () => {
  const pending = bridge.createStream({ sessionId: 'deep-native' }).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('video')).toBeTruthy();
  await bridge.closeStream('deep-native');
  expect(document.querySelector('video')).toBeNull();
  await vi.advanceTimersByTimeAsync(11000); await pending;
});
