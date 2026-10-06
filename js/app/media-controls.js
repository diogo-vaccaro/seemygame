import { syncStreamingOptions } from '../streaming/options-ui.js';
/** media-controls: commands receive explicit compatibility ports; no page initialization. */
export function syncClipDurationUI(compatibilityContext, seconds) {
  const num = Number(seconds);
  const valStr = String(isNaN(num) || num < 0 ? 30 : num);
  const displayLabel = num === 0 ? 'Full (Toda a Sessão)' : `${num}s`;

  const bufferSelect = document.getElementById('clip-buffer-duration-select') || compatibilityContext.clipBufferDurationSelect;
  const bufferVal = document.getElementById('clip-buffer-duration-val') || compatibilityContext.clipBufferDurationVal;
  const modalSelect = document.getElementById('clip-modal-duration-select');

  if (bufferSelect) bufferSelect.value = valStr;
  if (bufferVal) bufferVal.textContent = displayLabel;
  if (modalSelect) modalSelect.value = valStr;
}

export function syncH264EncoderVisibility(compatibilityContext) {
  syncStreamingOptions({ desktop: compatibilityContext.isDesktopApp() });
}

export function syncMediaControlsEnvironment(compatibilityContext) {
  const desktop = compatibilityContext.isDesktopApp();
  const group = document.getElementById('desktop-audio-exclusion-group') || compatibilityContext.desktopAudioExclusionGroup;
  if (group) group.style.display = desktop && compatibilityContext.audioModeSelect?.value === 'system' ? 'block' : 'none';
  syncStreamingOptions({ desktop });
}

export async function queueNativeReconfigure(compatibilityContext, params) {
  if (!compatibilityContext.activeNativeCaptureProvider?.session?.sessionId) return;
  compatibilityContext.pendingNativeReconfig = params;
  if (compatibilityContext.isNativeReconfiguring) return;
  compatibilityContext.isNativeReconfiguring = true;
  while (compatibilityContext.pendingNativeReconfig) {
    const nextParams = compatibilityContext.pendingNativeReconfig;
    compatibilityContext.pendingNativeReconfig = null;
    try {
      await compatibilityContext.activeNativeCaptureProvider.reconfigure(nextParams);
    } catch (err) {
      console.warn('Falha ao reconfigurar captura nativa dinamicamente:', err);
    }
  }
  compatibilityContext.isNativeReconfiguring = false;
}

export function applyLiveBitrateChange(compatibilityContext, isAutomatic = false) {
  let scaleFactor = 1;
  if (compatibilityContext.localStream) {
    const videoTrack = compatibilityContext.localStream.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack.getSettings === 'function') {
      const settings = videoTrack.getSettings();
      const nativeHeight = settings.height || 1080;
      const targetHeight = compatibilityContext.selectedProfile.height || 1080;
      if (nativeHeight > targetHeight) {
        scaleFactor = Number((nativeHeight / targetHeight).toFixed(2));
      }
    } else if (compatibilityContext.selectedProfile.height && compatibilityContext.selectedProfile.height < 1080) {
      scaleFactor = Number((1080 / compatibilityContext.selectedProfile.height).toFixed(2));
    }

    compatibilityContext.activeMediaCalls.forEach((call) => {
      if (call && call.peerConnection) {
        compatibilityContext.applySenderOptimizations(call.peerConnection, compatibilityContext.customBitrateBps, compatibilityContext.selectedProfile.fps, scaleFactor, compatibilityContext.selectedProfile?.degradationPreference || 'maintain-resolution');
      }
    });
  }

  const isCurrentlyStreaming = Boolean(compatibilityContext.localStream || (compatibilityContext.isDesktopApp() && compatibilityContext.activeNativeCaptureProvider?.session?.sessionId));

  // Se a captura nativa desktop estiver ativa, reconfigura o pipeline GStreamer a quente de forma serializada
  if (compatibilityContext.isDesktopApp() && compatibilityContext.activeNativeCaptureProvider?.session?.sessionId) {
    compatibilityContext.queueNativeReconfigure({
      bitrateKbps: Math.round(compatibilityContext.customBitrateBps / 1000),
      width: compatibilityContext.selectedProfile.width,
      height: compatibilityContext.selectedProfile.height,
      fps: compatibilityContext.selectedProfile.fps,
      h264Encoder: compatibilityContext.activeNativeCaptureProvider.session.h264Encoder || undefined,
      showCursor: compatibilityContext.captureCursorToggle ? compatibilityContext.captureCursorToggle.checked : undefined
    });
  }

  // Atualiza estado local da sala apenas se estiver realmente transmitindo (evita anunciar falso stream para espectadores)
  if (compatibilityContext.roomManager && isCurrentlyStreaming) {
    compatibilityContext.roomManager.setLocalStreaming(true, {
      title: 'Jogo / Tela',
      preset: compatibilityContext.selectedProfile.id,
      fps: compatibilityContext.selectedProfile.fps,
      height: compatibilityContext.selectedProfile.height,
      bitrate: compatibilityContext.customBitrateBps,
      audioMode: compatibilityContext.audioModeSelect ? compatibilityContext.audioModeSelect.value : 'system'
    });
  }

  // Notifica todos os espectadores se estiver transmitindo
  if (isCurrentlyStreaming) {
    const configMsg = {
      type: 'STREAM_CONFIG_UPDATED',
      preset: compatibilityContext.qualityPresetSelect ? compatibilityContext.qualityPresetSelect.value : null,
      bitrate: compatibilityContext.customBitrateBps,
      fps: compatibilityContext.selectedProfile.fps,
      height: compatibilityContext.selectedProfile.height,
      isAutomatic
    };

    compatibilityContext.connectedViewers.forEach((conn) => {
      try { conn.send(configMsg); } catch (e) {}
    });

    if (compatibilityContext.roomManager) {
      compatibilityContext.roomManager.broadcast(configMsg);
    }
  }
}

