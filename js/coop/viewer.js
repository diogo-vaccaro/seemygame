import { sendCoopMessage } from './message-transport.js';
/** viewer: commands receive explicit compatibility ports; no page initialization. */
export function requestCoopControl(compatibilityContext, hostPeerId, dataConn, preferredSlot = null) {
  if (!dataConn || dataConn.open === false) {
    return compatibilityContext.showToast('Conexão de dados indisponível.', 'error');
  }

  compatibilityContext.activeHostPeerId = hostPeerId;
  compatibilityContext.activeDataConn = dataConn;

  const slotLabel = preferredSlot !== null && preferredSlot !== undefined ? `Player ${Number(preferredSlot) + 1}` : 'Co-op';
  compatibilityContext.showToast(`⏳ Solicitando vaga de ${slotLabel}...`, 'info');
  const payload = { type: 'COOP_REQUEST' };
  if (preferredSlot !== null && preferredSlot !== undefined) {
    payload.preferredSlot = Number(preferredSlot);
  }
  sendCoopMessage(compatibilityContext, dataConn, payload);
}

export function handleViewerCoopMessage(compatibilityContext, data, hostPeerId, videoCard, sourceConn = null) {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'COOP_RESPONSE') {
    if (data.approved) {
      compatibilityContext.myAssignedSlot = Number(data.slot !== undefined ? data.slot : 1);
      compatibilityContext.isPlayer2 = true;
      compatibilityContext.activeHostPeerId = hostPeerId;
      if (sourceConn?.peer === hostPeerId) compatibilityContext.activeDataConn = sourceConn;
      compatibilityContext.showToast(`🎉 Você agora é o Player ${compatibilityContext.myAssignedSlot + 1}! Use controle ou teclado.`, 'success', 5000);
      compatibilityContext.attachPlayer2InputListeners(videoCard);
      compatibilityContext.notifyStateChange();
    } else {
      compatibilityContext.isPlayer2 = false;
      compatibilityContext.myAssignedSlot = null;
      compatibilityContext.showToast(`⚠ Pedido recusado: ${data.reason || 'O streamer não autorizou.'}`, 'error');
      compatibilityContext.notifyStateChange();
    }
  }

  else if (data.type === 'COOP_REVOKE') {
    if (compatibilityContext.isPlayer2 && (data.slot === undefined || Number(data.slot) === compatibilityContext.myAssignedSlot)) {
      compatibilityContext.releaseCoopControl(false);
      compatibilityContext.showToast('🛑 O streamer encerrou sua sessão de jogo.', 'info', 5000);
    }
  }

  else if (data.type === 'COOP_SLOTS_UPDATE') {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('coop:slots_update', { detail: data.slots }));
    }
  }

  else if (data.type === 'COOP_CONFIG') {
    const coopBtn = (videoCard && videoCard.querySelector) ? (videoCard.querySelector(`#btn-coop-${hostPeerId}`) || videoCard.querySelector('.card-btn-coop')) : document.getElementById(`btn-coop-${hostPeerId}`);
    if (coopBtn) {
      if (data.enabled === false) {
        coopBtn.disabled = true;
        coopBtn.classList.add('btn-disabled');
        coopBtn.title = 'O streamer desativou o modo Co-op nesta sessão';
        if (compatibilityContext.isPlayer2 && compatibilityContext.activeHostPeerId === hostPeerId) {
          compatibilityContext.releaseCoopControl(false);
          compatibilityContext.showToast('🔒 O streamer desativou o modo Co-op.', 'info');
        }
      } else {
        coopBtn.disabled = false;
        coopBtn.classList.remove('btn-disabled');
        coopBtn.title = 'Solicitar ao streamer para jogar no Co-op';
        compatibilityContext.showToast('🎮 O streamer ativou o modo Co-op!', 'info');
      }
    }
  }

  else if (data.type === 'COOP_CAPABILITIES') {
    if (data.slot !== undefined) {
      compatibilityContext.myAssignedSlot = Number(data.slot);
    }
    compatibilityContext.activeHostCapabilities = {
      keyboard: data.keyboard !== false,
      mouse: data.mouse === true,
      gamepad: data.gamepad === true
    };
    if (data.gamepad === false && compatibilityContext.isPlayer2) {
      compatibilityContext.showToast('Controle gamepad não disponível neste host; teclado continua disponível.', 'info', 5000);
    }
  }

  else if (data.type === 'GAMEPAD_RUMBLE') {
    if (data.slot === undefined || Number(data.slot) === compatibilityContext.myAssignedSlot) {
      compatibilityContext.triggerGamepadRumble(data.strongMagnitude ?? 0.5, data.weakMagnitude ?? 0.5, data.durationMs ?? 200);
    }
  }
}

export function releaseCoopControl(compatibilityContext, notifyHost = true) {
  if (compatibilityContext.isPlayer2 && compatibilityContext.activeDataConn && notifyHost) {
    try {
      sendCoopMessage(compatibilityContext, compatibilityContext.activeDataConn, {
        type: 'COOP_RELEASE',
        slot: compatibilityContext.myAssignedSlot !== null ? compatibilityContext.myAssignedSlot : 1
      });
    } catch (e) {}
  }
  const releasedSlot = compatibilityContext.myAssignedSlot;
  compatibilityContext.isPlayer2 = false;
  compatibilityContext.myAssignedSlot = null;
  compatibilityContext.detachPlayer2InputListeners();
  compatibilityContext.activeHostCapabilities = { keyboard: true, mouse: false, gamepad: false };
  if (releasedSlot !== null) {
    compatibilityContext.showToast(`Controle de Player ${releasedSlot + 1} liberado.`, 'info');
  } else {
    compatibilityContext.showToast('Controle liberado.', 'info');
  }
  compatibilityContext.notifyStateChange();
}
