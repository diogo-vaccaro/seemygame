import { reconcileRelayRoute } from './media-calls.js';
/** capture-session: commands receive explicit compatibility ports; no page initialization. */
export async function startLocalStream(compatibilityContext, options = {}) {
  // Prevenção de condições de corrida (duplo clique durante permissão do navegador)
  if (compatibilityContext.isStartingStream) return;

  if (compatibilityContext.localStream) {
    compatibilityContext.stopLocalStream();
    return;
  }

  compatibilityContext.isStartingStream = true;
  if (compatibilityContext.streamBtn) compatibilityContext.streamBtn.disabled = true;

  const audioMode = compatibilityContext.audioModeSelect ? compatibilityContext.audioModeSelect.value : 'system';

  // Restrições de vídeo com Alvo de 60 FPS
  const videoConstraints = {
    width: { ideal: compatibilityContext.selectedProfile.width, max: 1920 },
    height: { ideal: compatibilityContext.selectedProfile.height, max: 1080 },
    frameRate: { ideal: 60, max: 60 },
    cursor: (compatibilityContext.captureCursorToggle && !compatibilityContext.captureCursorToggle.checked) ? 'never' : 'always'
  };

  let capturedDisplayStream = null;
  let capturedMicStream = null;

  try {
    let effectiveAudioMode = audioMode;
    if (effectiveAudioMode === 'process') {
      if (compatibilityContext.isDesktopApp()) {
        const caps = await compatibilityContext.getNativeCaptureCapabilities().catch(() => ({}));
        if (!caps.supports_process_audio) {
          compatibilityContext.showToast('⚠️ Áudio exclusivo de janela requer Windows 11+ e não é suportado pelo Windows 10. Selecione "Áudio do Jogo / Sistema".', 'warning', 6000);
          if (compatibilityContext.audioModeSelect) compatibilityContext.audioModeSelect.value = 'system';
          compatibilityContext.isStartingStream = false;
          if (compatibilityContext.streamBtn) compatibilityContext.streamBtn.disabled = false;
          return;
        }
      }
    }
    const wantSystemAudio = (effectiveAudioMode === 'system' || effectiveAudioMode === 'process');

    if (compatibilityContext.isDesktopApp() && (options.sourceId || options.sourceType)) {
      compatibilityContext.showToast('Iniciando captura nativa...', 'info', 2500);
      const nativeProvider = new compatibilityContext.NativeCaptureProvider();
      const chosenCodec = compatibilityContext.videoCodecSelect ? compatibilityContext.videoCodecSelect.value : (options.videoCodec || null);
      const chosenEncoder = compatibilityContext.h264EncoderSelect ? compatibilityContext.h264EncoderSelect.value : (options.h264Encoder || null);
      const chosenCursor = compatibilityContext.captureCursorToggle ? compatibilityContext.captureCursorToggle.checked : (options.showCursor !== false);
      const chosenExcludeApp = options.excludeApp || compatibilityContext.getSelectedAudioExclusionApp();
      const result = await nativeProvider.start({
        sourceId: options.sourceId,
        sourceType: options.sourceType || 'window',
        audioMode: wantSystemAudio ? effectiveAudioMode : 'none',
        videoCodec: chosenCodec,
        h264Encoder: chosenEncoder,
        captureBackend: document.getElementById('capture-backend-select')?.value || options.captureBackend || null,
        captureApi: document.getElementById('capture-method-select')?.value || options.captureApi || null,
        showCursor: chosenCursor,
        width: compatibilityContext.selectedProfile.width,
        height: compatibilityContext.selectedProfile.height,
        fps: compatibilityContext.selectedProfile.fps || 60,
        bitrateKbps: Math.round(compatibilityContext.customBitrateBps / 1000) || 8000,
        excludeApp: chosenExcludeApp
      });
      capturedDisplayStream = result.stream;
      compatibilityContext.activeNativeCaptureProvider = nativeProvider;
    } else {
      try {
        capturedDisplayStream = await compatibilityContext.requestBrowserDisplayMedia({
          video: videoConstraints,
          audioMode: effectiveAudioMode,
          displaySurface: options.displaySurface,
          monitorTypeSurfaces: options.monitorTypeSurfaces
        });
        console.log('[Capture Browser] Trilhas capturadas:', {
          video: capturedDisplayStream.getVideoTracks().map(t => ({ id: t.id, label: t.label, enabled: t.enabled, readyState: t.readyState, settings: t.getSettings?.() })),
          audio: capturedDisplayStream.getAudioTracks().map(t => ({ id: t.id, label: t.label, enabled: t.enabled, readyState: t.readyState, settings: t.getSettings?.() }))
        });
      } catch (captureErr) {
        // Se o usuário cancelou o seletor do navegador
        if (captureErr.name === 'NotAllowedError') {
          return;
        }

        throw captureErr;
      }
    }

    compatibilityContext.localStream = capturedDisplayStream;
    let replayPref = null;
    try { replayPref = localStorage.getItem('seemygame_replay_enabled'); } catch (_) {}
    const shouldRecordReplay = options.replayEnabled !== undefined
      ? options.replayEnabled
      : (replayPref !== 'false');
    if (shouldRecordReplay) {
      compatibilityContext.clipRecorder.start(compatibilityContext.localStream, 'local');
    }
    if (wantSystemAudio) {
      if (compatibilityContext.localStream.getAudioTracks().length > 0) {
        compatibilityContext.capturedSystemAudioTrack = compatibilityContext.localStream.getAudioTracks()[0];
      } else if (!compatibilityContext.isDesktopApp()) {
        compatibilityContext.showToast('Aviso: Nenhuma trilha de áudio capturada. Se estiver compartilhando janela/tela, marque "Compartilhar áudio" no seletor do navegador.', 'info', 6000);
      }
    }

    // Se selecionou Microfone, captura e anexa a trilha de voz com filtro High-Pass e Noise Gate
    if (audioMode === 'mic') {
      try {
        capturedMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        if (compatibilityContext.activeMicProcessor) {
          compatibilityContext.activeMicProcessor.destroy();
          compatibilityContext.activeMicProcessor = null;
        }
        compatibilityContext.activeMicProcessor = compatibilityContext.applyMicrophoneProcessing(capturedMicStream);
        const micTrack = compatibilityContext.activeMicProcessor.processedStream.getAudioTracks()[0] || capturedMicStream.getAudioTracks()[0];
        if (micTrack) {
          compatibilityContext.localStream.addTrack(micTrack);
        }
      } catch (micErr) {
        console.warn('Microfone não concedido:', micErr);
        compatibilityContext.showToast('Aviso: Permissão do microfone não concedida.', 'info');
      }
    }

    const videoTrack = compatibilityContext.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = 'motion';
    }

    const hasAudio = compatibilityContext.localStream.getAudioTracks().length > 0;
    if (hasAudio) {
      const label = audioMode === 'mic' ? 'Microfone' : 'Áudio do jogo (sistema)';
      compatibilityContext.showToast(`${label} capturado com sucesso!`, 'success');
    } else if (wantSystemAudio) {
      compatibilityContext.showToast('O navegador entregou apenas vídeo. Para incluir som, reinicie o compartilhamento e verifique a opção de áudio no seletor.', 'info', 6000);
    } else {
      compatibilityContext.showToast('Transmissão iniciada (modo sem áudio).', 'info');
    }

    compatibilityContext.addOrUpdateVideoCard({
      stream: compatibilityContext.localStream,
      peerId: 'local-me',
      label: 'Minha Transmissão (Você)',
      isLocal: true,
      onDisconnect: () => compatibilityContext.stopLocalStream(),
      onPanicClick: () => compatibilityContext.revokePlayer2()
    });

    const reactionsDock = document.getElementById('reactions-dock');
    if (reactionsDock) reactionsDock.style.display = 'flex';

    // Inicia escuta para Companion Agent Windows (jogos PC nativos)
    compatibilityContext.initCompanionAgentConnection();
    
    if (compatibilityContext.streamBtn) {
      compatibilityContext.streamBtn.innerHTML = '<span>🛑</span> Parar Transmissão';
      compatibilityContext.streamBtn.classList.add('btn-stop');
    }

    if (compatibilityContext.discordUI) {
      compatibilityContext.discordUI.setStreamingState(true);
      compatibilityContext.discordUI.syncStageView(true);
    }

    if (compatibilityContext.roomManager) {
      if (compatibilityContext.isTreeRelayEnabled && compatibilityContext.peer) {
        if (!compatibilityContext.roomRelayManager) {
          compatibilityContext.roomRelayManager = new compatibilityContext.RelayManager({
            originPeerId: compatibilityContext.peer.id,
            maxDirectViewers: compatibilityContext.DEFAULT_MAX_DIRECT_VIEWERS,
            onRouteChange: (...args) => reconcileRelayRoute(compatibilityContext, ...args),
            onTopologyChange: (topo) => {
              console.log(`[RelayTree] Topologia atualizada: ${topo.directCount} diretos, ${topo.relayedCount} relays. Total: ${topo.totalViewers}`);
            },
            onFailover: (childId, newParentId, role) => {
              console.log(`[RelayTree] Failover para ${childId}: novo pai = ${newParentId} (${role})`);
            }
          });
        } else {
          compatibilityContext.roomRelayManager.setOrigin(compatibilityContext.peer.id);
        }
      }

      compatibilityContext.roomManager.setLocalStreaming(true, {
        title: 'Jogo / Tela',
        preset: compatibilityContext.selectedProfile.id,
        fps: compatibilityContext.selectedProfile.fps,
        height: compatibilityContext.selectedProfile.height,
        audioMode: compatibilityContext.audioModeSelect ? compatibilityContext.audioModeSelect.value : 'system'
      });
      compatibilityContext.roomManager.meshConnections.forEach((conn, viewerId) => {
        if (compatibilityContext.roomManager.isPeerAuthorized(viewerId)) {
          if (conn && conn.open) {
            try { conn.send({ type: 'STREAM_STATUS', isStreaming: true }); } catch (_) {}
          }
          compatibilityContext.initiateMediaCallToViewer(viewerId);
        }
      });
    }

    // Notifica e chama todos os espectadores autorizados fora da malha da sala
    compatibilityContext.connectedViewers.forEach((conn, viewerId) => {
      const alreadyInRoomMesh = Boolean(compatibilityContext.roomManager && compatibilityContext.roomManager.meshConnections.has(viewerId));
      if (!alreadyInRoomMesh && compatibilityContext.isPeerAuthorizedForMedia(viewerId)) {
        if (conn && conn.open) {
          try { conn.send({ type: 'STREAM_STATUS', isStreaming: true }); } catch (_) {}
        }
        compatibilityContext.initiateMediaCallToViewer(viewerId);
      }
    });

    compatibilityContext.showToast(`Transmissão ativa em alta fluidez (${(compatibilityContext.customBitrateBps / 1000000).toFixed(1)} Mbps)!`, 'success');

    videoTrack.onended = () => {
      compatibilityContext.stopLocalStream();
    };

  } catch (err) {
    console.error('Erro ao capturar tela:', err);
    // Limpeza de streams parciais em caso de erro
    if (capturedDisplayStream) {
      capturedDisplayStream.getTracks().forEach(t => t.stop());
    }
    if (capturedMicStream) {
      capturedMicStream.getTracks().forEach(t => t.stop());
    }
    compatibilityContext.localStream = null;

    if (err.name !== 'NotAllowedError') {
      const errMsg = String(err?.message || '').toLowerCase();
      if (errMsg.includes('could not start audio source') || errMsg.includes('audio source') || err.name === 'NotReadableError') {
        compatibilityContext.showToast('⚠️ O navegador não conseguiu capturar o áudio da Tela Inteira neste fone. Para transmitir com som, selecione a aba "Janela" ao compartilhar (áudio de processo isolado) ou use o App Desktop.', 'error', 10000);
      } else {
        compatibilityContext.showToast(`Erro ao iniciar stream: ${err.message}`, 'error');
      }
    }
  } finally {
    compatibilityContext.isStartingStream = false;
    if (compatibilityContext.streamBtn) {
      compatibilityContext.streamBtn.disabled = false;
    }
  }
}

