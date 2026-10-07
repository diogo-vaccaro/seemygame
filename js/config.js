// ==========================================
// CONFIGURAÇÕES GERAIS, ICE (STUN/TURN) & PRESETS
// ==========================================

export const TERMS_VERSION = '1.1';
export const MAX_VIEWERS_DEFAULT = 4;
export const PUBLIC_WEB_ORIGIN = 'https://seemygame.vercel.app';

/**
 * Returns the canonical origin that another person can actually open. Tauri
 * serves the UI from a localhost/asset origin, which must never leak into an
 * invitation. A deployment can override the public origin explicitly without
 * changing the bundle.
 */
export function getPublicOrigin() {
  const configured = typeof window !== 'undefined' && typeof localStorage !== 'undefined'
    ? localStorage.getItem('seemygame_public_origin')
    : null;
  const candidate = configured || (typeof window !== 'undefined' ? window.__SEEMYGAME_PUBLIC_ORIGIN__ : null);
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.search && !url.hash) {
        return url.origin;
      }
    } catch (e) {}
  }

  return PUBLIC_WEB_ORIGIN;
}

export const ROOM_MODES = {
  PUBLIC: 'public',
  PRIVATE: 'private'
};

export const LATENCY_MODES = {
  ULTRA_LOW: 'ultra-low',
  STABLE: 'stable'
};

// Servidores STUN públicos confiáveis e fallback para relay TURN (OpenRelay)
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // OpenRelay TURN para travessia de NATs restritivos / Firewalls corporativos
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
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

const PUBLIC_STUN_ICE_SERVERS = DEFAULT_ICE_SERVERS.filter((server) =>
  (Array.isArray(server.urls) ? server.urls : [server.urls])
    .every((url) => /^stun:/i.test(url))
);

function isProductionWebOrigin() {
  if (typeof window === 'undefined' || !window.location) return false;
  const { protocol, hostname } = window.location;
  return protocol === 'https:' && !/^(localhost|127\.0\.0\.1|::1)$/i.test(hostname || '');
}

function getStaticFallbackIceServers() {
  if (isProductionWebOrigin()) {
    return PUBLIC_STUN_ICE_SERVERS;
  }
  return DEFAULT_ICE_SERVERS;
}

function getRuntimeTurnAccessToken() {
  if (typeof window === 'undefined') return '';
  const configured = window.__SEEMYGAME_TURN_ACCESS_TOKEN__;
  if (typeof configured === 'string' && configured.length <= 512) return configured;
  try {
    const stored = localStorage.getItem('seemygame_turn_access_token');
    if (typeof stored === 'string' && stored.length <= 512) return stored;
  } catch (_) {}
  try {
    const sessionStored = sessionStorage.getItem('seemygame_turn_access_token');
    if (typeof sessionStored === 'string' && sessionStored.length <= 512) return sessionStored;
  } catch (_) {}
  try {
    if (window.location) {
      const searchParams = new URLSearchParams(window.location.search || '');
      const hash = (window.location.hash || '').replace(/^#/, '');
      const hashParams = new URLSearchParams(hash);
      const urlToken = searchParams.get('turn_token') || searchParams.get('turnToken') ||
                       hashParams.get('turn_token') || hashParams.get('turnToken');
      if (urlToken && urlToken.length <= 512) {
        try { localStorage.setItem('seemygame_turn_access_token', urlToken); } catch (_) {}
        return urlToken;
      }
    }
  } catch (_) {}
  return '';
}

function getTurnEndpoint() {
  if (typeof window !== 'undefined' && window.location) {
    const { hostname } = window.location;
    // The Tauri WebView is served from tauri.localhost. Its relative /api
    // route is not a Vercel function, so point it at the public deployment.
    if (/^tauri\.localhost$/i.test(hostname || '')) {
      return `${getPublicOrigin()}/api/turn`;
    }
  }
  return '/api/turn';
}

// Configurações de STUN/ICE para PeerJS
export const PEER_CONFIG = {
  config: {
    iceServers: DEFAULT_ICE_SERVERS,
    sdpSemantics: 'unified-plan',
    iceCandidatePoolSize: 10
  }
};

let dynamicIceServers = null;
let dynamicIceServersExpiresAt = 0;
let dynamicIceFetchPromise = null;
const DYNAMIC_ICE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos de TTL

function isValidIceUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  return /^(stun|turn|turns):[^\s]+$/i.test(url.trim());
}

