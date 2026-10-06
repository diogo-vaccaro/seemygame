import { isNativeCaptureProvider, readCaptureSettings } from '../capture/settings.js';
import { QUALITY_PROFILES } from '../config.js';
import { applySenderOptimizations } from '../webrtc/sender.js';
import { captureVideoConstraints, videoScaleForProfile } from './quality.js';
/** Change resolution/FPS live, but codec changes require a new negotiation/capture. */
export function bindStreamingQuality(session, { getStream, getCalls, getProvider, onSettings, showToast }) {
  let pending = Promise.resolve();
  for (const id of ['quality-preset', 'bitrate-slider', 'video-codec-select', 'degradation-preference-select']) {
    session.addEventListener(document.getElementById(id), 'change', () => {
      if (!getStream()) return;
      if (id === 'video-codec-select') { showToast('O novo codec será usado ao reiniciar a transmissão.', 'info'); return; }
      const settings = readCaptureSettings();
      if (id === 'quality-preset') {
        const profile = QUALITY_PROFILES[document.getElementById('quality-preset')?.value];
        if (profile) { settings.bitrateKbps = profile.bitrate / 1000; const slider = document.getElementById('bitrate-slider'); if (slider) slider.value = String(settings.bitrateKbps); }
      }
      pending = pending.catch(() => {}).then(async () => {
        if (session.isDisposed || !getStream()) return;
        const stream = getStream(), track = stream.getVideoTracks()[0];
        if (id === 'quality-preset' && !isNativeCaptureProvider(getProvider())) {
          try { await track?.applyConstraints?.(captureVideoConstraints(settings)); }
          catch (_) { showToast('A fonte não aceitou a resolução/FPS; confira o resultado no diagnóstico.', 'info'); }
        }
        if (session.isDisposed || getStream() !== stream) return;
        onSettings(settings);
        for (const call of getCalls()) {
          const sender = call.peerConnection?.getSenders?.().find(sender => sender.track?.kind === 'video');
          // Native capture already sizes its encoder output. Its bridge track
          // may still report the old dimensions while the new worker starts.
          const scale = isNativeCaptureProvider(getProvider()) ? 1 : videoScaleForProfile(track?.getSettings?.(), settings, sender?.getParameters?.()?.encodings?.[0]?.scaleResolutionDownBy);
          await applySenderOptimizations(call.peerConnection, settings.bitrateKbps * 1000, settings.fps, scale, settings.degradationPreference || 'maintain-resolution');
        }
      }).catch(error => showToast(error.message, 'error'));
    });
  }
  session.registerCleanup(() => pending);
}
