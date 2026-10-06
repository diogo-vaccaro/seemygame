/** Functional delivery and qualification are independent claims. Unsupported/empty never pass. */
export function assessVideoContinuity(timeline, { maxStallMs = 3000 } = {}) {
  let lastFrames = null, lastAdvance = null, maxObservedStallMs = 0, observed = 0, advances = 0;
  for (const sample of timeline || []) {
    const at = sample.receiverSamplePerf, frames = sample.presentation?.presentedFrames;
    if (!Number.isFinite(at) || !Number.isFinite(frames)) continue;
    if (lastFrames !== null && frames < lastFrames) return { passed: false, reason: 'frame-counter-reset', maxObservedStallMs, observed };
    if (lastFrames !== null && frames > lastFrames) advances++;
    if (lastAdvance === null || frames > lastFrames) lastAdvance = at;
    maxObservedStallMs = Math.max(maxObservedStallMs, at - lastAdvance);
    lastFrames = frames; observed++;
  }
  return { passed: observed >= 2 && advances > 0 && maxObservedStallMs < maxStallMs, reason: observed < 2 ? 'insufficient-frame-evidence' : maxObservedStallMs >= maxStallMs ? 'video-stalled' : advances === 0 ? 'no-advancing-frames' : 'frames-progress', maxObservedStallMs, observed, advances, maxStallMs };
}
export function summarizeQualityRuns(runs,{requireQuality=false}={}) {
  const delivered=runs.filter(r=>r.status==='delivered'),failed=runs.some(r=>r.status==='failed');
  const functionalPassed=delivered.length>0&&!failed;
  const qualificationStatus=runs.some(r=>r.assessment?.status==='failed')?'failed':
    runs.length>0&&runs.every(r=>r.status==='delivered'&&r.assessment?.status==='passed')?'passed':'insufficient-evidence';
  const status=failed?'failed':!delivered.length?'inconclusive':!requireQuality?'passed':qualificationStatus==='passed'?'passed':qualificationStatus==='failed'?'failed':'inconclusive';
  return {functionalPassed,qualificationStatus,requireQuality,status,deliveredRuns:delivered.length,unsupportedRuns:runs.filter(r=>r.status==='unsupported').length};
}
export function evaluateStreamVerdict({functionalPassed,measurementRequested=true,measurementValid,qualificationStatus='insufficient-evidence',requireQuality=false,minFps=0,p10Fps}) {
  const performancePassed=minFps>0 ? Number.isFinite(p10Fps) ? p10Fps>=minFps : null : null;
  const failed=!functionalPassed || performancePassed===false || requireQuality&&qualificationStatus==='failed';
  const missing=measurementRequested&&measurementValid!==true || minFps>0&&performancePassed===null || requireQuality&&qualificationStatus==='insufficient-evidence';
  return {functionalPassed,measurementRequested,measurementValid:measurementRequested?measurementValid:null,performancePassed,qualificationStatus,requireQuality,overallStatus:failed?'failed':missing?'inconclusive':'passed'};
}
