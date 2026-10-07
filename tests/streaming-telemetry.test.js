import { describe,it,expect,vi,afterEach } from 'vitest';
import { collectPeerMetrics } from '../js/stats/metrics.js';
import { observePresentation } from '../js/stats/presentation.js';
import { createStatsMonitorScope } from '../js/stats/monitor.js';
import { createDiagnostic } from '../js/stats/diagnostic.js';
import { createStatsHud,renderStatsHud } from '../js/stats/hud.js';
import { selectCodec,configureVideoCodecs } from '../js/streaming/codecs.js';
import { mutateVideoSender } from '../js/streaming/sender-parameters.js';
import { assessQuality,captureVideoConstraints } from '../js/streaming/quality.js';
import { applySenderOptimizationsWhenReady } from '../js/webrtc/sender.js';
import { diagnoseSample } from '../js/stats/diagnosis.js';
import { AdaptiveBitrateController } from '../js/abr.js';
const rtp=(values={})=>({id:'v',type:'inbound-rtp',kind:'video',ssrc:1,codecId:'c',bytesReceived:0,packetsLost:0,packetsReceived:0,framesDecoded:0,totalDecodeTime:0,jitterBufferDelay:0,jitterBufferEmittedCount:0,...values});
const sample=(report,previous={},now=1000,extra=[])=>collectPeerMetrics([report,{id:'c',type:'codec',mimeType:'video/AV1'},...extra],{peerId:'private-name',previous,now});
const codec=name=>({mimeType:'video/'+name,clockRate:90000});
afterEach(()=>{vi.useRealTimers();document.body.innerHTML='';});
describe('Production telemetry accuracy',()=>{
 it('shows browser ICE progress and failure in the HUD and exported diagnosis without RTP',async()=>{
  vi.useFakeTimers();
  const card=document.createElement('div');card.id='card-p';card.append(createStatsHud('p'));document.body.append(card);
  const pc={iceConnectionState:'checking',connectionState:'connecting',getStats:async()=>[]},scope=createStatsMonitorScope();
  scope.startStatsMonitor('p',pc);
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.getElementById('stat-codec-p').innerText).toBe('Conectando (ICE)...');
  pc.iceConnectionState='failed';pc.connectionState='failed';
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.getElementById('stat-codec-p').innerText).toBe('Falha ICE/NAT');
  expect(scope.exportDiagnostic().streams[0].samples.at(-1)).toMatchObject({iceConnectionState:'failed',connectionState:'failed'});
  scope.dispose();
 });
 it('shows native ICE state when the sender has no browser peer connection',async()=>{
  vi.useFakeTimers();
  const scope=createStatsMonitorScope();
  scope.startStatsMonitor('native-send-p',{getStats:async()=>[{id:'native-connection',type:'native-connection',iceConnectionState:'checking',connectionState:'connecting'}]},true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(scope.getLastMetrics('native-send-p')).toMatchObject({iceConnectionState:'checking',connectionState:'connecting',codec:null});
  scope.dispose();
 });
 it('calculates interval decode/jitter/loss/bitrate including an initial zero counter',()=>{
  const a=sample(rtp());
  const b=sample(rtp({bytesReceived:1000000,packetsLost:2,packetsReceived:98,framesDecoded:50,totalDecodeTime:.1,jitterBufferDelay:1,jitterBufferEmittedCount:50}),a,2000);
  expect(b.codec).toBe('video/AV1');expect(b.bitrateMbps).toBe(8);expect(b.decodeTimeMs).toBe(2);expect(b.jitterBufferDelayMs).toBe(20);expect(b.packetLossRate).toBe(.02);
 });
 it.each([{ssrc:2,bytesReceived:1000},{bytesReceived:0,framesDecoded:0}])('does not inherit counters from replacements/resets: %j',change=>{
  const a=sample(rtp({bytesReceived:10000,framesDecoded:100,totalDecodeTime:1}));
  const b=sample(rtp(change),a,2000);expect(b.bitrateMbps).toBeNull();expect(b.decodeTimeMs).toBeNull();
 });
 it('keeps missing codec/latency metrics unavailable instead of retaining stale values',()=>{
  const b=collectPeerMetrics([],{previous:sample(rtp()),now:2000});expect(b.codec).toBeNull();expect(b.decodeTimeMs).toBeNull();expect(b.rtt).toBeNull();
 });
 it('selects the transport pair even when another nominated pair exists',()=>{
  const b=sample(rtp({transportId:'t'}),{},1000,[{id:'t',type:'transport',selectedCandidatePairId:'active'},{id:'active',type:'candidate-pair',currentRoundTripTime:.02},{id:'other',type:'candidate-pair',nominated:true,currentRoundTripTime:1}]);expect(b.rtt).toBe(20);
 });
 it('aggregates active simulcast bandwidth but reports largest layer codec/resolution',()=>{
  const reports=[rtp({frameWidth:1280,frameHeight:720}),rtp({id:'v2',ssrc:2,frameWidth:320,frameHeight:180})];
  const a=collectPeerMetrics(reports,{now:1000});const b=collectPeerMetrics(reports.map(r=>({...r,bytesReceived:500000})),{previous:a,now:2000});
  expect(b.bitrateMbps).toBe(8);expect(b.width).toBe(1280);
 });
 it('exports no peer IDs, ICE address, raw counters or credentials',()=>{
  const json=JSON.stringify(createDiagnostic(new Map([['secret-peer',[{...sample(rtp()),ip:'1.2.3.4',password:'secret'}]]])));
  expect(json).not.toContain('secret');expect(json).not.toContain('1.2.3.4');expect(json).not.toContain('counters');expect(json).toContain('stream-1');
 });
 it('counts presentedFrames jumps without confusing lost callbacks with dropped frames',()=>{
  let time=0,callback;const cancel=vi.fn(),video={requestVideoFrameCallback:vi.fn(fn=>{callback=fn;return 1;}),cancelVideoFrameCallback:cancel};
  const observer=observePresentation(video,()=>time);
  callback(0,{presentedFrames:1,expectedDisplayTime:0});time=100;callback(100,{presentedFrames:7,expectedDisplayTime:100});time=200;
  const result=observer.sample();expect(result.presentedFps).toBe(35);expect(result.missedCallbacks).toBe(5);expect(result.maxPauseMs).toBeNull();expect(result.frametimeP95Ms).toBeNull();expect(result.callbackMaxGapMs).toBe(100);expect(result.presentationEvidence).toBe('callback-only');observer.dispose();expect(cancel).toHaveBeenCalledWith(1);
 });
 it('reports callback silence without certifying a stalled compositor',()=>{
  let time=0,callback;const o=observePresentation({requestVideoFrameCallback:fn=>{callback=fn;return 1;}},()=>time);
  callback(0,{presentedFrames:1,expectedDisplayTime:0});time=800;const result=o.sample();expect(result.callbackSilenceMs).toBe(800);expect(result.maxPauseMs).toBeNull();o.dispose();
 });
 it('does not report a startup zero before the first presentation callback',()=>{
  let time=0,callback;const o=observePresentation({requestVideoFrameCallback:fn=>{callback=fn;return 1;}},()=>time);
  time=10;expect(o.sample().presentedFps).toBeNull();
  callback(20,{presentedFrames:1,expectedDisplayTime:20});time=1010;expect(o.sample().presentedFps).toBe(1);
  time=2010;expect(o.sample().presentedFps).toBe(0);expect(o.sample().callbackSilenceMs).toBe(1990);o.dispose();
 });
 it('measures a long interval only when consecutive compositor frames confirm it',()=>{
  let time=0,callback;const o=observePresentation({requestVideoFrameCallback:fn=>{callback=fn;return 1;}},()=>time);
  callback(0,{presentedFrames:40,expectedDisplayTime:0});time=300;callback(300,{presentedFrames:41,expectedDisplayTime:300});
  expect(o.sample()).toMatchObject({maxPauseMs:300,frametimeP95Ms:300,consecutiveFrameIntervals:1,missedCallbacks:0});
  time=310;expect(o.sample().maxPauseMs).toBeNull();o.dispose();
 });
 it('does not infer a frame interval across a counter reset',()=>{
  let time=0,callback;const o=observePresentation({requestVideoFrameCallback:fn=>{callback=fn;return 1;}},()=>time);
  callback(0,{presentedFrames:40,expectedDisplayTime:0});time=300;callback(300,{presentedFrames:1,expectedDisplayTime:300});
  expect(o.sample().frametimeP95Ms).toBeNull();o.dispose();
 });
 it('prevents concurrent polls and discards results after disposal',async()=>{
  vi.useFakeTimers();let resolve;const pc={getStats:vi.fn(()=>new Promise(r=>{resolve=r;}))},scope=createStatsMonitorScope();
  scope.startStatsMonitor('p',pc);await vi.advanceTimersByTimeAsync(3000);expect(pc.getStats).toHaveBeenCalledTimes(1);scope.dispose();resolve([]);await Promise.resolve();expect(scope.getLastMetrics('p')).toBeNull();
 });
 it('bounds history and preserves stopped diagnostics until session disposal',async()=>{
  vi.useFakeTimers();const scope=createStatsMonitorScope({historyLimit:2});scope.startStatsMonitor('p',{getStats:async()=>[rtp()]});
  await vi.advanceTimersByTimeAsync(4000);scope.stopStatsMonitor('p');expect(scope.getHistory('p')).toHaveLength(2);scope.dispose();expect(scope.exportDiagnostic().streams).toHaveLength(0);
 });
 it('renders honest missing RTT and clears stale values in HUD',()=>{
  const card=document.createElement('div');card.id='card-p';card.append(createStatsHud('p'));document.body.append(card);
  renderStatsHud('p',true,{fps:60,codec:'video/H264',rtt:20},[]);renderStatsHud('p',true,{},[]);
  expect(document.getElementById('stat-rtt-p').innerText).toBe('N/D');expect(document.getElementById('stat-fps-p').innerText).toBe('N/D');
 });
});
describe('Quality capability selection and negotiation',()=>{
 it.each(['AV1','H265','VP8','VP9','H264'])('prefers available %s without stripping repair or fallback formats',name=>{
  const caps={send:[codec('H264'),codec(name),codec('rtx')],receive:[]},choice=selectCodec(name,caps);expect(choice.codecs[0].mimeType).toBe('video/'+name);expect(choice.codecs.some(c=>c.mimeType==='video/rtx')).toBe(true);
 });
 it('falls back to H264 when HEVC encoding is absent',()=>{const choice=selectCodec('hevc',{send:[codec('H264')],receive:[codec('H265')]});expect(choice.fallback).toBe(true);expect(choice.selected).toBe('h264');});
 it('intersects native encoder availability with local WebView decoder support',()=>{
  const choice=selectCodec('av1',{receive:[codec('AV1'),codec('H264')]},'receive',{supports_h264:true,supports_av1:false});expect(choice.selected).toBe('h264');expect(choice.fallback).toBe(true);
 });
 it('uses decoder capabilities on recvonly transceivers',()=>{
  const transceiver={receiver:{track:{kind:'video'}},sender:{},setCodecPreferences:vi.fn()};
  configureVideoCodecs(transceiver,'hevc',{RTCRtpSender:{getCapabilities:()=>({codecs:[codec('H264')]})},RTCRtpReceiver:{getCapabilities:()=>({codecs:[codec('H265')]})}});
  expect(transceiver.setCodecPreferences.mock.calls[0][0][0].mimeType).toBe('video/H265');
 });
 it('restores default negotiation when preference setting is rejected',()=>{
  const t={sender:{track:{kind:'video'}},setCodecPreferences:vi.fn().mockImplementationOnce(()=>{throw new DOMException('Unsupported','NotSupportedError');})};
  const result=configureVideoCodecs(t,'av1',{RTCRtpSender:{getCapabilities:()=>({codecs:[codec('AV1')]})}});
  expect(result.applied).toBe(false);expect(t.setCodecPreferences).toHaveBeenLastCalledWith([]);
 });
 it('serializes parameter updates and refreshes transaction IDs after previous writes',async()=>{
  let active=0,max=0,revision=0;const sender={getParameters:()=>({transactionId:revision,encodings:[{}]}),setParameters:async params=>{active++;max=Math.max(max,active);await Promise.resolve();expect(params.transactionId).toBe(revision);revision++;active--;}};
  await Promise.all([mutateVideoSender(sender,p=>{p.encodings[0].maxBitrate=1e6;}),mutateVideoSender(sender,p=>{p.encodings[0].maxFramerate=120;})]);expect(max).toBe(1);
 });
 it('does not fabricate unnegotiated encodings',async()=>{const sender={getParameters:()=>({encodings:[]}),setParameters:vi.fn()};expect(await mutateVideoSender(sender,()=>{})).toBe(false);expect(sender.setParameters).not.toHaveBeenCalled();});
 it('retries unsupported optional priorities while preserving essential caps',async()=>{
  const sender={getParameters:()=>({encodings:[{}]}),setParameters:vi.fn().mockRejectedValueOnce(new DOMException('priority','NotSupportedError')).mockResolvedValue()};
  await mutateVideoSender(sender,p=>{p.encodings[0].maxFramerate=120;p.encodings[0].networkPriority='high';});expect(sender.setParameters.mock.calls[1][0].encodings[0]).toEqual({maxFramerate:120});
 });
 it('120 FPS uses an 8.33ms encode budget',()=>{const c=new AdaptiveBitrateController({targetBitrateBps:8e6});c.processSample({encodeTimeMs:12,targetFps:120});expect(c.currentBitrateBps).toBe(6e6);});
 it('neutral and missing samples interrupt consecutive recovery',()=>{const c=new AdaptiveBitrateController({targetBitrateBps:8e6});c.currentBitrateBps=4e6;c.processSample({packetLossRate:0,rtt:30});c.processSample({packetLossRate:.02,rtt:100});expect(c.consecutiveGoodSamples).toBe(0);c.processSample({packetLossRate:0,rtt:30});c.processSample({});expect(c.consecutiveGoodSamples).toBe(0);});
 it('high bitrate cap does not masquerade as a certified 120 FPS result',()=>{
  const config={fps:120,width:1280,height:720};const samples=Array.from({length:60},()=>({measuredFps:60,presentedFps:60,intervalMs:1000,width:1280,height:720,codec:'video/H264',visibility:'visible',maxPauseMs:17}));
  expect(assessQuality(samples,config).status).toBe('failed');expect(assessQuality(samples.slice(0,5),config).status).toBe('insufficient-evidence');expect(captureVideoConstraints(config).frameRate.max).toBe(120);
 });
 it('passes only delivered resolution/cadence over the full stable duration',()=>{
  const samples=Array.from({length:60},()=>({measuredFps:119,presentedFps:118,intervalMs:1000,width:1280,height:720,codec:'video/AV1',visibility:'visible',maxPauseMs:16}));
  expect(assessQuality(samples,{fps:120,width:1280,height:720}).status).toBe('passed');
 });
 it('does not certify quality from high FPS alone when frame-interval evidence is unavailable',()=>{
  const samples=Array.from({length:60},()=>({measuredFps:60,presentedFps:60,intervalMs:1000,width:1280,height:720,codec:'video/H264',visibility:'visible',maxPauseMs:null,callbackMaxGapMs:100}));
  expect(assessQuality(samples,{fps:60,width:1280,height:720}).status).toBe('insufficient-evidence');
  samples[20].presentedFps=20;for(let i=21;i<30;i++)samples[i].presentedFps=20;
  expect(assessQuality(samples,{fps:60,width:1280,height:720}).failureReasons).toContain('composition-cadence-below-target');
 });
});


