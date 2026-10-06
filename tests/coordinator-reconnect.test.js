import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionContext } from '../js/core/session-context.js';
import { createCoordinatorReconnect } from '../js/session/coordinator-reconnect.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers();
  const session = createSessionContext(); cleanups.push(() => session.disposeAsync());
  const room = { isInRoom: true, isMaster: false }, connections = [];
  let current;
  const connected = vi.fn();
  const connect = vi.fn(() => {
    const events = new Map();
    const conn = { open: false, on: (event, handler) => events.set(event, handler),
      emit: event => events.get(event)?.(), close: vi.fn(() => { conn.open = false; conn.emit('close'); schedule(); }) };
    current = conn; connections.push(conn); return conn;
  });
  const schedule = createCoordinatorReconnect(session, { roomManager: room, getConnection: () => current, connect, onConnected: connected });
  return { session, room, connections, connect, connected, schedule };
}
describe('coordinator reconnection with unanswered offers', () => {
  it('retries a silent pending connection and stops after the replacement opens', () => {
    const { schedule, connect, connections, connected } = fixture();
    schedule(); schedule(); vi.advanceTimersByTime(1000);
    expect(connect).toHaveBeenCalledTimes(1);
    schedule(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5000); expect(connections[0].close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1500); expect(connect).toHaveBeenCalledTimes(2);
    connections[1].open = true; connections[1].emit('open');
    expect(connected).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100000); expect(connect).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('deduplicates error/close callbacks and late events from an obsolete attempt', () => {
    const { schedule, connect, connections, connected } = fixture(); schedule(); vi.advanceTimersByTime(1000);
    connections[0].emit('error'); connections[0].emit('close'); schedule();
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(1500);
    connections[0].emit('open'); connections[0].emit('error');
    expect(connected).not.toHaveBeenCalled(); expect(connect).toHaveBeenCalledTimes(2);
    connections[1].open = true; connections[1].emit('open'); expect(vi.getTimerCount()).toBe(0);
  });
  it('limits unanswered connections to fifteen attempts', () => {
    const { schedule, connect, connections } = fixture(); schedule(); vi.advanceTimersByTime(200000);
    expect(connect).toHaveBeenCalledTimes(15);
    for (const conn of connections) expect(conn.close).toHaveBeenCalledTimes(1);
    schedule(); vi.advanceTimersByTime(100000); expect(connect).toHaveBeenCalledTimes(15); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['queued', 'pending'])('cleans up a %s attempt on disposal', async phase => {
    const { session, schedule, connect, connections } = fixture(); schedule();
    if (phase === 'pending') vi.advanceTimersByTime(1000);
    await session.disposeAsync(); vi.advanceTimersByTime(100000);
    expect(connect).toHaveBeenCalledTimes(phase === 'pending' ? 1 : 0);
    if (phase === 'pending') expect(connections[0].close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['leave', 'master'])('does not connect after becoming %s', reason => {
    const { room, schedule, connect } = fixture(); schedule();
    if (reason === 'leave') room.isInRoom = false; else room.isMaster = true;
    vi.advanceTimersByTime(100000); expect(connect).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
