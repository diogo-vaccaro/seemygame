import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

globalThis.fetch = async () => ({ ok: false });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { createSessionContext } = await import('../js/core/session-context.js');
const { createStreamerSession } = await import('../js/session/streamer-session.js');
const { createViewerSession } = await import('../js/session/viewer-session.js');
const { createRoomSession } = await import('../js/session/room-session.js');
const { bindSessionMessageHandlers } = await import('../js/protocol/session-handlers.js');
const { WhiteboardManager } = await import('../js/whiteboard.js');
const { isSafeWhiteboardElement } = await import('../js/whiteboard/shared.js');
const { ChatManager } = await import('../js/chat.js');
const { getPeerConfig, _resetDynamicIceCache } = await import('../js/config.js');
const { RoomManager } = await import('../js/room.js');
const { WhiteboardPlugin } = await import('../js/plugins/whiteboard-plugin.js');
const { isWithinMessageLimit } = await import('../js/room/shared.js');

class MockConnection extends EventEmitter {
  constructor(peer) {
    super();
    this.peer = peer;
    this.open = false;
    this.sent = [];
  }
  send(data) { this.sent.push(data); }
  close() { this.open = false; this.emit('close'); }
}

class MockCall extends EventEmitter {
  constructor(peer, metadata = {}) {
    super();
    this.peer = peer;
    this.metadata = metadata;
    this.closed = false;
    this.peerConnection = {
      connectionState: 'new',
      setLocalDescription: async () => {},
      getTransceivers: () => [],
      getSenders: () => [],
      getStats: async () => new Map(),
      addEventListener() {},
      removeEventListener() {}
    };
  }
  answer(stream) { this.answeredWith = stream; }
  close() { this.closed = true; this.emit('close'); }
}

class MockPeer extends EventEmitter {
  constructor(id) {
    super();
    this.id = typeof id === 'string' ? id : 'random-peer';
    this.destroyed = false;
    this.calls = [];
    queueMicrotask(() => this.emit('open', this.id));
  }
  call(id, stream, options) {
    const call = new MockCall(id, options?.metadata);
    this.calls.push(call);
    return call;
  }
  connect(id) { return new MockConnection(id); }
  destroy() { this.destroyed = true; }
}

globalThis.Peer = MockPeer;

