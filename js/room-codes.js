/**
 * SeeMyGame - Gerador e Analisador de Códigos de Sala Amigáveis
 * 
 * Permite criar e interpretar códigos de salas limpos, memoráveis e fáceis de ditar,
 * suportando os estilos "Gamer" (ex: pixel-turbo-fogo) e "Meet" (ex: abc-defg-hij).
 */

import { sanitizeRoomId } from './room/room-id.js';

// Dicionário de palavras gamer em português (sem acentos, foneticamente claras)
export const GAMER_WORDS = {
  prefixes: [
    'pixel', 'turbo', 'retro', 'laser', 'ninja', 'cyber', 'ultra', 'alpha',
    'fogo', 'gelo', 'tropa', 'radio', 'cosmo', 'hyper', 'clutch', 'combo',
    'storm', 'speed', 'flash', 'prime', 'magia', 'furia', 'sniper', 'veloz'
  ],
  nouns: [
    'gamer', 'arcade', 'arena', 'squad', 'boss', 'boost', 'clube', 'resenha',
    'power', 'nave', 'drift', 'shield', 'titan', 'strike', 'craft', 'force',
    'castelo', 'portal', 'espada', 'escudo', 'trofeu', 'planeta', 'estrela'
  ]
};

// Caracteres fonéticos inequívocos para estilo Meet (sem 'l', '1', '0', 'o')
const MEET_CHARSET = 'abcdefghjkmnpqrstuvwxyz';

/**
 * Gera um código de sala estilo Gamer com 2 ou 3 palavras concatenadas
 * @returns {string} Ex: "turbo-pixel-squad" ou "fogo-arcade"
 */
export function generateGamerRoomCode() {
  const p1 = GAMER_WORDS.prefixes[Math.floor(Math.random() * GAMER_WORDS.prefixes.length)];
  const p2 = GAMER_WORDS.prefixes[Math.floor(Math.random() * GAMER_WORDS.prefixes.length)];
  const n = GAMER_WORDS.nouns[Math.floor(Math.random() * GAMER_WORDS.nouns.length)];

  // Garante que p1 e p2 sejam diferentes
  const prefix2 = (p1 === p2)
    ? GAMER_WORDS.prefixes[(GAMER_WORDS.prefixes.indexOf(p1) + 1) % GAMER_WORDS.prefixes.length]
    : p2;

  // 70% de chance de 3 palavras, 30% de 2 palavras
  if (Math.random() > 0.3) {
    return `${p1}-${prefix2}-${n}`;
  }
  return `${p1}-${n}`;
}

/**
 * Gera um código de sala no padrão Google Meet: 3 letras, traço, 4 letras, traço, 3 letras
 * @returns {string} Ex: "kpm-tzvw-ndq"
 */
export function generateMeetRoomCode() {
  const pick = (count) => {
    let res = '';
    for (let i = 0; i < count; i++) {
      res += MEET_CHARSET[Math.floor(Math.random() * MEET_CHARSET.length)];
    }
    return res;
  };
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

/**
 * Gera um código amigável de sala de acordo com o estilo escolhido
 * @param {'gamer'|'meet'} [style='gamer']
 * @returns {string}
 */
export function generateFriendlyRoomCode(style = 'gamer') {
  if (style === 'meet') {
    return generateMeetRoomCode();
  }
  return generateGamerRoomCode();
}

/**
 * Analisa e extrai o identificador limpo da sala a partir de texto digitado ou colado
 * Aceita:
 * - URL completa de convite (ex: "https://seemygame.app/room.html#room=resenha&key=123")
 * - URL com query (ex: "http://localhost:3000/room.html?room=turbo-pixel")
 * - ID de Coordenador PeerJS (ex: "smg_room_turbo-pixel_host")
 * - Código direto com ou sem formatação (ex: "abc-defg-hij", "  RESENHA ")
 * 
 * @param {string} raw
 * @returns {{ roomId: string, roomKey: string|null, original: string }}
 */
export function parseRoomIdentifier(raw) {
  if (!raw || typeof raw !== 'string') {
    return { roomId: 'general', roomKey: null, original: '' };
  }

  const original = raw.trim();
  let candidate = original;
  let roomKey = null;

  // 1. Extração de URL via hash ou query
  if (candidate.includes('#room=')) {
    const hashPart = candidate.slice(candidate.indexOf('#') + 1);
    const hashParams = new URLSearchParams(hashPart);
    candidate = hashParams.get('room') || hashPart.split('room=')[1].split('&')[0];
    roomKey = hashParams.get('key') || null;
    const turnToken = hashParams.get('turn_token') || hashParams.get('turnToken') || null;
    if (turnToken && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      try { localStorage.setItem('seemygame_turn_access_token', turnToken); } catch (_) {}
    }
  } else if (candidate.includes('?room=') || candidate.includes('&room=')) {
    try {
      const queryPart = candidate.includes('?') ? candidate.slice(candidate.indexOf('?') + 1) : candidate;
      const urlParams = new URLSearchParams(queryPart);
      candidate = urlParams.get('room') || candidate;
      roomKey = urlParams.get('key') || null;
      const turnToken = urlParams.get('turn_token') || urlParams.get('turnToken') || null;
      if (turnToken && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        try { localStorage.setItem('seemygame_turn_access_token', turnToken); } catch (_) {}
      }
    } catch (e) {}
  } else if (candidate.includes('#watch=')) {
    const watchPart = candidate.slice(candidate.indexOf('#') + 1);
    candidate = `watch-${watchPart.split('watch=')[1].split('&')[0]}`;
  }

  // 2. Remoção de ID técnico do coordenador PeerJS (ex: smg_room_xyz_host)
  const masterPattern = /^smg_room_(.+)_host$/i;
  const masterMatch = candidate.match(masterPattern);
  if (masterMatch && masterMatch[1]) {
    candidate = masterMatch[1];
    // Se o master tiver hash anexado (ex: nome_hash123), remove o hash
    if (candidate.includes('_') && candidate.length > 20) {
      candidate = candidate.split('_')[0];
    }
  }

  // 3. Sanitização final
  const cleanRoomId = sanitizeRoomId(candidate) || 'general';

  // Validação segura de roomKey
  const safeRoomKey = (typeof roomKey === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(roomKey))
    ? roomKey
    : null;

  return {
    roomId: cleanRoomId,
    roomKey: safeRoomKey,
    original
  };
}

/**
 * Formata em tempo real o que o usuário digita para o padrão fonético (se for 10 letras contínuas)
 * @param {string} input 
 * @returns {string}
 */
export function formatRoomCodeInput(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim().toLowerCase();

  // Se for apenas letras consecutivas de 10 chars sem hífen ou underline, formata estilo Meet conforme digita
  const lettersOnly = trimmed.replace(/[^a-z]/g, '');
  if (lettersOnly.length === 10 && !trimmed.includes('-') && !trimmed.includes('_')) {
    return `${lettersOnly.slice(0, 3)}-${lettersOnly.slice(3, 7)}-${lettersOnly.slice(7, 10)}`;
  }

  // Caso contrário, apenas sanitiza mantendo hífens seguros
  return trimmed.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 32);
}
