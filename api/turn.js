const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://seemygame.vercel.app',
  'https://seemygame.com',
  'https://www.seemygame.com',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://tauri.localhost'
]);
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_RATE_BUCKETS = 10_000;

function getHeader(req, name) {
  return req?.headers?.[name] || req?.headers?.[name.toLowerCase()] || '';
}

function getAllowedOrigins() {
  const configured = process.env.TURN_ALLOWED_ORIGINS || '';
  const values = configured.split(',').map((value) => value.trim()).filter(Boolean);
  return new Set(values.length > 0 ? values : DEFAULT_ALLOWED_ORIGINS);
}

function isRateLimited(req) {
  const forwardedFor = getHeader(req, 'x-forwarded-for').split(',')[0].trim();
  const key = forwardedFor || getHeader(req, 'x-real-ip') || 'anonymous';
  const now = Date.now();
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(bucketKey);
    }
    while (rateBuckets.size > MAX_RATE_BUCKETS) {
      const oldestKey = rateBuckets.keys().next().value;
      if (oldestKey === undefined) break;
      rateBuckets.delete(oldestKey);
    }
  }
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > MAX_REQUESTS_PER_WINDOW;
}

function getBearerToken(req) {
  const header = getHeader(req, 'authorization').trim();
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  return match ? match[1] : '';
}

function hasValidAccessToken(req) {
  const expected = process.env.TURN_ACCESS_TOKEN || '';
  const provided = getBearerToken(req);
  return expected.length > 0 && provided.length > 0 && provided === expected;
}

/**
 * Endpoint Serverless para geração de credenciais TURN/STUN seguras
 * Compatível com Vercel Serverless Functions e ambientes Node.js
 */

export default async function handler(req, res) {
  const origin = getHeader(req, 'origin');
  const allowedOrigins = getAllowedOrigins();
  const production = process.env.NODE_ENV === 'production';
  if ((origin && !allowedOrigins.has(origin)) || (!origin && production)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // Keep CORS scoped to the configured frontend. Missing Origin is allowed only
  // outside production so local CLI/serverless tests remain usable.
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Origin is only a browser boundary. A non-browser client can send the
  // same header, so production credential delivery also requires a short
  // lived deployment token supplied through Authorization: Bearer.
  if (production && !hasValidAccessToken(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'TURN authentication required' });
  }

  if (isRateLimited(req)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const meteredDomain = process.env.METERED_DOMAIN;
  const meteredApiKey = process.env.METERED_API_KEY;

  // 1. Se credenciais privadas do provedor (Metered Video) estiverem configuradas nas variáveis de ambiente:
  if (meteredDomain && meteredApiKey) {
    let timeoutId = null;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 3500);
      const response = await fetch(
        `https://${meteredDomain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredApiKey)}`,
        { signal: controller.signal }
      );
      if (response.ok) {
        const iceServers = await response.json();
        if (Array.isArray(iceServers) && iceServers.length > 0) {
          res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
          return res.status(200).json({ iceServers, source: 'metered-private' });
        }
      }
    } catch (err) {
      console.error('Erro ao consultar API TURN privada:', err);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // 1.1 Se servidores TURN estáticos forem fornecidos diretamente em JSON:
  if (process.env.TURN_SERVERS_JSON) {
    try {
      const customServers = JSON.parse(process.env.TURN_SERVERS_JSON);
      if (Array.isArray(customServers) && customServers.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
        return res.status(200).json({ iceServers: customServers, source: 'custom-static-credentials' });
      }
    } catch (_) {}
  }

  // 1.2 Se credenciais estáticas do TURN (ex: Metered Brasil / Coturn) estiverem configuradas:
  const turnUsername = process.env.TURN_USERNAME;
  const turnPassword = process.env.TURN_PASSWORD || process.env.TURN_CREDENTIAL;
  const turnHost = process.env.TURN_HOST || process.env.TURN_DOMAIN || 'br.relay.metered.ca';

  if (turnUsername && turnPassword) {
    const iceServers = [
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: `turn:${turnHost}:80`, username: turnUsername, credential: turnPassword },
      { urls: `turn:${turnHost}:80?transport=tcp`, username: turnUsername, credential: turnPassword },
      { urls: `turn:${turnHost}:443`, username: turnUsername, credential: turnPassword },
      { urls: `turns:${turnHost}:443?transport=tcp`, username: turnUsername, credential: turnPassword }
    ];
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json({ iceServers, source: 'metered-static-credentials' });
  }

  // 2. Fallback de alta disponibilidade com STUNs públicos e TURN OpenRelay (50 GB/mês para testes e desenvolvimento)
  if (production) {
    // Never expose the public OpenRelay credentials as a production fallback.
    // A missing/expired deployment configuration should degrade to STUN in
    // the client instead of turning a billable relay into an open endpoint.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'TURN service unavailable' });
  }

  const defaultIceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:openrelay.metered.ca:80' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  return res.status(200).json({ iceServers: defaultIceServers, source: 'metered-openrelay-fallback' });
}
