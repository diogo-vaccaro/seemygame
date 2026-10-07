const fields=['timestamp','direction','fps','measuredFps','bitrateMbps','width','height','codec','codecParameters','encoderImplementation','decoderImplementation','powerEfficientEncoder','powerEfficientDecoder','rtt','packetsLost','packetLossRate','qualityReason','encodeTimeMs','decodeTimeMs','packetSendDelayMs','jitterMs','jitterBufferDelayMs','jitterBufferTargetMs','availableOutgoingBitrate','framesDropped','freezes','nackCount','pliCount','presentedFps','frametimeP50Ms','frametimeP95Ms','maxPauseMs','missedCallbacks','visibility','intervalMs','sampleError','requestedFps','requestedCodec'];
/** Explicit allowlist: never export raw ICE/SDP, credentials, peer names or addresses. */
fields.push('iceConnectionState', 'connectionState');
export function safeSample(sample){const keys=[...fields,'requestedDegradationPreference','effectiveDegradationPreference','senderParameterFallback','callbackMaxGapMs','callbackSilenceMs','consecutiveFrameIntervals','skippedCallbackSpans','presentationEvidence','producedFps','producedBitrateMbps','producerMaxPauseMs','producerFrameAgeMs','fpsStage'];const result=Object.fromEntries(keys.filter(k=>sample[k]!==undefined).map(k=>[k,sample[k]]));if(sample.diagnosis)result.diagnosis={stage:sample.diagnosis.stage,confidence:sample.diagnosis.confidence,message:sample.diagnosis.message};return result;}
export function createDiagnostic(histories) {
 return {schemaVersion:2,generatedAt:new Date().toISOString(),samplingIntervalMs:1000,notes:['RTT is network round-trip, not glass-to-glass latency.','Encode/decode/jitter interval averages overlap; do not sum as end-to-end latency.','Presentation metadata does not prove physical scanout. Missing metrics remain null.','Frametime/maxPause use consecutive presentedFrames only; callback gaps/silence are separate observation metrics.'],streams:[...histories.values()].map((history,index)=>({id:`stream-${index+1}`,samples:history.map(safeSample)}))};
}
export function downloadDiagnostic(report) {
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),link=document.createElement('a');
 link.href=url;link.download=`seemygame-diagnostico-${Date.now()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

