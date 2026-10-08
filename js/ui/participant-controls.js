/**
 * SeeMyGame - ParticipantControls
 * Componente de interface para controle de volume individual e mudo local por participante.
 * Conectado diretamente aos métodos setUserVolume e setUserLocallyMuted do VoiceManager.
 */

export function createParticipantVolumePopover({ peerId, name = 'Amigo', voiceManager }) {
  if (!peerId || !voiceManager) return null;

  const currentVol = voiceManager.getUserVolume ? voiceManager.getUserVolume(peerId) : 100;
  const isMuted = voiceManager.isUserLocallyMuted ? voiceManager.isUserLocallyMuted(peerId) : false;

  const wrapper = document.createElement('div');
  wrapper.className = 'participant-volume-wrapper';
  wrapper.dataset.peerId = peerId;

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn-participant-volume-toggle';
  toggleBtn.title = `Ajustar volume de ${name}`;
  toggleBtn.setAttribute('aria-label', `Volume de ${name}: ${isMuted ? 'Silenciado' : currentVol + '%'}`);
  toggleBtn.innerHTML = isMuted ? '🔇' : (currentVol < 50 ? '🔈' : (currentVol > 120 ? '🔊+' : '🔊'));

  const popover = document.createElement('div');
  popover.className = 'participant-volume-popover';
  popover.style.display = 'none';

  const header = document.createElement('div');
  header.className = 'participant-volume-header';
  
  const nameLabel = document.createElement('span');
  nameLabel.className = 'participant-volume-name';
  nameLabel.textContent = name;

  const volBadge = document.createElement('span');
  volBadge.className = 'participant-volume-badge';
  volBadge.textContent = isMuted ? 'Mudo' : `${currentVol}%`;

  header.appendChild(nameLabel);
  header.appendChild(volBadge);

  const sliderRow = document.createElement('div');
  sliderRow.className = 'participant-volume-slider-row';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '200';
  slider.step = '1';
  slider.setAttribute('aria-label', `Volume de ${name}`);
  slider.value = String(currentVol);
  slider.className = 'participant-volume-slider';
  slider.disabled = isMuted;

  sliderRow.appendChild(slider);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'participant-volume-actions';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = `btn-participant-mute-local ${isMuted ? 'active-mute' : ''}`;
  muteBtn.textContent = isMuted ? 'Desmutar' : 'Silenciar';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn-participant-vol-reset';
  resetBtn.textContent = '100%';
  resetBtn.title = 'Restaurar volume padrão (100%)';

  actionsRow.appendChild(muteBtn);
  actionsRow.appendChild(resetBtn);

  popover.appendChild(header);
  popover.appendChild(sliderRow);
  popover.appendChild(actionsRow);

  wrapper.appendChild(toggleBtn);
  wrapper.appendChild(popover);

  // Interações
  const updateUI = (volume, muted) => {
    volBadge.textContent = muted ? 'Mudo' : `${volume}%`;
    slider.value = String(volume);
    slider.disabled = muted;
    muteBtn.textContent = muted ? 'Desmutar' : 'Silenciar';
    muteBtn.classList.toggle('active-mute', muted);
    toggleBtn.innerHTML = muted ? '🔇' : (volume < 50 ? '🔈' : (volume > 120 ? '🔊+' : '🔊'));
    toggleBtn.setAttribute('aria-label', `Volume de ${name}: ${muted ? 'Silenciado' : volume + '%'}`);
  };

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = popover.style.display !== 'none';
    // Fechar outros popovers abertos
    document.querySelectorAll('.participant-volume-popover').forEach(p => {
      if (p !== popover) p.style.display = 'none';
    });
    popover.style.display = isVisible ? 'none' : 'flex';
    updateUI(voiceManager.getUserVolume?.(peerId) ?? Number(slider.value), voiceManager.isUserLocallyMuted?.(peerId) ?? false);
  });

  slider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    if (typeof voiceManager.setUserVolume === 'function') {
      voiceManager.setUserVolume(peerId, val);
    }
    updateUI(val, false);
  });

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nextMuted = !muteBtn.classList.contains('active-mute');
    if (typeof voiceManager.setUserLocallyMuted === 'function') {
      voiceManager.setUserLocallyMuted(peerId, nextMuted);
    } else if (typeof voiceManager.setUserMuted === 'function') {
      voiceManager.setUserMuted(peerId, nextMuted);
    }
    const vol = voiceManager.getUserVolume ? voiceManager.getUserVolume(peerId) : Number(slider.value);
    updateUI(vol, nextMuted);
  });

  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof voiceManager.setUserVolume === 'function') {
      voiceManager.setUserVolume(peerId, 100);
    }
    if (typeof voiceManager.setUserLocallyMuted === 'function') {
      voiceManager.setUserLocallyMuted(peerId, false);
    } else if (typeof voiceManager.setUserMuted === 'function') {
      voiceManager.setUserMuted(peerId, false);
    }
    updateUI(100, false);
  });

  // Fechar popover ao clicar fora ou pressionar Escape
  const onDocClick = (e) => {
    if (!wrapper.contains(e.target)) {
      popover.style.display = 'none';
    }
  };
  const onDocKeydown = (e) => {
    if (e.key === 'Escape' && popover.style.display !== 'none') {
      popover.style.display = 'none';
    }
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKeydown);

  wrapper.cleanup = () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKeydown);
  };
  if (voiceManager.on && voiceManager.off) {
    const sync = data => {
      if (data.peerId === peerId) updateUI(voiceManager.getUserVolume(peerId), voiceManager.isUserLocallyMuted(peerId));
    };
    voiceManager.on('userVolumeChange', sync); voiceManager.on('userMuteChange', sync);
    const cleanup = wrapper.cleanup;
    wrapper.cleanup = () => { cleanup(); voiceManager.off('userVolumeChange', sync); voiceManager.off('userMuteChange', sync); };
  }

  return wrapper;
}