describe('Negotiation readiness and diagnosis',()=>{
 it('retries when first application happens before encodings are negotiated',async()=>{
  vi.useFakeTimers();let negotiated=false;
  const sender={track:{kind:'video'},getParameters:()=>({encodings:negotiated?[{}]:[]}),setParameters:vi.fn().mockResolvedValue()};
  const stop=applySenderOptimizationsWhenReady({getSenders:()=>[sender]},9e6,120);
  await vi.advanceTimersByTimeAsync(100);expect(sender.setParameters).not.toHaveBeenCalled();negotiated=true;
  await vi.advanceTimersByTimeAsync(500);expect(sender.setParameters).toHaveBeenCalled();expect(sender.setParameters.mock.calls[0][0].encodings[0].maxFramerate).toBe(120);stop();
 });
 it('does not claim an unknown stage is healthy or an inferred bottleneck proven',()=>{
  expect(diagnoseSample({}).stage).toBe('undetermined');
  const diagnosis=diagnoseSample({maxPauseMs:300,measuredFps:59,requestedFps:60});expect(diagnosis.stage).toBe('presentation');expect(diagnosis.confidence).toBe('medium');
  expect(diagnoseSample({callbackMaxGapMs:300,maxPauseMs:null,measuredFps:59}).stage).toBe('presentation-observation');
 });
 it('counts a genuine stall as zero FPS even if framesPerSecond is stale',()=>{
  const a=sample(rtp({framesPerSecond:60,framesDecoded:120}));const b=sample(rtp({framesPerSecond:60,framesDecoded:120}),a,2000);expect(b.measuredFps).toBe(0);
 });
});

