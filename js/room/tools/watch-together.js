/**
 * SeeMyGame - WatchTogetherController
 * 
 * Co-visualização e sincronização de vídeos em grupo na sala:
 * - Suporte a YouTube gravado (IFrame API) e arquivos MP4 remotos via HTTPS
 * - Comandos serializados pelo coordenador com ancoragem no relógio da sala
 * - Compensação inteligente de drift (meta <500 ms sob rede estável)
 * - Proteção contra loops de eventos de seek/play locais decorrentes de sync remoto
 * - Espectador somente-leitura acompanha sem disparar comandos
 */

export class WatchTogetherController {
  constructor(options = {}) {
    this.service = options.service || null;
    this.getLocalPeerId = options.getLocalPeerId || (() => 'me');
    this.getDisplayName = options.getDisplayName || (() => 'Jogador');
    this.isHost = typeof options.isHost === 'function' ? options.isHost : () => Boolean(options.isHost);
    this.getCoordinatorPeerId = options.getCoordinatorPeerId || (() => null);
    this.getIsReadonly = typeof options.getIsReadonly === 'function'
      ? options.getIsReadonly
      : () => Boolean(options.isReadonly);

    this.mediaId = null;
    this.provider = null; // 'youtube' | 'mp4'
    this.resource = null; // YouTube video ID or MP4 HTTPS URL
    this.positionSeconds = 0;
    this.paused = true;
    this.controllerPeerId = null; // Peer delegated by host to control
    this.roomClockAnchor = 0; // Timestamp ms when playback position was anchored
    this.revision = 0;

    this.adapter = null;
    this.isApplyingRemoteSync = false;
    this.listeners = new Set();
    this.containerEl = null;

    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  setService(service) {
    this.service = service;
    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  _bindWithService(service) {
    service.registerFeature('watch_together', {
      applyProposal: (payload, meta) => this._applyProposalOnHost(payload, meta),
      applyConfirm: (payload, meta) => this._applyConfirmOnClient(payload, meta),
      getSnapshot: () => this.getSnapshot(),
      applySnapshot: (snapshot) => this.applySnapshot(snapshot)
    });
  }

  static parseMediaUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return null;

    // Detectar YouTube
    const ytRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const ytMatch = raw.match(ytRegex);
    if (ytMatch) {
      return { provider: 'youtube', resource: ytMatch[1] };
    }

    // Detectar MP4 HTTPS
    if (/^https:\/\/[^/]+\/.*\.(mp4|webm|m4v)($|\?)/i.test(raw)) {
      return { provider: 'mp4', resource: raw };
    }

    return null;
  }

  _canControl(authorPeerId) {
    if (authorPeerId === this.getCoordinatorPeerId()) return true;
    if (this.isHost() && authorPeerId === this.getLocalPeerId()) return true;
    if (this.controllerPeerId && authorPeerId === this.controllerPeerId) return true;
    return false;
  }

  _applyProposalOnHost(payload, { authorPeerId }) {
    const { action } = payload;
    const now = Date.now();

    // Somente o host ou o controlador delegado podem comandar reprodução
    if (action !== 'request_sync' && !this._canControl(authorPeerId)) {
      return { success: false, reason: 'unauthorized_controller' };
    }

    switch (action) {
      case 'load_media': {
        const { provider, resource } = payload;
        if (!['youtube', 'mp4'].includes(provider) || !resource) {
          return { success: false, reason: 'invalid_media_params' };
        }

        this.mediaId = `media_${now}_${Math.random().toString(36).slice(2, 7)}`;
        this.provider = provider;
        this.resource = resource;
        this.positionSeconds = 0;
        this.paused = true;
        this.roomClockAnchor = now;
        this.revision++;

        return {
          success: true,
          payload: {
            action: 'media_loaded',
            mediaId: this.mediaId,
            provider: this.provider,
            resource: this.resource,
            positionSeconds: 0,
            paused: true,
            roomClockAnchor: now,
            controllerPeerId: this.controllerPeerId
          }
        };
      }

      case 'play': {
        if (!this.mediaId) return { success: false, reason: 'no_media_loaded' };

        const currentPos = this.calculateEstimatedPosition();
        this.positionSeconds = payload.positionSeconds !== undefined ? Number(payload.positionSeconds) : currentPos;
        this.paused = false;
        this.roomClockAnchor = now;
        this.revision++;

        return {
          success: true,
          payload: {
            action: 'play',
            positionSeconds: this.positionSeconds,
            roomClockAnchor: now,
            paused: false
          }
        };
      }

      case 'pause': {
        if (!this.mediaId) return { success: false, reason: 'no_media_loaded' };

        const currentPos = this.calculateEstimatedPosition();
        this.positionSeconds = payload.positionSeconds !== undefined ? Number(payload.positionSeconds) : currentPos;
        this.paused = true;
        this.roomClockAnchor = now;
        this.revision++;

        return {
          success: true,
          payload: {
            action: 'pause',
            positionSeconds: this.positionSeconds,
            roomClockAnchor: now,
            paused: true
          }
        };
      }

      case 'seek': {
        if (!this.mediaId) return { success: false, reason: 'no_media_loaded' };

        const targetPos = Math.max(0, Number(payload.positionSeconds) || 0);
        this.positionSeconds = targetPos;
        this.roomClockAnchor = now;
        this.revision++;

        return {
          success: true,
          payload: {
            action: 'seek',
            positionSeconds: this.positionSeconds,
            roomClockAnchor: now,
            paused: this.paused
          }
        };
      }

      case 'delegate_controller': {
        // Apenas o host coordenador pode delegar controle
        const isAuthorHost = authorPeerId === this.getCoordinatorPeerId() || (this.isHost() && authorPeerId === this.getLocalPeerId());
        if (!isAuthorHost) {
          return { success: false, reason: 'unauthorized_only_host' };
        }

        this.controllerPeerId = payload.peerId || null;
        this.revision++;
        return {
          success: true,
          payload: {
            action: 'controller_delegated',
            controllerPeerId: this.controllerPeerId
          }
        };
      }

      default:
        return { success: false, reason: 'unknown_action' };
    }
  }

  _applyConfirmOnClient(payload) {
    if (!payload || !payload.action) return;
    const { action } = payload;

    switch (action) {
      case 'media_loaded': {
        this.mediaId = payload.mediaId;
        this.provider = payload.provider;
        this.resource = payload.resource;
        this.positionSeconds = payload.positionSeconds || 0;
        this.paused = Boolean(payload.paused);
        this.roomClockAnchor = payload.roomClockAnchor || Date.now();
        this.controllerPeerId = payload.controllerPeerId || null;

        this._mountAdapter();
        break;
      }
      case 'play': {
        this.positionSeconds = payload.positionSeconds || 0;
        this.paused = false;
        this.roomClockAnchor = payload.roomClockAnchor || Date.now();
        this._syncAdapterPlayback();
        break;
      }
      case 'pause': {
        this.positionSeconds = payload.positionSeconds || 0;
        this.paused = true;
        this.roomClockAnchor = payload.roomClockAnchor || Date.now();
        this._syncAdapterPlayback();
        break;
      }
      case 'seek': {
        this.positionSeconds = payload.positionSeconds || 0;
        this.roomClockAnchor = payload.roomClockAnchor || Date.now();
        this._syncAdapterSeek();
        break;
      }
      case 'controller_delegated': {
        this.controllerPeerId = payload.controllerPeerId || null;
        break;
      }
    }

    this._notify();
  }

  calculateEstimatedPosition() {
    if (!this.mediaId) return 0;
    if (this.paused) return this.positionSeconds;

    const elapsedSeconds = Math.max(0, (Date.now() - this.roomClockAnchor) / 1000);
    return this.positionSeconds + elapsedSeconds;
  }

  getSnapshot() {
    return {
      mediaId: this.mediaId,
      provider: this.provider,
      resource: this.resource,
      positionSeconds: this.calculateEstimatedPosition(),
      paused: this.paused,
      controllerPeerId: this.controllerPeerId,
      roomClockAnchor: Date.now(),
      revision: this.revision
    };
  }

  applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const hasMediaChanged = snapshot.mediaId !== this.mediaId || snapshot.resource !== this.resource;

    this.mediaId = snapshot.mediaId || null;
    this.provider = snapshot.provider || null;
    this.resource = snapshot.resource || null;
    this.positionSeconds = Number(snapshot.positionSeconds) || 0;
    this.paused = Boolean(snapshot.paused);
    this.controllerPeerId = snapshot.controllerPeerId || null;
    this.roomClockAnchor = snapshot.roomClockAnchor || Date.now();
    this.revision = snapshot.revision || 0;

    if (hasMediaChanged) {
      this._mountAdapter();
    } else {
      this._syncAdapterPlayback();
    }
    this._notify();
  }

