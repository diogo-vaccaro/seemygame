import {describe,it,expect} from 'vitest';
import {summarizeFpsResolutionCase} from '../tools/e2e/harness/fps-resolution-summary.mjs';
describe('Two-machine FPS/resolution results',()=>{
 it('reclassifies historical 30-FPS events without rewriting the original evidence',()=>{
   const original={second:8,suspectedCause:'NATIVE_WORKER_CADENCE_DROP',confidence:'medium'};
   const result={nativeWithoutPreview:true,qualityConditions:{requestedFps:30},sourceProfile:{fps:60},native:{diagnostics:{stutterEvents:[original]},timeline:[{second:8,phase:'steady',source:{fps:60},nativeStages:{worker:{fps:29.5}},webInbound:{nackDelta:3}}]}};
   const row=summarizeFpsResolutionCase(result,'native-d3d12');
   expect(row.stutterEvents[0]).toMatchObject({suspectedCause:'RTP_LOSS_OR_RECOVERY',originalSuspectedCause:'NATIVE_WORKER_CADENCE_DROP'});
   expect(original.suspectedCause).toBe('NATIVE_WORKER_CADENCE_DROP');
   expect(row.nativePreview).toBe('disabled-diagnostic');
   expect(summarizeFpsResolutionCase({...result,nativeWithoutPreview:undefined},'native-d3d12').nativePreview).toBe('normal');
 });
 it('does not certify a failed or empty phase',()=>{
   expect(summarizeFpsResolutionCase({status:'failed',error:'calibration'},'web')).toMatchObject({measurementValid:false,error:'calibration'});
 });
 it('keeps clock bounds and actual profiles separate from requested values',()=>{
   const result={status:'passed',sourceProfile:{width:1920,height:1080,fps:60},qualityConditions:{requestedFps:30,requestedWidth:1280,requestedHeight:720},receiverConditions:{sameMachine:false},webCapture:{settings:{width:1280,height:720,frameRate:30}},web:{diagnostics:{measurementValid:true},performance:{medianDecodedFps:29.5},glassToGlassLatency:{p50Ms:80,clockUncertaintyMs:8,p50ClockBoundsMs:{lower:72,upper:88}},timeline:[]}};
   const row=summarizeFpsResolutionCase(result,'web');
   expect(row).toMatchObject({receiverOnOtherMachine:true,sourceProfile:result.sourceProfile,effectiveWeb:result.webCapture.settings,latency:result.web.glassToGlassLatency});
   expect(row.rttP50Ms).toBeNull();expect(row.packetsLostDelta).toBeNull();
 });
 it('uses the selected media candidate pair and only steady receiver samples',()=>{
   const make=(at,rtt)=>({at,side:'web',rows:[{type:'inbound-rtp',pcId:1,kind:'video',framesDecoded:100},{type:'transport',pcId:1,selectedCandidatePairId:'media'},{type:'candidate-pair',pcId:1,id:'media',currentRoundTripTime:rtt},{type:'candidate-pair',pcId:1,id:'unused',nominated:true,state:'succeeded',currentRoundTripTime:1},{type:'transport',pcId:0,selectedCandidatePairId:'data'},{type:'candidate-pair',pcId:0,id:'data',currentRoundTripTime:5}]});
   const result={status:'passed',native:{timeline:[{phase:'steady',receiverSampleEpoch:100,source:{fps:60},webInbound:{packetsLostDelta:0}},{phase:'steady',receiverSampleEpoch:200,source:{fps:59},webInbound:{packetsLostDelta:2}}]},measurements:[make(90,.5),make(110,.004),make(190,.006),make(210,.8)]};
   const row=summarizeFpsResolutionCase(result,'native-d3d12');
   expect(row.networkPairSamples).toBe(2);expect(row.rttP50Ms).toBe(4);expect(row.rttP95Ms).toBe(6);expect(row.packetsLostDelta).toBe(2);
 });
});
