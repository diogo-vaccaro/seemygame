import { BasePlugin } from './base-plugin.js';
import { getPeerConfig } from '../config.js';
import { createNativeViewerPeer, closeNativeViewerPeer, addNativeViewerIceCandidate, listenNativeCaptureBridge, isDesktopApp } from '../desktop.js';
import { sendSessionMessage } from '../protocol/transport.js';
import { addOrUpdateVideoCard, removeVideoCard } from '../ui.js';
import { startStatsMonitor, stopStatsMonitor } from '../stats.js';
import { getNativeStreamStats } from '../desktop/webrtc.js';
import { applyTransceiverOptimizations } from '../webrtc.js';

/** Direct GStreamer transport. State belongs to this session, separate from PeerJS calls. */
export class NativeMediaPlugin extends BasePlugin {
  constructor({ session, getProvider, isAuthorized, onClip, onCoop } = {}) {
    super('native-media');
    this.session = session; this.getProvider = getProvider; this.isAuthorized = isAuthorized; this.onClip = onClip; this.onCoop = onCoop;
    this.receivers = new Map(); this.senders = new Map(); this.negotiating = new Set();
    this.outgoing = new Map();
  }
  setupListeners() {
    const handlers = {
      START_DIRECT_STREAM: (data, conn) => this.receive(data, conn),
      DIRECT_STREAM_OFFER: (data, conn) => this.answer(data, conn),
      DIRECT_STREAM_STOP: (data, conn) => {
        const receiver = this.receivers.get(conn.peer);
        if (this.matches(receiver, data)) this.closeReceiver(conn.peer, receiver.pc);
      },
      DIRECT_STREAM_ANSWER: async (data, conn) => {
        const receiver = this.receivers.get(conn.peer);
        if (!this.matches(receiver, data) || typeof data.sdp !== 'string' || data.sdp.length > 256 * 1024) return;
        await receiver.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        for (const candidate of receiver.pending.splice(0)) {
          if (this.receivers.get(conn.peer) !== receiver) return;
          await receiver.pc.addIceCandidate(candidate);
        }
      },
      DIRECT_STREAM_ICE_CANDIDATE: async (data, conn) => {
        if (typeof data.candidate !== 'string' || data.candidate.length > 8192) return;
        const sender = this.outgoing.get(conn.peer);
        if (data.target === 'sender') {
          if (this.matches(sender, data) && this.senders.get(conn.peer) === sender.sessionId) {
            return addNativeViewerIceCandidate(sender.sessionId, conn.peer, Number(data.mlineIndex || 0), data.candidate, sender.negotiationId);
          }
          return;
        }
        const receiver = this.receivers.get(conn.peer);
        if (data.target !== 'receiver' || !this.matches(receiver, data)) return;
        const candidate = { candidate: data.candidate, sdpMLineIndex: Number(data.mlineIndex || 0) };
        if (receiver.pc.remoteDescription) await receiver.pc.addIceCandidate(candidate);
        else if (receiver.pending.length < 256) receiver.pending.push(candidate);
      }
    };
    for (const [type, handler] of Object.entries(handlers)) this.registerCleanup(this.context.dispatcher.register(type, (data, conn) => {
      if (this.session.isDisposed || !conn || !this.isAuthorized(conn.peer)) return;
      return handler(data, conn);
    }));
    this.registerCleanup(this.context.eventBus.on('stream:stopped', ({ sourceId } = {}) => {
      if (!sourceId || sourceId === 'local-me') return this.stopSending();
      this.closeReceiver(sourceId);
    }));
    for (const event of ['viewer:disconnected', 'room:memberLeft', 'streamer:viewerDisconnected']) {
      this.registerCleanup(this.context.eventBus.on(event, async data => {
        const id = data?.peerId || data?.streamerId;
        if (!id) return;
        this.session.services?.statsScope?.stopStatsMonitor(`native-send-${id}`);
        this.closeReceiver(id);
        const captureId = this.senders.get(id);
        const sender = this.outgoing.get(id);
        this.senders.delete(id); this.outgoing.delete(id); this.negotiating.delete(id); this.connections?.delete(id);
        if (captureId) await closeNativeViewerPeer(captureId, id, sender?.negotiationId);
      }));
    }
    if (isDesktopApp()) {
      const pending = listenNativeCaptureBridge(event => {
        const id = event.peerId || event.peer_id;
        const sender = this.outgoing.get(id);
        if (!sender || this.senders.get(id) !== sender.sessionId || (event.sessionId || event.session_id) !== sender.sessionId || (event.negotiationId || event.negotiation_id) !== sender.negotiationId || event.event !== 'ice-candidate' || !event.candidate) return;
        const conn = this.connections?.get(id);
        sendSessionMessage(this.session, conn, { type: 'DIRECT_STREAM_ICE_CANDIDATE', ...sender, target: 'receiver', candidate: event.candidate, mlineIndex: event.mlineIndex ?? event.mline_index ?? 0 });
      }).then(unlisten => this.session.registerCleanup(unlisten)).catch(error => {
        this.context?.eventBus.emit('system:error', { sourceEvent: 'native-media:listen', error });
      });
      this.session.registerCleanup(() => pending);
    }
  }
  matches(state, data) {
    return Boolean(state && state.sessionId === data.sessionId && state.negotiationId === data.negotiationId);
  }
  broadcastTo(conn) {
    const provider = this.getProvider?.();
    const sessionId = provider?.session?.sessionId;
    if (!sessionId || provider.uiAudioMode === 'mic' || !this.isAuthorized(conn?.peer)) return false;
    this.connections ||= new Map(); this.connections.set(conn.peer, conn);
    if (this.negotiating.has(conn.peer) || this.senders.has(conn.peer)) return true;
    this.negotiating.add(conn.peer);
    const sender = { sessionId, negotiationId: crypto.randomUUID() };
    this.outgoing.set(conn.peer, sender);
    if (!sendSessionMessage(this.session, conn, { type: 'START_DIRECT_STREAM', ...sender, quality: provider.requestedSettings, hasAudio: Boolean(provider.session.audioRtpPort || provider.session.audio_rtp_port) })) {
      this.negotiating.delete(conn.peer); this.outgoing.delete(conn.peer);
    }
    return true;
  }
  async answer(data, conn) {
    const sessionId = this.getProvider?.()?.session?.sessionId;
    const sender = this.outgoing.get(conn.peer);
    if (!sessionId || data.sessionId !== sessionId || !this.matches(sender, data) || this.senders.has(conn.peer) || typeof data.sdp !== 'string' || data.sdp.length > 256 * 1024) return;
    this.senders.set(conn.peer, sessionId);
    try {
      const answer = await createNativeViewerPeer(sessionId, conn.peer, data.sdp, getPeerConfig().config.iceServers, sender.negotiationId);
      if (this.session.isDisposed || this.getProvider?.()?.session?.sessionId !== sessionId || this.outgoing.get(conn.peer) !== sender) {
        await closeNativeViewerPeer(sessionId, conn.peer, sender.negotiationId); return;
      }
      sendSessionMessage(this.session, conn, { type: 'DIRECT_STREAM_ANSWER', ...sender, sdp: answer.sdp });
      this.session.services?.statsScope?.startStatsMonitor(`native-send-${conn.peer}`, { getStats: () => getNativeStreamStats(sessionId, conn.peer) }, true, null, { cardId: 'local-me', context: () => {
        const provider = this.getProvider?.(), codec = provider?.session?.videoCodec;
        return { requestedCodec: codec, requestedFps: provider?.requestedSettings?.fps, encoderImplementation: codec === 'av1' ? 'svtav1enc' : codec === 'hevc' ? 'mfh265enc' : provider?.session?.h264Encoder || null };
      } });
    } catch (error) {
      if (this.outgoing.get(conn.peer) === sender) this.senders.delete(conn.peer);
      throw error;
    } finally {
      if (this.outgoing.get(conn.peer) === sender) this.negotiating.delete(conn.peer);
    }
  }
  async receive(data, conn) {
    if (typeof data.sessionId !== 'string' || data.sessionId.length > 128 || typeof data.negotiationId !== 'string' || !data.negotiationId || data.negotiationId.length > 128) return;
    if (this.matches(this.receivers.get(conn.peer), data)) return;
    this.closeReceiver(conn.peer);
    const pc = new RTCPeerConnection(getPeerConfig().config);
    const stream = new MediaStream();
    this.receivers.set(conn.peer, { pc, stream, pending: [], sessionId: data.sessionId, negotiationId: data.negotiationId });
    pc.addTransceiver('video', { direction: 'recvonly' });
    if (data.hasAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
    applyTransceiverOptimizations(pc, 'ultra-low', 'auto');
    pc.ontrack = event => {
      if (this.session.isDisposed || this.receivers.get(conn.peer)?.pc !== pc) return;
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      addOrUpdateVideoCard({ session: this.session, audioScope: this.session.audioScope, peerId: conn.peer, stream, label: `Ao Vivo: ${conn.peer.slice(0, 8)}`, onClipClick: this.onClip, onCoopClick: this.onCoop });
      this.context.eventBus.emit('stream:received', { hostId: conn.peer, stream });
      (this.session.services?.statsScope?.startStatsMonitor || startStatsMonitor)(conn.peer, pc, false, null, { context: () => ({ requestedFps: Number.isFinite(data.quality?.fps) && data.quality.fps > 0 && data.quality.fps <= 120 ? data.quality.fps : null }) });
    };
    pc.onicecandidate = event => {
      if (this.receivers.get(conn.peer)?.pc !== pc || this.session.isDisposed) return;
      if (event.candidate) sendSessionMessage(this.session, conn, { type: 'DIRECT_STREAM_ICE_CANDIDATE', sessionId: data.sessionId, negotiationId: data.negotiationId, target: 'sender', candidate: event.candidate.candidate, mlineIndex: event.candidate.sdpMLineIndex ?? 0 });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.closeReceiver(conn.peer, pc);
    };
    try {
      const offer = await pc.createOffer();
      if (this.session.isDisposed || this.receivers.get(conn.peer)?.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (!this.session.isDisposed && this.receivers.get(conn.peer)?.pc === pc) sendSessionMessage(this.session, conn, { type: 'DIRECT_STREAM_OFFER', sessionId: data.sessionId, negotiationId: data.negotiationId, sdp: pc.localDescription?.sdp || offer.sdp });
    } catch (error) { this.closeReceiver(conn.peer, pc); throw error; }
  }
  closeReceiver(id, expectedPc = null) {
    const receiver = this.receivers.get(id);
    if (!receiver || (expectedPc && receiver.pc !== expectedPc)) return;
    this.receivers.delete(id); receiver.pc.close(); receiver.stream.getTracks().forEach(track => track.stop());
    (this.session.services?.statsScope?.stopStatsMonitor || stopStatsMonitor)(id); removeVideoCard(id);
    this.context?.eventBus.emit('stream:stopped', { sourceId: id });
  }
  stopSending() {
    for (const id of this.senders.keys()) this.session.services?.statsScope?.stopStatsMonitor(`native-send-${id}`);
    for (const conn of this.connections?.values() || []) {
      const sender = this.outgoing.get(conn.peer);
      if (sender) sendSessionMessage(this.session, conn, { type: 'DIRECT_STREAM_STOP', ...sender });
    }
    const pending = [...this.senders].map(([id, sessionId]) => closeNativeViewerPeer(sessionId, id, this.outgoing.get(id)?.negotiationId));
    this.senders.clear(); this.outgoing.clear(); this.negotiating.clear(); this.connections?.clear();
    return Promise.allSettled(pending);
  }
  destroy() {
    for (const id of [...this.receivers.keys()]) this.closeReceiver(id);
    super.destroy();
    return this.stopSending();
  }
}
