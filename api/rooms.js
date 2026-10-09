/**
 * SeeMyGame - Endpoint Serverless para Diretório e Descoberta de Salas
 * Compatível com Vercel Serverless Functions (Edge/Node.js) e Node.js local.
 *
 * Suporta:
 * - GET /api/rooms: Listar salas ativas (filtros: game, type, player2, search)
 * - POST /api/rooms: Registrar sala / heartbeat periódico (cadência 60s, TTL 90s)
 * - DELETE /api/rooms: Despublicar sala imediatamente
 *
 * Extração de geolocalização via headers Vercel Edge:
 * - x-vercel-ip-country (ex: BR, US, PT)
 * - x-vercel-ip-country-region (ex: SP, RJ, CA)
 * - x-vercel-ip-city (ex: Sao Paulo)
 *
 * Armazenamento:
 * - Vercel KV / Upstash Redis REST (quando configurado)
 * - Fallback em memória com expiração por TTL para dev local e testes
 */

const ROOM_TTL_SECONDS = 90; // 90s TTL (permite tolerância para heartbeat de 60s)
const MAX_STORED_ROOMS = 500;

// Armazenamento em memória para dev local e testes
const memoryRooms = new Map();

/**
 * Limpa o armazenamento em memória (útil em testes unitários).
 */
export function resetMemoryRooms() {
  memoryRooms.clear();
}

/**
 * Converte código de país ISO 3166-1 alpha-2 em emoji de bandeira.
 * Ex: 'BR' -> '🇧🇷', 'US' -> '🇺🇸', 'PT' -> '🇵🇹'
 */
export function countryCodeToEmoji(code) {
  if (!code || typeof code !== 'string' || code.trim().length !== 2) return '🌐';
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(clean)) return '🌐';
  const chars = [...clean].map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...chars);
}

function getHeader(req, name) {
  return req?.headers?.[name] || req?.headers?.[name.toLowerCase()] || '';
}

function decodeHeader(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function parseGeolocation(req, clientPayload = {}) {
  const headerCountry = getHeader(req, 'x-vercel-ip-country');
  const headerRegion = getHeader(req, 'x-vercel-ip-country-region');
  const headerCity = decodeHeader(getHeader(req, 'x-vercel-ip-city'));

  const country = (headerCountry || clientPayload.country || 'BR').toUpperCase().slice(0, 2);
  const region = (headerRegion || clientPayload.region || '').slice(0, 10);
  const city = (headerCity || clientPayload.city || 'Local').slice(0, 50);
  const flag = countryCodeToEmoji(country);

  let locationText = '';
  if (city && region) {
    locationText = `${city}, ${region}`;
  } else if (city) {
    locationText = city;
  } else if (country) {
    locationText = country;
  } else {
    locationText = 'Global';
  }

  return {
    country,
    region,
    city,
    flag,
    locationText
  };
}

// Helpers para comunicação com Vercel KV / Upstash Redis REST
function getKvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return { url: url.replace(/\/$/, ''), token };
  }
  return null;
}

async function kvCommand(command) {
  const config = getKvConfig();
  if (!config) return null;
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command)
    });
    if (!res.ok) throw new DirectoryStorageError();
    const json = await res.json();
    if (json.error || !Object.hasOwn(json, 'result')) throw new DirectoryStorageError();
    return json.result;
  } catch (err) {
    throw new DirectoryStorageError();
  }
}

class DirectoryStorageError extends Error {}

// Check ownership and mutate both Redis keys in a single operation.
const SAVE_ROOM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then
  local existing = cjson.decode(raw)
  local secret = existing.secretKey
  if type(secret) == 'string' and secret ~= '' and secret ~= ARGV[5] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
