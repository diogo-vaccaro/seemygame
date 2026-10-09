import { RelayManager } from '../relay.js';
import { sendSessionMessage } from '../protocol/transport.js';
import { collectPeerMetrics } from '../stats/metrics.js';

/** Room-session media routing. Forwarded calls are scoped by origin and target. */
export class RoomRelayTransport {
  constructor({ session, room, state, sendDirect, maxDirectViewers = 8 }) {
    this.session = session; this.room = room; this.state = state; this.sendDirect = sendDirect;
    this.assignments = new Map();
    this.forwards = new Map();
    this.stopped = false;
    this.polling = false;
    this.tree = new RelayManager({
      originPeerId: state.peer.id, maxDirectViewers,
      onRouteChange: (...args) => this.reconcile(...args),
      onFailover: (target, parent, role) => this.reconcile(target, parent, role)
    });
    this.routeTimer = setInterval(() => this.pollRoutes(), 2000);
    session?.registerCleanup(() => this.dispose());
  }

  async pollRoutes() {
    if (this.polling || this.stopped || !this.state.localStream) return;
    this.polling = true;
    try {
      // Relayed video has no origin-to-viewer stats; classify the admitted data connection instead.
      for (const node of this.tree.nodes.values()) {
        if (node.role !== 'relay') continue;
        const conn = this.room.meshConnections.get(node.peerId);
        if (!conn?.open || !conn.peerConnection?.getStats) continue;
        try {
          const stats = await conn.peerConnection.getStats();
          if (this.stopped || this.session?.isDisposed) return;
          const metrics = collectPeerMetrics(stats);
          if (Number.isFinite(metrics.rtt)) this.tree.updateTelemetry(node.peerId, metrics);
        } catch { /* Closed data connection; membership handles failover. */ }
      }
    } finally { this.polling = false; }
  }

  send(peerId, message) {
    const conn = this.room.meshConnections.get(peerId);
    if (this.stopped || this.session?.isDisposed || !conn?.open || !this.room.isPeerAuthorized(peerId)) return false;
    sendSessionMessage(this.session, conn, message);
    return true;
  }

  allocate(target) {
    const node = this.tree.nodes.get(target) || this.tree.registerViewer(target, { rtt: 50 });
    if (!node) return false;
    if (node.role === 'relay') { this.reconcile(target, node.parentPeerId, node.role); return false; }
    this.send(target, { type: 'RELAY_UPSTREAM_ASSIGNED', hostPeerId: this.state.peer.id, parentPeerId: this.state.peer.id });
    return true;
  }

  reconcile(target, parent, role, oldParent) {
    if (this.stopped || !this.state.localStream) return;
    const host = this.state.peer.id;
    if (!this.send(target, { type: 'RELAY_UPSTREAM_ASSIGNED', hostPeerId: host, parentPeerId: parent })) return;
    if (oldParent && oldParent !== host) this.send(oldParent, { type: 'RELAY_FORWARD_REQUEST', hostPeerId: host, targetPeerId: target, stop: true });
    if (role === 'direct') {
      this.sendDirect(target);
    } else {
      const old = this.state.screenCalls.get(target);
      this.state.screenCalls.delete(target);
      try { old?.close(); } catch { /* Already closed. */ }
      this.send(parent, { type: 'RELAY_FORWARD_REQUEST', hostPeerId: host, targetPeerId: target });
    }
  }

  handle(message, conn) {
    if (!['RELAY_UPSTREAM_ASSIGNED', 'RELAY_FORWARD_REQUEST'].includes(message?.type)) return false;
    const host = message.hostPeerId;
    if (this.stopped || conn?.peer !== host || !this.room.isPeerAuthorized(host)) return true;
    if (message.type === 'RELAY_UPSTREAM_ASSIGNED') {
      const parent = message.parentPeerId;
      if (parent === this.state.peer.id || !this.room.isPeerAuthorized(parent)) return true;
      const changed = this.assignments.get(host) !== parent;
      this.assignments.set(host, parent);
      if (changed) this.send(host, { type: 'REQUEST_STREAM' });
      return true;
    }
    const target = message.targetPeerId;
    if (!target || target === host || target === this.state.peer.id || !this.room.isPeerAuthorized(target)) return true;
    const key = JSON.stringify([host, target]);
    if (message.stop) { this.closeForward(key); return true; }
    if (!this.forwards.has(key)) this.forwards.set(key, { host, target, call: null, stream: null });
    this.forward(key);
    return true;
  }

  accepts(call) {
    const host = call.metadata?.type === 'RELAY_STREAM' ? call.metadata.hostPeerId : call.peer;
    if (!this.room.isPeerAuthorized(host) || !this.room.isPeerAuthorized(call.peer)) return false;
    if (call.metadata?.type === 'RELAY_STREAM') return this.assignments.get(host) === call.peer;
    return !this.assignments.has(host) || this.assignments.get(host) === host;
  }

  forward(key) {
    const entry = this.forwards.get(key);
    if (!entry || this.stopped || this.session?.isDisposed) return;
    const stream = this.state.remoteStreams.get(entry.host)?.stream;
    if (!stream || !this.room.isPeerAuthorized(entry.target)) return;
    if (entry.call && entry.stream === stream) return;
    const old = entry.call;
    entry.call = null;
    try { old?.close(); } catch { /* Already closed. */ }
    const call = this.state.peer.call(entry.target, stream, { metadata: { type: 'RELAY_STREAM', hostPeerId: entry.host } });
    entry.call = call; entry.stream = stream;
    const release = () => {
      if (entry.call !== call) return;
      entry.call = null; entry.stream = null;
    };
    call?.on('close', release); call?.on('error', release);
  }

  received(host) {
    for (const [key, entry] of this.forwards) if (entry.host === host) this.forward(key);
  }

  closeForward(key) {
    const entry = this.forwards.get(key);
    this.forwards.delete(key);
    try { entry?.call?.close(); } catch { /* Already closed. */ }
  }

  remove(peerId) {
    this.tree.unregisterViewer(peerId);
    this.assignments.delete(peerId);
    for (const [key, entry] of this.forwards) if (entry.host === peerId || entry.target === peerId) this.closeForward(key);
  }

  stopSource(host) {
    for (const [key, entry] of this.forwards) if (entry.host === host) this.closeForward(key);
    this.assignments.delete(host);
  }

  resetLocal() {
    // Suppress failovers while tearing down the origin's stream.
    this.tree.nodes.clear();
    this.tree.setOrigin(this.state.peer?.id);
  }

  dispose() {
    this.stopped = true;
    clearInterval(this.routeTimer);
    for (const key of [...this.forwards.keys()]) this.closeForward(key);
    this.assignments.clear(); this.tree.nodes.clear();
  }
}
