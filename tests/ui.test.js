import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isValidPeerId,
  showToast,
  initTermsModal,
  updateGridEmptyState,
  createPlaceholderCard,
  updateCardStatus,
  hideCardLoading,
  setCardStreamPaused,
  removeVideoCard,
  addOrUpdateVideoCard
} from '../js/ui.js';
import {
  MockMediaStream,
  MockMediaStreamTrack
} from './mocks/webrtc.mock.js';

describe('Módulo: ui.js', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `
      <div id="toast-container"></div>
      <main id="video-grid" class="video-grid">
        <div class="empty-state" id="empty-state" style="display: flex;"></div>
      </main>
      <div id="terms-modal" class="modal-overlay" style="display: flex;">
        <input type="checkbox" id="check-age">
        <input type="checkbox" id="check-terms">
        <button id="accept-btn" disabled>Aceitar</button>
      </div>
      <a id="open-terms-link">Termos</a>
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('showToast', () => {
    it('deve adicionar um elemento toast ao toast-container com a classe do tipo correspondente', () => {
      showToast('Transmissão conectada com sucesso!', 'success');

      const container = document.getElementById('toast-container');
      const toast = container.querySelector('.toast');

      expect(toast).not.toBeNull();
      expect(toast.classList.contains('toast-success')).toBe(true);
      expect(toast.innerHTML).toContain('Transmissão conectada com sucesso!');
    });

    it('deve utilizar tipo info por padrão', () => {
      showToast('Mensagem informativa');

      const container = document.getElementById('toast-container');
      const toast = container.querySelector('.toast-info');

      expect(toast).not.toBeNull();
      expect(toast.innerHTML).toContain('Mensagem informativa');
    });

    it('não deve lançar erro se o toast-container não existir', () => {
      document.getElementById('toast-container').remove();
      expect(() => showToast('Teste sem container')).not.toThrow();
    });

    it('deve remover o toast do DOM após o tempo de animação', async () => {
      vi.useFakeTimers();
      showToast('Toast temporário', 'info');

      const container = document.getElementById('toast-container');
      expect(container.querySelectorAll('.toast').length).toBe(1);

      // Avança 4000ms (inicia fade-out) + 300ms (remove do DOM)
      await vi.advanceTimersByTimeAsync(4350);

      expect(container.querySelectorAll('.toast').length).toBe(0);
      vi.useRealTimers();
    });
  });

  describe('initTermsModal', () => {
    it('deve manter o botão de aceitar desabilitado até que ambos os checkboxes sejam marcados', () => {
      initTermsModal();

      const checkAge = document.getElementById('check-age');
      const checkTerms = document.getElementById('check-terms');
      const acceptBtn = document.getElementById('accept-btn');

      expect(acceptBtn.disabled).toBe(true);

      checkAge.checked = true;
      checkAge.dispatchEvent(new Event('change'));
      expect(acceptBtn.disabled).toBe(true);

      checkTerms.checked = true;
      checkTerms.dispatchEvent(new Event('change'));
      expect(acceptBtn.disabled).toBe(false);

      checkAge.checked = false;
      checkAge.dispatchEvent(new Event('change'));
      expect(acceptBtn.disabled).toBe(true);
    });

    it('deve ocultar o modal caso os termos já tenham sido aceitos anteriormente no localStorage', () => {
      localStorage.setItem('seemygame_terms_accepted', 'true');
      initTermsModal();

      const modal = document.getElementById('terms-modal');
      expect(modal.style.display).toBe('none');
    });

    it('deve invocar onAcceptCallback imediatamente caso os termos já tenham sido aceitos', () => {
      localStorage.setItem('seemygame_terms_accepted', 'true');
      const callback = vi.fn();
      initTermsModal(callback);

      expect(callback).toHaveBeenCalledOnce();
    });

    it('deve salvar aceite no localStorage e fechar o modal ao clicar em aceitar', () => {
      initTermsModal();

      const modal = document.getElementById('terms-modal');
      const checkAge = document.getElementById('check-age');
      const checkTerms = document.getElementById('check-terms');
      const acceptBtn = document.getElementById('accept-btn');

      checkAge.checked = true;
      checkTerms.checked = true;
      checkAge.dispatchEvent(new Event('change'));
      checkTerms.dispatchEvent(new Event('change'));

      acceptBtn.click();

      expect(localStorage.getItem('seemygame_terms_accepted')).toBe('true');
      expect(modal.style.display).toBe('none');
    });

    it('deve habilitar o botão via eventos click ou input também', () => {
      initTermsModal();

      const checkAge = document.getElementById('check-age');
      const checkTerms = document.getElementById('check-terms');
      const acceptBtn = document.getElementById('accept-btn');

      checkAge.checked = true;
      checkAge.dispatchEvent(new Event('input'));
      expect(acceptBtn.disabled).toBe(true);

      checkTerms.checked = true;
      checkTerms.dispatchEvent(new Event('click'));
      expect(acceptBtn.disabled).toBe(false);
    });

    it('deve sincronizar o botão imediatamente se os checkboxes já estiverem marcados no DOM', () => {
      const checkAge = document.getElementById('check-age');
      const checkTerms = document.getElementById('check-terms');
      const acceptBtn = document.getElementById('accept-btn');

      checkAge.checked = true;
      checkTerms.checked = true;
      acceptBtn.disabled = true;

      initTermsModal();
      expect(acceptBtn.disabled).toBe(false);
    });

    it('deve reabrir o modal e marcar os checkboxes ao clicar no link de termos', () => {
      localStorage.setItem('seemygame_terms_accepted', 'true');
      initTermsModal();

      const modal = document.getElementById('terms-modal');
      const openLink = document.getElementById('open-terms-link');
      const checkAge = document.getElementById('check-age');
      const checkTerms = document.getElementById('check-terms');
      const acceptBtn = document.getElementById('accept-btn');

      expect(modal.style.display).toBe('none');

      openLink.click();

      expect(modal.style.display).toBe('flex');
      expect(checkAge.checked).toBe(true);
      expect(checkTerms.checked).toBe(true);
      expect(acceptBtn.disabled).toBe(false);
    });
  });

  describe('updateGridEmptyState', () => {
    it('deve exibir empty-state quando não houver cards de vídeo', () => {
      updateGridEmptyState();
      const empty = document.getElementById('empty-state');
      expect(empty.style.display).toBe('flex');
    });

    it('deve ocultar empty-state quando houver cards de vídeo na grade', () => {
      const grid = document.getElementById('video-grid');
      const card = document.createElement('div');
      card.className = 'video-card';
      grid.appendChild(card);

      updateGridEmptyState();
      const empty = document.getElementById('empty-state');
      expect(empty.style.display).toBe('none');
    });
  });

  describe('createPlaceholderCard, updateCardStatus e hideCardLoading', () => {
    it('deve criar um card com spinner e texto inicial no grid de vídeos', () => {
      const onDisconnect = vi.fn();
      createPlaceholderCard('peer-xyz', 'Aguardando stream...', onDisconnect);

      const card = document.getElementById('card-peer-xyz');
      expect(card).not.toBeNull();
      expect(card.textContent).toContain('Aguardando stream...');

      const disconnectBtn = card.querySelector('#disconnect-btn-peer-xyz');
      expect(disconnectBtn).not.toBeNull();
      disconnectBtn.click();
      expect(onDisconnect).toHaveBeenCalledWith('peer-xyz');
    });

    it('não deve recriar o card se já existir para o mesmo peerId', () => {
      createPlaceholderCard('peer-xyz', 'Msg 1');
      createPlaceholderCard('peer-xyz', 'Msg 2');

      const cards = document.querySelectorAll('#card-peer-xyz');
      expect(cards.length).toBe(1);
    });

    it('updateCardStatus deve atualizar a mensagem de status exibida no card', () => {
      createPlaceholderCard('peer-xyz', 'Texto inicial');
      updateCardStatus('peer-xyz', 'Novo status de sincronização');

      const status = document.getElementById('status-peer-xyz');
      expect(status.querySelector('p').innerText).toBe('Novo status de sincronização');
    });

    it('hideCardLoading deve ocultar o overlay de loading do card', () => {
      createPlaceholderCard('peer-xyz', 'Carregando...');
      hideCardLoading('peer-xyz');

      const status = document.getElementById('status-peer-xyz');
      expect(status.style.display).toBe('none');
    });
  });

  describe('removeVideoCard', () => {
    it('deve remover o card do DOM e restaurar a visibilidade do empty-state', () => {
      createPlaceholderCard('peer-rem', 'Aguardando...');
      expect(document.getElementById('card-peer-rem')).not.toBeNull();

      removeVideoCard('peer-rem');

      expect(document.getElementById('card-peer-rem')).toBeNull();
      const empty = document.getElementById('empty-state');
      expect(empty.style.display).toBe('flex');
    });
  });

  describe('addOrUpdateVideoCard', () => {
    it('deve montar a estrutura completa do card de transmissão remota', () => {
      const stream = new MockMediaStream([
        new MockMediaStreamTrack('video'),
        new MockMediaStreamTrack('audio')
      ]);
      const onDisconnect = vi.fn();

      const result = addOrUpdateVideoCard({
        stream,
        peerId: 'streamer-123',
        label: '🎮 Amigo Pro',
        isLocal: false,
        onDisconnect
      });

      expect(result).toHaveProperty('card');
      expect(result).toHaveProperty('video');

      const card = document.getElementById('card-streamer-123');
      expect(card).not.toBeNull();
      expect(card.innerHTML).toContain('🎮 Amigo Pro');

      // VU Meter
      expect(card.querySelector('#vu-l-streamer-123')).not.toBeNull();
      expect(card.querySelector('#vu-r-streamer-123')).not.toBeNull();

      // HUD de telemetria
      expect(card.querySelector('.stats-hud')).not.toBeNull();
      expect(card.querySelector('#stat-fps-streamer-123')).not.toBeNull();

      // Video element
      const video = card.querySelector('video');
      expect(video.srcObject).toBe(stream);
      expect(video.muted).toBe(false);

      // Botão Sair
      const exitBtn = card.querySelector('.card-btn-danger');
      expect(exitBtn.textContent).toBe('Sair');
      exitBtn.click();
      expect(onDisconnect).toHaveBeenCalledWith('streamer-123');
    });

    it('deve configurar o vídeo local como mudo e com botão Encerrar', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      const onDisconnect = vi.fn();

      addOrUpdateVideoCard({
        stream,
        peerId: 'local-me',
        label: 'Minha Transmissão',
        isLocal: true,
        onDisconnect
      });

      const card = document.getElementById('card-local-me');
      const video = card.querySelector('video');
      expect(video.muted).toBe(true);

      const exitBtn = card.querySelector('.card-btn-danger');
      expect(exitBtn.textContent).toBe('Encerrar');
    });

    it('deve isolar a trilha de vídeo no preview local quando o stream possui áudio e vídeo para evitar engasgos A/V', () => {
      const videoTrack = new MockMediaStreamTrack('video');
      const audioTrack = new MockMediaStreamTrack('audio');
      const stream = new MockMediaStream([videoTrack, audioTrack]);

      addOrUpdateVideoCard({
        stream,
        peerId: 'local-me-av',
        label: 'Minha Transmissão AV',
        isLocal: true
      });

      const card = document.getElementById('card-local-me-av');
      const video = card.querySelector('video');
      expect(video.srcObject).not.toBeNull();
      expect(video.srcObject.getVideoTracks()).toHaveLength(1);
      expect(video.srcObject.getAudioTracks()).toHaveLength(0);
      expect(video.muted).toBe(true);
    });

    it('deve renderizar botão de Clipar no card e acionar #clip-btn global ao ser clicado', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      const clipBtnGlobal = document.createElement('button');
      clipBtnGlobal.id = 'clip-btn';
      clipBtnGlobal.click = vi.fn();
      document.body.appendChild(clipBtnGlobal);

      addOrUpdateVideoCard({
        stream,
        peerId: 'clip-test-peer',
        label: 'Clip Test',
        isLocal: false
      });

      const card = document.getElementById('card-clip-test-peer');
      const clipCardBtn = card.querySelector('.card-btn-clip');
      expect(clipCardBtn).not.toBeNull();
      expect(clipCardBtn.textContent).toContain('Clipar');

      clipCardBtn.click();
      expect(clipBtnGlobal.click).toHaveBeenCalled();

      clipBtnGlobal.remove();
    });

    it('deve reaproveitar o elemento video e preservar o card ao reconectar ou atualizar stream', () => {
      const initialStream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      const { card, video: initialVideo } = addOrUpdateVideoCard({
        stream: initialStream,
        peerId: 'reuse-peer',
        label: '🎮 Amigo Gamer',
        isLocal: false
      });

      expect(initialVideo.srcObject).toBe(initialStream);

      // Simula uma nova stream recebida do mesmo peer (ex: streamer parou e reiniciou)
      const updatedStream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      const result = addOrUpdateVideoCard({
        stream: updatedStream,
        peerId: 'reuse-peer',
        label: '🎮 Amigo Gamer (Live)',
        isLocal: false
      });

      expect(result.card).toBe(card);
      expect(result.video).toBe(initialVideo);
      expect(initialVideo.srcObject).toBe(updatedStream);
      expect(card.innerHTML).toContain('🎮 Amigo Gamer (Live)');
    });

    it('deve alternar a visibilidade do HUD de stats ao clicar no botão Stats', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'hud-peer',
        label: 'HUD Test'
      });

      const card = document.getElementById('card-hud-peer');
      const statsBtn = card.querySelectorAll('.card-btn')[0]; // Botão Stats
      const hud = card.querySelector('.stats-hud');

      expect(hud.style.display).not.toBe('flex');

      statsBtn.click();
      expect(hud.style.display).toBe('flex');
      expect(statsBtn.classList.contains('card-btn-active')).toBe(true);

      statsBtn.click();
      expect(hud.style.display).toBe('none');
      expect(statsBtn.classList.contains('card-btn-active')).toBe(false);
    });

    it('deve alternar mute/som ao clicar no botão de áudio de stream remoto', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'audio-peer',
        label: 'Audio Test',
        isLocal: false
      });

      const card = document.getElementById('card-audio-peer');
      const video = card.querySelector('video');
      const muteBtn = Array.from(card.querySelectorAll('.card-controls button')).find(b => b.innerHTML.includes('Som'));

      expect(muteBtn).toBeDefined();
      expect(video.muted).toBe(false);

      muteBtn.click();
      expect(video.muted).toBe(true);
      expect(muteBtn.innerHTML).toContain('Mudo');

      muteBtn.click();
      expect(video.muted).toBe(false);
      expect(muteBtn.innerHTML).toContain('Som');
    });

    it('deve acionar requestFullscreen ao clicar no botão de tela cheia', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'fs-peer',
        label: 'Fullscreen Test'
      });

      const card = document.getElementById('card-fs-peer');
      const video = card.querySelector('video');
      card.requestFullscreen = vi.fn(async () => {});
      const fsSpy = card.requestFullscreen;

      const fsBtn = Array.from(card.querySelectorAll('.card-controls button')).find(b => b.textContent.includes('Tela Cheia'));
      fsBtn.click();

      expect(fsSpy).toHaveBeenCalled();
    });

    it('deve acionar requestPictureInPicture ao clicar no botão PiP', async () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'pip-peer',
        label: 'PiP Test'
      });

      const card = document.getElementById('card-pip-peer');
      const video = card.querySelector('video');
      const pipSpy = vi.spyOn(video, 'requestPictureInPicture');

      const pipBtn = Array.from(card.querySelectorAll('.card-controls button')).find(b => b.textContent.includes('PiP'));
      await pipBtn.click();

      expect(pipSpy).toHaveBeenCalled();
    });

    it('deve alternar entre modo contido e modo expandido ao clicar no botão de redimensionamento', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'resize-peer',
        label: 'Resize Test'
      });

      const card = document.getElementById('card-resize-peer');
      const resizeBtn = card.querySelector('#resize-btn-resize-peer');

      expect(card.classList.contains('expanded-mode')).toBe(false);
      expect(document.body.classList.contains('has-expanded-video')).toBe(false);
      expect(resizeBtn.textContent).toContain('Expandir');

      resizeBtn.click();
      expect(card.classList.contains('expanded-mode')).toBe(true);
      expect(document.body.classList.contains('has-expanded-video')).toBe(true);
      expect(resizeBtn.textContent).toContain('Ajustar');

      resizeBtn.click();
      expect(card.classList.contains('expanded-mode')).toBe(false);
      expect(document.body.classList.contains('has-expanded-video')).toBe(false);
      expect(resizeBtn.textContent).toContain('Expandir');
    });

    it('deve renderizar a barra flutuante de controles overlay com botões essenciais e slider de volume', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'overlay-peer',
        label: 'Overlay Test',
        isLocal: false
      });

      const card = document.getElementById('card-overlay-peer');
      const overlayBar = card.querySelector('.video-overlay-bar');
      expect(overlayBar).not.toBeNull();

      // Botão Fullscreen no overlay
      const overlayFsBtn = overlayBar.querySelector('.overlay-btn-highlight');
      expect(overlayFsBtn).not.toBeNull();
      expect(overlayFsBtn.textContent).toContain('Tela Cheia');

      // Slider de volume e mute
      const volSlider = overlayBar.querySelector('.volume-slider');
      expect(volSlider).not.toBeNull();

      const video = card.querySelector('video');
      card.requestFullscreen = vi.fn(async () => {});
      const fsSpy = card.requestFullscreen;
      overlayFsBtn.click();
      expect(fsSpy).toHaveBeenCalled();
    });

    it('deve acionar requestFullscreen ao dar duplo clique no vídeo', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'dbl-peer',
        label: 'DblClick Test'
      });

      const card = document.getElementById('card-dbl-peer');
      const video = card.querySelector('video');
      card.requestFullscreen = vi.fn(async () => {});
      const fsSpy = card.requestFullscreen;

      video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(fsSpy).toHaveBeenCalled();
    });

    it('deve atualizar o volume e o estado mudo ao alterar o volume-slider', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'vol-peer',
        label: 'Volume Test',
        isLocal: false
      });

      const card = document.getElementById('card-vol-peer');
      const video = card.querySelector('video');
      const volSlider = card.querySelector('.volume-slider');

      volSlider.value = '0.5';
      volSlider.dispatchEvent(new Event('input'));
      expect(video.volume).toBe(0.5);
      expect(video.muted).toBe(false);

      volSlider.value = '0';
      volSlider.dispatchEvent(new Event('input'));
      expect(video.volume).toBe(0);
      expect(video.muted).toBe(true);
    });
  });

  describe('Segurança e Sanitização contra XSS', () => {
    it('isValidPeerId deve aceitar IDs alfanuméricos válidos com hífen e underline', () => {
      expect(isValidPeerId('peer-123')).toBe(true);
      expect(isValidPeerId('user_stream_456')).toBe(true);
      expect(isValidPeerId('a1b2c3d4e5')).toBe(true);
    });

    it('isValidPeerId deve rejeitar IDs com payloads maliciosos de injeção HTML/XSS ou caracteres inválidos', () => {
      expect(isValidPeerId('<img src=x onerror=alert(1)>')).toBe(false);
      expect(isValidPeerId('user"><script>alert(1)</script>')).toBe(false);
      expect(isValidPeerId('peer id with spaces')).toBe(false);
      expect(isValidPeerId('peer#hash')).toBe(false);
      expect(isValidPeerId('')).toBe(false);
      expect(isValidPeerId(null)).toBe(false);
      expect(isValidPeerId(undefined)).toBe(false);
      // Mais de 64 caracteres
      expect(isValidPeerId('a'.repeat(65))).toBe(false);
    });

    it('showToast deve renderizar mensagens com tags HTML como texto puro sem interpretar como elementos do DOM', () => {
      showToast('<b id="xss-test-element">Payload Negrito</b>', 'error');

      const container = document.getElementById('toast-container');
      const injectedElement = container.querySelector('#xss-test-element');

      // Não deve ter criado a tag <b> no DOM
      expect(injectedElement).toBeNull();
      // O texto literal deve estar presente
      expect(container.textContent).toContain('<b id="xss-test-element">Payload Negrito</b>');
    });

    it('createPlaceholderCard não deve criar cartão se o peerId for inválido/malformado', () => {
      createPlaceholderCard('<img src=x onerror=alert(1)>', 'Texto teste');
      const cards = document.querySelectorAll('.video-card');
      expect(cards.length).toBe(0);
    });
  });

  describe('setCardStreamPaused', () => {
    it('deve alternar a visibilidade do overlay de stream pausado', () => {
      const stream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      addOrUpdateVideoCard({
        stream,
        peerId: 'paused-peer',
        label: 'Pausado Test'
      });

      const pausedOverlay = document.getElementById('paused-overlay-paused-peer');
      expect(pausedOverlay).not.toBeNull();
      expect(pausedOverlay.style.display).toBe('none');

      setCardStreamPaused('paused-peer', true, 'A transmissão foi pausada');
      expect(pausedOverlay.style.display).toBe('flex');
      expect(pausedOverlay.textContent).toContain('A transmissão foi pausada');

      setCardStreamPaused('paused-peer', false);
      expect(pausedOverlay.style.display).toBe('none');
    });
  });
});
