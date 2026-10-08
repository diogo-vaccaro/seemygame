/**
 * SeeMyGame - Dedicated Lobby Entrypoint
 * Gerencia a entrada em salas (lobby), geração e formatação de códigos amigáveis,
 * persistência de apelido de usuário e preflight de dispositivos de áudio (Green Room).
 */

import {
  generateFriendlyRoomCode,
  parseRoomIdentifier,
  formatRoomCodeInput
} from '../room-codes.js';
import {
  buildRoomUrl,
  createRoomKey
} from '../navigation/room-links.js';
import { 
  isDesktopApp, 
  isAlwaysOnTop, 
  toggleAlwaysOnTop,
  shouldPlayDesktopIntro,
  initDesktopIntro
} from '../desktop.js';
import { 
  getAudioDevices, 
  populateDeviceSelect, 
  playTestTone, 
  watchDeviceChanges, 
  isAudioOutputSupported 
} from '../audio-devices.js';
import { showToast } from '../ui.js';
import { TERMS_VERSION } from '../config.js';
import { createSessionContext } from '../core/session-context.js';
import { initLobbyDirectory } from '../directory/lobby-directory.js';

export const isLobbyPage = true;

/**
 * Inicializa a página de Lobby principal e vincula eventos aos elementos da interface.
 */
export function initLobbyApp(options = {}) {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (!isBrowser) return { active: false };

  const session = createSessionContext({
    role: 'lobby',
    initialState: {}
  });

  const userNameInput = document.getElementById('lobby-user-name');
  const roomIdInput = document.getElementById('lobby-room-id');
  const joinBtn = document.getElementById('lobby-join-btn');
  const createRandomBtn = document.getElementById('lobby-create-random-btn');
  const lobbyForm = document.getElementById('lobby-form');

  // Recupera apelido salvo anteriormente
  try {
    const savedName = localStorage.getItem('seemygame_user_name');
    if (savedName && userNameInput && !userNameInput.value) {
      userNameInput.value = savedName;
    }
  } catch (e) {}

  if (window._smgTargetRoom && roomIdInput) {
    roomIdInput.value = window._smgTargetRoom;
  }

  // Formatação automática do código da sala enquanto o usuário digita
  if (roomIdInput) {
    session.addEventListener(roomIdInput, 'input', () => {
      const rawValue = roomIdInput.value;
      // Links e fragmentos carregam identidade da sala, chave e PIN; não os
      // transforme no formato destinado a códigos digitados manualmente.
      if (/^\s*(?:[a-z][a-z\d+.-]*:\/\/|www\.|#)/i.test(rawValue)
        || /(?:[?&])(?:room|watch)=/i.test(rawValue)) return;

      const formatted = formatRoomCodeInput(rawValue);
      if (formatted !== roomIdInput.value) {
        roomIdInput.value = formatted;
      }
    });
  }

  // Submissão do formulário para entrar na sala
  if (lobbyForm) {
    session.addEventListener(lobbyForm, 'submit', (e) => {
      e.preventDefault();
      handleJoinRoom();
    });
  }

  if (joinBtn) {
    session.addEventListener(joinBtn, 'click', () => {
      handleJoinRoom();
    });
  }

  if (roomIdInput) {
    session.addEventListener(roomIdInput, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleJoinRoom();
      }
    });
  }

  // Modal de Termos de Uso
  const openTermsLink = document.getElementById('open-terms-link');
  const termsModal = document.getElementById('terms-modal');
  const closeTermsBtn = document.getElementById('close-terms-btn');

  function openTerms() {
    if (!termsModal) return;
    termsModal.style.display = 'flex';
    closeTermsBtn?.focus();
    document.addEventListener('keydown', handleTermsKeyDown);
  }

  function closeTerms() {
    if (!termsModal) return;
    termsModal.style.display = 'none';
    openTermsLink?.focus();
    document.removeEventListener('keydown', handleTermsKeyDown);
  }

  function handleTermsKeyDown(e) {
    if (e.key === 'Escape') closeTerms();
  }

  if (openTermsLink) session.addEventListener(openTermsLink, 'click', openTerms);
  if (closeTermsBtn) session.addEventListener(closeTermsBtn, 'click', closeTerms);

  if (createRandomBtn) {
    session.addEventListener(createRandomBtn, 'click', () => {
      const randomCode = generateFriendlyRoomCode();
      if (roomIdInput) roomIdInput.value = randomCode;
      handleJoinRoom(randomCode);
    });
  }

  function handleJoinRoom(forcedCode = null, explicitKey = null) {
    const rawCode = forcedCode || (roomIdInput ? roomIdInput.value.trim() : '');
    const userName = userNameInput ? userNameInput.value.trim() : '';

    if (!rawCode) {
      showToast('Digite um código de sala ou clique em "Criar sala".', 'warning');
      if (roomIdInput) roomIdInput.focus();
      return;
    }

    const parsed = parseRoomIdentifier(rawCode);
    if (!parsed || !parsed.roomId) {
      showToast('Código de sala inválido. Use letras minúsculas ou formato palavra-palavra.', 'error');
      if (roomIdInput) roomIdInput.focus();
      return;
    }

    if (userName) {
      try {
        localStorage.setItem('seemygame_user_name', userName);
      } catch (e) {}
    }

    const effectiveKey = explicitKey || parsed.roomKey;
    const targetUrl = buildRoomUrl({
      roomId: parsed.roomId,
      roomKey: effectiveKey
    });

    try {
      window.location.href = targetUrl;
    } catch (e) {
      try {
        window.location = new URL(targetUrl, window.location?.href || 'http://localhost/').href;
      } catch (err) {}
    }
  }

  // Integração com Always-on-Top caso esteja rodando no Desktop Tauri
  initDesktopAlwaysOnTop();

  // Inicializa o Diretório Comunitário de Salas ao Vivo
  const directory = initLobbyDirectory({
    session,
    onSelectRoom: (selectedRoomId) => {
      if (roomIdInput) {
        roomIdInput.value = selectedRoomId;
      }
      const userName = userNameInput ? userNameInput.value.trim() : '';
      if (!userName) {
        showToast('Defina seu apelido para entrar na sala!', 'info');
        userNameInput?.focus();
        return;
      }
      handleJoinRoom(selectedRoomId);
    }
  });

  // Abertura cinematográfica para Desktop
  let introController = null;
  const replayIntroBtn = document.getElementById('desktop-intro-btn');
  const searchParams = new URLSearchParams(window.location?.search || '');
  const isPreview = searchParams.get('intro') === '1' || searchParams.get('previewIntro') === '1';

  if (replayIntroBtn && (isDesktopApp() || isPreview)) {
    replayIntroBtn.style.display = 'inline-flex';
  }

  if (shouldPlayDesktopIntro(searchParams)) {
    introController = initDesktopIntro({
      replayBtn: replayIntroBtn
    });
  } else if (replayIntroBtn && (isDesktopApp() || isPreview)) {
    session.addEventListener(replayIntroBtn, 'click', () => {
      introController = initDesktopIntro({
        replayBtn: replayIntroBtn
      });
    });
  }

  return {
    active: true,
    session,
    directory,
    dispose: () => {
      session.dispose();
      document.removeEventListener('keydown', handleTermsKeyDown);
      if (introController?.dispose) {
        introController.dispose();
      }
    },
    joinRoom: handleJoinRoom,
    generateCode: generateFriendlyRoomCode
  };
}

