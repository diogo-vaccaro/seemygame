// Audit reproductions: assertions require correct behavior and intentionally expose current defects.
// These probes are isolated from the standard test suite; no application source is modified.
import { it, expect, vi, afterEach } from 'vitest';
const ipc = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(async () => {}), ice: vi.fn(async () => {}) }));
vi.mock('../js/desktop.js', () => ({ createNativeViewerPeer: ipc.create, closeNativeViewerPeer: ipc.close,
  addNativeViewerIceCandidate: ipc.ice, listenNativeCaptureBridge: vi.fn(), isDesktopApp: () => false,
  isNativeCaptureSupported: () => false }));
vi.mock('../js/ui.js', () => ({ addOrUpdateVideoCard: vi.fn(), removeVideoCard: vi.fn() }));
import { createSessionContext } from '../js/core/session-context.js';
import { NativeMediaPlugin } from '../js/plugins/native-media-plugin.js';
import { DiscordUIController } from '../js/discord-ui.js';
import { VoiceManager } from '../js/voice.js';
import { ChatManager } from '../js/chat.js';

const sessions = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.disposeAsync(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function fixture() {
  const session = createSessionContext(); sessions.push(session); session.getPeerId = () => 'host';
  session.services = { statsScope: { startStatsMonitor: vi.fn(), stopStatsMonitor: vi.fn() } };
  const provider = { session: { sessionId: 'local-capture' } };
  const plugin = new NativeMediaPlugin({ session, getProvider: () => provider, isAuthorized: id => id === 'guest' });
  session.pluginManager.register(plugin); session.pluginManager.initAll();
  return { session, provider, plugin, conn: { peer: 'guest', open: true, send: vi.fn() } };
}

it('positive control: receive-only ICE reaches the browser receiver', async () => {
  const { session, plugin, conn } = fixture();
  await plugin.receive({ sessionId: 'remote-capture' }, conn);
  const pc = plugin.receivers.get('guest').pc;
  pc.remoteDescription = { type: 'answer', sdp: 'answer' };
  const receiveIce = vi.spyOn(pc, 'addIceCandidate');
  session.dispatcher.dispatch({ type: 'DIRECT_STREAM_ICE_CANDIDATE', candidate: 'candidate:remote-receiver', mlineIndex: 0 }, conn);
  await Promise.resolve(); expect(receiveIce).toHaveBeenCalledTimes(1); expect(ipc.ice).not.toHaveBeenCalled();
});
it('N01: simultaneous native send/receive must route remote-capture ICE to its receiver', async () => {
  const { session, plugin, conn } = fixture();
  await plugin.receive({ sessionId: 'remote-capture' }, conn);
  const pc = plugin.receivers.get('guest').pc;
  pc.remoteDescription = { type: 'answer', sdp: 'answer' };
  const receiveIce = vi.spyOn(pc, 'addIceCandidate');
  plugin.senders.set('guest', 'local-capture');
  session.dispatcher.dispatch({ type: 'DIRECT_STREAM_ICE_CANDIDATE', sessionId: 'remote-capture', candidate: 'candidate:1 1 UDP 2122260223 192.0.2.10 50000 typ host ufrag remote', mlineIndex: 0 }, conn);
  await Promise.resolve();
  console.log('N01 evidence', JSON.stringify({ receiverCalls: receiveIce.mock.calls.length, nativeCalls: ipc.ice.mock.calls }));
  expect(receiveIce).toHaveBeenCalledTimes(1);
  expect(ipc.ice).not.toHaveBeenCalled();
});

it('N02: failure of an obsolete offer must preserve the replacement receiver', async () => {
  const { plugin, conn } = fixture(); let rejectOld;
  const offer = vi.spyOn(RTCPeerConnection.prototype, 'createOffer');
  offer.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
  const old = plugin.receive({ sessionId: 'old-capture' }, conn).catch(() => {});
  await plugin.receive({ sessionId: 'new-capture' }, conn);
  const current = plugin.receivers.get('guest'); const close = vi.spyOn(current.pc, 'close');
  rejectOld(new Error('old offer rejected after replacement')); await old;
  console.log('N02 evidence', JSON.stringify({ currentPreserved: plugin.receivers.get('guest') === current, currentClosed: close.mock.calls.length }));
  expect(plugin.receivers.get('guest')).toBe(current); expect(close).not.toHaveBeenCalled();
});

it('N05: participant rerenders must not retain listeners for removed voice cards', () => {
  document.body.innerHTML = '<div id="voice-participants-list"></div>';
  const voice = new VoiceManager(); voice.myPeerId = 'local-peer'; voice.isInVoice = true;
  voice.participants.set('local-peer', { peerId: 'local-peer', name: 'Local', isLocal: true });
  voice.participants.set('remote-peer', { peerId: 'remote-peer', name: 'Remote', isLocal: false });
  const ui = new DiscordUIController({ voiceManager: voice, chatManager: new ChatManager() });
  try {
    ui.init(); const initial = ui._cleanupFns.length;
    for (let i = 0; i < 200; i++) voice.setLocalSpeaking(i % 2 === 0);
    const final = ui._cleanupFns.length;
    console.log('N05 evidence', JSON.stringify({ initialCleanups: initial, finalCleanups: final, visibleCards: document.querySelectorAll('.voice-user-card').length }));
    expect(final).toBeLessThanOrEqual(initial + 4);
  } finally { ui.destroy(); document.body.innerHTML = ''; }
});
