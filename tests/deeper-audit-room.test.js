import { afterEach, expect, it, vi } from 'vitest';
import { RoomManager } from '../js/room.js';
import { createSessionContext } from '../js/core/session-context.js';
import { createCoordinatorReconnect } from '../js/session/coordinator-reconnect.js';
const rooms = [];
afterEach(() => { rooms.splice(0).forEach(room => room.leave()); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  const room = new RoomManager({ roomId: 'deep-room' }); rooms.push(room);
  room.join('guest-local', false);
  const master = { peer: room.masterPeerId, open: true, send: vi.fn(), close: vi.fn() };
  room.registerConnection(master.peer, master); room.promoteConnection(master.peer, master, { isMaster: true });
  return { room, master };
}
it('reconciles a coordinator snapshot by revoking members missing after reconnection', () => {
  const { room, master } = fixture();
  const old = { peer: 'departed', open: true, send: vi.fn(), close: vi.fn() };
  room.promoteConnection(old.peer, old, { name: 'Departed' });
  room.handleRoomMessage(master.peer, { type: 'ROOM_SYNC_ALL', members: [{ peerId: master.peer, name: 'Host' }] }, master);
  expect(room.members.has('departed')).toBe(false);
  expect(room.isPeerAuthorized('departed')).toBe(false);
  expect(old.close).toHaveBeenCalledTimes(1);
  expect(room.members.has(room.myPeerId)).toBe(true);
});
it('stops a remote stream when the authoritative snapshot says it is no longer published', () => {
  const { room, master } = fixture();
  room.promoteConnection('publisher', { peer: 'publisher', open: true }, { isStreaming: true });
  const stopped = vi.fn(); room.on('streamUnpublished', stopped);
  room.handleRoomMessage(master.peer, { type: 'ROOM_SYNC_ALL', members: [
    { peerId: master.peer }, { peerId: 'publisher', isStreaming: false }
  ] }, master);
  expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ peerId: 'publisher' }));
});
it.each(['ROOM_PIN_REQUIRED', 'ROOM_KEY_REQUIRED', 'ROOM_JOIN_REJECTED'])('ignores admission notification %s from another participant', type => {
  const { room } = fixture();
  const peer = { peer: 'another-guest', open: true };
  room.promoteConnection(peer.peer, peer);
  const callback = vi.fn(); room.on(type === 'ROOM_PIN_REQUIRED' ? 'pinRequired' : 'joinRejected', callback);
  room.handleRoomMessage(peer.peer, { type, error: 'fake rejection' }, peer);
  expect(callback).not.toHaveBeenCalled();
});
it('does not accept a coordinator approval over a replaced connection', () => {
  const { room, master } = fixture();
  const stale = { ...master };
  const accepted = vi.fn(); room.on('pinAccepted', accepted);
  room.handleRoomMessage(master.peer, { type: 'ROOM_PIN_ACCEPTED' }, stale);
  expect(room.meshConnections.get(master.peer)).toBe(master);
  expect(accepted).not.toHaveBeenCalled();
});
it('retries coordinator connection even if opening the next attempt throws synchronously', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const session = createSessionContext();
  const connect = vi.fn().mockImplementationOnce(() => { throw new Error('peer temporarily unavailable'); }).mockReturnValue(null);
  const schedule = createCoordinatorReconnect(session, { roomManager: { isInRoom: true, isMaster: false }, getConnection: () => null, connect });
  schedule();
  try {
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    vi.advanceTimersByTime(1500);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally { await session.disposeAsync(); }
});