describe('Audit Findings Regression Suite (A01 - A15)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="video-grid"></div>';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A01: Viewer rejects voice calls from unauthorized peers and does not leak microphone', async () => {
    const runtime = createViewerSession();
    const session = createSessionContext();
    const microphone = { marker: 'active-local-microphone' };
    const voiceManager = { isInVoice: true, localStream: microphone, removeRemoteParticipant() {}, addRemoteParticipant() {} };
    runtime.viewerState.session = session;
    runtime.viewerState.targetHostId = 'trusted-host';
    runtime.viewerState.messageHandlers = bindSessionMessageHandlers(session, {
      role: 'viewer',
      voiceManager,
      isAuthorizedPeer: (id) => id === 'trusted-host'
    });

    const peer = await runtime.initViewerPeer(session);
    const unauthorizedCall = new MockCall('unrelated-peer', { type: 'VOICE_CHAT' });
    peer.emit('call', unauthorizedCall);

    expect(unauthorizedCall.answeredWith).toBeUndefined();
    expect(unauthorizedCall.closed).toBe(true);

    session.dispose();
  });

  it('A02: Room mesh connects without re-entrant connection storms', async () => {
    const runtime = createRoomSession();
    const session = createSessionContext();
    const peer = new MockPeer('aaa-guest');
    let meshAttempts = 0;
    peer.connect = (id) => {
      if (id === 'zzz-guest') meshAttempts++;
      return new MockConnection(id);
    };
    runtime.roomState.peer = peer;
    runtime.roomState.session = session;
    await runtime.setupRoomSession(peer.id, session);
    const rm = runtime.roomState.roomManager;
    const coordinator = runtime.roomState.coordinatorConn;
    coordinator.open = true;
    coordinator.emit('open');

    coordinator.emit('data', {
      type: 'ROOM_SYNC_ALL',
      roomId: rm.roomId,
      members: [
        { peerId: rm.masterPeerId, isMaster: true },
        { peerId: 'zzz-guest', name: 'Guest Z' }
      ]
    });

    expect(meshAttempts).toBeLessThanOrEqual(1);

    rm.leave();
    session.dispose();
  });

  it('A03 & A04: Streamer callViewerWithStream is idempotent and closes media call on disconnect', async () => {
    const runtime = createStreamerSession();
    const session = createSessionContext();
    runtime.streamerState.session = session;
    runtime.streamerState.localStream = { getTracks: () => [] };
    const peer = await runtime.initStreamerPeer('audit-host', session);
    const conn = new MockConnection('audit-viewer');
    peer.emit('connection', conn);
    conn.open = true;
    conn.emit('open');

    conn.emit('data', { type: 'REQUEST_STREAM' });

    // Idempotent: exactly 1 call created despite open + REQUEST_STREAM
    expect(peer.calls.length).toBe(1);
    expect(runtime.streamerState.activeCalls.size).toBe(1);

    const call = peer.calls[0];
    expect(call.closed).toBe(false);

    // Disconnection must close the active media call
    conn.close();
    expect(call.closed).toBe(true);
    expect(runtime.streamerState.activeCalls.size).toBe(0);

    session.dispose();
  });

  it('A05: Whiteboard updateElement enforces safe element validation', () => {
    const board = new WhiteboardManager();
    board.addElement({ id: 'element-1', type: 'pencil', points: [{ x: 1, y: 1 }] }, false);
    const invalid = { id: 'element-1', type: 'pencil', points: [null, null] };

    expect(isSafeWhiteboardElement(invalid)).toBe(false);
    board.updateElement(invalid, false);

    // Invalid update must be rejected
    expect(board.elements[0].points[0]).toEqual({ x: 1, y: 1 });
    board.setCanvas(null);
  });

  it('A06: Room capture stops acquired screen track when microphone permission is denied', async () => {
    let stopped = 0;
    const track = new EventTarget();
    track.kind = 'video';
    track.readyState = 'live';
    track.stop = () => { stopped++; track.readyState = 'ended'; };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [], addTrack() {} };

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: async () => stream,
        getUserMedia: async () => { throw new Error('microphone denied'); }
      }
    });

    const runtime = createRoomSession();
    const app = await runtime.initRoomApp();
    app.state.roomManager = new RoomManager({ roomId: 'audit-room' });

    await app.startCapture({ audioMode: 'mic' });

    expect(app.state.localStream).toBeNull();
    expect(stopped).toBe(1);

    app.dispose();
  });

  it('A07: Streamer stops capture when video track ends in browser', async () => {
    const track = new EventTarget();
    track.kind = 'video';
    track.readyState = 'live';
    track.stop = () => { track.readyState = 'ended'; };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };

    navigator.mediaDevices.getDisplayMedia = async () => stream;
    const runtime = createStreamerSession();
    const app = await runtime.initStreamerApp();
    await app.startCapture({ audioMode: 'none' });

    expect(app.state.localStream).toBe(stream);

    track.readyState = 'ended';
    track.dispatchEvent(new Event('ended'));

    expect(app.state.localStream).toBeNull();

    app.dispose();
  });

  it('A08: Streamer unavailable-id falls back to random peer ID without repeating occupied ID', async () => {
    const ids = [];
    class RetryPeer extends MockPeer {
      constructor(id) {
        super(id);
        ids.push(this.id);
      }
      emit(type, ...args) {
        if (type === 'open' && ids.length === 1) return super.emit('error', { type: 'unavailable-id' });
        return super.emit(type, ...args);
      }
    }
    globalThis.Peer = RetryPeer;

    const runtime = createStreamerSession();
    const session = createSessionContext();
    runtime.streamerState.customId = 'occupied-id';

    await runtime.initStreamerPeer('occupied-id', session);

    expect(ids[0]).toBe('occupied-id');
    expect(ids[1]).toBe('random-peer');

    session.dispose();
    globalThis.Peer = MockPeer;
  });

  it('A09: Viewer video card has working onCoopClick callback attached to button', async () => {
    window.HTMLMediaElement.prototype.play = async () => {};
    window.HTMLMediaElement.prototype.pause = () => {};
    const runtime = createViewerSession();
    const session = createSessionContext();
    runtime.viewerState.session = session;
    runtime.viewerState.targetHostId = 'trusted-host';

    const peer = await runtime.initViewerPeer(session);
    await runtime.connectToStreamer('trusted-host', null, session);
    runtime.viewerState.activeConn.open = true;
    runtime.viewerState.activeConn.emit('open');
    const call = new MockCall('trusted-host');
    peer.emit('call', call);
    const stream = { getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] };
    call.emit('stream', stream);

    const button = document.getElementById('btn-coop-trusted-host');
    expect(button).toBeTruthy();
    expect(typeof button.onclick).toBe('function');

    call.close();
    session.dispose();
  });

  it('A10: Chat handler prevents author and role spoofing', () => {
    const session = createSessionContext();
    const chatManager = new ChatManager();
    bindSessionMessageHandlers(session, { role: 'streamer', chatManager });

    session.dispatcher.dispatch({
      type: 'CHAT_MESSAGE',
      senderPeerId: 'guest-peer',
      message: {
        id: 'forged-chat',
        senderId: 'host',
        senderName: 'Host',
        role: 'host',
        isSystem: true,
        channel: 'geral',
        text: 'forged message'
      }
    }, { peer: 'guest-peer' });

    const messages = chatManager.getMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].senderId).toBe('guest-peer');
    expect(messages[0].role).toBe('viewer');
    expect(messages[0].isSystem).toBe(false);

    session.dispose();
  });

  it('A11: Whiteboard late sync chunks large images so no message exceeds transport limit', () => {
    const session = createSessionContext();
    const board = new WhiteboardManager();
    board.addElement({
      id: 'large-image',
      type: 'image',
      startX: 0,
      startY: 0,
      endX: 20,
      endY: 20,
      dataUrl: 'data:image/png;base64,' + 'A'.repeat(300000)
    }, false);

    const plugin = new WhiteboardPlugin({ manager: board });
    session.pluginManager.register(plugin);
    session.pluginManager.initAll({ isRoomMode: () => true });

    const conn = new MockConnection('late-viewer');
    conn.open = true;
    session.dispatcher.dispatch({ type: 'WHITEBOARD_REQUEST_SYNC' }, conn);

    expect(conn.sent.length).toBeGreaterThan(1);
    for (const msg of conn.sent) {
      expect(isWithinMessageLimit(msg)).toBe(true);
    }

    session.dispose();
  });

  it('A12: RoomManager does not purge live member when another user joins with the same display name', () => {
    const rm = new RoomManager({ roomId: 'name-collision-test' });
    rm.join('room-host', true);
    const first = new MockConnection('first-guest');
    first.open = true;
    const second = new MockConnection('second-guest');
    second.open = true;

    rm.registerConnection(first.peer, first);
    rm.handleRoomMessage(first.peer, { type: 'ROOM_JOIN_REQUEST', name: 'Gamer', clientSessionId: 'tab-1' }, first);

    rm.registerConnection(second.peer, second);
    rm.handleRoomMessage(second.peer, { type: 'ROOM_JOIN_REQUEST', name: 'Gamer', clientSessionId: 'tab-2' }, second);

    expect(rm.members.has(first.peer)).toBe(true);
    expect(rm.members.has(second.peer)).toBe(true);

    rm.leave();
  });

  it('A13: Static ICE fallback on production HTTPS origin uses STUN-only and omits OpenRelay', () => {
    _resetDynamicIceCache();
    const originalLocation = window.location;
    delete window.location;
    window.location = new URL('https://seemygame.vercel.app/viewer.html');

    const config = getPeerConfig();
    const turns = config.config.iceServers.filter(server => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some(u => /^turns?:/i.test(u));
    });

    expect(turns.length).toBe(0);

    window.location = originalLocation;
    _resetDynamicIceCache();
  });

  it('Static 2: Whiteboard caps undoStack size to 50 snapshots', () => {
    const board = new WhiteboardManager();
    for (let i = 0; i < 70; i++) {
      board.addElement({ id: `elem-${i}`, type: 'pencil', points: [{ x: i, y: i }] }, false);
    }
    expect(board.undoStack.length).toBeLessThanOrEqual(50);
  });

  it('Static 3: Room voice calls are properly tracked and closed on leaveRoomVoice', async () => {
    const mockMicTrack = { kind: 'audio', readyState: 'live', stop: vi.fn() };
    const mockMicStream = {
      getTracks: () => [mockMicTrack],
      getAudioTracks: () => [mockMicTrack],
      getVideoTracks: () => []
    };
    navigator.mediaDevices.getUserMedia = async () => mockMicStream;

    const runtime = createRoomSession();
    const app = await runtime.initRoomApp();
    const peer = new MockPeer('a-host');
    app.state.peer = peer;

    const rm = new RoomManager({ roomId: 'audit-voice-room' });
    rm.join('a-host', true);
    app.state.roomManager = rm;

    const memberConn = new MockConnection('z-member');
    memberConn.open = true;
    rm.registerConnection('z-member', memberConn);
    rm.authenticatedPeers.add('z-member');
    rm.meshConnections.set('z-member', memberConn);

    const handlers = app.session.messageHandlers;
    expect(handlers).toBeTruthy();
    app.session.dispatcher.dispatch({ type: 'VOICE_SIGNAL', action: 'VOICE_JOINED', peerId: 'z-member' }, memberConn);

    await app.joinVoice();

    expect(peer.calls.length).toBe(1);
    expect(handlers.activeVoiceCalls.has('z-member')).toBe(true);
    const voiceCall = handlers.activeVoiceCalls.get('z-member');
    expect(voiceCall.closed).toBe(false);

    app.leaveVoice();

    expect(handlers.activeVoiceCalls.size).toBe(0);
    expect(voiceCall.closed).toBe(true);

    rm.leave();
    app.dispose();
  });

  it('Static 5: Room PIN authentication rate-limits and rejects peer on excessive failures', () => {
    const rm = new RoomManager({ roomId: 'rate-limit-room' });
    rm.join('master-host', true);
    rm.setRoomPin('1234');

    const conn = new MockConnection('attacker-peer');
    conn.open = true;
    rm.registerConnection(conn.peer, conn);

    for (let i = 0; i < 5; i++) {
      rm.handleRoomMessage(conn.peer, { type: 'ROOM_JOIN_REQUEST', pin: 'wrong' }, conn);
    }

    expect(conn.sent.length).toBe(5);
    expect(conn.open).toBe(false);

    // Further attempts remain blocked during the cooldown.
    rm.handleRoomMessage(conn.peer, { type: 'ROOM_JOIN_REQUEST', pin: 'wrong' }, conn);

    expect(conn.sent.length).toBe(6);
    expect(conn.sent[5].error).toMatch(/Excesso de tentativas/i);
    expect(conn.open).toBe(false);

    rm.leave();
  });

  it('A14 & A15: serve.mjs blocks dotfiles (403) and handles malformed URI (400) without crashing', async () => {
    const { spawn } = await import('node:child_process');
    const http = await import('node:http');
    const net = await import('node:net');
    const path = await import('node:path');
    const { once } = await import('node:events');

    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(res => reservation.close(res));

    const projectRoot = process.cwd();
    const serveScript = path.resolve(projectRoot, 'tools/serve.mjs');
    const child = spawn(process.execPath, [serveScript], {
      cwd: projectRoot,
      windowsHide: true,
      env: { ...process.env, PORT: String(port) }
    });

    const ready = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Server start timeout')), 5000);
      child.once('error', (err) => { clearTimeout(timer); rej(err); });
      child.stdout.once('data', () => { clearTimeout(timer); res(); });
    });

    const request = (reqPath) => new Promise((res, rej) => {
      const req = http.get({ host: '127.0.0.1', port, path: reqPath }, (response) => {
        response.resume();
        response.once('end', () => res({ status: response.statusCode }));
      });
      req.once('error', rej);
      req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    });

    try {
      await ready;

      // A14: Dotfile access must be forbidden (403)
      const dotfileRes = await request('/.git/HEAD');
      expect(dotfileRes.status).toBe(403);
      for (const uri of ['/%5C.git%5CHEAD', '/css/%5C..%5C.git%5CHEAD', '/%2Egit%2FHEAD', '/.git/HEAD::$DATA', '/src-tauri/Cargo.toml', '/package.json']) {
        expect((await request(uri)).status, uri).toBe(403);
      }

      // A15: Malformed URI must return 400 Bad Request and server remains alive
      const malformedRes = await request('/%ZZ');
      expect(malformedRes.status).toBe(400);

      // Verify server is still responding normally
      const normalRes = await request('/');
      expect(normalRes.status).toBe(200);
      expect((await request('/js/config.js')).status).toBe(200);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});
