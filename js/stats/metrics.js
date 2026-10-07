const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const delta = (a,b,key) => finite(a?.[key]) !== null && finite(b?.[key]) !== null && a[key]>=b[key] ? a[key]-b[key] : null;
const average = (a,b,sum,count) => { const s=delta(a,b,sum), n=delta(a,b,count); return s!==null && n>0 ? s*1000/n : null; };
/** Interval metrics, with identity and reset guards. Units: milliseconds and Mbps. */
export function collectPeerMetrics(stats,{peerId,isLocal=false,previous={},now=performance.now()}={}) {
 const reports=[]; stats.forEach(r=>reports.push(r));
 const byId=new Map(reports.map(r=>[r.id,r]));
 const streams=reports.filter(r=>r.type===(isLocal?'outbound-rtp':'inbound-rtp') && (r.kind||r.mediaType)==='video' && r.active!==false);
 const bytesKey=isLocal?'bytesSent':'bytesReceived', framesKey=isLocal?'framesEncoded':'framesDecoded';
 const video=[...streams].sort((a,b)=>(b.frameWidth||0)*(b.frameHeight||0)-(a.frameWidth||0)*(a.frameHeight||0))[0];
 const counters={}; let byteDelta=0, frameDelta=0, lostDelta=0, receivedDelta=0, bytesValid=false, framesValid=false, lossValid=false;
 for(const r of streams) {
  const key=`${r.id||r.type}:${r.ssrc??''}`, prior=previous.counters?.[key]; counters[key]={...r};
  const bytes=delta(r,prior,bytesKey), frames=delta(r,prior,framesKey), lost=delta(r,prior,'packetsLost'), received=delta(r,prior,'packetsReceived');
  if(bytes!==null){byteDelta+=bytes;bytesValid=true;} if(frames!==null){frameDelta+=frames;framesValid=true;}
  if(lost!==null && received!==null){lostDelta+=lost;receivedDelta+=received;lossValid=true;}
 }
 const elapsed=previous.timestamp!==undefined?(now-previous.timestamp)/1000:0;
 const prior=video && previous.counters?.[`${video.id||video.type}:${video.ssrc??''}`];
 const codec=byId.get(video?.codecId), transport=byId.get(video?.transportId)||reports.find(r=>r.type==='transport'&&r.selectedCandidatePairId);
 const pair=byId.get(transport?.selectedCandidatePairId)||reports.find(r=>r.type==='candidate-pair'&&(r.selected||r.nominated))||reports.find(r=>r.type==='candidate-pair'&&r.state==='succeeded');
 const remote=reports.find(r=>r.type==='remote-inbound-rtp'&&video&&(r.localId===video.id||r.id===video.remoteId))||reports.find(r=>r.type==='remote-inbound-rtp'&&(r.kind||r.mediaType)==='video');
 const track=reports.find(r=>r.type==='track'&&r.kind==='video');
 const bitrateMbps=bytesValid&&elapsed>0?byteDelta*8/elapsed/1e6:null;
 const native = reports.find(r => r.type === 'native-pipeline');
 const connection = reports.find(r => r.type === 'native-connection');
 const producedFrames = delta(native, previous.nativeCounters, 'framesProduced');
 const producedBytes = delta(native, previous.nativeCounters, 'bytesProduced');
 const producedFps = producedFrames !== null && elapsed > 0 ? producedFrames / elapsed : null;
 const primaryFrames = delta(video, prior, framesKey);
 const rawFps=primaryFrames!==null&&elapsed>0?primaryFrames/elapsed:finite(video?.framesPerSecond) ?? producedFps;
 return {
  peerId,timestamp:now,direction:isLocal?'outbound':'inbound',counters,nativeCounters:native,
  iceConnectionState:connection?.iceConnectionState ?? null,connectionState:connection?.connectionState ?? null,
  producedFps, producedBitrateMbps: producedBytes !== null && elapsed > 0 ? producedBytes * 8 / elapsed / 1e6 : null,
  producerMaxPauseMs: native?.producerMaxPauseMs ?? null, producerFrameAgeMs: native?.producerFrameAgeMs ?? null, fpsStage: native ? 'native-rtp' : isLocal ? 'encoded' : 'decoded',
  fps:rawFps===null?null:Math.round(rawFps),measuredFps:rawFps,bitrateMbps,bitrateText:bitrateMbps===null?'N/D':bitrateMbps.toFixed(2),
  bytes:streams.reduce((n,r)=>n+(r[bytesKey]||0),0),width:finite(video?.frameWidth)??finite(track?.frameWidth),height:finite(video?.frameHeight)??finite(track?.frameHeight),
  codec:codec?.mimeType||null,codecParameters:codec?.sdpFmtpLine||null,
  encoderImplementation:video?.encoderImplementation||null,decoderImplementation:video?.decoderImplementation||null,
  powerEfficientEncoder:video?.powerEfficientEncoder??null,powerEfficientDecoder:video?.powerEfficientDecoder??null,
  rtt:finite(isLocal?remote?.roundTripTime:null)!==null?Math.round(remote.roundTripTime*1000):finite(pair?.currentRoundTripTime)!==null?Math.round(pair.currentRoundTripTime*1000):null,
  availableOutgoingBitrate:finite(pair?.availableOutgoingBitrate),
  packetsLost:finite(isLocal?remote?.packetsLost:video?.packetsLost),
  packetLossRate:isLocal?finite(remote?.fractionLost):lossValid&&lostDelta+receivedDelta>0?lostDelta/(lostDelta+receivedDelta):null,
  qualityReason:video?.qualityLimitationReason||null,
  encodeTimeMs:average(video,prior,'totalEncodeTime','framesEncoded'),decodeTimeMs:average(video,prior,'totalDecodeTime','framesDecoded'),
  packetSendDelayMs:average(video,prior,'totalPacketSendDelay','packetsSent'),
  jitterBufferDelayMs:average(video,prior,'jitterBufferDelay','jitterBufferEmittedCount'),jitterBufferTargetMs:average(video,prior,'jitterBufferTargetDelay','jitterBufferEmittedCount'),
  jitterMs:finite(video?.jitter)===null?null:video.jitter*1000,
  framesDropped:delta(video,prior,'framesDropped'),freezes:delta(video,prior,'freezeCount'),nackCount:delta(video,prior,'nackCount'),pliCount:delta(video,prior,'pliCount'),intervalMs:elapsed>0?elapsed*1000:null
 };
}
