/** Correlations narrow an investigation; callback pauses alone cannot identify the compositor. */
export function classifyStutter(entry,isNative=false,{targetFps=60,sourceFps=60}={}){
 const inbound=entry.webInbound||{},outbound=entry.outbound||{};
 if(Number.isFinite(entry.source?.fps)&&entry.source.fps<sourceFps/2)return {suspectedCause:'SOURCE_WINDOW_THROTTLING',confidence:'high'};
 if(isNative&&entry.nativeStages?.stages?.some(s=>s.sequenceGapPacketsDelta>0))return {suspectedCause:'NATIVE_LOCAL_RTP_DISCONTINUITY',confidence:'medium'};
 if(isNative&&Number.isFinite(entry.nativeStages?.worker?.fps)&&entry.nativeStages.worker.fps<targetFps/2)return {suspectedCause:'NATIVE_WORKER_CADENCE_DROP',confidence:'medium'};
 if(isNative&&entry.bridge?.decodedFps!=null&&entry.bridge.decodedFps<targetFps/2)return {suspectedCause:'NATIVE_CAPTURE_OR_BRIDGE_THROTTLING',confidence:'medium'};
 if(inbound.packetsLostDelta>0||inbound.nackDelta>0||inbound.pliDelta>0)return {suspectedCause:'RTP_LOSS_OR_RECOVERY',confidence:'medium'};
 if(outbound.limitation==='cpu')return {suspectedCause:'STREAMER_CPU_SATURATION',confidence:'medium'};
 if(outbound.limitation==='bandwidth')return {suspectedCause:'WEBRTC_BANDWIDTH_LIMITATION',confidence:'medium'};
 if(inbound.jitterBufferMs>100)return {suspectedCause:'RECEIVER_JITTER_BUFFER_STALL',confidence:'medium'};
 if(inbound.freezesDelta>0||inbound.decodedFps===0)return {suspectedCause:'RECEIVER_STREAM_FREEZE',confidence:'low'};
 if(entry.presentation?.intervalCallbackMaxGapMs>150&&entry.presentation?.intervalMaxPauseMs<=100)return {suspectedCause:'CALLBACK_OBSERVATION_GAP',confidence:'low'};
 return {suspectedCause:'UNRESOLVED_PRESENTATION_STALL',confidence:'low'};
}
