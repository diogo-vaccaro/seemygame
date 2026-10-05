import {deltaMetrics} from '../telemetry.mjs';

export function percentile(values,q=.5){
  const sorted=values.filter(v=>typeof v==='number'&&Number.isFinite(v)).sort((a,b)=>a-b);
  return sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*q)-1)]:null;
}
export function requireOpticalEvidence(presentation,seconds,opticalHz){
  if(opticalHz===0)return {status:'not-measured',reason:'optical-disabled'};
  const latency=presentation?.steadyLatency;
  if(!latency||!Number.isFinite(latency.p50)||!Number.isFinite(latency.p99)||!Number.isInteger(latency.samplesCount)||latency.samplesCount<seconds*3)throw Error('Insufficient optical evidence');
  return {status:'measured',samples:latency.samplesCount};
}
function sourceStats(samples){
  const values=key=>samples.map(s=>(s.source??s).workload?.[key]);
  return {sourceFpsP50:percentile(samples.map(s=>(s.source??s).fps)),
    shaderSubmissionFpsP50:percentile(values('fps')),gpuElapsedP50Ms:percentile(values('gpuMs')),
    completionObservedP50Ms:percentile(values('completionObservedP50Ms')),
    completionObservedP95Ms:percentile(values('completionObservedP95Ms'),.95),pendingQueriesP50:percentile(values('pendingQueries'))};
}
function resources(run){
  return {...run.resources?.summary,gpu3DP50Percent:percentile((run.resources?.samples??[]).map(s=>{
    const engines=(s.gpu?.engines??[]).filter(e=>e.type==='3D');
    return s.gpu?.available&&engines.length?Math.max(...engines.map(e=>e.utilizationPercent)):null;
  }))};
}
export function summarizeNativeStageRun(run){
  const frames=run.frameJourney?.frames??[];
  const maxDifference=Math.max(0,...frames.filter(f=>[f.captureToEncodedMs,f.captureToEncoderInputMs,f.encodeMs].every(Number.isFinite)).map(f=>Math.abs(f.captureToEncodedMs-f.captureToEncoderInputMs-f.encodeMs)));
  return {repetition:run.repetition,profile:run.workload.profile,mode:'native-stages',
    encodedFps:run.stages.encoded.fps,metrics:run.frameJourney.metrics,matchedFrames:frames.filter(f=>Number.isFinite(f.captureToEncodedMs)).length,
    capturedFrames:run.stages.capture.frames,unmatched:run.frameJourney.pendingUnmatched,evicted:run.frameJourney.evicted,
    maxSameFrameAdditivityErrorMs:maxDifference,rawCaptureCaps:run.captureCaps,encoderInputCaps:run.encoderInputCaps,
    source:sourceStats(run.sourceSamples??[]),resources:resources(run)};
}
export function summarizeBrowserStageRun(run){
  const row=(sample,type)=>sample.rows?.find(s=>s.type===type&&(s.kind==='video'||s.mimeType?.startsWith('video/')));
  const delta=type=>{const a=row(run.before,type),b=row(run.after,type);return a&&b?deltaMetrics(a,b):null;};
  const outbound=delta('outbound-rtp'),inbound=delta('inbound-rtp');
  const before=run.before.videos?.[0]?.playbackQuality,after=run.after.videos?.[0]?.playbackQuality;
  const dt=(run.after.at-run.before.at)/1000;
  const produced=before&&after&&dt>0?(after.totalVideoFrames-before.totalVideoFrames)/dt:null;
  const dropped=before&&after&&dt>0?(after.droppedVideoFrames-before.droppedVideoFrames)/dt:null;
  return {repetition:run.repetition,profile:run.workload.profile,mode:run.mode,
    latency:run.presentation.steadyLatency,decodedFps:inbound?.decodedFps??null,renderedFps:produced!==null&&dropped!==null?produced-dropped:null,
    encodeTimeMs:outbound?.encodeTimeMs??null,decodeTimeMs:inbound?.decodeTimeMs??null,jitterBufferMs:inbound?.jitterBufferMs??null,
    opticalOverheadMs:run.presentation.instrumentationOverheadMs,
    encoderImplementation:row(run.after,'outbound-rtp')?.encoderImplementation??null,
    codec:run.after.rows?.filter(s=>s.type==='codec').map(s=>s.mimeType)??[],
    source:sourceStats(run.timeline),resources:resources(run)};
}
