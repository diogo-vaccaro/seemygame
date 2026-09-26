import { initAudioAnalyser, stopAudioAnalyser } from './audio.js';
import { stopStatsMonitor } from './stats.js';
import { TERMS_VERSION } from './config.js';

/**
 * Valida o formato e tamanho seguro de um Peer ID
 * @param {string} id
 * @returns {boolean}
 */
export function isValidPeerId(id) {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed);
}

/**
 * Retorna o MediaStream adequado para o elemento <video>.
 * Para a visualização local (preview), se o stream possuir áudio e vídeo juntos,
 * isola apenas a trilha de vídeo para exibição na tela. O áudio já é escutado pelo jogador
 * diretamente pelo sistema operacional. Ao evitar trilhas de áudio no elemento <video> de preview,
 * o Chromium não ativa o mecanismo de sincronização de relógio A/V (AudioRenderer master clock)
 * nem sofre engasgos/congelamentos periódicos de 1 segundo causados por RTCP Sender Reports.
 * @param {MediaStream|null} stream
 * @param {boolean} isLocal
 * @returns {MediaStream|null}
 */
export function resolveCardDisplayStream(stream, isLocal = false) {
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

/**
 * Exibe notificações toast flutuantes na tela (Seguro contra XSS)
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 * @param {number} [duration=4000]
 */
export function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const msgText = String(message);

  // Previne flood de toasts idênticos consecutivos visíveis na tela
  const existingToasts = container.querySelectorAll('.toast');
  for (const existing of existingToasts) {
    if (existing.querySelector('span')?.textContent === msgText) {
      return;
    }
  }

  // Limite máximo de toasts empilhados simultaneamente (descarta os mais antigos para evitar flood)
  const MAX_VISIBLE_TOASTS = 4;
  if (existingToasts.length >= MAX_VISIBLE_TOASTS) {
    for (let i = 0; i <= existingToasts.length - MAX_VISIBLE_TOASTS; i++) {
      existingToasts[i].remove();
    }
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '✓',
    info: 'ℹ',
    error: '⚠'
  };

  const iconStrong = document.createElement('strong');
  iconStrong.textContent = icons[type] || '•';

  const msgSpan = document.createElement('span');
  msgSpan.textContent = msgText;

  toast.appendChild(iconStrong);
  toast.appendChild(document.createTextNode(' '));
  toast.appendChild(msgSpan);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, duration);
}

/**
 * Inicializa o modal de termos de uso e verificação de maioridade
 * @param {Function} [onAcceptCallback]
 */
export function initTermsModal(onAcceptCallback) {
  const modal = document.getElementById('terms-modal');
  const checkAge = document.getElementById('check-age');
  const checkTerms = document.getElementById('check-terms');
  const acceptBtn = document.getElementById('accept-btn');
  const openTermsLink = document.getElementById('open-terms-link');

  if (!modal || !checkAge || !checkTerms || !acceptBtn) return;

  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  function updateAcceptButton() {
    const isBothChecked = Boolean(checkAge.checked && checkTerms.checked);
    acceptBtn.disabled = !isBothChecked;
    acceptBtn.setAttribute('aria-disabled', String(!isBothChecked));
    if (isBothChecked) {
      acceptBtn.removeAttribute('disabled');
      acceptBtn.classList.remove('disabled');
    } else {
      acceptBtn.setAttribute('disabled', 'true');
      acceptBtn.classList.add('disabled');
    }
  }

  // Registra múltiplos eventos (change, input, click) para máxima compatibilidade em navegadores e WebView2
  if (!modal.dataset.termsInitialized) {
    modal.dataset.termsInitialized = 'true';

    ['change', 'input', 'click'].forEach((evt) => {
      checkAge.addEventListener(evt, updateAcceptButton);
      checkTerms.addEventListener(evt, updateAcceptButton);
    });

    acceptBtn.addEventListener('click', () => {
      if (!checkAge.checked || !checkTerms.checked) {
        updateAcceptButton();
        return;
      }

      try {
        localStorage.setItem('seemygame_terms_version', TERMS_VERSION);
        localStorage.setItem('seemygame_terms_accepted', 'true');
      } catch (e) {}

      modal.style.display = 'none';
      showToast('Termos aceitos com sucesso!', 'success');

      if (typeof onAcceptCallback === 'function') {
        onAcceptCallback();
      }
    });

    if (openTermsLink) {
      openTermsLink.addEventListener('click', () => {
        checkAge.checked = true;
        checkTerms.checked = true;
        updateAcceptButton();
        modal.style.display = 'flex';
      });
    }
  }

  // Sincroniza o botão imediatamente de acordo com o estado atual dos checkboxes
  updateAcceptButton();

  let acceptedVersion = null;
  let legacyAccepted = false;
  try {
    acceptedVersion = localStorage.getItem('seemygame_terms_version');
    legacyAccepted = localStorage.getItem('seemygame_terms_accepted') === 'true';
  } catch (e) {}

  if (acceptedVersion === TERMS_VERSION || (legacyAccepted && !acceptedVersion)) {
    modal.style.display = 'none';
  } else {
    modal.style.display = 'flex';
  }
}

