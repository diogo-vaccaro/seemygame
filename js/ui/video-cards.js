import { createStatsHud } from '../stats/hud.js';
import { pipController } from '../room/pip-controller.js';
import { annotateManager } from '../room/annotate.js';
const cardDisposals = new WeakMap();

function disposeCard(card) {
  cardDisposals.get(card)?.();
  cardDisposals.delete(card);
  const video = card.querySelector('video');
  if (video) { video.pause(); video.srcObject = null; }
}
/** video-cards: commands receive explicit compatibility ports; no page initialization. */
export function resolveCardDisplayStream(compatibilityContext, stream, isLocal = false) {
  if (!stream) return stream;
  if (isLocal && typeof stream.getVideoTracks === 'function' && typeof stream.getAudioTracks === 'function') {
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0 && videoTracks.length > 0) {
      try {
        const StreamCtor = stream.constructor || (typeof MediaStream !== 'undefined' ? MediaStream : null);
        if (StreamCtor) {
          return new StreamCtor(videoTracks);
        }
      } catch (_) {
        return stream;
      }
    }
  }
  return stream;
}

export function updateGridEmptyState(compatibilityContext) {
  const grid = document.getElementById('video-grid');
  const emptyState = document.getElementById('empty-state');
  if (!grid || !emptyState) return;

  const cards = grid.querySelectorAll('.video-card');
  if (cards.length === 0) {
    emptyState.style.display = 'flex';
  } else {
    emptyState.style.display = 'none';
  }

  if (document.body) {
    const hasExpanded = grid.querySelector('.video-card.expanded-mode') !== null;
    document.body.classList.toggle('has-expanded-video', hasExpanded);
  }
}

export function createPlaceholderCard(compatibilityContext, peerId, initialText, onDisconnect) {
  const grid = document.getElementById('video-grid');
  if (!grid) return;

  // Validação de segurança de ID
  if (!compatibilityContext.isValidPeerId(peerId)) {
    compatibilityContext.showToast('ID inválido para criação de cartão.', 'error');
    return;
  }

  if (document.getElementById(`card-${peerId}`)) return;

  const card = document.createElement('div');
  card.className = 'video-card';
  card.id = `card-${peerId}`;

  // Header seguro
  const header = document.createElement('div');
  header.className = 'video-card-header';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'streamer-title';

  const iconSpan = document.createElement('span');
  iconSpan.textContent = '📡 ';

  const nameSpan = document.createElement('span');
  nameSpan.textContent = `Tela de ${peerId.slice(0, 6)}`;

  titleDiv.appendChild(iconSpan);
  titleDiv.appendChild(nameSpan);

  const controlsDiv = document.createElement('div');
  controlsDiv.className = 'card-controls';

  const disconnectBtn = document.createElement('button');
  disconnectBtn.className = 'card-btn card-btn-danger';
  disconnectBtn.id = `disconnect-btn-${peerId}`;
  disconnectBtn.textContent = 'Desconectar';

  controlsDiv.appendChild(disconnectBtn);
  header.appendChild(titleDiv);
  header.appendChild(controlsDiv);

  // Wrapper do vídeo com spinner
  const wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper';

  const statusOverlay = document.createElement('div');
  statusOverlay.className = 'stream-status-overlay';
  statusOverlay.id = `status-${peerId}`;

  const spinner = document.createElement('div');
  spinner.className = 'spinner';

  const pText = document.createElement('p');
  pText.style.cssText = 'font-size: 13px; color: var(--text-muted);';
  pText.textContent = initialText;

  statusOverlay.appendChild(spinner);
  statusOverlay.appendChild(pText);
  wrapper.appendChild(statusOverlay);

  card.appendChild(header);
  card.appendChild(wrapper);
  grid.appendChild(card);

  if (onDisconnect) {
    disconnectBtn.onclick = () => onDisconnect(peerId);
  }

  compatibilityContext.updateGridEmptyState();
}

export function updateCardStatus(compatibilityContext, peerId, message) {
  const statusOverlay = document.getElementById(`status-${peerId}`);
  if (statusOverlay) {
    const textElem = statusOverlay.querySelector('p');
    if (textElem) textElem.innerText = message;
  }
}