export async function syncAudioModeCapabilities(compatibilityContext) {
  if (!compatibilityContext.audioModeSelect) return;
  const processOption = compatibilityContext.audioModeSelect.querySelector('option[value="process"]');
  if (!processOption) return;

  if (compatibilityContext.isDesktopApp()) {
    try {
      const caps = await compatibilityContext.getNativeCaptureCapabilities();
      if (!caps.supports_process_audio) {
        processOption.disabled = true;
        processOption.text = '🔒 Áudio da Janela (Indisponível no Windows 10 - Requer Windows 11+)';
        processOption.title = 'A API de captura exclusiva de áudio por processo foi criada pela Microsoft a partir do Windows 11 (Build 22000+) e não existe no Windows 10.';
        if (compatibilityContext.audioModeSelect.value === 'process') {
          compatibilityContext.audioModeSelect.value = 'system';
        }
      } else {
        processOption.disabled = false;
        processOption.text = '🎮 Áudio da Janela / Processo (Windows 11+)';
        processOption.title = 'Captura exclusivamente o som emitido pela janela selecionada.';
      }
    } catch (_) {
      processOption.disabled = true;
      processOption.text = '🔒 Áudio da Janela (Requer Windows 11+)';
      if (compatibilityContext.audioModeSelect.value === 'process') compatibilityContext.audioModeSelect.value = 'system';
    }
  } else {
    // No navegador web (Chromium 141+), captura de áudio por janela isolada é suportada nativamente via windowAudio: 'window'
    processOption.disabled = false;
    processOption.text = '🎮 Áudio da Janela (Isolado da Janela)';
    processOption.title = 'Captura exclusivamente o som emitido pela janela selecionada.';
  }

  await compatibilityContext.syncAudioExclusionOptions().catch(() => {});
}

