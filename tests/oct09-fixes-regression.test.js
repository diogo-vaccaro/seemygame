import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomPublisher } from '../js/directory/room-publisher.js';
import { NotepadManager } from '../js/room/notepad.js';
import { RelayManager } from '../js/relay.js';
import { reconcileRelayRoute } from '../js/app/media-calls.js';
import { setupIncomingDataConnection } from '../js/app/message-routing.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Publication lifecycle', () => {
  it('waits for the pending POST before deletion and never recreates the timer', async () => {
    const pending = deferred();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => init.method === 'POST' ? pending.promise : Promise.resolve({ ok: true }));
    const publisher = new RoomPublisher();
    const start = publisher.start({ roomId: 'closed-room' });
    const stop = publisher.stop();
    expect(publisher.isActive).toBe(false);
    expect(fetchMock.mock.calls.map(call => call[1].method)).toEqual(['POST']);
    pending.resolve({ ok: true });
    expect(await start).toBe(false);
    await stop;
    expect(fetchMock.mock.calls.map(call => call[1].method)).toEqual(['POST', 'DELETE']);
    expect(publisher.timer).toBeNull();
  });
  it('serializes a restart after pending cleanup so old deletion cannot remove the new listing', async () => {
    const pending = deferred();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true }).mockImplementationOnce(() => pending.promise);
    const publisher = new RoomPublisher();
    const oldStart = publisher.start({ roomId: 'same-room' });
    const stop = publisher.stop();
    const restart = publisher.start({ roomId: 'same-room', title: 'New generation' });
    pending.resolve({ ok: true });
    await oldStart; await stop;
    expect(await restart).toBe(true);
    expect(fetchMock.mock.calls.map(call => call[1].method)).toEqual(['POST', 'DELETE', 'POST']);
    expect(publisher.isActive).toBe(true);
    await publisher.stop();
  });
  it('also waits for an independently pending periodic heartbeat', async () => {
    const pending = deferred();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });
    const publisher = new RoomPublisher();
    await publisher.start({ roomId: 'periodic-room' });
    fetchMock.mockImplementationOnce(() => pending.promise);
    const heartbeat = publisher.sendHeartbeat();
    const stop = publisher.stop();
    expect(fetchMock.mock.calls.filter(call => call[1].method === 'DELETE')).toHaveLength(0);
    pending.resolve({ ok: true }); await heartbeat; await stop;
    expect(publisher.timer).toBeNull();
    expect(fetchMock.mock.calls.at(-1)[1].method).toBe('DELETE');
  });
});

describe('Snapshot authority', () => {
  it('ignores an admitted guest snapshot and accepts subsequent host revisions', () => {
    const notes = new NotepadManager({ getCoordinatorPeerId: () => 'host' });
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'Original', version: 1 }, 'host');
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'Forged', version: 1000000 }, 'guest');
    expect(notes.text).toBe('Original');
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'Next', version: 2 }, 'host');
    expect(notes.text).toBe('Next'); expect(notes.version).toBe(2);
  });
  it.each([Infinity, NaN, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])('rejects invalid version %s even from the coordinator', version => {
    const notes = new NotepadManager({ getCoordinatorPeerId: () => 'host' });
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'Invalid', version }, 'host');
    expect(notes.text).toBe(''); expect(notes.version).toBe(0);
  });
  it('rejects remote snapshots at the authoritative host', () => {
    const notes = new NotepadManager({ isHost: true, getCoordinatorPeerId: () => 'host' });
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'Forged', version: 999 }, 'guest');
    expect(notes.text).toBe('');
  });
  it('accepts a new coordinator epoch without accepting the previous coordinator', () => {
    let coordinator = 'host';
    const notes = new NotepadManager({ getCoordinatorPeerId: () => coordinator });
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'Old', version: 50 }, 'host');
    coordinator = 'new-host';
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'New', version: 1 }, 'new-host');
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'Stale', version: 100 }, 'host');
    expect(notes.text).toBe('New'); expect(notes.version).toBe(1);
  });
});