return 1
`;
const DELETE_ROOM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local existing = cjson.decode(raw)
local secret = existing.secretKey
if type(secret) == 'string' and secret ~= '' and secret ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

// Configured Redis failures are explicit; memory is only used without Redis.
async function saveRoomToStorage(room) {
  const kv = getKvConfig();
  const expiresAt = Date.now() + ROOM_TTL_SECONDS * 1000;
  const roomToStore = { ...room, expiresAt };

  if (kv) {
    const result = await kvCommand(['EVAL', SAVE_ROOM_SCRIPT, 2, `smg:room:${room.id}`, 'smg:rooms:active',
      JSON.stringify(roomToStore), room.id, expiresAt, ROOM_TTL_SECONDS, room.secretKey || '']);
    if (result !== 0 && result !== 1) throw new DirectoryStorageError();
    return result === 1;
  }

  // Fallback in-memory
  if (memoryRooms.size > MAX_STORED_ROOMS) {
    const now = Date.now();
    for (const [key, item] of memoryRooms) {
      if (item.expiresAt <= now) memoryRooms.delete(key);
    }
  }
  const existing = memoryRooms.get(room.id);
  if (existing?.expiresAt > Date.now() && existing.secretKey && existing.secretKey !== room.secretKey) return false;
  memoryRooms.set(room.id, roomToStore);
  return true;
}

async function getRoomsFromStorage() {
  const now = Date.now();
  const kv = getKvConfig();

  if (kv) {
    await kvCommand(['ZREMRANGEBYSCORE', 'smg:rooms:active', '-inf', now]);
    const roomIds = await kvCommand(['ZRANGE', 'smg:rooms:active', 0, -1]);
    if (!Array.isArray(roomIds)) throw new DirectoryStorageError();
    if (roomIds.length === 0) return [];
    const rawRooms = await kvCommand(['MGET', ...roomIds.map(id => `smg:room:${id}`)]);
    if (!Array.isArray(rawRooms)) throw new DirectoryStorageError();
    return rawRooms.filter(Boolean).map(raw => {
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch (_) { return null; }
    }).filter(room => room && room.expiresAt > now);
  }

  // Fallback in-memory
  const activeRooms = [];
  for (const [id, item] of memoryRooms) {
    if (item.expiresAt > now) {
      activeRooms.push(item);
    } else {
      memoryRooms.delete(id);
    }
  }
  return activeRooms;
}

async function deleteRoomFromStorage(roomId, secretKey = null) {
  const kv = getKvConfig();

  if (kv) {
    const result = await kvCommand(['EVAL', DELETE_ROOM_SCRIPT, 2, `smg:room:${roomId}`, 'smg:rooms:active', roomId, secretKey || '']);
    if (result !== 0 && result !== 1) throw new DirectoryStorageError();
    return result === 1;
  }

  // Fallback in-memory
  const existing = memoryRooms.get(roomId);
  if (existing) {
    if (existing.secretKey && existing.secretKey !== secretKey) {
      return false;
    }
    memoryRooms.delete(roomId);
    return true;
  }
  return false;
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve) => {
    let body = '';
    req.on?.('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        req.destroy();
        resolve({});
      }
    });
    req.on?.('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_) {
        resolve({});
      }
    });
    if (!req.on) {
      resolve({});
    }
  });
}

function ensureResponseHelpers(res) {
  if (!res.status) {
    res.status = function status(code) {
      this.statusCode = code;
      return this;
    };
  }
  if (!res.json) {
    res.json = function json(data) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
      this.end(JSON.stringify(data));
      return this;
    };
  }
}

/**
 * Handler Serverless principal para /api/rooms.
 */
async function handleRequest(req, res) {
  ensureResponseHelpers(res);

  // Headers de CORS e Cache
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = new URL(req.url, 'http://localhost');
  const actionParam = url.searchParams.get('action');

  // DELETE ou POST com action=delete (suporte nativo a navigator.sendBeacon)
  if (req.method === 'DELETE' || (req.method === 'POST' && actionParam === 'delete')) {
    let roomId = url.searchParams.get('id');
    let secretKey = url.searchParams.get('secret');

    if (!roomId) {
      const body = await parseJsonBody(req);
      roomId = body.id || body.roomId;
      secretKey = body.secretKey || body.secret || secretKey;
    }

    if (!roomId) {
      return res.status(400).json({ error: 'ID da sala obrigatório para remoção.' });
    }

    const deleted = await deleteRoomFromStorage(roomId, secretKey);
    return res.status(200).json({ ok: true, deleted });
  }

  // GET: Listagem com filtros
  if (req.method === 'GET') {
    const rawRooms = await getRoomsFromStorage();

    const gameFilter = (url.searchParams.get('game') || '').trim().toLowerCase();
    const typeFilter = (url.searchParams.get('type') || 'all').trim().toLowerCase();
    const player2Filter = url.searchParams.get('player2') === '1' || url.searchParams.get('player2') === 'true';
    const searchFilter = (url.searchParams.get('search') || '').trim().toLowerCase();

    const filtered = rawRooms.filter((r) => {
      if (gameFilter && (!r.game || !r.game.toLowerCase().includes(gameFilter))) {
        return false;
      }
      if (typeFilter === 'public' && r.isPrivate) {
        return false;
      }
      if (typeFilter === 'private' && !r.isPrivate) {
        return false;
      }
      if (player2Filter && !r.hasPlayer2Slot) {
        return false;
      }
      if (searchFilter) {
        const matchesId = r.id.toLowerCase().includes(searchFilter);
        const matchesTitle = r.title && r.title.toLowerCase().includes(searchFilter);
        const matchesGame = r.game && r.game.toLowerCase().includes(searchFilter);
        if (!matchesId && !matchesTitle && !matchesGame) return false;
      }
      return true;
    });

    // Sanitiza output: NUNCA expor segredos, senhas ou secretKeys
    const sanitized = filtered.map((r) => ({
      id: r.id,
      title: r.title || r.id,
      game: r.game || 'Geral',
      isPrivate: Boolean(r.isPrivate),
      hasPlayer2Slot: Boolean(r.hasPlayer2Slot),
      memberCount: Number(r.memberCount) || 1,
      maxMembers: Number(r.maxMembers) || 8,
      country: r.country,
      region: r.region,
      city: r.city,
      flag: r.flag,
      locationText: r.locationText,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt
    }));

    // Ordena: mais membros primeiro, depois mais recentes
    sanitized.sort((a, b) => (b.memberCount - a.memberCount) || (b.updatedAt - a.updatedAt));

    return res.status(200).json({
      rooms: sanitized,
      count: sanitized.length,
      ttl: ROOM_TTL_SECONDS
    });
  }

  // POST: Registrar sala / Heartbeat (a cada 60s pelo host)
  if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    const id = String(body.id || body.roomId || '').trim().toLowerCase();

    // Valida formato de ID da sala
    if (!id || !/^[a-z0-9_-]{1,40}$/.test(id)) {
      return res.status(400).json({ error: 'ID de sala inválido. Use de 1 a 40 caracteres alfanuméricos.' });
    }

    const geo = parseGeolocation(req, body);
    const now = Date.now();

    // Verifica se a sala já existe para verificar secretKey se configurada
    const existingList = await getRoomsFromStorage();
    const existing = existingList.find((r) => r.id === id);

    if (existing && existing.secretKey && existing.secretKey !== body.secretKey) {
      return res.status(403).json({ error: 'Chave de controle da sala não autorizada.' });
    }

    const roomRecord = {
      id,
      title: String(body.title || id).slice(0, 60),
      game: String(body.game || 'Geral').slice(0, 40),
      isPrivate: Boolean(body.isPrivate), // Apenas flag booleana; NUNCA aceita nem armazena PIN!
      hasPlayer2Slot: Boolean(body.hasPlayer2Slot),
      memberCount: Math.max(1, Math.min(32, Number(body.memberCount) || 1)),
      maxMembers: Math.max(2, Math.min(32, Number(body.maxMembers) || 8)),
      secretKey: body.secretKey || existing?.secretKey || null,
      ...geo,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    if (!await saveRoomToStorage(roomRecord)) {
      return res.status(403).json({ error: 'Chave de controle da sala não autorizada.' });
    }

    return res.status(200).json({
      ok: true,
      room: {
        id: roomRecord.id,
        title: roomRecord.title,
        game: roomRecord.game,
        isPrivate: roomRecord.isPrivate,
        hasPlayer2Slot: roomRecord.hasPlayer2Slot,
        memberCount: roomRecord.memberCount,
        maxMembers: roomRecord.maxMembers,
        flag: roomRecord.flag,
        locationText: roomRecord.locationText,
        updatedAt: roomRecord.updatedAt
      },
      heartbeatIntervalSeconds: 60,
      ttlSeconds: ROOM_TTL_SECONDS
    });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (error) {
    if (!(error instanceof DirectoryStorageError)) throw error;
    return res.status(503).json({ error: 'Diretório temporariamente indisponível. Tente novamente.' });
  }
}