export function hideCardLoading(compatibilityContext, peerId) {
  const statusOverlay = document.getElementById(`status-${peerId}`);
  if (statusOverlay) {
    statusOverlay.style.display = 'none';
  }
  const loadingOverlay = document.getElementById(`loading-${peerId}`);
  if (loadingOverlay) {
    loadingOverlay.style.display = 'none';
  }
}

export function setCardStreamPaused(compatibilityContext, peerId, isPaused, message = 'Transmissão pausada pelo streamer.') {
  const pausedOverlay = document.getElementById(`paused-overlay-${peerId}`);
  if (pausedOverlay) {
    pausedOverlay.style.display = isPaused ? 'flex' : 'none';
    const p = pausedOverlay.querySelector('p');
    if (p) p.textContent = message;
    return;
  }

  const statusOverlay = document.getElementById(`status-${peerId}`);
  if (statusOverlay) {
    statusOverlay.style.display = isPaused ? 'flex' : 'none';
    const p = statusOverlay.querySelector('p');
    if (p) p.textContent = message;
  }
}

export function removeVideoCard(compatibilityContext, peerId) {
  const normalizedId = (peerId === 'local-stream') ? 'local-me' : peerId;
  const card = document.getElementById(`card-${normalizedId}`) || document.getElementById(`card-${peerId}`);
  if (card) { disposeCard(card); card.remove(); }
  compatibilityContext.stopStatsMonitor(normalizedId);
  compatibilityContext.stopAudioAnalyser(normalizedId);
  compatibilityContext.updateGridEmptyState();
}