describe('Connection and fallback boundaries',()=>{
 it('keeps native CPU H264 eligible when hardware factories are unavailable',()=>{
  const choice=selectCodec('auto',{receive:[codec('H264')]},'receive',{h264_available:false,nvenc_h264_available:false,x264_available:true});expect(choice.selected).toBe('h264');
 });
 it('lets multiple senders share one export button and select one displayed connection',async()=>{
  vi.useFakeTimers();const scope=createStatsMonitorScope(),card=document.createElement('div');card.id='card-local-me';card.append(createStatsHud('local-me'));document.body.append(card);
  scope.startStatsMonitor('a',{getStats:async()=>[{id:'a',type:'outbound-rtp',kind:'video',framesPerSecond:30}]},true,null,{cardId:'local-me'});
  scope.startStatsMonitor('b',{getStats:async()=>[{id:'b',type:'outbound-rtp',kind:'video',framesPerSecond:60}]},true,null,{cardId:'local-me'});
  await vi.advanceTimersByTimeAsync(1000);const select=card.querySelector('.stats-source');expect(select.options.length).toBe(2);expect(card.querySelector('.stats-export').disabled).toBe(false);
  expect(document.getElementById('stat-fps-local-me').innerText).toBe('30 FPS');select.value='b';select.dispatchEvent(new Event('change'));expect(document.getElementById('stat-fps-local-me').innerText).toBe('60 FPS');
  scope.dispose();expect(card.querySelector('.stats-export').disabled).toBe(true);
 });
});

describe('Native producer handoff telemetry',()=>{
 it('separates producer frames from WebRTC network bytes without inventing encode time',()=>{
  const reports=frames=>[{id:'v',type:'outbound-rtp',kind:'video',bytesSent:frames*1000},{id:'capture-worker',type:'native-pipeline',framesProduced:frames,bytesProduced:frames*1500,producerFrameAgeMs:5,producerMaxPauseMs:20}];
  const a=collectPeerMetrics(reports(10),{isLocal:true,now:1000});const b=collectPeerMetrics(reports(70),{isLocal:true,previous:a,now:2000});
  expect(b.producedFps).toBe(60);expect(b.measuredFps).toBe(60);expect(b.bitrateMbps).toBe(.48);expect(b.producedBitrateMbps).toBe(.72);expect(b.encodeTimeMs).toBeNull();expect(b.fpsStage).toBe('native-rtp');
 });
 it('localizes low production upstream of WebRTC without attributing it to GPU scheduling',()=>{
  const result=diagnoseSample({producedFps:54,requestedFps:120});expect(result.stage).toBe('native-producer');expect(result.confidence).toBe('medium');
 });
});
