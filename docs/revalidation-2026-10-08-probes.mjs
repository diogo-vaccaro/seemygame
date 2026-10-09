import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import handler, { resetMemoryRooms } from '../api/rooms.js';
import { createQualityController } from '../js/streaming/adaptation.js';

const evidence = { findings: [], errors: [] };
async function request(method, url = '/api/rooms', body = {}) {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() {} };
  await handler({ method, url, body, headers: {} }, res);
  return { status: res.statusCode, body: res.body };
}
const previous = { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, upUrl: process.env.UPSTASH_REDIS_REST_URL, upToken: process.env.UPSTASH_REDIS_REST_TOKEN, fetch: globalThis.fetch };
try {
  for (const key of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[key];
  resetMemoryRooms();
  await request('POST', '/api/rooms', { id: 'audit-protected', title: 'Original', secretKey: 'owner-key' });
  assert.equal((await request('POST', '/api/rooms', { id: 'audit-protected', title: 'Wrong key', secretKey: 'wrong-key' })).status, 403);
  const overwrite = await request('POST', '/api/rooms', { id: 'audit-protected', title: 'Unauthorized overwrite' });
  assert.equal(overwrite.status, 200);
  assert.equal((await request('GET')).body.rooms[0].title, 'Unauthorized overwrite');
  const deletion = await request('DELETE', '/api/rooms?id=audit-protected');
  assert.equal(deletion.body.deleted, true);
  evidence.findings.push({ id: 'N01', overwrite, deletion, remaining: (await request('GET')).body.count });

  resetMemoryRooms();
  process.env.KV_REST_API_URL = 'https://audit.invalid';
  process.env.KV_REST_API_TOKEN = 'fake-audit-token';
  const commands = [];
  globalThis.fetch = async (_url, init) => { commands.push(JSON.parse(init.body)[0]); return { ok: false, status: 503 }; };
  const publish = await request('POST', '/api/rooms', { id: 'audit-kv-down', secretKey: 'key' });
  assert.equal(publish.body.ok, true);
  const listed = await request('GET');
  assert.equal(listed.body.count, 0);
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  assert.equal((await request('GET')).body.count, 0, 'No actual memory fallback occurred');
  evidence.findings.push({ id: 'N02', publish, listed, commands, memoryFallbackCount: 0 });

  let params = { encodings: [{ maxBitrate: 8000000 }] }, writes = 0;
  const sender = { track: { kind: 'video' }, getParameters: () => structuredClone(params), setParameters: async next => { params = structuredClone(next); writes++; } };
  const quality = createQualityController({ getSenders: () => [sender] }, () => ({ bitrateKbps: 8000, fps: 60 }), () => ({ viewerCount: 3, lanViewerCount: 1 }));
  quality.process({ timestamp: 1000, isLan: false, packetLossRate: 0, rttMs: 40, encodeTimeMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const mesh = { controllerBitrate: quality.controller.currentBitrateBps, senderBitrate: params.encodings[0].maxBitrate, writes };
  assert.equal(mesh.controllerBitrate, 6000000);
  assert.equal(mesh.senderBitrate, 8000000);
  assert.equal(mesh.writes, 0);
  await quality.dispose();
  evidence.findings.push({ id: 'N03', ...mesh });
  evidence.status = 'three-defects-reproduced';
} catch (error) { evidence.status = 'failed'; evidence.errors.push(error.stack); process.exitCode = 1; }
finally {
  globalThis.fetch = previous.fetch;
  for (const [key, value] of [['KV_REST_API_URL', previous.url], ['KV_REST_API_TOKEN', previous.token], ['UPSTASH_REDIS_REST_URL', previous.upUrl], ['UPSTASH_REDIS_REST_TOKEN', previous.upToken]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetMemoryRooms();
  await writeFile(new URL('../output/revalidation-2026-10-08-probes.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