describe('LAN route transitions', () => {
  it('accepts route assignment from its host and stops only its matching forwarded stream', () => {
    const handlers = new Map();
    const conn = { peer: 'host', on: (event, callback) => handlers.set(event, callback), send: vi.fn() };
    const call = { metadata: { hostPeerId: 'host' }, close: vi.fn() };
    const watcher = { isRelayed: true, relayParentPeerId: 'old-relay' };
    const context = {
      connectedViewers: new Map(), maxViewers: 10,
      roomManager: null, isPeerAuthorizedForMedia: () => true,
      handleDirectStreamSignaling: () => false,
      watchingHosts: new Map([['host', watcher]]),
      activeMediaCalls: new Map([['viewer', call]]),
      pendingRelayRequests: [{ targetPeerId: 'viewer', hostPeerId: 'host' }]
    };
    setupIncomingDataConnection(context, conn);
    handlers.get('data')({ type: 'RELAY_UPSTREAM_ASSIGNED', hostPeerId: 'host', parentPeerId: 'host' });
    expect(watcher.isRelayed).toBe(false); expect(watcher.relayParentPeerId).toBeNull();
    handlers.get('data')({ type: 'RELAY_FORWARD_REQUEST', hostPeerId: 'other', targetPeerId: 'viewer', stop: true });
    expect(call.close).not.toHaveBeenCalled();
    handlers.get('data')({ type: 'RELAY_FORWARD_REQUEST', hostPeerId: 'host', targetPeerId: 'viewer', stop: true });
    expect(call.close).toHaveBeenCalled(); expect(context.pendingRelayRequests).toEqual([]);
  });
  it('promotes LAN, updates both parents, and restores WAN quota on demotion', () => {
    const onRouteChange = vi.fn();
    const relay = new RelayManager({ originPeerId: 'host', maxDirectViewers: 1, onRouteChange });
    relay.registerViewer('wan', { isLan: false, rtt: 50 });
    relay.registerViewer('late-lan', { rtt: 50 });
    relay.updateTelemetry('late-lan', { isLan: true, rtt: 2 });
    expect(relay.nodes.get('late-lan').parentPeerId).toBe('host');
    expect(relay.nodes.get('wan').children.has('late-lan')).toBe(false);
    expect(relay.nodes.get('host').children.has('late-lan')).toBe(true);
    expect(onRouteChange).toHaveBeenLastCalledWith('late-lan', 'host', 'direct', 'wan');
    relay.updateTelemetry('late-lan', { isLan: false, isRelay: true, rtt: 50 });
    expect(relay.nodes.get('late-lan').role).toBe('relay');
    expect(relay.getDirectNodes().filter(node => !node.isLan)).toHaveLength(1);
    expect(onRouteChange).toHaveBeenLastCalledWith('late-lan', 'wan', 'relay', 'host');
  });
  it('signals the new upstream, stops the previous relay and starts the direct call', () => {
    const viewer = { open: true, send: vi.fn() }, parent = { open: true, send: vi.fn() };
    const context = { peer: { id: 'host' }, localStream: {}, roomManager: { meshConnections: new Map([['viewer', viewer], ['wan', parent]]) }, initiateMediaCallToViewer: vi.fn() };
    reconcileRelayRoute(context, 'viewer', 'host', 'direct', 'wan');
    expect(viewer.send).toHaveBeenCalledWith({ type: 'RELAY_UPSTREAM_ASSIGNED', parentPeerId: 'host', hostPeerId: 'host' });
    expect(parent.send).toHaveBeenCalledWith({ type: 'RELAY_FORWARD_REQUEST', targetPeerId: 'viewer', hostPeerId: 'host', stop: true });
    expect(context.initiateMediaCallToViewer).toHaveBeenCalledWith('viewer');
  });
  it('closes a direct upload and requests forwarding on demotion', () => {
    const previous = { close: vi.fn() }, parent = { open: true, send: vi.fn() };
    const context = { peer: { id: 'host' }, localStream: {}, roomManager: { meshConnections: new Map([['viewer', { open: true, send: vi.fn() }], ['wan', parent]]) }, activeMediaCalls: new Map([['viewer', previous]]) };
    reconcileRelayRoute(context, 'viewer', 'wan', 'relay', 'host');
    expect(previous.close).toHaveBeenCalled();
    expect(context.activeMediaCalls.has('viewer')).toBe(false);
    expect(parent.send).toHaveBeenCalledWith({ type: 'RELAY_FORWARD_REQUEST', targetPeerId: 'viewer', hostPeerId: 'host' });
  });
});
