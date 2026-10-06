import { buildRoomUrl } from '../navigation/room-links.js';
import { PUBLIC_WEB_ORIGIN } from '../config.js';

export function bindRoomIdentity(session, { getRoomInfo, showToast }) {
  const badge = document.getElementById('copy-badge');
  const statusOnly = badge?.classList.contains('room-connection-status');
  const invite = document.getElementById('share-link-btn');
  let ready = false;
  const update = status => {
    ready = status === 'ready';
    const roomId = getRoomInfo().roomId;
    const roomTitle = document.getElementById('room-header-badge');
    if (roomTitle) roomTitle.textContent = `Sala: #${roomId}`;
    if (badge) {
      badge.textContent = ready ? statusOnly ? '● Conectado' : `🏠 ${roomId}` : status === 'error' ? '⚠️ Conexão indisponível' : '⏳ Conectando...';
      badge.setAttribute('aria-label', ready && !statusOnly ? `Copiar link da sala ${roomId}` : badge.textContent);
      if (!statusOnly) { badge.setAttribute('aria-disabled', String(!ready)); badge.tabIndex = ready ? 0 : -1; }
    }
    if (invite) invite.disabled = !ready;
  };
  const copy = async () => {
    if (!ready) return;
    try {
      const url = buildRoomUrl(getRoomInfo());
      const isDesktop = Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
      const shareUrl = isDesktop ? new URL(new URL(url).pathname + new URL(url).hash, PUBLIC_WEB_ORIGIN).href : url;
      await navigator.clipboard.writeText(shareUrl);
      if (!session.isDisposed) showToast('Link da sala copiado!', 'success');
    } catch (_) {
      if (!session.isDisposed) showToast('Não foi possível copiar o link da sala.', 'error');
    }
  };
  if (badge && !statusOnly) {
    session.addEventListener(badge, 'click', copy);
    session.addEventListener(badge, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copy(); }
    });
  }
  if (invite) session.addEventListener(invite, 'click', copy);
  update('connecting');
  return { update };
}
