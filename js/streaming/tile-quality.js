/**
 * SeeMyGame - TileQualityController
 * 
 * Adaptação automática de qualidade por tamanho e visibilidade de tile:
 * - Mede área visível com ResizeObserver e visibilidade com IntersectionObserver
 * - Classes discretas de demanda: pequeno (<=360p), médio (<=720p), foco (<=1080p), oculto (reduzido)
 * - Histerese: subida rápida em foco, redução atrasada (2 a 5s) e debounce de resize
 * - Agregação em nó Relay: upstream recebe a maior qualidade necessária entre consumo local e downstream
 * - Combina de forma conservadora com ABR, teto manual do host e capacidades do encoder
 */

export const TILE_QUALITY_PROFILES = Object.freeze({
  hidden: { name: 'hidden', maxFramerate: 15, scaleResolutionDownBy: 4, bitrateMultiplier: 0.25 },
  small: { name: 'small', maxFramerate: 30, scaleResolutionDownBy: 3, bitrateMultiplier: 0.4 },
  medium: { name: 'medium', maxFramerate: 30, scaleResolutionDownBy: 1.5, bitrateMultiplier: 0.7 },
  focus: { name: 'focus', maxFramerate: 60, scaleResolutionDownBy: 1, bitrateMultiplier: 1.0 }
});

const PROFILE_RANK = {
  hidden: 0,
  small: 1,
  medium: 2,
  focus: 3
};

export class TileQualityController {
  constructor(options = {}) {
    this.streamId = options.streamId || 'default-stream';
    this.onDemandChange = options.onDemandChange || (() => {});
    this.downscaleDelayMs = options.downscaleDelayMs || 3000;
    this.resizeDebounceMs = options.resizeDebounceMs || 250;

    this.currentProfile = 'medium';
    this.targetProfile = 'medium';
    this.downscaleTimer = null;
    this.resizeTimer = null;

    this.isPageVisible = typeof document !== 'undefined' ? !document.hidden : true;
    this.isTileIntersecting = true;
    this.isTileFocused = false;
    this.tileArea = 0;

    this.downstreamDemands = new Map(); // peerId -> profileName
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.observedElement = null;
    this.listeners = new Set();
  }

  static rankProfile(profileName) {
    return PROFILE_RANK[profileName] ?? 1;
  }

  static maxProfile(profileA, profileB) {
    const rankA = TileQualityController.rankProfile(profileA);
    const rankB = TileQualityController.rankProfile(profileB);
    return rankA >= rankB ? profileA : profileB;
  }

  /**
   * Avalia a classe de perfil baseado nas dimensões e visibilidade do elemento.
   */
  evaluateLocalProfile() {
    if (!this.isPageVisible || !this.isTileIntersecting) {
      return 'hidden';
    }
    if (this.isTileFocused) {
      return 'focus';
    }

    // Limiares de área em pixels
    if (this.tileArea <= 0) return 'hidden';
    // <= 360p (ex: 480x270 = 129.600px ou 640x360 = 230.400px)
    if (this.tileArea <= 250000) {
      return 'small';
    }
    // <= 720p (ex: 1280x720 = 921.600px)
    if (this.tileArea <= 950000) {
      return 'medium';
    }
    // Grande/Foco
    return 'focus';
  }

  /**
   * Determina a demanda final agregando a necessidade local e eventuais relays downstream.
   */
  getEffectiveDemandedProfile() {
    let effective = this.currentProfile;
    for (const downstreamProfile of this.downstreamDemands.values()) {
      effective = TileQualityController.maxProfile(effective, downstreamProfile);
    }
    return effective;
  }

  setDownstreamDemand(peerId, profileName) {
    if (!peerId) return;
    const validProfile = TILE_QUALITY_PROFILES[profileName] ? profileName : 'medium';
    this.downstreamDemands.set(peerId, validProfile);
    this._checkAndEmitDemand();
  }

  removeDownstreamDemand(peerId) {
    if (this.downstreamDemands.has(peerId)) {
      this.downstreamDemands.delete(peerId);
      this._checkAndEmitDemand();
    }
  }

  setFocused(isFocused) {
    this.isTileFocused = Boolean(isFocused);
    this._updateProfileImmediate();
  }

  setPageVisibility(isVisible) {
    this.isPageVisible = Boolean(isVisible);
    this._updateProfileWithHysteresis();
  }

  updateTileDimensions(width, height) {
    this.tileArea = Math.max(0, width * height);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this._updateProfileWithHysteresis();
    }, this.resizeDebounceMs);
  }

  _updateProfileImmediate() {
    const next = this.evaluateLocalProfile();
    this.targetProfile = next;
    if (this.downscaleTimer) {
      clearTimeout(this.downscaleTimer);
      this.downscaleTimer = null;
    }
    this.currentProfile = next;
    this._checkAndEmitDemand();
  }

  _updateProfileWithHysteresis() {
    const next = this.evaluateLocalProfile();
    const currentRank = TileQualityController.rankProfile(this.currentProfile);
    const nextRank = TileQualityController.rankProfile(next);

    this.targetProfile = next;

    // Subida de qualidade: aplica rápido
    if (nextRank > currentRank) {
      if (this.downscaleTimer) {
        clearTimeout(this.downscaleTimer);
        this.downscaleTimer = null;
      }
      this.currentProfile = next;
      this._checkAndEmitDemand();
      return;
    }

    // Redução de qualidade: histerese de 2 a 5s para evitar oscilação
    if (nextRank < currentRank) {
      if (!this.downscaleTimer) {
        this.downscaleTimer = setTimeout(() => {
          this.downscaleTimer = null;
          this.currentProfile = this.targetProfile;
          this._checkAndEmitDemand();
        }, this.downscaleDelayMs);
      }
    }
  }

  _checkAndEmitDemand() {
    const effective = this.getEffectiveDemandedProfile();
    const config = TILE_QUALITY_PROFILES[effective] || TILE_QUALITY_PROFILES.medium;
    this.listeners.forEach(fn => {
      try { fn(effective, config); } catch (_) {}
    });
    this.onDemandChange(effective, config);
  }

  observeElement(element) {
    if (!element || typeof window === 'undefined') return;
    this.unobserve();
    this.observedElement = element;

    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const rect = entry.contentRect || entry.target.getBoundingClientRect();
          this.updateTileDimensions(rect.width, rect.height);
        }
      });
      this.resizeObserver.observe(element);
    }

    if ('IntersectionObserver' in window) {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          this.isTileIntersecting = entry.isIntersecting;
          this._updateProfileWithHysteresis();
        }
      }, { threshold: 0.1 });
      this.intersectionObserver.observe(element);
    }

    const rect = element.getBoundingClientRect();
    this.updateTileDimensions(rect.width, rect.height);
  }

  unobserve() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    this.observedElement = null;
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  dispose() {
    this.unobserve();
    if (this.downscaleTimer) {
      clearTimeout(this.downscaleTimer);
      this.downscaleTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.downstreamDemands.clear();
    this.listeners.clear();
  }
}
