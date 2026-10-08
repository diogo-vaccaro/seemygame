import { buildRoomUrl } from '../navigation/room-links.js';

/** Only the coordinator changes admission settings. A new slug has a new coordinator identity. */
export function bindRoomSettings(session, { getRoomManager, applySettings, showToast }) {
  const modal = document.getElementById('custom-id-modal');
  const slug = document.getElementById('custom-id-input');
  const pin = document.getElementById('room-pin-input');
  const error = document.getElementById('custom-id-error');
  const save = document.getElementById('custom-id-save-btn');
  const reset = document.getElementById('custom-id-reset-btn');
  if (!modal || !slug || !pin) return;
  const close = () => { modal.style.display = 'none'; };
  const fail = message => {
    if (error) { error.textContent = message; error.style.display = 'block'; }
  };
  const dirCheck = document.getElementById('room-directory-publish-check');
  const dirOptions = document.getElementById('room-directory-options');
  const gameInput = document.getElementById('room-game-input');
  const p2Check = document.getElementById('room-player2-slot-check');

  const syncDirVisibility = () => {
    if (dirOptions) {
      dirOptions.style.display = dirCheck?.checked ? 'flex' : 'none';
    }
  };

  if (dirCheck) {
    session.addEventListener(dirCheck, 'change', syncDirVisibility);
  }

  session.addEventListener(document.getElementById('edit-id-btn'), 'click', () => {
    const room = getRoomManager();
    if (!room?.isInRoom) { showToast('Entre na sala para abrir os ajustes.', 'info'); return; }
    slug.value = room.roomId; pin.value = room.isMaster ? room.roomPin || '' : '';
    slug.disabled = pin.disabled = !room.isMaster;
    if (dirCheck) {
      dirCheck.disabled = !room.isMaster;
      try {
        dirCheck.checked = room.isMaster && localStorage.getItem('seemygame_dir_publish_' + room.roomId) === 'true';
      } catch (_) {
        dirCheck.checked = false;
      }
    }
    if (gameInput) {
      gameInput.disabled = !room.isMaster;
      try {
        gameInput.value = localStorage.getItem('seemygame_dir_game_' + room.roomId) || '';
      } catch (_) {
        gameInput.value = '';
      }
    }
    if (p2Check) {
      p2Check.disabled = !room.isMaster;
      try {
        p2Check.checked = localStorage.getItem('seemygame_dir_p2_' + room.roomId) === 'true';
      } catch (_) {
        p2Check.checked = false;
      }
    }
    syncDirVisibility();
    if (save) save.disabled = !room.isMaster;
    if (reset) reset.disabled = !room.isMaster;
    if (error) error.style.display = 'none';
    if (!room.isMaster) fail('Somente o coordenador pode alterar o nome e o PIN da sala.');
    modal.style.display = 'flex';
    (room.isMaster ? slug : document.getElementById('custom-id-cancel-btn'))?.focus();
  });
  session.addEventListener(document.getElementById('custom-id-cancel-btn'), 'click', close);
  session.addEventListener(modal, 'click', event => { if (event.target === modal) close(); });
  session.addEventListener(modal, 'keydown', event => { if (event.key === 'Escape') close(); });
  session.addEventListener(reset, 'click', () => {
    slug.value = getRoomManager()?.roomId || 'general'; pin.value = '';
    if (dirCheck) dirCheck.checked = false;
    if (gameInput) gameInput.value = '';
    if (p2Check) p2Check.checked = false;
    syncDirVisibility();
    if (error) error.style.display = 'none';
  });
  session.addEventListener(save, 'click', () => {
    const room = getRoomManager();
    if (session.isDisposed || !room?.isInRoom || !room.isMaster) return;
    const roomId = slug.value.trim().toLowerCase(), roomPin = pin.value.trim() || null;
    if (!/^[a-z0-9_-]{1,30}$/.test(roomId)) { fail('Use de 1 a 30 letras, números, hífens ou sublinhados no nome.'); return; }
    if (roomPin && !/^[0-9]{4,8}$/.test(roomPin)) { fail('Digite um PIN de 4 a 8 números ou deixe em branco.'); return; }

    const directoryPublish = Boolean(dirCheck?.checked);
    const game = (gameInput?.value || '').trim() || 'Geral';
    const player2Slot = Boolean(p2Check?.checked);

    try {
      localStorage.setItem('seemygame_dir_publish_' + roomId, String(directoryPublish));
      localStorage.setItem('seemygame_dir_game_' + roomId, game);
      localStorage.setItem('seemygame_dir_p2_' + roomId, String(player2Slot));
    } catch (_) {}

    applySettings({
      roomId,
      roomPin,
      roomKey: room.roomKey,
      directoryPublish,
      game,
      player2Slot,
      url: buildRoomUrl({ roomId, roomPin, roomKey: room.roomKey })
    });
    close();
  });
  session.registerCleanup(close);
}
