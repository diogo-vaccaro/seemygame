import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import handler, { resetMemoryRooms } from '../api/rooms.js';
import { RoomPublisher } from '../js/directory/room-publisher.js';
import { NotepadManager } from '../js/room/notepad.js';
import { RoomRelayTransport } from '../js/room/relay-transport.js';

async function request(method, body = {}, url = '/api/rooms') {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; }, end() {} };
  await handler({ method, body, url, headers: {} }, res);
  return res;
}
const disposables = [];
beforeEach(() => {
  resetMemoryRooms();
  for (const key of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) vi.stubEnv(key, '');
});
afterEach(() => {
  for (const resource of disposables.splice(0)) resource.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetMemoryRooms();
});

describe('Retired publication generations', () => {
  const publication = () => ({ id: 'room', secretKey: 'owner', publicationId: 'old', sentAt: Date.now() });
  it('rejects a delayed first POST after the unload DELETE has already arrived', async () => {
    const body = publication();
    await request('DELETE', {}, '/api/rooms?id=room&secret=owner&publication=old');
    expect((await request('POST', body)).statusCode).toBe(403);
    expect((await request('GET')).body.count).toBe(0);
  });
  it('keeps a new publication when a repeated old-generation DELETE arrives', async () => {
    await request('POST', publication());
    await request('DELETE', {}, '/api/rooms?id=room&secret=owner&publication=old');
    await request('POST', { ...publication(), publicationId: 'new', title: 'New session' });
    await request('DELETE', {}, '/api/rooms?id=room&secret=owner&publication=old');
    expect((await request('GET')).body.rooms[0].title).toBe('New session');
    expect((await request('POST', publication())).statusCode).toBe(403);
  });
  it('rejects expired heartbeats after a retirement record could have expired', async () => {
    expect((await request('POST', { ...publication(), sentAt: Date.now() - 181000 })).statusCode).toBe(400);
  });
  it('cannot retire another owner publication', async () => {
    await request('POST', publication());
    await request('DELETE', {}, '/api/rooms?id=room&secret=attacker&publication=old');
    expect((await request('POST', publication())).statusCode).toBe(200);
  });
  it('invalidates an unload start and falls back if sendBeacon rejects the request', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push(init.method);
      if (init.method === 'POST') await gate;
      const result = await request(init.method, init.body ? JSON.parse(init.body) : {}, url);
      return { ok: result.statusCode === 200 };
    }));
    const publisher = new RoomPublisher(); disposables.push(publisher);
    const start = publisher.start({ roomId: 'room' });
    publisher._handleUnload();
    await vi.waitFor(() => expect(calls).toEqual(['POST', 'DELETE']));
    release();
    expect(await start).toBe(false);
    expect(publisher.timer).toBeNull();
    expect((await request('GET')).body.count).toBe(0);
  });
});

describe('Coordinator-ordered note edits', () => {
  it('keeps an official snapshot when another guest sends an older edit directly', () => {
    const notes = new NotepadManager({ getCoordinatorPeerId: () => 'host' });
    notes.handleRemoteMessage({ type: 'NOTE_SYNC', text: 'Latest', version: 5 }, 'host');
    notes.handleRemoteMessage({ type: 'NOTE_UPDATE', text: 'Old edit' }, 'guest');
    expect(notes.text).toBe('Latest'); expect(notes.version).toBe(5);
  });
  it('still allows guest proposals through the host and replicates the official revision', () => {
    const guest = new NotepadManager({ getCoordinatorPeerId: () => 'host' });
    const host = new NotepadManager({ isHost: true, broadcast: message => guest.handleRemoteMessage(message, 'host') });
    host.handleRemoteMessage({ type: 'NOTE_UPDATE', text: 'Strategy', authorName: 'Guest' }, 'guest');
    expect(guest.text).toBe('Strategy'); expect(guest.version).toBe(host.version);
  });
});

