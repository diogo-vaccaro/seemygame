/** Freeze the receiver first. Its last marker must already exist when the
 * complete source log is copied; reversing this order creates false failures. */
export async function collectRendererEndEvidence(readReceiver, readSource) {
  const receiverEvidence = await readReceiver();
  const sourceAfter = await readSource();
  return {receiverEvidence, sourceAfter};
}

/** Use receiver capture time mapped onto the source clock, not RPC completion
 * time. Preserve raw evidence separately and reject unmatched in-window frames. */
export function qualifyWindowOptics(optics, frameLog, {start, end, offsetMs}) {
  if (!Array.isArray(optics) || !Array.isArray(frameLog)) throw Error('Missing optical evidence or source frame log');
  if (![start, end, offsetMs].every(Number.isFinite) || end < start) throw Error('Invalid optical measurement window');
  const known = new Set(frameLog.map(frame => `${frame.seq}:${frame.timeMs >>> 0}`));
  const samples = [];
  let beforeWindow = 0, afterWindow = 0, malformed = 0, invalidProvenance = 0;
  for (const sample of optics) {
    if (!Number.isFinite(sample.captureEpoch) || !Number.isInteger(sample.seq) || sample.seq < 0 || sample.seq > 0xffffff || !Number.isInteger(sample.sourceTime32) || sample.sourceTime32 < 0 || sample.sourceTime32 > 0xffffffff) {
      malformed++;
      continue;
    }
    const epoch = sample.captureEpoch - offsetMs;
    if (epoch < start) { beforeWindow++; continue; }
    if (epoch > end) { afterWindow++; continue; }
    const provenanceValid = known.has(`${sample.seq}:${sample.sourceTime32}`);
    if (!provenanceValid) invalidProvenance++;
    samples.push({...sample, provenanceValid});
  }
  return {samples, invalidProvenance, malformed, beforeWindow, afterWindow, rawSamples: optics.length,
    window: {start, end, offsetMs}, boundaryPolicy: 'Inclusive centered clock estimate; boundary placement shares reported clock uncertainty'};
}
