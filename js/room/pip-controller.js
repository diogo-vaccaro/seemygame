/**
 * SeeMyGame - PipController
 * Controlador de Picture-in-Picture padrão e Document Picture-in-Picture.
 * Permite destacar streams da transmissão em janelas flutuantes sempre no topo.
 */

export class PipController {
  constructor() {
    this.activePipVideo = null;
    this.pipWindow = null;
    this.listeners = new Set();
  }

  isSupported() {
    if (typeof document === 'undefined') return false;
    return Boolean(
      document.pictureInPictureEnabled ||
      (typeof window !== 'undefined' && 'documentPictureInPicture' in window)
    );
  }

  hasDocumentPip() {
    return typeof window !== 'undefined' && Boolean(window.documentPictureInPicture);
  }

  async toggleVideoPip(videoElement, container = null) {
    if (!videoElement) return false;

    if (this.isPipActive(videoElement)) {
      return this.exitPip();
    }
    return this.enterPip(videoElement, container);
  }

  isPipActive(videoElement) {
    if (this.pipWindow) return true;
    if (typeof document !== 'undefined' && document.pictureInPictureElement) {
      return document.pictureInPictureElement === videoElement;
    }
    return false;
  }

  async enterPip(videoElement, container = null) {
    if (!videoElement) return false;

    if (this.activePipVideo || this.pipWindow || (typeof document !== 'undefined' && document.pictureInPictureElement)) {
      await this.exitPip();
    }

    try {
      // 1. Tentar Document Picture-in-Picture se disponível e container fornecido
      if (this.hasDocumentPip() && container && typeof window.documentPictureInPicture.requestWindow === 'function') {
        const width = videoElement.videoWidth || 640;
        const height = videoElement.videoHeight || 360;
        const pipWin = await window.documentPictureInPicture.requestWindow({
          width: Math.min(800, width),
          height: Math.min(600, height)
        });

        this.pipWindow = pipWin;
        this.activePipVideo = videoElement;

        // Copiar estilos principais para a janela PiP
        document.querySelectorAll('style, link[rel="stylesheet"]').forEach(styleNode => {
          pipWin.document.head.appendChild(styleNode.cloneNode(true));
        });

        // Mover ou anexar o container
        const originalParent = container.parentElement;
        const placeholder = document.createElement('div');
        placeholder.className = 'pip-placeholder-box';
        placeholder.innerHTML = '<span>📺 Transmissão em Picture-in-Picture</span>';
        if (originalParent) {
          originalParent.replaceChild(placeholder, container);
        }

        pipWin.document.body.appendChild(container);
        pipWin.document.body.style.margin = '0';
        pipWin.document.body.style.background = '#090a0f';

        pipWin.addEventListener('pagehide', () => {
          if (placeholder.isConnected && originalParent) {
            originalParent.replaceChild(container, placeholder);
          }
          this.pipWindow = null;
          this.activePipVideo = null;
          this.notify('leave', { videoElement });
        });

        this.notify('enter', { videoElement, mode: 'document' });
        return true;
      }

      // 2. Fallback para HTML5 Video Picture-in-Picture
      if (videoElement.requestPictureInPicture) {
        await videoElement.requestPictureInPicture();
        this.activePipVideo = videoElement;

        const onLeave = () => {
          videoElement.removeEventListener('leavepictureinpicture', onLeave);
          if (this.activePipVideo === videoElement) {
            this.activePipVideo = null;
          }
          this.notify('leave', { videoElement });
        };
        videoElement.addEventListener('leavepictureinpicture', onLeave);

        this.notify('enter', { videoElement, mode: 'video' });
        return true;
      }
    } catch (err) {
      console.warn('[PipController] Falha ao entrar em Picture-in-Picture:', err);
      return false;
    }

    return false;
  }

  async exitPip() {
    try {
      if (this.pipWindow) {
        this.pipWindow.close();
        this.pipWindow = null;
      } else if (typeof document !== 'undefined' && document.exitPictureInPicture) {
        await document.exitPictureInPicture();
      }
      this.activePipVideo = null;
      return true;
    } catch (err) {
      console.warn('[PipController] Erro ao sair do Picture-in-Picture:', err);
      return false;
    }
  }

  onPipChange(listener) {
    if (typeof listener === 'function') {
      this.listeners.add(listener);
    }
    return () => this.listeners.delete(listener);
  }

  notify(event, data) {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch (err) {
        console.error('[PipController] Erro no listener:', err);
      }
    }
  }
}

export const pipController = new PipController();
