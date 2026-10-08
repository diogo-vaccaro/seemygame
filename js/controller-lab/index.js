import { ControllerLab } from './controller.js';
import { createControllerLabView } from './view.js';

export function bindControllerLab(session, { getPeerId, getDisplayName, getConnections, isAuthorizedPeer,
  canInvite = true, canManageAccess = false, showToast = () => {}, coopController = null } = {}) {
  let view = null; let frame = null; let selectedIndex = null; let lastSampleAt = -Infinity;
  let localSample = null;
  const lab = new ControllerLab({ session, getPeerId, getDisplayName, getConnections, isAuthorizedPeer, canInvite,
    onChange: players => view?.render(players, getPeerId?.() || 'local', accessSnapshot(players)),
    onInvite: pending => view?.invitation(pending),
    onError: message => showToast(message, 'info'),
    onOpen: () => {
      coopController?.setInputTestMode?.(true);
      selectedIndex = coopController?.getSelectedGamepadIndex?.() ?? null; lastSampleAt = -Infinity; localSample = null;
      view?.open(lab.owner && canInvite, accessSnapshot(lab.list()).canManage);
      frame = requestAnimationFrame(sample);
    },
    onClose: () => {
      if (frame !== null) cancelAnimationFrame(frame); frame = null;
      view?.close(); coopController?.setInputTestMode?.(false);
    }
  });
  const accessSnapshot = players => {
    const state = coopController?.getCoopState?.();
    const canManage = Boolean(lab.owner && canManageAccess && state?.isCoopEnabled && !state.isPlayer2 && !state.activeHostPeerId);
    const assignments = new Map((state?.slots || [])
      .filter(slot => slot?.occupied && slot.peerId && slot.peerId !== 'host-local')
      .map(slot => [slot.peerId, slot.slot]));
    const byPeer = new Map();
    for (const player of players) {
      if (!player || player.slot === 0 || player.peerId === (getPeerId?.() || 'local')) continue;
      byPeer.set(player.peerId, {
        slot: assignments.get(player.peerId) ?? null,
        availableSlot: canManage ? coopController.getNextAvailableSlot?.(player.slot) ?? null : null
      });
    }
    return { canManage, byPeer };
  };
  const sample = timestamp => {
    if (!lab.active || session.isDisposed) return;
    if (timestamp - lastSampleAt >= 50) {
      lastSampleAt = timestamp;
      let pads = [];
      try { pads = Array.from(navigator.getGamepads?.() || []).filter(pad => pad?.connected); } catch (_) {}
      if (selectedIndex === null && pads.length) {
        selectedIndex = pads[0].index;
        coopController?.setSelectedGamepadIndex?.(selectedIndex);
      }
      const pad = pads.find(pad => pad.index === selectedIndex);
      localSample = pad || null;
      lab.sample(document.hidden ? null : localSample);
      lab.tick();
      view?.updateDevices(pads, selectedIndex);
    }
    if (lab.active) frame = requestAnimationFrame(sample);
  };
  if (typeof document !== 'undefined') {
    view = createControllerLabView({ onClose: () => lab.close(), onInvite: () => {
      const count = lab.invite();
      showToast(count ? 'Convite enviado aos amigos conectados.' : 'Compartilhe o link da sala. Os amigos recebem o convite quando se conectarem.', 'info');
    },
      onReady: ready => lab.setReady(ready), onDevice: index => {
        selectedIndex = index; coopController?.setSelectedGamepadIndex?.(index); lab.sample(null);
      },
      onGrantAccess: async peerId => {
        if (!lab.active || !lab.owner || !accessSnapshot(lab.list()).canManage) return;
        const player = lab.players.get(peerId);
        const conn = lab.connections().find(connection => connection.peer === peerId);
        if (!player || !conn) return;
        const slot = coopController.getNextAvailableSlot?.(player.slot);
        if (slot === null || slot === undefined) { showToast('Não há um slot de Co-op disponível. Ajuste o limite de jogadores na sala.', 'info'); return; }
        if (!await coopController.grantCoopPlayer?.(peerId, conn, player.name, slot)) {
          showToast('Não foi possível liberar o controle. Verifique o modo Co-op e os slots disponíveis.', 'error');
        }
      },
      onRevokeAccess: peerId => {
        if (!lab.active || !lab.owner || !accessSnapshot(lab.list()).canManage) return;
        const assigned = [...(coopController?.coopSlots || [])].find(([, player]) => player.peerId === peerId);
        if (assigned) coopController.revokeCoopPlayer(assigned[0], true);
      },
      onAccept: () => { if (!lab.acceptInvite()) { lab.dismissInvite(); showToast('Esse convite expirou. Peça um novo convite.', 'info'); } },
      onDismiss: () => lab.dismissInvite() });
    session.addEventListener(document.getElementById('open-controller-lab-btn'), 'click', () => lab.open());
    session.addEventListener(document, 'visibilitychange', () => {
      view.pause(document.hidden);
      if (document.hidden && lab.active) { lab.sample(null); if (lab.owner) lab.publish(); }
    });
  }
  session.registerCleanup(session.eventBus.on('stream:started', () => lab.close()));
  session.registerCleanup(() => { lab.dispose(); view?.destroy(); });
  return lab;
}
