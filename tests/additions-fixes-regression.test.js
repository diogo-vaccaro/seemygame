import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { resetMemoryRooms } from '../api/rooms.js';
import { createQualityController } from '../js/streaming/adaptation.js';

async function request(method, url = '/api/rooms', body = {}) {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; }, end() {} };
  await handler({ method, url, body, headers: {} }, res);
  return res;
}
beforeEach(() => {
  resetMemoryRooms();
  for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) vi.stubEnv(name, '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetMemoryRooms(); });

describe('Directory ownership regressions', () => {
  it.each([undefined, '', 'wrong'])('rejects overwrite with key %s and preserves the record', async secretKey => {
    await request('POST', '/api/rooms', { id: 'protected', title: 'Original', secretKey: 'owner' });
    const changed = await request('POST', '/api/rooms', { id: 'protected', title: 'Tampered', secretKey });
    expect(changed.statusCode).toBe(403);
    expect((await request('GET')).body.rooms[0].title).toBe('Original');
    expect((await request('POST', '/api/rooms', { id: 'protected', title: 'Updated', secretKey: 'owner' })).statusCode).toBe(200);
  });
  it.each(['', '&secret=', '&secret=wrong'])('rejects deletion without the correct key (%s)', async suffix => {
    await request('POST', '/api/rooms', { id: 'protected', secretKey: 'owner' });
    expect((await request('DELETE', '/api/rooms?id=protected' + suffix)).body.deleted).toBe(false);
    expect((await request('GET')).body.count).toBe(1);
    expect((await request('DELETE', '/api/rooms?id=protected&secret=owner')).body.deleted).toBe(true);
  });
  it('enforces ownership for beacon deletion and accepts the owner', async () => {
    await request('POST', '/api/rooms', { id: 'protected', secretKey: 'owner' });
    expect((await request('POST', '/api/rooms?action=delete', { id: 'protected' })).body.deleted).toBe(false);
    expect((await request('POST', '/api/rooms?action=delete', { id: 'protected', secretKey: 'owner' })).body.deleted).toBe(true);
  });
});

function configureRedis(respond) {
  vi.stubEnv('KV_REST_API_URL', 'https://redis.test');
  vi.stubEnv('KV_REST_API_TOKEN', 'test');
  const fetchMock = vi.fn(async (_url, init) => respond(JSON.parse(init.body)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const reply = result => ({ ok: true, json: async () => ({ result }) });
describe('Configured Redis failures and atomic writes', () => {
  it.each(['http', 'network', 'redis-error', 'invalid-result'])('returns 503 when publication fails: %s', async failure => {
    configureRedis(command => {
      if (command[0] !== 'EVAL') return reply(command[0] === 'ZRANGE' ? [] : 0);
      if (failure === 'http') return { ok: false, status: 503 };
      if (failure === 'network') throw new Error('Disconnected');
      if (failure === 'redis-error') return { ok: true, json: async () => ({ error: 'ERR unavailable' }) };
      return reply(null);
    });
    expect((await request('POST', '/api/rooms', { id: 'new-room', secretKey: 'owner' })).statusCode).toBe(503);
    vi.stubEnv('KV_REST_API_URL', ''); vi.stubEnv('KV_REST_API_TOKEN', '');
    expect((await request('GET')).body.count).toBe(0);
  });
  it.each(['GET', 'DELETE'])('does not hide Redis failure during %s', async method => {
    configureRedis(() => ({ ok: false, status: 503 }));
    expect((await request(method, '/api/rooms?id=protected&secret=owner')).statusCode).toBe(503);
  });
  it('honors an atomic ownership refusal after a stale initial lookup', async () => {
    const fetchMock = configureRedis(command => reply(command[0] === 'ZRANGE' ? [] : 0));
    expect((await request('POST', '/api/rooms', { id: 'protected', secretKey: 'other-owner' })).statusCode).toBe(403);
    const command = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(command[0]).toBe('EVAL');
    expect(command[1]).toContain("secret ~= ARGV[5]");
    expect(command.slice(2, 5)).toEqual([3, 'smg:room:protected', 'smg:rooms:active']);
  });
  it('confirms successful atomic save and delete without separate writes', async () => {
    const fetchMock = configureRedis(command => reply(command[0] === 'ZRANGE' ? [] : command[0] === 'EVAL' ? 1 : 0));
    expect((await request('POST', '/api/rooms', { id: 'protected', secretKey: 'owner' })).body.ok).toBe(true);
    expect((await request('DELETE', '/api/rooms?id=protected&secret=owner')).body.deleted).toBe(true);
    const commands = fetchMock.mock.calls.map(call => JSON.parse(call[1].body));
    expect(commands.filter(command => command[0] === 'EVAL')).toHaveLength(2);
    expect(commands.some(command => ['SET', 'DEL', 'ZADD', 'ZREM'].includes(command[0]))).toBe(false);
  });
});

it('applies Mesh Guard to the sender and restores bitrate when the receiver becomes LAN', async () => {
  let params = { encodings: [{ maxBitrate: 8000000 }] };
  const sender = { track: { kind: 'video' }, getParameters: () => structuredClone(params), setParameters: vi.fn(async next => { params = structuredClone(next); }) };
  const quality = createQualityController({ getSenders: () => [sender] }, () => ({ bitrateKbps: 8000, fps: 60 }), () => ({ viewerCount: 3, lanViewerCount: 1 }));
  try {
    quality.process({ timestamp: 1000, isLan: false, packetLossRate: 0, rtt: 40 });
    await vi.waitFor(() => expect(params.encodings[0].maxBitrate).toBe(6000000));
    quality.process({ timestamp: 1001, isLan: true, packetLossRate: 0, rtt: 2 });
    await vi.waitFor(() => expect(params.encodings[0].maxBitrate).toBe(8000000));
  } finally { await quality.dispose(); }
});
