/**
 * SeeMyGame - Room Links & Navigation
 * Utilitários canônicos para parsing, geração de chaves criptográficas e
 * construção de links de sala preservando subdiretórios, chaves e parâmetros.
 */

import { parseRoomIdentifier } from '../room-codes.js';
import { sanitizeRoomId } from '../room/room-id.js';

/**
 * Obtém o caminho base normalizado do aplicativo (suporta subdiretórios e hospedagem estática).
 * @returns {string}
 */
export function getSanitizedPath() {
  if (typeof window === 'undefined' || !window.location) return '/';
  let basePath = window.location.pathname || '/';
  if (basePath.endsWith('.html')) {
    basePath = basePath.substring(0, basePath.lastIndexOf('/') + 1);
  } else if (!basePath.endsWith('/')) {
    basePath += '/';
  }
  return basePath;
}

/**
 * Gera uma chave criptográfica segura para a sala (16 a 32 caracteres hex/uuid).
 * @returns {string}
 */
export function createRoomKey() {
  try {
    const cryptoObj = typeof window !== 'undefined' ? window.crypto : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (cryptoObj?.randomUUID) {
      return cryptoObj.randomUUID().replace(/-/g, '');
    }
    if (cryptoObj?.getRandomValues) {
      const bytes = new Uint8Array(24);
      cryptoObj.getRandomValues(bytes);
      if (bytes.some((value) => value !== 0)) {
        return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
      }
    }
  } catch (e) {}
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 32);
}

/**
 * Constrói a URL canônica para entrar na sala.
 * @param {Object} options
 * @param {string} options.roomId
 * @param {string} [options.roomKey=null]
 * @param {string} [options.roomPin=null]
 * @param {string} [options.basePath=null]
 * @returns {string}
 */
export function buildRoomUrl({ roomId, roomKey = null, roomPin = null, basePath = null, turnToken = null } = {}) {
  const cleanId = sanitizeRoomId(roomId);
  const effectiveBase = basePath !== null ? basePath : getSanitizedPath();
  const origin = (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null')
    ? window.location.origin
    : '';
  const keyParam = roomKey ? `&key=${encodeURIComponent(roomKey)}` : '';
  const pinParam = roomPin ? `&pin=${encodeURIComponent(roomPin)}` : '';
  let token = turnToken;
  if (!token && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try { token = localStorage.getItem('seemygame_turn_access_token'); } catch (_) {}
  }
  const tokenParam = (token && typeof token === 'string' && token.length <= 512)
    ? `&turn_token=${encodeURIComponent(token)}`
    : '';
  return `${origin}${effectiveBase}room.html#room=${encodeURIComponent(cleanId)}${keyParam}${pinParam}${tokenParam}`;
}

export { parseRoomIdentifier };
