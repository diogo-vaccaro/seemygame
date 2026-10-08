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
    this.entering = false;
    this.generation = 0;
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
    if (!videoElement || this.entering) return false;

    if (this.isPipActive(videoElement)) {
      return this.exitPip();
    }
    return this.enterPip(videoElement, container);
  }

  isPipActive(videoElement) {
    if (this.activePipVideo === videoElement) return true;
    if (typeof document !== 'undefined' && document.pictureInPictureElement) {
      return document.pictureInPictureElement === videoElement;
    }
    return false;
  }

  async enterPip(videoElement, container = null) {
    if (!videoElement || this.entering) return false;
    this.entering = true;

    if (this.activePipVideo || this.pipWindow || (typeof document !== 'undefined' && document.pictureInPictureElement)) {
      await this.exitPip();
    }

    const generation = ++this.generation;
    try {
      // 1. Tentar Document Picture-in-Picture se disponível e container fornecido
      if (this.hasDocumentPip() && container && typeof window.documentPictureInPicture.requestWindow === 'function') {
        try {
        const width = videoElement.videoWidth || 640;
        const height = videoElement.videoHeight || 360;
        const pipWin = await window.documentPictureInPicture.requestWindow({
          width: Math.min(800, width),
          height: Math.min(600, height)
        });
        if (generation !== this.generation) { pipWin.close(); return false; }

        this.pipWindow = pipWin;
        this.activePipVideo = videoElement;

        // Copiar estilos principais para a janela PiP
        document.querySelectorAll('style, link[rel="stylesheet"]').forEach(styleNode => {
          const clone = styleNode.cloneNode(true);
          if (styleNode.href) clone.href = styleNode.href;
          pipWin.document.head.appendChild(clone);
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

        let restored = false;
        this.restoreDocument = () => {
          if (restored) return;
          restored = true;
          if (placeholder.isConnected && originalParent) {
            originalParent.replaceChild(container, placeholder);
          }
          if (this.pipWindow === pipWin) {
            this.pipWindow = null; this.activePipVideo = null; this.restoreDocument = null;
          }
          this.notify('leave', { videoElement });
        };
        pipWin.addEventListener('pagehide', this.restoreDocument, { once: true });

        this.notify('enter', { videoElement, mode: 'document' });
        return true;
        } catch (error) {
          this.restoreDocument?.(); this.pipWindow?.close(); this.pipWindow = null; this.activePipVideo = null;
          console.warn('[PipController] Document PiP indisponível, tentando PiP de vídeo:', error);
        }
      }

      // 2. Fallback para HTML5 Video Picture-in-Picture
      if (videoElement.requestPictureInPicture) {
        await videoElement.requestPictureInPicture();
        if (generation !== this.generation) { await document.exitPictureInPicture?.(); return false; }
        this.activePipVideo = videoElement;

        const onLeave = () => {
          if (this.leaveVideo !== onLeave) return;
          this.leaveVideo = null;
          videoElement.removeEventListener('leavepictureinpicture', onLeave);
          if (this.activePipVideo === videoElement) {
            this.activePipVideo = null;
          }
          this.notify('leave', { videoElement });
        };
        this.leaveVideo = onLeave;
        videoElement.addEventListener('leavepictureinpicture', onLeave);

        this.notify('enter', { videoElement, mode: 'video' });
        return true;
      }
    } catch (err) {
      console.warn('[PipController] Falha ao entrar em Picture-in-Picture:', err);
      return false;
    } finally { this.entering = false; }

    return false;
  }

  async exitPip() {
    this.generation++;
    try {
      if (this.pipWindow) {
        const pipWindow = this.pipWindow;
        this.restoreDocument?.();
        pipWindow.close();
        this.pipWindow = null;
      } else if (typeof document !== 'undefined' && document.exitPictureInPicture) {
        await document.exitPictureInPicture();
      }
      this.activePipVideo = null;
      this.leaveVideo?.();
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