function normalizeIceServers(value) {
  if (!Array.isArray(value)) return [];

  return value.reduce((servers, item) => {
    if (!item || typeof item !== 'object') return servers;
    const urls = Array.isArray(item.urls)
      ? item.urls.filter(isValidIceUrl).map((url) => url.trim())
      : (isValidIceUrl(item.urls) ? item.urls.trim() : null);
    if (!urls || (Array.isArray(urls) && urls.length === 0)) return servers;

    const server = { urls };
    if (typeof item.username === 'string' && item.username.length <= 512) {
      server.username = item.username;
    }
    if (typeof item.credential === 'string' && item.credential.length <= 2048) {
      server.credential = item.credential;
    }
    servers.push(server);
    return servers;
  }, []);
}

/**
 * Consulta a rota serverless /api/turn para obter servidores ICE dinâmicos (STUN/TURN) com timeout e cache TTL
 * @param {number} [timeoutMs=3500]
 * @returns {Promise<Array>}
 */
export async function fetchIceServersFromApi(timeoutMs = 3500) {
  const now = Date.now();
  if (dynamicIceServers && now < dynamicIceServersExpiresAt) {
    return dynamicIceServers;
  }

  // Only one request may establish the cache. Peer initialization can be
  // triggered by both the terms dialog and DOMContentLoaded at the same time.
  if (dynamicIceFetchPromise) return dynamicIceFetchPromise;

  dynamicIceFetchPromise = (async () => {
    const requestStartedAt = Date.now();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const fetchOptions = controller ? { signal: controller.signal } : {};
      const accessToken = getRuntimeTurnAccessToken();
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const res = await fetch(getTurnEndpoint(), { ...fetchOptions, headers });

      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeIceServers(data?.iceServers);
        if (normalized.length > 0) {
          dynamicIceServers = normalized;
          dynamicIceServersExpiresAt = requestStartedAt + DYNAMIC_ICE_CACHE_TTL_MS;
          console.log('[ICE/TURN] Servidores STUN/TURN dinâmicos carregados:', dynamicIceServers.length);
          return dynamicIceServers;
        }
      }
    } catch (err) {
      console.info('[ICE/TURN] /api/turn não acessível ou timeout (modo estático), usando servidores ICE padrão.');
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    // Cache the fallback too, otherwise every reconnection would start a new
    // TURN request even though the static configuration is already valid.
    dynamicIceServers = getStaticFallbackIceServers();
    dynamicIceServersExpiresAt = requestStartedAt + DYNAMIC_ICE_CACHE_TTL_MS;
    return dynamicIceServers;
  })();

  try {
    return await dynamicIceFetchPromise;
  } finally {
    dynamicIceFetchPromise = null;
  }
}

export function _resetDynamicIceCache() {
  dynamicIceServers = null;
  dynamicIceServersExpiresAt = 0;
}

export function getPendingIceServersPromise() {
  return dynamicIceFetchPromise;
}

/**
 * Retorna a configuração do Peer com servidores ICE customizados, da API ou padrão
 * @returns {Object}
 */
export function getPeerConfig(customServers = null) {
  const signaling = typeof window !== 'undefined' ? window.__SEEMYGAME_PEER_CONFIG__ : null;
  if (signaling) return { ...signaling, config: { ...PEER_CONFIG.config, ...signaling.config } };
  const servers = customServers || dynamicIceServers || getStaticFallbackIceServers();
  return {
    config: {
      ...PEER_CONFIG.config,
      iceServers: servers
    }
  };
}

// Perfis de Qualidade focados em Máxima Fluidez
export const QUALITY_PROFILES = {
  hd120: { id: 'hd120', label: '720p / 120 FPS (experimental)', width: 1280, height: 720, fps: 120, bitrate: 9000000, experimental: true },
  fhd120: { id: 'fhd120', label: '1080p / 120 FPS (experimental)', width: 1920, height: 1080, fps: 120, bitrate: 15000000, experimental: true },
  ultra: {
    id: 'ultra',
    label: 'Modo Competitivo (720p - Fluidez Máxima)',
    width: 1280,
    height: 720,
    fps: 60,
    bitrate: 4500000
  },
  balanced: {
    id: 'balanced',
    label: 'Modo Dinâmico (1080p - Equilibrado & Fluido)',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 7500000
  },
  high: {
    id: 'high',
    label: 'Alta Fidelidade (1080p - Alta Nitidez)',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 12000000
  }
};

export const DEFAULT_PROFILE = QUALITY_PROFILES.balanced;
export const DEFAULT_BITRATE_BPS = DEFAULT_PROFILE.bitrate;