function routing() {
  const calls = [];
  const peers = ['host', 'a', 'b', 'c'];
  const room = { meshConnections: new Map(peers.map(peer => [peer, { peer, open: true, send: vi.fn() }])), isPeerAuthorized: id => peers.includes(id) };
  const state = { peer: { id: 'host', call: vi.fn((target, stream, options) => {
    const call = new EventEmitter(); call.peer = target; call.metadata = options.metadata;
    call.close = vi.fn(() => call.emit('close')); calls.push(call); return call;
  }) }, localStream: {}, screenCalls: new Map(), remoteStreams: new Map() };
  const sendDirect = vi.fn();
  const transport = new RoomRelayTransport({ session: { getPeerId: () => 'host', registerCleanup() {} }, room, state, sendDirect, maxDirectViewers: 1 });
  disposables.push(transport);
  return { transport, state, room, sendDirect, calls };
}
describe('Current room relay transport', () => {
  it('delegates a second WAN viewer and replaces the route on LAN and WAN transitions', () => {
    const { transport, state, room, sendDirect } = routing();
    expect(transport.allocate('a')).toBe(true);
    expect(transport.allocate('b')).toBe(false);
    expect(room.meshConnections.get('a').send).toHaveBeenCalledWith(expect.objectContaining({ type: 'RELAY_FORWARD_REQUEST', targetPeerId: 'b' }));
    transport.tree.updateTelemetry('b', { isLan: true, rtt: 2 });
    expect(sendDirect).toHaveBeenCalledWith('b');
    const direct = { close: vi.fn() }; state.screenCalls.set('b', direct);
    transport.tree.updateTelemetry('b', { isLan: false, rtt: 50 });
    expect(direct.close).toHaveBeenCalled(); expect(state.screenCalls.has('b')).toBe(false);
  });
  it('queues forwarding until the source arrives and closes it on the matching stop', () => {
    const { transport, state, calls } = routing();
    const message = { type: 'RELAY_FORWARD_REQUEST', hostPeerId: 'a', targetPeerId: 'b' };
    transport.handle(message, { peer: 'a' }); expect(calls).toHaveLength(0);
    state.remoteStreams.set('a', { stream: {} }); transport.received('a');
    expect(calls).toHaveLength(1); expect(calls[0].metadata.hostPeerId).toBe('a');
    transport.handle({ ...message, stop: true }, { peer: 'c' }); expect(calls[0].close).not.toHaveBeenCalled();
    transport.handle({ ...message, stop: true }, { peer: 'a' }); expect(calls[0].close).toHaveBeenCalled();
  });
  it('only accepts the assigned upstream and preserves independent origins', () => {
    const { transport } = routing();
    transport.handle({ type: 'RELAY_UPSTREAM_ASSIGNED', hostPeerId: 'a', parentPeerId: 'b' }, { peer: 'c' });
    expect(transport.accepts({ peer: 'b', metadata: { type: 'RELAY_STREAM', hostPeerId: 'a' } })).toBe(false);
    transport.handle({ type: 'RELAY_UPSTREAM_ASSIGNED', hostPeerId: 'a', parentPeerId: 'b' }, { peer: 'a' });
    expect(transport.accepts({ peer: 'b', metadata: { type: 'RELAY_STREAM', hostPeerId: 'a' } })).toBe(true);
    expect(transport.accepts({ peer: 'c', metadata: { type: 'RELAY_STREAM', hostPeerId: 'a' } })).toBe(false);
    expect(transport.accepts({ peer: 'c', metadata: { type: 'ROOM_STREAM' } })).toBe(true);
  });
  it('replaces forwarding on a new source stream and releases every call on disposal', () => {
    const { transport, state, calls } = routing();
    state.remoteStreams.set('a', { stream: {} });
    transport.handle({ type: 'RELAY_FORWARD_REQUEST', hostPeerId: 'a', targetPeerId: 'b' }, { peer: 'a' });
    state.remoteStreams.set('a', { stream: {} }); transport.received('a');
    expect(calls[0].close).toHaveBeenCalled(); expect(calls).toHaveLength(2);
    transport.dispose(); expect(calls[1].close).toHaveBeenCalled();
    expect(transport.forwards.size).toBe(0);
  });
});