export async function syncAudioExclusionOptions(compatibilityContext) {
  const audioExcludeSelect = document.getElementById('audio-exclude-select');
  const pickerExcludeSelect = document.getElementById('picker-audio-exclude-select');
  const desktopAudioExclusionGroup = document.getElementById('desktop-audio-exclusion-group');
  const pickerBar = document.getElementById('picker-audio-exclusion-bar');

  if (!compatibilityContext.isDesktopApp()) {
    if (desktopAudioExclusionGroup) desktopAudioExclusionGroup.style.display = 'none';
    if (pickerBar) pickerBar.style.display = 'none';
    return;
  }

  if (pickerBar) pickerBar.style.display = 'block';

  if (desktopAudioExclusionGroup) {
    const currentMode = compatibilityContext.audioModeSelect ? compatibilityContext.audioModeSelect.value : 'system';
    desktopAudioExclusionGroup.style.display = currentMode === 'system' ? 'block' : 'none';
  }

  let candidates = [];
  try {
    candidates = await compatibilityContext.getAudioExclusionCandidates();
  } catch (err) {
    console.warn('[Desktop] Falha ao obter candidatos a exclusão de áudio:', err);
  }

  const savedPref = (() => {
    try {
      return localStorage.getItem('seemygame_audio_exclude_app') || 'seemygame';
    } catch (_) {
      return 'seemygame';
    }
  })();

  const populateSelect = (selectEl) => {
    if (!selectEl) return;
    const currentVal = selectEl.value || savedPref;
    selectEl.innerHTML = '';

    // 1. SeeMyGame (recomendado)
    const optSelf = document.createElement('option');
    optSelf.value = 'seemygame';
    optSelf.textContent = '🎮 SeeMyGame (Ignorar Voz da Sala / Recomendado)';
    selectEl.appendChild(optSelf);

    // 2. Discord
    const discordCand = candidates.find(c => c.id === 'discord');
    const optDiscord = document.createElement('option');
    optDiscord.value = 'discord';
    optDiscord.textContent = discordCand ? discordCand.label : '🎧 Discord (Ignorar Chamada Externa)';
    selectEl.appendChild(optDiscord);

    // 3. Outras janelas
    candidates.forEach(c => {
      if (c.id !== 'seemygame' && c.id !== 'discord') {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        selectEl.appendChild(opt);
      }
    });

    // 4. Nenhum
    const optNone = document.createElement('option');
    optNone.value = 'none';
    optNone.textContent = '🌐 Nenhum (Capturar todos os sons do PC)';
    selectEl.appendChild(optNone);

    const match = Array.from(selectEl.options).some(o => o.value === currentVal);
    selectEl.value = match ? currentVal : 'seemygame';
  };

  populateSelect(audioExcludeSelect);
  populateSelect(pickerExcludeSelect);
}

export function getSelectedAudioExclusionApp(compatibilityContext) {
  const pickerExcludeSelect = document.getElementById('picker-audio-exclude-select');
  if (pickerExcludeSelect && pickerExcludeSelect.value) {
    return pickerExcludeSelect.value;
  }
  const audioExcludeSelect = document.getElementById('audio-exclude-select');
  if (audioExcludeSelect && audioExcludeSelect.value) {
    return audioExcludeSelect.value;
  }
  try {
    const saved = localStorage.getItem('seemygame_audio_exclude_app');
    if (saved) return saved;
  } catch (_) {}
  return 'seemygame';
}

export function handleAudioExcludeChange(compatibilityContext, newVal) {
  try {
    localStorage.setItem('seemygame_audio_exclude_app', newVal);
  } catch (_) {}
  const audioExcludeSelect = document.getElementById('audio-exclude-select');
  const pickerExcludeSelect = document.getElementById('picker-audio-exclude-select');
  if (audioExcludeSelect && audioExcludeSelect.value !== newVal) {
    audioExcludeSelect.value = newVal;
  }
  if (pickerExcludeSelect && pickerExcludeSelect.value !== newVal) {
    pickerExcludeSelect.value = newVal;
  }

  if (compatibilityContext.isDesktopApp() && compatibilityContext.activeNativeCaptureProvider?.session?.sessionId) {
    compatibilityContext.activeNativeCaptureProvider.reconfigure({ excludeApp: newVal })
      .then(() => {
        const label = newVal === 'seemygame'
          ? 'SeeMyGame (Voz da Sala)'
          : (newVal === 'discord' ? 'Discord' : (newVal === 'none' ? 'Nenhum' : newVal));
        compatibilityContext.showToast(`🛡️ Anti-eco atualizado: ignorando sons de ${label}`, 'info', 3000);
      })
      .catch(err => {
        console.warn('Falha ao atualizar aplicativo ignorado no áudio nativo:', err);
      });
  }
}
