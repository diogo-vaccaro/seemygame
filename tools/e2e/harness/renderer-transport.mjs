// Diagnostic candidate policy. Excludes VPN/media-over-SSH route mixing.
export function allowRendererCandidate(candidate, policy = 'local-and-public') {
  if (!candidate) return true; // End of candidates, not an address.
  const fields = candidate.replace(/^a=/, '').trim().split(/\s+/);
  if (fields.length < 8 || fields[6] !== 'typ') return false;
  const address = fields[4], type = fields[7];
  if (policy === 'tailscale') return type === 'host' && /^100\./.test(address);
  if (type === 'srflx') return true;
  if (policy === 'public-srflx') return false;
  // These experiments have Ethernet/Wi-Fi on 192.168.x.x; no virtual/VPN NIC.
  return type === 'host' && /^192\.168\.\d{1,3}\.\d{1,3}$/.test(address);
}

export function rendererRoute(stats) {
  const transport = stats.find(r => r.type === 'transport' && r.selectedCandidatePairId);
  const pair = stats.find(r => r.id === transport?.selectedCandidatePairId)
    || stats.find(r => r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated === true);
  if (!pair) return null;
  const endpoint = id => {
    const r = stats.find(r => r.id === id);
    if (!r) return null;
    return {address:r.address || r.ip, protocol:r.protocol, type:r.candidateType || r['candidate-type'], port:r.port};
  };
  const local = endpoint(pair.localCandidateId || pair['local-candidate-id']);
  const remote = endpoint(pair.remoteCandidateId || pair['remote-candidate-id']);
  return {pairId:pair.id,local,remote,rttMs:Number.isFinite(pair.currentRoundTripTime)?pair.currentRoundTripTime*1000:null};
}

export function sameRendererRoute(a, b) {
  // Ports and ICE candidate classifications can differ on the same packet path.
  return !!(a?.local?.address && a?.remote?.address && b?.local?.address && b?.remote?.address
    && a.local.protocol && a.remote.protocol && b.local.protocol && b.remote.protocol
    && a.local.address === b.local.address && a.remote.address === b.remote.address
    && a.local.protocol === b.local.protocol && a.remote.protocol === b.remote.protocol);
}

export function sameRendererSource(a, b) {
  const key = g => g && JSON.stringify([g.innerWidth,g.innerHeight,g.devicePixelRatio,g.canvasRect?.width,g.canvasRect?.height]);
  const stable = r => r.sourceGeometryBeforeSample?.visibility === 'visible'
    && r.sourceGeometryAfterSample?.visibility === 'visible'
    && key(r.sourceGeometryBeforeSample) === key(r.sourceGeometryAfterSample);
  return !!(stable(a) && stable(b) && key(a.sourceGeometryBeforeSample) === key(b.sourceGeometryBeforeSample));
}

export function receiverContinuity(timeline, browser, initialDecoded = 0) {
  let previous = initialDecoded;
  const deltas = timeline.map(row => {
    const value = browser ? row.browser?.inbound?.framesDecoded : row.receiver?.decoded;
    const delta = Number.isFinite(value) ? value - previous : null;
    previous = value;
    return delta;
  });
  return {deltas, stalledIntervals:deltas.filter(d => d === 0).length,
    valid:deltas.length > 0 && deltas.every(d => Number.isFinite(d) && d > 0)};
}

/** Decoded FPS alone also counts black/stale video. The synthetic benchmark
 * requires its session/CRC marker before spending a full measurement interval. */
export function rendererContentReadiness(status, minimumSamples = 3) {
  const samples = status?.opticalSamples;
  const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  const markers = Array.isArray(status?.optics) ? status.optics.filter(row =>
    uint32(row?.seq) && uint32(row?.sourceTime32) && Number.isFinite(row?.captureEpoch)) : [];
  const distinctMarkers = new Set(markers.map(row => `${row.seq}:${row.sourceTime32}`)).size;
  const enoughSamples = Number.isInteger(samples) && samples >= minimumSamples;
  const valid = enoughSamples && distinctMarkers >= minimumSamples;
  return {valid, opticalSamples:Number.isInteger(samples)?samples:0,
    distinctMarkers, rejectedReads:status?.rejectedReads??null,
    reason:valid?null:enoughSamples&&distinctMarkers>0?'synthetic-optical-marker-not-advancing':'no-valid-synthetic-optical-marker'};
}
