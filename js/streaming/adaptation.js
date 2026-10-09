import { AdaptiveBitrateController } from '../abr.js';
import { updateSenderBitrate } from '../webrtc/sender.js';
/** Conservative browser cap adaptation. Browser congestion control and RTP pacing remain authoritative. */
export function createQualityController(pc, getSettings, getMeshContext = null) {
  let stopped = false, lastChange = -Infinity, pending = Promise.resolve();
  const queueBitrate = bps => {
    pending = pending.catch(() => {}).then(async () => {
      if (!stopped) await updateSenderBitrate(pc, bps);
    });
  };
  const controller = new AdaptiveBitrateController({
    targetBitrateBps: getSettings().bitrateKbps * 1000,
    onBitrateChange: queueBitrate
  });
  return {
    get controller() { return controller; },
    process(sample) {
      if (stopped) return;
      const settings = getSettings();
      const baseTarget = settings.bitrateKbps * 1000;
      const now = sample.timestamp;

      let effectiveTarget = baseTarget;
      if (typeof getMeshContext === 'function') {
        const { viewerCount = 1, lanViewerCount = 0 } = getMeshContext() || {};
        if (viewerCount > 1 && !sample?.isLan) {
          const cap = AdaptiveBitrateController.calculateMeshGuardCap(viewerCount, baseTarget, lanViewerCount);
          effectiveTarget = Math.min(baseTarget, cap);
        }
      }

      const beforeTarget = controller.currentBitrateBps;
      controller.setTargetBitrate(effectiveTarget);
      if (beforeTarget !== controller.currentBitrateBps) queueBitrate(controller.currentBitrateBps);
      const enabled = typeof document === 'undefined' || document.getElementById('abr-toggle-btn')?.getAttribute('aria-pressed') !== 'false';
      if (controller.isEnabled !== enabled) controller.setEnabled(enabled);
      if (!enabled || !Number.isFinite(now) || now - lastChange < 3000) return;
      const before = controller.currentBitrateBps;
      controller.processSample({ ...sample, rttMs: sample.rttMs ?? sample.rtt, targetFps: settings.fps });
      if (before !== controller.currentBitrateBps) lastChange = now;
    },
    dispose() { stopped = true; return pending; }
  };
}

