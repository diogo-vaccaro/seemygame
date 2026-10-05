import {percentile} from './causal-summary.mjs';
import {classifyStutter} from './stutter-cause.mjs';

export function summarizeFpsResolutionCase(result,sender) {
 const phase=sender==='web'?result.web:result.native;
 if(!phase)return {status:result.status,error:result.error,measurementValid:false};
 const steady=(phase.timeline??[]).filter(t=>t.phase==='steady');
 const rx=result.measurements?.filter(m=>m.side==='web'&&m.at>=steady[0]?.receiverSampleEpoch&&m.at<=steady.at(-1)?.receiverSampleEpoch)??[];
 const pairs=rx.flatMap(m=>{
   const mediaPcs=new Set(m.rows.filter(r=>r.type==='inbound-rtp'&&r.kind==='video'&&r.framesDecoded>0).map(r=>r.pcId));
   const ids=new Set(m.rows.filter(r=>mediaPcs.has(r.pcId)&&r.type==='transport'&&r.selectedCandidatePairId).map(r=>`${r.pcId}:${r.selectedCandidatePairId}`));
   return m.rows.filter(r=>mediaPcs.has(r.pcId)&&r.type==='candidate-pair'&&(ids.has(`${r.pcId}:${r.id}`)||!ids.size&&r.nominated&&r.state==='succeeded'));
 });
 const med=(section,key)=>percentile(steady.map(t=>t[section]?.[key]));
 const sum=key=>{const values=steady.map(t=>t.webInbound?.[key]).filter(Number.isFinite);return values.length?values.reduce((n,v)=>n+Math.max(0,v),0):null;};
 const gpuP50=(resources,type)=>percentile((resources?.samples??[]).map(s=>{
   const engines=(s.gpu?.engines??[]).filter(e=>e.type===type);
   return engines.length?Math.max(...engines.map(e=>e.utilizationPercent)):null;
 }));
 const senderSamples=result.measurements?.filter(m=>m.side==='desktop'&&m.at>=phase.steadyWindow?.senderStart&&m.at<=phase.steadyWindow?.senderEnd)??[];
 const stutterEvents=(phase.diagnostics?.stutterEvents??[]).map(event=>{
   const entry=steady.find(t=>t.second===event.second);
   if(!entry)return {...event,reclassification:'timeline evidence unavailable'};
   return {...event,originalSuspectedCause:event.suspectedCause,originalConfidence:event.confidence,
     ...classifyStutter(entry,sender!=='web',{targetFps:result.qualityConditions?.requestedFps??60,sourceFps:result.sourceProfile?.fps??60}),
     reclassification:'cadence thresholds use half the stream/source target; raw artifact unchanged'};
 });
 return {status:result.status,error:result.error,measurementValid:phase.diagnostics?.measurementValid===true,
   receiverOnOtherMachine:result.receiverConditions?.sameMachine===false,
   requested:result.qualityConditions,sourceProfile:result.sourceProfile,
   effectiveNative:result.nativeTestStreamProfile?.nativeRequested??null,effectiveWeb:result.webCapture?.settings??null,
   fpsP50:phase.performance?.medianDecodedFps,fpsP10:phase.performance?.p10DecodedFps,
   latency:phase.glassToGlassLatency??null,qualification:phase.qualification,
   calibrationMethod:phase.clockCalibration?.before?.method??null,
   severeStutterIntervals:phase.diagnostics?.stuttersDetected,metadataPauseEvents:phase.diagnostics?.metadataPauseEvents,
   stutterEvents,nativePreview:sender==='web'?null:result.nativeWithoutPreview===true?'disabled-diagnostic':'normal',
   rtcFreezeEvents:sum('freezesDelta'),packetsLostDelta:sum('packetsLostDelta'),nacks:sum('nackDelta'),plis:sum('pliDelta'),
   decodeP50Ms:med('webInbound','decodeTimeMs'),jitterP50Ms:med('webInbound','jitterBufferMs'),
   sourceFpsP50:med('source','fps'),shaderSubmissionFpsP50:percentile(steady.map(t=>t.source?.workload?.fps)),
   sourceCompletionP50Ms:percentile(steady.map(t=>t.source?.workload?.completionObservedP50Ms)),
   encodeP50Ms:med('outbound','encodeTimeMs'),encodeImplementation:[...new Set(steady.map(t=>t.outbound?.encoderImplementation).filter(Boolean))],
   browserCaptureFpsP50:percentile(senderSamples.flatMap(s=>s.rows.filter(r=>r.type==='media-source'&&r.kind==='video').map(r=>r.framesPerSecond))),
   webCaptureStages:result.webCaptureStages??null,
   rttP50Ms:percentile(pairs.map(r=>Number.isFinite(r.currentRoundTripTime)?r.currentRoundTripTime*1000:null)),
   rttP95Ms:percentile(pairs.map(r=>Number.isFinite(r.currentRoundTripTime)?r.currentRoundTripTime*1000:null),.95),
   networkPairSamples:pairs.length,
   senderResources:{...phase.resources?.summary,gpu3DP50Percent:gpuP50(phase.resources,'3D'),gpuEncodeP50Percent:gpuP50(phase.resources,'VideoEncode')},
   receiverResources:{...phase.receiverResources?.summary,gpu3DP50Percent:gpuP50(phase.receiverResources,'3D'),gpuDecodeP50Percent:gpuP50(phase.receiverResources,'VideoDecode')},
   artifactScope:'Synthetic load, optical compositor proxy; see nativePreview for preview mode. Wi-Fi and sender runtimes remain factors'};
}