/**
 * Inicializa o botão de fixar janela no topo (Always-on-Top) em ambiente Desktop.
 */
export function initDesktopAlwaysOnTop() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  if (isDesktopApp()) {
    const pinBtn = document.getElementById('desktop-pin-btn');
    if (pinBtn) {
      pinBtn.style.display = 'inline-flex';
      const updatePin = (pinned) => {
        const pinIcon = document.getElementById('desktop-pin-icon');
        const pinText = document.getElementById('desktop-pin-text');
        if (pinIcon) pinIcon.textContent = pinned ? '📌' : '📍';
        if (pinText) pinText.textContent = pinned ? 'Fixado' : 'Livre';
        pinBtn.title = pinned
          ? 'Janela fixada no topo (Always-on-Top ativo). Clique para desafixar.'
          : 'Janela em modo livre. Clique para fixar no topo.';
        if (pinned) pinBtn.classList.add('pinned');
        else pinBtn.classList.remove('pinned');
      };

      isAlwaysOnTop().then(updatePin).catch(() => updatePin(false));
      pinBtn.addEventListener('click', async () => {
        const pinned = await toggleAlwaysOnTop();
        updatePin(pinned);
      });
    }
  }
}

/**
 * Preflight de dispositivo de áudio para o Green Room.
 */
export async function initGreenRoomPreflight(elements = {}) {
  const { micSelect, speakerSelect, speakerNote, testSpeakerBtn } = elements;
  const supportsOutput = isAudioOutputSupported();

  if (speakerNote) {
    speakerNote.textContent = supportsOutput
      ? ''
      : 'Seleção de saída não suportada neste navegador (usando padrão do sistema).';
  }
  if (speakerSelect && !supportsOutput) {
    speakerSelect.disabled = true;
  }
  if (testSpeakerBtn && !supportsOutput) {
    testSpeakerBtn.disabled = true;
  }

  try {
    const { microphones, speakers } = await getAudioDevices();
    if (micSelect && microphones.length > 0) {
      populateDeviceSelect(micSelect, microphones);
    }
    if (speakerSelect && speakers.length > 0 && supportsOutput) {
      populateDeviceSelect(speakerSelect, speakers);
    }
  } catch (err) {
    console.warn('[Lobby] Falha ao listar dispositivos de áudio:', err);
  }

  if (testSpeakerBtn && supportsOutput) {
    testSpeakerBtn.onclick = async () => {
      const selectedSinkId = speakerSelect ? speakerSelect.value : '';
      const originalHtml = testSpeakerBtn.innerHTML;
      testSpeakerBtn.disabled = true;
      testSpeakerBtn.innerHTML = '<span>🔊</span> Testando...';
      try {
        await playTestTone(selectedSinkId);
      } catch (e) {
        console.warn('[Lobby] Erro ao reproduzir tom de teste:', e);
      } finally {
        testSpeakerBtn.disabled = false;
        testSpeakerBtn.innerHTML = originalHtml;
      }
    };
  }
}

// Auto-inicialização somente quando carregado como entrypoint direto da página

