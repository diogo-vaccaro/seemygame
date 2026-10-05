import { QUALITY_PROFILES, DEFAULT_PROFILE } from '../config.js';
import { bindStreamingOptions } from '../streaming/options-ui.js';

/** Shared capture settings for browser and native providers. */
export function readCaptureSettings(root = document) {
  const value = id => root.getElementById(id)?.value;
  const key = value('quality-preset') || 'balanced';
  const profile = QUALITY_PROFILES[key === 'fhd60' ? 'balanced' : key === 'hd60' ? 'ultra' : key] || DEFAULT_PROFILE;
  return {
    width: profile.width, height: profile.height, fps: profile.fps,
    bitrateKbps: Number(value('bitrate-slider')) || Math.round(profile.bitrate / 1000),
    audioMode: value('audio-mode-select') || 'system',
    videoCodec: value('video-codec-select') || null,
    h264Encoder: value('h264-encoder-select') || null,
    captureBackend: value('capture-backend-select') || null,
    captureApi: value('capture-method-select') || null,
    showCursor: root.getElementById('capture-cursor-toggle')?.checked !== false,
    excludeApp: value('picker-audio-exclude-select') || value('audio-exclude-select') || null
  };
}

/** Serializes live provider changes and removes all subscriptions with the session. */
export function bindCaptureSettings(session, getProvider, showToast) {
  if (session.captureSettingsBound) return;
  session.captureSettingsBound = true;
  let pending = Promise.resolve();
  for (const id of ['quality-preset', 'bitrate-slider', 'audio-mode-select', 'video-codec-select', 'h264-encoder-select', 'capture-backend-select', 'capture-method-select', 'capture-cursor-toggle', 'audio-exclude-select']) {
    session.addEventListener(document.getElementById(id), 'change', () => {
      const provider = getProvider();
      if (!provider?.session) return;
      if (id === 'video-codec-select') return;
      if (id === 'h264-encoder-select') { showToast('O novo encoder será usado ao reiniciar a transmissão.', 'info'); return; }
      if (id === 'capture-backend-select') { showToast('A nova API gráfica será usada ao reiniciar a transmissão.', 'info'); return; }
      if (id === 'capture-method-select') { showToast('O novo método de captura será usado ao reiniciar a transmissão.', 'info'); return; }
      const settings = readCaptureSettings();
      settings.videoCodec = provider.session.videoCodec || provider.session.video_codec || settings.videoCodec;
      settings.h264Encoder = provider.requestedSettings?.h264Encoder || provider.session.h264Encoder || provider.session.h264_encoder || null;
      // Other live changes must preserve the active API until the next start.
      settings.captureBackend = provider.requestedSettings?.captureBackend || null;
      settings.captureApi = provider.requestedSettings?.captureApi || provider.session.captureApi || null;
      pending = pending.then(async () => {
        if (!session.isDisposed && getProvider() === provider && provider.session) await provider.reconfigure(settings);
      }).catch(error => showToast(error.message, 'error'));
    });
  }
  session.registerCleanup(() => pending);
}

/** Advertised support is a preflight only; the HUD reports negotiated codec and delivered FPS. */
export function bindQualityCapabilities(session) {
  bindStreamingOptions(session);
  session.addEventListener(document.getElementById('quality-preset'), 'change', event => {
    const key = event.target.value, profile = QUALITY_PROFILES[key === 'hd60' ? 'ultra' : key === 'fhd60' ? 'balanced' : key];
    const slider = document.getElementById('bitrate-slider');
    if (profile && slider) slider.value = String(profile.bitrate / 1000);
    const label = document.getElementById('bitrate-display');
    if (profile && label) label.textContent = `${(profile.bitrate / 1000000).toFixed(1)} Mbps`;
  });
  const abr = document.getElementById('abr-toggle-btn');
  if (abr) { abr.setAttribute('aria-pressed', 'true'); session.addEventListener(abr, 'click', () => { const enabled = abr.getAttribute('aria-pressed') !== 'true'; abr.setAttribute('aria-pressed', String(enabled)); abr.textContent = enabled ? 'ABR ativo' : 'ABR desativado'; }); }
}