export function stopLocalStream(compatibilityContext) {
  compatibilityContext.clipRecorder.stop('local');
  if (compatibilityContext.activeNativeCaptureProvider) {
    const sessionId = compatibilityContext.activeNativeCaptureProvider.session?.sessionId;
    if (sessionId && compatibilityContext.isDesktopApp()) {
      for (const viewerId of compatibilityContext.activeNativeViewerPeers) {
        compatibilityContext.closeNativeViewerPeer(sessionId, viewerId).catch(() => {});
      }
      compatibilityContext.activeNativeViewerPeers.clear();
      compatibilityContext.activeDirectSignaling.clear();
    }
    compatibilityContext.activeNativeCaptureProvider.stop().catch(() => {});
    compatibilityContext.activeNativeCaptureProvider = null;
  }
  if (compatibilityContext.localStream) {
    const stream = compatibilityContext.localStream;
    compatibilityContext.localStream = null;
    stream.getTracks().forEach(track => track.stop());
  }

  if (compatibilityContext.capturedSystemAudioTrack) {
    try { compatibilityContext.capturedSystemAudioTrack.stop(); } catch (e) {}
    compatibilityContext.capturedSystemAudioTrack = null;
  }
  if (compatibilityContext.capturedMicStream) {
    try { compatibilityContext.capturedMicStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    compatibilityContext.capturedMicStream = null;
  }
  if (compatibilityContext.activeMicProcessor) {
    compatibilityContext.activeMicProcessor.destroy();
    compatibilityContext.activeMicProcessor = null;
  }

  // Revoga Player 2 se houver algum conectado
  const coopState = compatibilityContext.getCoopState();
  if (coopState.activePlayer2PeerId) {
    compatibilityContext.revokePlayer2();
  }

  // Fecha explicitamente todas as chamadas de mídia ativas dos espectadores
  compatibilityContext.activeMediaCalls.forEach((call, viewerId) => {
    try {
      call.close();
    } catch (e) {}
    compatibilityContext.stopStatsMonitor(viewerId);
  });
  compatibilityContext.activeMediaCalls.clear();

  compatibilityContext.removeVideoCard('local-me');
  compatibilityContext.stopStatsMonitor('local-me');

  if (compatibilityContext.streamBtn) {
    compatibilityContext.streamBtn.innerHTML = '<span>🚀</span> Transmitir Jogo';
    compatibilityContext.streamBtn.classList.remove('btn-stop');
  }

  if (compatibilityContext.discordUI) {
    compatibilityContext.discordUI.setStreamingState(false);
    if (compatibilityContext.watchingHosts.size === 0) {
      compatibilityContext.discordUI.syncStageView(false);
    }
  }

  if (compatibilityContext.roomManager) {
    compatibilityContext.roomManager.setLocalStreaming(false);
  }

  if (compatibilityContext.roomRelayManager) {
    compatibilityContext.roomRelayManager = null;
  }

  compatibilityContext.connectedViewers.forEach((conn) => {
    conn.send({ type: 'STREAM_STOPPED' });
  });

  compatibilityContext.updateViewerCountUI();
  compatibilityContext.showToast('Transmissão encerrada.', 'info');
}

export async function initDesktopSupport(compatibilityContext) {
  if (!compatibilityContext.isDesktopApp()) return null;

  const desktopBadge = document.getElementById('desktop-badge');
  if (desktopBadge) {
    desktopBadge.style.display = 'inline-flex';
  }

  // Eleva a prioridade de processo imediatamente para alta prioridade de GPU
  await compatibilityContext.setHighPriority();

  // Escuta candidatos ICE da ponte Rust para espectadores
  await compatibilityContext.setupNativeBridgeListener();

  // Sincroniza capacidades de áudio (desabilita áudio de janela isolada no Windows 10)
  await compatibilityContext.syncAudioModeCapabilities();

  const desktopPickerModal = document.getElementById('desktop-picker-modal');
  const desktopWindowsList = document.getElementById('desktop-windows-list');
  const pickerRefreshBtn = document.getElementById('picker-refresh-btn');
  const pickerCancelBtn = document.getElementById('picker-cancel-btn');
  const pickerScreenFallbackBtn = document.getElementById('picker-screen-fallback-btn');
  const captureMethod = document.getElementById('capture-method-select');

  async function refreshWindowsList() {
    if (!desktopWindowsList) return;
    desktopWindowsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px;">🔍 Buscando jogos e janelas ativas no Windows...</div>';

    await compatibilityContext.syncAudioExclusionOptions().catch(() => {});

    const pickerNativeStatus = document.getElementById('picker-native-status');
    try {
      const caps = await compatibilityContext.getNativeCaptureCapabilities();
      if (caps && (caps.available || caps.provider === 'native') && pickerNativeStatus) {
        pickerNativeStatus.textContent = captureMethod?.value === 'dxgi'
          ? 'Método selecionado: DXGI — compartilha tudo que aparecer no monitor inteiro.'
          : 'Captura Nativa Ativa: Windows Graphics Capture';
      }
    } catch (e) {}

    let sources = await compatibilityContext.getCapturableSources();
    if (!sources || sources.length === 0) {
      sources = await compatibilityContext.getCapturableWindows();
    }

    if (!sources || sources.length === 0) {
      desktopWindowsList.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 20px;">
          Nenhum jogo em janela detectado no momento.<br>
          <small>Você pode iniciar a transmissão de tela inteira abaixo.</small>
        </div>
      `;
      return;
    }

    desktopWindowsList.innerHTML = '';

    const monitors = sources.filter(s => s.sourceType === 'monitor' || s.source_type === 'monitor');
    const windows = sources.filter(s => s.sourceType !== 'monitor' && s.source_type !== 'monitor');

    if (monitors.length > 0) {
      const monHeader = document.createElement('div');
      monHeader.style.padding = '8px 4px 4px 4px';
      monHeader.style.fontWeight = 'bold';
      monHeader.style.color = 'var(--text-muted, #9ca3af)';
      monHeader.textContent = 'Telas Inteiras / Monitores';
      desktopWindowsList.appendChild(monHeader);

      monitors.forEach(mon => {
        const item = document.createElement('div');
        item.className = 'window-item';
        item.innerHTML = `
          <div class="window-info">
            <span class="window-title" title="${mon.title}">🖥️ ${mon.title}</span>
          </div>
          <button class="window-action-btn">Transmitir</button>
        `;
        item.addEventListener('click', () => {
          if (desktopPickerModal) desktopPickerModal.style.display = 'none';
          compatibilityContext.startLocalStream({ sourceId: mon.sourceId || mon.id, sourceType: 'monitor', excludeApp: compatibilityContext.getSelectedAudioExclusionApp() });
        });
        desktopWindowsList.appendChild(item);
      });
    }

    if (windows.length > 0) {
      const winHeader = document.createElement('div');
      winHeader.style.padding = '8px 4px 4px 4px';
      winHeader.style.fontWeight = 'bold';
      winHeader.style.color = 'var(--text-muted, #9ca3af)';
      winHeader.textContent = 'Jogos e Janelas Ativas';
      desktopWindowsList.appendChild(winHeader);

      windows.forEach(win => {
        const item = document.createElement('div');
        item.className = 'window-item';
        item.innerHTML = `
          <div class="window-info">
            <span class="window-title" title="${win.title}">🎮 ${win.title}</span>
            <span class="window-process">${win.processName || win.process_name || 'Processo Windows'}</span>
          </div>
          <button class="window-action-btn">Transmitir</button>
        `;
        item.querySelector('button').disabled = captureMethod?.value === 'dxgi';
        if (captureMethod?.value === 'dxgi') item.title = 'Escolha WGC ou Automático para compartilhar somente esta janela.';
        item.addEventListener('click', () => {
          if (captureMethod?.value === 'dxgi') {
            compatibilityContext.showToast('DXGI captura somente um monitor inteiro. Escolha WGC ou Automático para compartilhar uma janela.', 'info');
            return;
          }
          if (desktopPickerModal) desktopPickerModal.style.display = 'none';
          compatibilityContext.startLocalStream({ sourceId: win.sourceId || win.id, sourceType: 'window', excludeApp: compatibilityContext.getSelectedAudioExclusionApp() });
        });
        desktopWindowsList.appendChild(item);
      });
    }
  }

  if (pickerRefreshBtn) {
    pickerRefreshBtn.addEventListener('click', refreshWindowsList);
  }

  if (pickerCancelBtn && desktopPickerModal) {
    pickerCancelBtn.addEventListener('click', () => {
      desktopPickerModal.style.display = 'none';
    });
  }

  if (pickerScreenFallbackBtn && desktopPickerModal) {
    pickerScreenFallbackBtn.addEventListener('click', async () => {
      desktopPickerModal.style.display = 'none';
      try {
        let sources = await compatibilityContext.getCapturableSources().catch(() => []);
        if (!sources || sources.length === 0) sources = await compatibilityContext.getCapturableWindows().catch(() => []);
        const mon = sources?.find(s => s.sourceType === 'monitor' || s.source_type === 'monitor');
        if (mon) {
          compatibilityContext.startLocalStream({ sourceId: mon.sourceId || mon.id, sourceType: 'monitor', excludeApp: compatibilityContext.getSelectedAudioExclusionApp() });
          return;
        }
      } catch (_) {}
      compatibilityContext.startLocalStream({ excludeApp: compatibilityContext.getSelectedAudioExclusionApp() });
    });
  }

  return { refreshWindowsList };
}
