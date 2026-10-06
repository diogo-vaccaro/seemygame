const quantile = (values, q) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null; };
/** Component smoke only: validate every steady sample, not a minimum height. */
export function assessResolutionRun(result, profile) {
  const steady = result.samples.filter(sample => sample.phase !== 'transition' && sample.second > 1);
  const phases = profile.dynamicSwitch ? ['initial', 'final'] : ['initial'];
  const reasons = [];
  for (const phase of phases) if (steady.filter(sample => sample.phase === phase).length < 2) reasons.push(`${phase}-insufficient-samples`);
  const resolutionMatches = steady.length > 0 && steady.every(sample => {
    const target = sample.phase === 'final' ? profile.dynamicSwitch : profile;
    return target && Math.abs(sample.inboundFrameWidth - target.targetWidth) <= 2 && Math.abs(sample.inboundFrameHeight - target.targetHeight) <= 2;
  });
  if (!resolutionMatches) reasons.push('resolution-mismatch');
  const decodeFpsP10 = quantile(steady.map(sample => sample.rxFps), .1);
  if (!Number.isFinite(decodeFpsP10) || decodeFpsP10 < profile.fps * .9) reasons.push('decode-cadence-below-target');
  const presentedFpsP10 = quantile(steady.map(sample => sample.presentedFps), .1);
  if (!Number.isFinite(presentedFpsP10) || presentedFpsP10 < profile.fps * .85) reasons.push('presentation-cadence-below-target');
  if (result.appliedDegradation !== profile.degradationPreference || result.finalDegradation !== (profile.dynamicSwitch?.degradationPreference || profile.degradationPreference)) reasons.push('adaptation-not-applied');
  if (steady.some(sample => sample.codec !== 'video/H264')) reasons.push('codec-mismatch');
  if (result.signalErrors?.length) reasons.push('signaling-errors');
  return { passed: reasons.length === 0, resolutionMatches, decodeFpsP10, presentedFpsP10, reasons, scope: 'Canvas WebRTC component smoke; not capture hardware, UI integration or performance certification' };
}