/**
 * Atualiza a visibilidade do estado vazio da grade de vídeos
 */
export function updateGridEmptyState() {
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

/**
 * Cria um cartão temporário com animação de carregamento enquanto conecta (Seguro contra XSS)
 * @param {string} peerId
 * @param {string} initialText
 * @param {Function} onDisconnect
 */
export function createPlaceholderCard(peerId, initialText, onDisconnect) {
  const grid = document.getElementById('video-grid');
  if (!grid) return;

  // Validação de segurança de ID
  if (!isValidPeerId(peerId)) {
    showToast('ID inválido para criação de cartão.', 'error');
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

  updateGridEmptyState();
}

/**
 * Atualiza o texto do overlay de status de um cartão
 * @param {string} peerId
 * @param {string} message
 */
export function updateCardStatus(peerId, message) {
  const statusOverlay = document.getElementById(`status-${peerId}`);
  if (statusOverlay) {
    const textElem = statusOverlay.querySelector('p');
    if (textElem) textElem.innerText = message;
  }
}

/**
 * Oculta o overlay de carregamento quando o stream é recebido
 * @param {string} peerId
 */
export function hideCardLoading(peerId) {
  const statusOverlay = document.getElementById(`status-${peerId}`);
  if (statusOverlay) {
    statusOverlay.style.display = 'none';
  }
}

/**
 * Altera visualmente o overlay de status de pausa da transmissão
 * @param {string} peerId
 * @param {boolean} isPaused
 * @param {string} [message='Transmissão pausada pelo streamer.']
 */
export function setCardStreamPaused(peerId, isPaused, message = 'Transmissão pausada pelo streamer.') {
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

/**
 * Remove o cartão de vídeo e interrompe monitorias associadas
 * @param {string} peerId
 */
export function removeVideoCard(peerId) {
  const card = document.getElementById(`card-${peerId}`);
  if (card) card.remove();
  stopStatsMonitor(peerId);
  stopAudioAnalyser(peerId);
  updateGridEmptyState();
}

/**
 * Adiciona ou atualiza o player de vídeo na grade com controles de stats, som, PiP e tela cheia
 * @param {Object} options
 * @param {MediaStream} options.stream
 * @param {string} options.peerId
 * @param {string} options.label
 * @param {boolean} [options.isLocal=false]
 * @param {Function} [options.onDisconnect]
 */
export function addOrUpdateVideoCard({ stream, peerId, label, isLocal = false, onDisconnect, onCoopClick, onPanicClick, onClipClick }) {
  const grid = document.getElementById('video-grid');
  if (!grid) return null;

  if (!isValidPeerId(peerId) && peerId !== 'local-me') {
    showToast('ID inválido para adicionar cartão de vídeo.', 'error');
    return null;
  }

  let card = document.getElementById(`card-${peerId}`);
  if (card) {
    const existingVideo = card.querySelector('video');
    const wasLocal = card.dataset.isLocal === 'true';
    if (existingVideo && wasLocal === isLocal) {
      const resolvedStream = resolveCardDisplayStream(stream, isLocal);
      if (existingVideo.srcObject !== resolvedStream) {
        existingVideo.srcObject = resolvedStream;
      }
      setCardStreamPaused(peerId, false);
      hideCardLoading(peerId);

      const labelSpan = card.querySelector('.streamer-name') || card.querySelector('.streamer-title span');
      if (labelSpan && label) {
        labelSpan.textContent = label;
      }

      initAudioAnalyser(stream, peerId);

      const playPromise = existingVideo.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('Autoplay bloqueado na reconexão:', err);
          if (!isLocal) {
            const unmuteOverlay = card.querySelector('.audio-unmute-overlay');
            if (unmuteOverlay) unmuteOverlay.style.display = 'flex';
          }
        });
      }

      updateGridEmptyState();
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
  pipBtn.className = 'card-btn';
  pipBtn.innerText = '⧉ PiP';
  pipBtn.onclick = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      showToast('Picture-in-Picture não suportado.', 'error');
    }
  };
  controls.appendChild(pipBtn);

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
      showToast('Gravação de clipe iniciada.', 'info');
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
      if (video.requestFullscreen) {
        video.requestFullscreen().catch((err) => {
          console.warn('Falha ao abrir tela cheia:', err);
        });
      } else if (video.webkitRequestFullscreen) {
        video.webkitRequestFullscreen();
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
  closeBtn.innerText = isLocal ? 'Encerrar' : 'Sair';
  closeBtn.onclick = () => {
    if (onDisconnect) {
      onDisconnect(peerId);
    }
  };
  controls.appendChild(closeBtn);

  header.appendChild(title);
  header.appendChild(controls);
  card.appendChild(header);

  // Wrapper do Vídeo
  const videoWrapper = document.createElement('div');
  videoWrapper.className = 'video-wrapper';

  // HUD de Estatísticas em Tempo Real (Inicia com -- em vez de valor fictício)
  const statsHud = document.createElement('div');
  statsHud.className = 'stats-hud';
  statsHud.innerHTML = `
    <div class="stats-row"><span class="stats-label">Taxa de Quadros:</span> <span class="stats-val stats-val-green" id="stat-fps-${peerId}">-- FPS</span></div>
    <div class="stats-row"><span class="stats-label">Latência (RTT):</span> <span class="stats-val stats-val-green" id="stat-rtt-${peerId}">-- ms</span></div>
    <div class="stats-row"><span class="stats-label">Bitrate:</span> <span class="stats-val" id="stat-bitrate-${peerId}">-- Mbps</span></div>
    <div class="stats-row"><span class="stats-label">Resolução:</span> <span class="stats-val" id="stat-res-${peerId}">--</span></div>
    <div class="stats-row"><span class="stats-label">Prioridade:</span> <span class="stats-val stats-val-purple">Máxima Fluidez</span></div>
  `;

  const video = document.createElement('video');
  video.srcObject = resolveCardDisplayStream(stream, isLocal);
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
    initAudioAnalyser(stream, peerId);
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
    fsBtn.innerText = isFs ? '🗗 Restaurar' : '⛶ Tela Cheia';
    overlayFsBtn.innerHTML = isFs ? '🗗 Restaurar' : '⛶ Tela Cheia';
  };
  document.addEventListener('fullscreenchange', handleFsChange);
  document.addEventListener('webkitfullscreenchange', handleFsChange);

  // Auto-hide suave dos controles no vídeo
  let hideControlsTimer = null;
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
      <p style="font-weight: 600; color: #fff; margin-bottom: 4px;">Sua transmissão está ativa para os amigos!</p>
      <p style="font-size: 12.5px; color: var(--text-muted); max-width: 320px;">A prévia da sua tela foi pausada aqui para evitar o efeito espelho infinito do navegador.</p>
    `;
    videoWrapper.appendChild(mirrorOverlay);
  }

  card.appendChild(videoWrapper);

  // Inicia o analisador de VU Meter estéreo
  initAudioAnalyser(stream, peerId);

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

  updateGridEmptyState();
  const reactionsDock = document.getElementById('reactions-dock');
  if (reactionsDock) reactionsDock.style.display = 'flex';
  return { card, video };
}

/**
 * Exibe o modal de solicitação de controle do Player 2 para o streamer
 * @param {string} requesterId
 * @param {Function} onApprove
 * @param {Function} onDeny
 */
export function showCoopPromptModal(requesterId, onApprove, onDeny) {
  const modal = document.getElementById('coop-modal');
  const reqIdSpan = document.getElementById('coop-requester-id');
  const approveBtn = document.getElementById('coop-approve-btn');
  const denyBtn = document.getElementById('coop-deny-btn');
  if (!modal) return;

  if (reqIdSpan) reqIdSpan.textContent = requesterId.slice(0, 8);
  modal.style.display = 'flex';

  if (approveBtn) {
    approveBtn.onclick = () => {
      modal.style.display = 'none';
      if (onApprove) onApprove();
    };
  }

  if (denyBtn) {
    denyBtn.onclick = () => {
      modal.style.display = 'none';
      if (onDeny) onDeny();
    };
  }
}

/**
 * Atualiza visualmente o estado de Co-op nos cards (Host e Espectador)
 * @param {Object} state
 */
export function updateCoopUI(state) {
  // 1. Host side: badges e botão de pânico
  const hostP2Badge = document.getElementById('host-p2-badge');
  const hostP2Name = document.getElementById('host-p2-name');
  const hostPanicBtn = document.getElementById('host-panic-btn');

  if (state.activePlayer2PeerId) {
    if (hostP2Badge) hostP2Badge.style.display = 'inline-flex';
    if (hostP2Name) hostP2Name.textContent = state.activePlayer2PeerId.slice(0, 6);
    if (hostPanicBtn) hostPanicBtn.style.display = 'inline-flex';
  } else {
    if (hostP2Badge) hostP2Badge.style.display = 'none';
    if (hostPanicBtn) hostPanicBtn.style.display = 'none';
  }

  // 2. Viewer side: botões de pedir/liberar controle
  if (state.activeHostPeerId) {
    const btn = document.getElementById(`btn-coop-${state.activeHostPeerId}`);
    if (btn) {
      if (state.isPlayer2) {
        btn.innerHTML = '🎮 Liberar P2';
        btn.classList.add('card-btn-p2-active');
        btn.title = 'Você está controlando. Clique para liberar o controle.';
      } else {
        btn.innerHTML = '🎮 Pedir Controle';
        btn.classList.remove('card-btn-p2-active');
        btn.title = 'Solicitar ao streamer para jogar como Player 2';
      }
    }
  }
}

/**
 * Renderiza ou atualiza o dock de slots de jogadores Co-op
 */
export function renderCoopLobbyDock(slots = [], isHost = false, options = {}) {
  // Safe stub/renderer para slots coop no lobby
}