  async loadMedia(url) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const parsed = WatchTogetherController.parseMediaUrl(url);
    if (!parsed) return { success: false, reason: 'unsupported_url_format' };

    const payload = { action: 'load_media', provider: parsed.provider, resource: parsed.resource };

    if (this.service) {
      return this.service.propose('watch_together', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async play() {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const payload = { action: 'play', positionSeconds: this.adapter?.getTime?.() ?? this.positionSeconds };

    if (this.service) {
      return this.service.propose('watch_together', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async pause() {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const payload = { action: 'pause', positionSeconds: this.adapter?.getTime?.() ?? this.positionSeconds };

    if (this.service) {
      return this.service.propose('watch_together', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async seek(seconds) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const payload = { action: 'seek', positionSeconds: Math.max(0, Number(seconds) || 0) };

    if (this.service) {
      return this.service.propose('watch_together', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async delegateController(peerId) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const payload = { action: 'delegate_controller', peerId };

    if (this.service) {
      return this.service.propose('watch_together', { payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  canIControl() {
    if (this.getIsReadonly()) return false;
    return this._canControl(this.getLocalPeerId());
  }

  setContainer(containerEl) {
    this.containerEl = containerEl;
    if (this.mediaId && this.resource) {
      this._mountAdapter();
    }
  }

  _mountAdapter() {
    if (this.adapter) {
      try { this.adapter.destroy(); } catch (_) {}
      this.adapter = null;
    }
    if (!this.containerEl || !this.resource) return;

    if (this.provider === 'youtube') {
      this.adapter = this._createYouTubeAdapter();
    } else if (this.provider === 'mp4') {
      this.adapter = this._createMp4Adapter();
    }

    if (this.adapter) {
      this.adapter.load(this.resource, this.positionSeconds);
    }
  }

  _createYouTubeAdapter() {
    const container = this.containerEl;
    container.innerHTML = '';

    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${this.resource}?enablejsapi=1&autoplay=1&origin=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}`;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    container.appendChild(iframe);

    let currentTime = 0;
    const postCmd = (func, args = []) => {
      try {
        iframe.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
      } catch (_) {}
    };

    return {
      load: (_res, startSec) => {
        if (startSec > 0) postCmd('seekTo', [startSec, true]);
        if (this.paused) postCmd('pauseVideo');
        else postCmd('playVideo');
      },
      play: () => postCmd('playVideo'),
      pause: () => postCmd('pauseVideo'),
      seek: (sec) => {
        currentTime = sec;
        postCmd('seekTo', [sec, true]);
      },
      getTime: () => currentTime,
      destroy: () => {
        container.innerHTML = '';
      }
    };
  }

  _createMp4Adapter() {
    const container = this.containerEl;
    container.innerHTML = '';

    const video = document.createElement('video');
    video.src = this.resource;
    video.playsInline = true;
    video.controls = this.canIControl();
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    container.appendChild(video);

    const onPlay = () => {
      if (this.isApplyingRemoteSync) return;
      if (this.canIControl() && this.paused) this.play();
    };
    const onPause = () => {
      if (this.isApplyingRemoteSync) return;
      if (this.canIControl() && !this.paused) this.pause();
    };
    const onSeeked = () => {
      if (this.isApplyingRemoteSync) return;
      if (this.canIControl()) this.seek(video.currentTime);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);

    return {
      load: (_res, startSec) => {
        this.isApplyingRemoteSync = true;
        if (startSec > 0) video.currentTime = startSec;
        if (this.paused) video.pause();
        else video.play().catch(() => {});
        setTimeout(() => { this.isApplyingRemoteSync = false; }, 300);
      },
      play: () => {
        this.isApplyingRemoteSync = true;
        video.play().catch(() => {}).finally(() => {
          setTimeout(() => { this.isApplyingRemoteSync = false; }, 200);
        });
      },
      pause: () => {
        this.isApplyingRemoteSync = true;
        video.pause();
        setTimeout(() => { this.isApplyingRemoteSync = false; }, 200);
      },
      seek: (sec) => {
        this.isApplyingRemoteSync = true;
        video.currentTime = sec;
        setTimeout(() => { this.isApplyingRemoteSync = false; }, 300);
      },
      getTime: () => video.currentTime,
      destroy: () => {
        video.removeEventListener('play', onPlay);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('seeked', onSeeked);
        container.innerHTML = '';
      }
    };
  }

  _syncAdapterPlayback() {
    if (!this.adapter) return;
    const estimated = this.calculateEstimatedPosition();
    const current = this.adapter.getTime?.() ?? 0;
    const drift = Math.abs(current - estimated);

    if (drift > 1.5) {
      this.adapter.seek?.(estimated);
    }
    if (this.paused) {
      this.adapter.pause?.();
    } else {
      this.adapter.play?.();
    }
  }

  _syncAdapterSeek() {
    if (!this.adapter) return;
    this.adapter.seek?.(this.positionSeconds);
    if (this.paused) this.adapter.pause?.();
    else this.adapter.play?.();
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notify() {
    const state = {
      mediaId: this.mediaId,
      provider: this.provider,
      resource: this.resource,
      positionSeconds: this.calculateEstimatedPosition(),
      paused: this.paused,
      controllerPeerId: this.controllerPeerId
    };
    this.listeners.forEach(fn => {
      try { fn(state); } catch (_) {}
    });
  }

  destroy() {
    if (this.adapter) {
      try { this.adapter.destroy(); } catch (_) {}
      this.adapter = null;
    }
    this.listeners.clear();
  }
}
