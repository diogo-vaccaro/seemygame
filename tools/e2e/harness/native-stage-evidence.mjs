const delta = (a,b,key) => Number.isFinite(a?.[key]) && Number.isFinite(b?.[key]) && a[key]>=b[key] ? a[key]-b[key] : null;
/** Same-sender clock/counter differences. Missing or reset measurements remain unknown. */
export function nativeStageEvidence(previous,current) {
 if(!current)return null;
 const elapsedMs=previous && current.perf-previous.perf;
 const stages=(current.rows||[]).filter(r=>['native-pipeline','native-rtp-stage'].includes(r.type)).map(row=>{
  const before=previous?.rows?.find(r=>r.id===row.id&&r.type===row.type);
  const frames=delta(row,before,'framesProduced'),bytes=delta(row,before,'bytesProduced');
  return {stage:row.stage||'worker-handoff',fps:elapsedMs>0&&frames!==null?frames*1000/elapsedMs:null,mbps:elapsedMs>0&&bytes!==null?bytes*8/elapsedMs/1000:null,frames:row.framesProduced,frameAgeMs:row.producerFrameAgeMs??null,lifetimeMaxPauseMs:row.producerMaxPauseMs??null,sequenceGapPacketsDelta:delta(row,before,'sequenceGapPackets'),reorderedPacketsDelta:delta(row,before,'reorderedPackets'),duplicatePacketsDelta:delta(row,before,'duplicatePackets'),rtpFrameClock:row.rtpFrameClock??null,videoRtpClockMode:row.videoRtpClockMode??null,queueLevelTimeMs:row.queueLevelTimeMs??null,queueLevelBuffers:row.queueLevelBuffers??null,scope:row.scope||'RTP marker cadence at worker fanout; not capture timestamps or NIC departure'};
 });
 return {sampleEpoch:current.epoch,samplePerf:current.perf,intervalMs:elapsedMs>0?elapsedMs:null,collectionMs:current.collectionMs??null,stages,worker:stages.find(s=>s.stage==='worker-handoff')??null,error:current.error??null};
}
