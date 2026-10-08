/** green-room: commands receive explicit compatibility ports; no page initialization. */
export async function initGreenRoomLobby(compatibilityContext) {
  const greenRoomModal = document.getElementById('green-room-modal');
  if (greenRoomModal?.dataset.greenRoomInitialized === 'true') {
    if (greenRoomModal) greenRoomModal.style.display = 'flex';
    return;
  }
  if (greenRoomModal) {
    greenRoomModal.dataset.greenRoomInitialized = 'true';
    greenRoomModal.style.display = 'flex';
  }
  const info = compatibilityContext.getRoomInfoFromUrl();
  const idLabel = document.getElementById('green-room-id-label');
  if (idLabel && info?.roomId) {
    idLabel.textContent = `#${info.roomId}`;
  }

  const joinBtn = document.getElementById('green-room-join-btn');
  const nameInput = document.getElementById('green-room-user-name');
  if (nameInput) {
    let savedName = null;
    try { savedName = localStorage.getItem('seemygame_user_name'); } catch (_) {}
    if (savedName && !nameInput.value) nameInput.value = savedName;
  }

  const micSelect = document.getElementById('green-room-mic-select');
  const speakerSelect = document.getElementById('green-room-speaker-select');
  const speakerNote = document.getElementById('green-room-speaker-note');
  const testSpeakerBtn = document.getElementById('green-room-test-speaker-btn');
  const toggleMicBtn = document.getElementById('green-room-toggle-mic-btn');
  const micIcon = document.getElementById('green-room-mic-icon');
  const micBtnText = document.getElementById('green-room-mic-btn-text');
  const vuBar = document.getElementById('green-room-vu-bar');
  const micStatus = document.getElementById('green-room-mic-status');

  let previewStream = null;
  let previewSource = null;
  let previewAnalyser = null;
  let previewRafId = null;
  let isMicMuted = false;
  let lastSpokeTime = 0;
  let isCleanedUp = false;
  let previewEpoch = 0;
  let unwatchDevices;
  const listenerScope = new AbortController();
  const cleanup = () => {
    isCleanedUp = true;
    previewEpoch++;
    stopMicPreview();
    unwatchDevices?.();
    listenerScope.abort();
    if (joinBtn) joinBtn.onclick = null;
    if (toggleMicBtn) toggleMicBtn.onclick = null;
    if (testSpeakerBtn) testSpeakerBtn.onclick = null;
    if (greenRoomModal) delete greenRoomModal.dataset.greenRoomInitialized;
  };
  compatibilityContext.registerCleanup?.(cleanup);

  const requestAnimFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
      ? window.requestAnimationFrame.bind(window)
      : (cb) => setTimeout(cb, 1000 / 60);

  const cancelAnimFrame = typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function')
      ? window.cancelAnimationFrame.bind(window)
      : (id) => clearTimeout(id);

  const supportsOutput = compatibilityContext.isAudioOutputSupported();
  if (speakerNote) {
    if (!supportsOutput) {
      speakerNote.textContent = 'Seleção de saída não suportada neste navegador (usando padrão do sistema).';
    } else {
      speakerNote.textContent = '';
    }
  }
  if (speakerSelect && !supportsOutput) {
    speakerSelect.disabled = true;
  }
  if (testSpeakerBtn && !supportsOutput) {
    testSpeakerBtn.disabled = true;
  }

  if (testSpeakerBtn && supportsOutput) {
    testSpeakerBtn.onclick = async () => {
      const selectedSinkId = speakerSelect ? speakerSelect.value : '';
      const originalHtml = testSpeakerBtn.innerHTML;
      testSpeakerBtn.disabled = true;
      testSpeakerBtn.innerHTML = '<span>🔊</span> Testando...';
      try {
        await compatibilityContext.playTestTone(selectedSinkId);
      } catch (e) {
        console.warn('[GreenRoom] Erro ao reproduzir tom de teste:', e);
      } finally {
        testSpeakerBtn.disabled = false;
        testSpeakerBtn.innerHTML = originalHtml;
      }
    };
  }

  if (speakerSelect && supportsOutput) {
    speakerSelect.addEventListener('change', () => {
      const deviceId = speakerSelect.value;
      compatibilityContext.saveAudioPreference('output', deviceId);
      if (compatibilityContext.voiceManager) {
        compatibilityContext.voiceManager.selectedSpeakerId = deviceId;
      }
    }, { signal: listenerScope.signal });
  }

  function stopMicPreview() {
    if (previewRafId) {
      cancelAnimFrame(previewRafId);
      previewRafId = null;
    }
    try { previewSource?.disconnect?.(); } catch (_) {}
    try { previewAnalyser?.disconnect?.(); } catch (_) {}
    previewSource = null;
    previewAnalyser = null;

    if (previewStream) {
      try {
        const tracks = previewStream.getTracks ? previewStream.getTracks() : (previewStream._tracks || []);
        tracks.forEach((t) => {
          try { t.stop?.(); } catch (_) {}
        });
      } catch (_) {}
      previewStream = null;
    }
    if (vuBar) vuBar.style.width = '0%';
  }

  async function startMicPreview(deviceId = null) {
    if (isCleanedUp) return;
    const epoch = ++previewEpoch;
    stopMicPreview();
    let acquiredStream;

    const savedPrefs = compatibilityContext.getSavedAudioPreferences?.() || {};
    const targetDeviceId = deviceId !== null ? deviceId : (savedPrefs.inputId || compatibilityContext.voiceManager?.selectedMicId || '');

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(targetDeviceId ? { deviceId: { ideal: targetDeviceId } } : {})
    };

    if (micStatus && !isMicMuted) {
      micStatus.textContent = 'Iniciando captura de microfone...';
      micStatus.style.color = 'var(--text-muted)';
    }

    try {
      if (navigator?.mediaDevices?.getUserMedia) {
        try {
          acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
        } catch (deviceErr) {
          console.warn('[GreenRoom] Dispositivo preferencial falhou, tentando padrão:', deviceErr);
          if (targetDeviceId) {
            compatibilityContext.saveAudioPreference?.('input', '');
            if (compatibilityContext.voiceManager) {
              compatibilityContext.voiceManager.selectedMicId = '';
            }
          }
          try {
            acquiredStream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
              video: false
            });
          } catch (stdErr) {
            console.warn('[GreenRoom] Captura com cancelamento de ruído falhou, usando captura pura (audio: true):', stdErr);
            acquiredStream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: false
            });
          }
        }
      }
    } catch (err) {
      console.warn('[GreenRoom] Falha ao acessar microfone:', err);
      if (micStatus) {
        micStatus.textContent = '⚠️ Microfone não permitido ou indisponível. Verifique as permissões do sistema/navegador.';
        micStatus.style.color = '#f87171';
      }
      return;
    }

    if (isCleanedUp || epoch !== previewEpoch) {
      acquiredStream?.getTracks().forEach(track => track.stop());
      return;
    }
    previewStream = acquiredStream;
    if (!previewStream) return;

    try {
      const tracks = previewStream.getAudioTracks ? previewStream.getAudioTracks() : (previewStream._tracks || []);
      if (tracks[0]) {
        tracks[0].enabled = !isMicMuted;
      }
    } catch (_) {}

    try {
      const ctx = compatibilityContext.getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        if (typeof ctx.createMediaStreamSource === 'function' && typeof ctx.createAnalyser === 'function') {
          previewSource = ctx.createMediaStreamSource(previewStream);
          previewAnalyser = ctx.createAnalyser();
          previewAnalyser.fftSize = 64;
          previewAnalyser.smoothingTimeConstant = 0.4;
          previewSource.connect(previewAnalyser);

          const dataArray = new Uint8Array(previewAnalyser.frequencyBinCount);

          function updateVU() {
            if (isCleanedUp || !greenRoomModal || greenRoomModal.style.display === 'none') {
              return;
            }

            if (isMicMuted) {
              if (vuBar) vuBar.style.width = '0%';
              previewRafId = requestAnimFrame(updateVU);
              return;
            }

            previewAnalyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const average = sum / dataArray.length;
            const percent = Math.min(100, Math.round((average / 255) * 160));

            if (vuBar) {
              vuBar.style.width = `${percent}%`;
            }

            const now = Date.now();
            if (percent >= 10) {
              lastSpokeTime = now;
              if (micStatus) {
                micStatus.textContent = '✅ Microfone funcionando! Áudio captado com sucesso.';
                micStatus.style.color = '#34d399';
              }
            } else if (now - lastSpokeTime > 1800) {
              if (micStatus && !isMicMuted) {
                micStatus.textContent = 'Fale algo para verificar se o seu microfone está captando som...';
                micStatus.style.color = 'var(--text-muted)';
              }
            }

            previewRafId = requestAnimFrame(updateVU);
          }

          updateVU();
        }
      }
    } catch (audioErr) {
      console.warn('[GreenRoom] Erro no Web Audio VU:', audioErr);
    }
  }

  async function refreshDevices() {
    if (isCleanedUp) return;
    try {
      const { microphones, speakers } = await compatibilityContext.getAudioDevices(false);
      if (isCleanedUp) return;
      const prefs = compatibilityContext.getSavedAudioPreferences?.() || {};
      let currentMicId = micSelect?.value || prefs.inputId || compatibilityContext.voiceManager?.selectedMicId || '';
      let currentSpeakerId = speakerSelect?.value || prefs.outputId || compatibilityContext.voiceManager?.selectedSpeakerId || '';

      // Reconciliação: se o ID salvo não existe mais nos dispositivos conectados, limpa a preferência obsoleta
      if (currentMicId && microphones.length > 0 && !microphones.some(m => m.deviceId === currentMicId)) {
        compatibilityContext.saveAudioPreference?.('input', '');
        if (compatibilityContext.voiceManager) compatibilityContext.voiceManager.selectedMicId = '';
        currentMicId = '';
      }
      if (currentSpeakerId && speakers.length > 0 && !speakers.some(s => s.deviceId === currentSpeakerId)) {
        compatibilityContext.saveAudioPreference?.('output', '');
        if (compatibilityContext.voiceManager) compatibilityContext.voiceManager.selectedSpeakerId = '';
        currentSpeakerId = '';
      }

      if (micSelect) {
        compatibilityContext.populateDeviceSelect(micSelect, microphones, currentMicId, 'Microfone Padrão do Sistema');
      }
      if (speakerSelect) {
        compatibilityContext.populateDeviceSelect(speakerSelect, speakers, currentSpeakerId, 'Alto-falante Padrão do Sistema');
      }
    } catch (e) {
      console.warn('[GreenRoom] Erro ao listar dispositivos:', e);
    }
  }

  if (micSelect) {
    micSelect.addEventListener('change', async () => {
      const newDeviceId = micSelect.value;
      compatibilityContext.saveAudioPreference('input', newDeviceId);
      if (compatibilityContext.voiceManager) {
        compatibilityContext.voiceManager.selectedMicId = newDeviceId;
      }
      await startMicPreview(newDeviceId);
    }, { signal: listenerScope.signal });
  }

  if (toggleMicBtn) {
    toggleMicBtn.onclick = () => {
      isMicMuted = !isMicMuted;
      if (previewStream) {
        try {
          const tracks = previewStream.getAudioTracks ? previewStream.getAudioTracks() : (previewStream._tracks || []);
          tracks.forEach(t => { t.enabled = !isMicMuted; });
        } catch (_) {}
      }
      if (isMicMuted) {
        toggleMicBtn.classList.add('is-muted');
        if (micIcon) micIcon.textContent = '🔇';
        if (micBtnText) micBtnText.textContent = 'Microfone Mutado';
        if (vuBar) vuBar.style.width = '0%';
        if (micStatus) {
          micStatus.textContent = '🔇 Microfone mutado para a entrada na sala.';
          micStatus.style.color = '#f87171';
        }
      } else {
        toggleMicBtn.classList.remove('is-muted');
        if (micIcon) micIcon.textContent = '🔊';
        if (micBtnText) micBtnText.textContent = 'Microfone Ativo';
        if (micStatus) {
          micStatus.textContent = 'Fale algo para verificar se o seu microfone está captando som...';
          micStatus.style.color = 'var(--text-muted)';
        }
      }
    };
  }

  if (greenRoomModal) {
    greenRoomModal.addEventListener('pointerdown', () => {
      try {
        const ctx = compatibilityContext.getAudioContext();
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
      } catch (_) {}
    }, { once: true, signal: listenerScope.signal });
  }

  refreshDevices().catch(() => {});

  startMicPreview().then(async () => {
    await refreshDevices();
  }).catch(() => {});

  unwatchDevices = compatibilityContext.watchDeviceChanges(() => {
    refreshDevices().catch(() => {});
  });

  if (joinBtn) {
    joinBtn.onclick = () => {
      if (isCleanedUp) return;
      cleanup();

      if (nameInput && nameInput.value.trim() && typeof localStorage !== 'undefined') {
        localStorage.setItem('seemygame_user_name', nameInput.value.trim());
      }
      if (greenRoomModal) {
        greenRoomModal.style.display = 'none';
      }

      if (compatibilityContext.voiceManager) {
        compatibilityContext.voiceManager.setMuted(isMicMuted);
        if (micSelect && micSelect.value) {
          compatibilityContext.voiceManager.selectedMicId = micSelect.value;
        }
        if (speakerSelect && speakerSelect.value) {
          compatibilityContext.voiceManager.selectedSpeakerId = speakerSelect.value;
        }
      }

      if (compatibilityContext.onProceed) {
        compatibilityContext.onProceed();
      } else if (!compatibilityContext.peer || compatibilityContext.peer.destroyed) {
        compatibilityContext.initPeer();
      } else if (compatibilityContext.peer.open && compatibilityContext.roomManager && !compatibilityContext.roomManager.isInRoom) {
        compatibilityContext.setupRoomSession(compatibilityContext.peer.id);
      }
    };
  }
}