export function addOrUpdateVideoCard(compatibilityContext, optionsOrPeerId, streamArg, extraOptions = {}) {
  const grid = document.getElementById('video-grid');
  if (!grid) return null;

  let stream, peerId, label, isLocal, onDisconnect, onCoopClick, onPanicClick, onClipClick, audioScope, session;
  if (optionsOrPeerId && typeof optionsOrPeerId === 'object' && ('stream' in optionsOrPeerId || 'peerId' in optionsOrPeerId)) {
    ({ stream, peerId, label, isLocal = false, onDisconnect, onCoopClick, onPanicClick, onClipClick, audioScope, session } = optionsOrPeerId);
  } else {
    peerId = optionsOrPeerId;
    stream = streamArg;
    label = extraOptions.title || extraOptions.label || 'Stream';
    isLocal = extraOptions.isLocal ?? extraOptions.isHost ?? false;
    onDisconnect = extraOptions.onDisconnect;
    onCoopClick = extraOptions.onCoopClick;
    onPanicClick = extraOptions.onPanicClick;
    onClipClick = extraOptions.onClipClick;
  }

  if (peerId === 'local-stream') peerId = 'local-me';

  if (!compatibilityContext.isValidPeerId(peerId) && peerId !== 'local-me') {
    compatibilityContext.showToast('ID inválido para adicionar cartão de vídeo.', 'error');
    return null;
  }

  let card = document.getElementById(`card-${peerId}`);
  if (card) {
    const existingVideo = card.querySelector('video');
    const wasLocal = card.dataset.isLocal === 'true';
    if (existingVideo && wasLocal === isLocal) {
      const resolvedStream = compatibilityContext.resolveCardDisplayStream(stream, isLocal);
      if (existingVideo.srcObject !== resolvedStream) {
        existingVideo.srcObject = resolvedStream;
      }
      compatibilityContext.setCardStreamPaused(peerId, false);
      compatibilityContext.hideCardLoading(peerId);

      const labelSpan = card.querySelector('.streamer-name') || card.querySelector('.streamer-title span');
      if (labelSpan && label) {
        labelSpan.textContent = label;
      }

      compatibilityContext.initAudioAnalyser(stream, peerId, audioScope);
      if (onCoopClick) {
        const button = card.querySelector('.card-btn-coop');
        if (button) button.onclick = () => onCoopClick(peerId);
      }
      if (onClipClick) {
        const button = card.querySelector('.card-btn-clip');
        if (button) button.onclick = () => onClipClick(peerId, stream);
      }

      const playPromise = existingVideo.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('Autoplay bloqueado na reconexão:', err);
          existingVideo.muted = true;
          existingVideo.play().catch(e => console.warn(e));
          if (!isLocal) {
            const unmuteOverlay = card.querySelector('.audio-unmute-overlay');
            if (unmuteOverlay) unmuteOverlay.style.display = 'flex';
          }
        });
      }

      compatibilityContext.updateGridEmptyState();
      const reactionsDock = document.getElementById('reactions-dock');
      if (reactionsDock) reactionsDock.style.display = 'flex';
      return { card, video: existingVideo };
    }
  } else {
    card = document.createElement('div');
    card.className = 'video-card';
    card.id = `card-${peerId}`;
    grid.appendChild(card);
  }

  card.dataset.isLocal = isLocal ? 'true' : 'false';
  disposeCard(card);
  card.innerHTML = '';

  // Header do Card
  const header = document.createElement('div');
  header.className = 'video-card-header';

  const title = document.createElement('div');
  title.className = 'streamer-title';

  const liveDot = document.createElement('div');
  liveDot.className = 'live-dot';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'streamer-name';
  labelSpan.textContent = label;

  title.appendChild(liveDot);
  title.appendChild(labelSpan);

  // VU Meter Estéreo no Header
  const vuMeter = document.createElement('div');
  vuMeter.className = 'vu-meter-container';
  vuMeter.title = 'Medidor Estéreo L / R (Áudio do Jogo)';
  vuMeter.innerHTML = `
    <span class="vu-label">L</span>
    <div class="vu-track"><div class="vu-bar" id="vu-l-${peerId}"></div></div>
    <span class="vu-label">R</span>
    <div class="vu-track"><div class="vu-bar" id="vu-r-${peerId}"></div></div>
  `;
  title.appendChild(vuMeter);

  const controls = document.createElement('div');
  controls.className = 'card-controls';

  // Botão de HUD Stats
  const statsBtn = document.createElement('button');
  statsBtn.className = 'card-btn';
  statsBtn.innerText = '📊 Stats';
  statsBtn.title = 'Alternar HUD de FPS, Ping e Bitrate';
  statsBtn.onclick = () => {
    const hud = card.querySelector('.stats-hud');
    if (hud) {
      const isVisible = hud.style.display === 'flex';
      hud.style.display = isVisible ? 'none' : 'flex';
      statsBtn.classList.toggle('card-btn-active', !isVisible);
    }
  };
  controls.appendChild(statsBtn);

  // Botão Mute / Áudio
  let muteBtn = null;
  if (!isLocal) {
    muteBtn = document.createElement('button');
    muteBtn.className = 'card-btn';
    muteBtn.innerHTML = '🔊 Som';
    muteBtn.onclick = () => {
      video.muted = !video.muted;
      muteBtn.innerHTML = video.muted ? '🔇 Mudo' : '🔊 Som';
    };
    controls.appendChild(muteBtn);
  } else {
    // Botão para o streamer ocultar a própria prévia (evita efeito espelho infinito)
    const previewBtn = document.createElement('button');
    previewBtn.className = 'card-btn';
    previewBtn.id = 'toggle-local-preview-btn';
    previewBtn.innerHTML = '👁️ Ocultar Prévia';
    previewBtn.title = 'Ocultar vídeo local para evitar o efeito espelho infinito do navegador';
    let isHidden = false;
    previewBtn.onclick = () => {
      isHidden = !isHidden;
      video.style.opacity = isHidden ? '0' : '1';
      if (isHidden) {
        video._savedSrcObject = video.srcObject;
        video.srcObject = null;
      } else if (video._savedSrcObject) {
        video.srcObject = video._savedSrcObject;
        video.play().catch(() => {});
      }
      previewBtn.innerHTML = isHidden ? '👁️ Mostrar Prévia' : '👁️ Ocultar Prévia';
      previewBtn.classList.toggle('card-btn-active', isHidden);
      const mirrorOverlay = card.querySelector('.local-mirror-overlay');
      if (mirrorOverlay) {
        mirrorOverlay.style.display = isHidden ? 'flex' : 'none';
      }
    };
    controls.appendChild(previewBtn);
  }

  // Botão Redimensionar (Ajustar / Expandir)
  const resizeBtn = document.createElement('button');
  resizeBtn.className = 'card-btn';
  resizeBtn.id = `resize-btn-${peerId}`;
  resizeBtn.innerHTML = '↔️ Expandir';
  resizeBtn.title = 'Alternar entre Modo Contido (ajustado à janela) e Modo Expandido';
  controls.appendChild(resizeBtn);

  // Botão PiP
  const pipBtn = document.createElement('button');
  pipBtn.className = 'card-btn card-btn-pip';
  pipBtn.innerText = '⧉ PiP';
  pipBtn.title = 'Destacar vídeo em janela flutuante Picture-in-Picture';
  pipBtn.onclick = async () => {
    try {
      const ok = await pipController.toggleVideoPip(video, card);
      if (!ok && !pipController.isSupported()) {
        compatibilityContext.showToast('Picture-in-Picture não suportado neste navegador.', 'error');
      }
    } catch (err) {
      compatibilityContext.showToast('Erro ao alternar Picture-in-Picture.', 'error');
    }
  };
  controls.appendChild(pipBtn);

  // Botão Anotar (Telestrator)
  const annotateBtn = document.createElement('button');
  annotateBtn.className = 'card-btn card-btn-annotate';
  annotateBtn.innerText = '✏️ Anotar';
  annotateBtn.title = 'Desenhar e fazer anotações táticas sobre o stream';
  annotateBtn.onclick = () => {
    if (annotateManager.isActive && annotateManager.container === card) {
      annotateManager.detach();
      annotateBtn.classList.remove('card-btn-active');
    } else {
      annotateManager.attach(card, video);
      annotateManager.createToolbar(card);
      annotateBtn.classList.add('card-btn-active');
    }
  };
  controls.appendChild(annotateBtn);

  // Botão de Clipar
  const clipCardBtn = document.createElement('button');
  clipCardBtn.className = 'card-btn card-btn-clip';
  clipCardBtn.innerHTML = '🎬 Clipar';
  clipCardBtn.title = 'Salvar os últimos 30 segundos desta transmissão';
  clipCardBtn.onclick = () => {
    if (typeof onClipClick === 'function') {
      onClipClick(peerId, stream);
      return;
    }
    const globalClipBtn = document.getElementById('clip-btn');
    if (globalClipBtn) {
      globalClipBtn.click();
    } else {
      compatibilityContext.showToast('Gravação de clipe iniciada.', 'info');
    }
  };
  controls.appendChild(clipCardBtn);

  // Botão Fullscreen
  const fsBtn = document.createElement('button');
  fsBtn.className = 'card-btn';
  fsBtn.innerText = '⛶ Tela Cheia';
  fsBtn.title = 'Alternar Tela Cheia (F ou duplo clique)';
  controls.appendChild(fsBtn);

  const toggleFullscreen = () => {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!isFs) {
      const canvas = document.getElementById('ping-canvas');
      const stage = canvas?.parentElement?.contains(card) ? canvas.parentElement : card;
      const resetStage = () => { stage.classList.remove('tactical-fullscreen-stage'); card.classList.remove('fullscreen-card'); };
      stage.classList.add('tactical-fullscreen-stage'); card.classList.add('fullscreen-card');
      if (stage.requestFullscreen) {
        stage.requestFullscreen().then(() => {
          if (!card.isConnected && document.fullscreenElement === stage) return document.exitFullscreen?.();
        }).catch((err) => {
          resetStage();
          console.warn('Falha ao abrir tela cheia:', err);
        });
      } else if (stage.webkitRequestFullscreen) {
        stage.webkitRequestFullscreen();
      } else {
        resetStage();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch((err) => console.warn(err));
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  };
  fsBtn.onclick = toggleFullscreen;

  // Botão Co-op / Player 2 para espectadores
  if (!isLocal) {
    const coopBtn = document.createElement('button');
    coopBtn.className = 'card-btn card-btn-coop';
    coopBtn.id = `btn-coop-${peerId}`;
    coopBtn.innerHTML = '🎮 Pedir Controle';
    coopBtn.title = 'Solicitar ao streamer para jogar como Player 2';
    if (onCoopClick) {
      coopBtn.onclick = () => onCoopClick(peerId);
    }
    controls.appendChild(coopBtn);
  }

  // Badges e Botão de Pânico no Host (Streamer)
  if (isLocal) {
    const hostP2Badge = document.createElement('div');
    hostP2Badge.id = 'host-p2-badge';
    hostP2Badge.style.display = 'none';
    hostP2Badge.className = 'card-badge-p2';
    hostP2Badge.innerHTML = `<span>🎮 P2: <strong id="host-p2-name">--</strong></span>`;
    title.appendChild(hostP2Badge);

    const panicBtn = document.createElement('button');
    panicBtn.id = 'host-panic-btn';
    panicBtn.style.display = 'none';
    panicBtn.className = 'card-btn card-btn-panic';
    panicBtn.innerHTML = '🛑 Revogar P2';
    panicBtn.title = 'Cortar imediatamente o controle do Player 2 (Escape)';
    if (onPanicClick) {
      panicBtn.onclick = () => onPanicClick();
    }
    controls.appendChild(panicBtn);
  }

  // Botão Sair / Encerrar
  const closeBtn = document.createElement('button');
  closeBtn.className = 'card-btn card-btn-danger';
  const roomLobbyLayout = document.body.classList.contains('room-lobby-layout');
  closeBtn.innerText = isLocal ? 'Encerrar' : roomLobbyLayout ? 'Fechar vídeo' : 'Sair';
  closeBtn.onclick = () => {
    if (onDisconnect) {
      onDisconnect(peerId);
    }
  };
  // In the room workspace the dock owns the single stop-stream action.
  if (!isLocal || !roomLobbyLayout) controls.appendChild(closeBtn);

  header.appendChild(title);
  header.appendChild(controls);
  card.appendChild(header);

  // Wrapper do Vídeo
  const videoWrapper = document.createElement('div');
  videoWrapper.className = 'video-wrapper';

  // HUD de Estatísticas em Tempo Real (Inicia com -- em vez de valor fictício)
  const statsHud = createStatsHud(peerId);

  const video = document.createElement('video');
  video.srcObject = compatibilityContext.resolveCardDisplayStream(stream, isLocal);
  video.autoplay = true;
  video.playsInline = true;
  video.controls = false;
  video.muted = isLocal;
  try {
    const savedSpeaker = typeof localStorage !== 'undefined' ? localStorage.getItem('seemygame_audio_output_id') : null;
    if (savedSpeaker && typeof video.setSinkId === 'function') {
      video.setSinkId(savedSpeaker).catch(() => {});
    }
  } catch (e) {}

  // Overlay de transmissão pausada
  const pausedOverlay = document.createElement('div');
  pausedOverlay.className = 'stream-paused-overlay';
  pausedOverlay.id = `paused-overlay-${peerId}`;
  pausedOverlay.style.display = 'none';
  pausedOverlay.innerHTML = `
    <div class="pause-icon">⏸️</div>
    <p style="font-size: 13px; color: var(--text-main);">Transmissão pausada pelo streamer.</p>
  `;

  // Overlay de Unmute caso autoplay seja barrado
  const unmuteOverlay = document.createElement('div');
  unmuteOverlay.className = 'audio-unmute-overlay';
  unmuteOverlay.innerHTML = `
    <p style="font-size: 13px; color: #fff;">O navegador pausou o áudio automático do jogo.</p>
    <button>🔊 Clique para Ativar Áudio Estéreo</button>
  `;

  unmuteOverlay.onclick = () => {
    video.muted = false;
    video.play().catch(e => console.warn(e));
    unmuteOverlay.style.display = 'none';
    compatibilityContext.initAudioAnalyser(stream, peerId, audioScope);
  };

  videoWrapper.appendChild(statsHud);
  videoWrapper.appendChild(video);
  videoWrapper.appendChild(pausedOverlay);
  videoWrapper.appendChild(unmuteOverlay);

  // Duplo clique no vídeo para alternar Tela Cheia
  video.ondblclick = toggleFullscreen;

  // Barra Flutuante de Controles Overlay no Vídeo (Estilo YouTube/Twitch)
  const overlayBar = document.createElement('div');
  overlayBar.className = 'video-overlay-bar';

  // Lado Esquerdo do Overlay
  const overlayLeft = document.createElement('div');
  overlayLeft.className = 'overlay-left';

  const liveBadge = document.createElement('div');
  liveBadge.className = 'overlay-live-badge';
  liveBadge.innerHTML = '<div class="overlay-live-dot"></div> AO VIVO';
  overlayLeft.appendChild(liveBadge);

  // Grupo de Áudio / Volume
  if (!isLocal) {
    const volGroup = document.createElement('div');
    volGroup.className = 'volume-control-group';

    const overlayMuteBtn = document.createElement('button');
    overlayMuteBtn.className = 'overlay-btn';
    overlayMuteBtn.style.padding = '4px 8px';
    overlayMuteBtn.innerHTML = video.muted ? '🔇' : '🔊';
    overlayMuteBtn.title = 'Alternar áudio (M)';

    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.className = 'volume-slider';
    volSlider.min = '0';
    volSlider.max = '1';
    volSlider.step = '0.05';
    volSlider.value = video.muted ? '0' : String(video.volume || 1);
    volSlider.title = 'Ajustar volume da transmissão';

    const updateAudioUI = () => {
      const isMuted = video.muted || video.volume === 0;
      overlayMuteBtn.innerHTML = isMuted ? '🔇' : '🔊';
      if (muteBtn) muteBtn.innerHTML = isMuted ? '🔇 Mudo' : '🔊 Som';
      volSlider.value = isMuted ? '0' : String(video.volume);
    };

    overlayMuteBtn.onclick = (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
      updateAudioUI();
    };

    volSlider.oninput = (e) => {
      e.stopPropagation();
      const val = parseFloat(e.target.value);
      video.volume = val;
      video.muted = (val === 0);
      updateAudioUI();
    };

    volGroup.appendChild(overlayMuteBtn);
    volGroup.appendChild(volSlider);
    overlayLeft.appendChild(volGroup);

    if (muteBtn) {
      muteBtn.onclick = () => {
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) video.volume = 1;
        updateAudioUI();
      };
    }
  }

  // Lado Direito do Overlay
  const overlayRight = document.createElement('div');
  overlayRight.className = 'overlay-right';

  if (!isLocal && onCoopClick) {
    const overlayCoopBtn = document.createElement('button');
    overlayCoopBtn.className = 'overlay-btn';
    overlayCoopBtn.innerHTML = '🎮 Player 2';
    overlayCoopBtn.title = 'Solicitar ao streamer para jogar como Player 2';
    overlayCoopBtn.onclick = (e) => {
      e.stopPropagation();
      onCoopClick(peerId);
    };
    overlayRight.appendChild(overlayCoopBtn);
  }

  // Botão Redimensionar no Overlay
  const overlayResizeBtn = document.createElement('button');
  overlayResizeBtn.className = 'overlay-btn';
  overlayResizeBtn.innerHTML = '↔️ Expandir';
  overlayResizeBtn.title = 'Alternar entre Modo Contido e Modo Expandido';
  overlayRight.appendChild(overlayResizeBtn);

  const toggleResizeMode = () => {
    const isExpanded = card.classList.toggle('expanded-mode');
    const label = isExpanded ? '📐 Ajustar' : '↔️ Expandir';
    const title = isExpanded ? 'Ajustar para caber na janela visível' : 'Expandir para largura total';
    resizeBtn.innerHTML = label;
    resizeBtn.title = title;
    overlayResizeBtn.innerHTML = label;
    overlayResizeBtn.title = title;
    if (document.body) {
      const anyExpanded = document.querySelector('.video-card.expanded-mode') !== null;
      document.body.classList.toggle('has-expanded-video', anyExpanded);
    }
  };
  resizeBtn.onclick = toggleResizeMode;
  overlayResizeBtn.onclick = (e) => {
    e.stopPropagation();
    toggleResizeMode();
  };

  // Botão Stats no Overlay
  const overlayStatsBtn = document.createElement('button');
  overlayStatsBtn.className = 'overlay-btn';
  overlayStatsBtn.innerHTML = '📊 Stats';
  overlayStatsBtn.title = 'Exibir telemetria de FPS e latência WebRTC';
  overlayStatsBtn.onclick = (e) => {
    e.stopPropagation();
    statsBtn.click();
  };
  overlayRight.appendChild(overlayStatsBtn);

  // Botão PiP no Overlay
  const overlayPipBtn = document.createElement('button');
  overlayPipBtn.className = 'overlay-btn';
  overlayPipBtn.innerHTML = '⧉ PiP';
  overlayPipBtn.title = 'Picture-in-Picture';
  overlayPipBtn.onclick = (e) => {
    e.stopPropagation();
    pipBtn.click();
  };
  overlayRight.appendChild(overlayPipBtn);

  // Botão Fullscreen no Overlay (destacado)
  const overlayFsBtn = document.createElement('button');
  overlayFsBtn.className = 'overlay-btn overlay-btn-highlight';
  overlayFsBtn.innerHTML = '⛶ Tela Cheia';
  overlayFsBtn.title = 'Alternar Tela Cheia (F ou duplo clique no vídeo)';
  overlayFsBtn.onclick = (e) => {
    e.stopPropagation();
    toggleFullscreen();
  };
  overlayRight.appendChild(overlayFsBtn);

  overlayBar.appendChild(overlayLeft);
  overlayBar.appendChild(overlayRight);
  videoWrapper.appendChild(overlayBar);

  // Sincroniza indicador de tela cheia
  const handleFsChange = () => {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!isFs) {
      card.classList.remove('fullscreen-card');
      document.querySelectorAll('.tactical-fullscreen-stage').forEach(stage => stage.classList.remove('tactical-fullscreen-stage'));
    }
    fsBtn.innerText = isFs ? '🗗 Restaurar' : '⛶ Tela Cheia';
    overlayFsBtn.innerHTML = isFs ? '🗗 Restaurar' : '⛶ Tela Cheia';
  };
  document.addEventListener('fullscreenchange', handleFsChange);
  document.addEventListener('webkitfullscreenchange', handleFsChange);

  // Auto-hide suave dos controles no vídeo
  let hideControlsTimer = null;
  const cleanup = () => {
    clearTimeout(hideControlsTimer);
    document.removeEventListener('fullscreenchange', handleFsChange);
    document.removeEventListener('webkitfullscreenchange', handleFsChange);
    if (card.classList.contains('fullscreen-card')) {
      card.closest('.tactical-fullscreen-stage')?.classList.remove('tactical-fullscreen-stage');
      const stage = document.fullscreenElement || document.webkitFullscreenElement;
      if (stage?.contains(card)) {
        document.exitFullscreen?.().catch(() => {});
        stage.classList.remove('tactical-fullscreen-stage');
      }
      card.classList.remove('fullscreen-card');
    }
  };
  let unregister = () => {};
  const release = () => { cleanup(); unregister(); };
  cardDisposals.set(card, release);
  unregister = session?.registerCleanup(() => {
    if (cardDisposals.get(card) !== release) return;
    disposeCard(card); card.remove();
    compatibilityContext.stopStatsMonitor(peerId);
    compatibilityContext.stopAudioAnalyser(peerId);
  }) || (() => {});
  const showControls = () => {
    videoWrapper.classList.add('controls-visible');
    if (hideControlsTimer) clearTimeout(hideControlsTimer);
    hideControlsTimer = setTimeout(() => {
      videoWrapper.classList.remove('controls-visible');
    }, 3500);
  };

  videoWrapper.addEventListener('mousemove', showControls);
  videoWrapper.addEventListener('touchstart', showControls, { passive: true });
  videoWrapper.addEventListener('mouseleave', () => {
    if (hideControlsTimer) clearTimeout(hideControlsTimer);
    videoWrapper.classList.remove('controls-visible');
  });

  if (isLocal) {
    const mirrorOverlay = document.createElement('div');
    mirrorOverlay.className = 'local-mirror-overlay';
    mirrorOverlay.style.cssText = 'position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; background: rgba(10, 12, 20, 0.95); z-index: 4; text-align: center; padding: 20px;';
    mirrorOverlay.innerHTML = `
      <div style="font-size: 2.2rem; margin-bottom: 8px;">🎮📡</div>
      <p style="font-weight: 600; color: var(--text-main); margin-bottom: 4px;">Sua transmissão está ativa para os amigos!</p>
      <p style="font-size: 12.5px; color: var(--text-muted); max-width: 320px;">A prévia da sua tela foi pausada aqui para evitar o efeito espelho infinito do navegador.</p>
    `;
    videoWrapper.appendChild(mirrorOverlay);
  }

  card.appendChild(videoWrapper);

  // Inicia o analisador de VU Meter estéreo
  compatibilityContext.initAudioAnalyser(stream, peerId, audioScope);

  const playPromise = video.play();
  if (playPromise !== undefined) {
    playPromise.catch((err) => {
      console.warn("Autoplay bloqueado:", err);
      video.muted = true;
      video.play().catch(e => console.warn(e));
      if (!isLocal) {
        unmuteOverlay.style.display = 'flex';
      }
    });
  }

  compatibilityContext.updateGridEmptyState();
  const reactionsDock = document.getElementById('reactions-dock');
  if (reactionsDock) reactionsDock.style.display = 'flex';
  return { card, video };
}
