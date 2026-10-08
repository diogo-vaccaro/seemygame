import {describe,it,expect} from 'vitest';
import {nativeStageEvidence} from '../tools/e2e/harness/native-stage-evidence.mjs';
import {classifyStutter} from '../tools/e2e/harness/stutter-cause.mjs';
const row=(frames,extra={})=>({id:'capture-worker',type:'native-pipeline',framesProduced:frames,bytesProduced:frames*1000,producerFrameAgeMs:10,producerMaxPauseMs:24,sequenceGapPackets:0,...extra});
describe('native handoff and transport evidence',()=>{
 it('uses sender monotonic timestamps, not receiver epochs, to calculate cadence',()=>{
  const a={perf:1000,epoch:1,rows:[row(60)]},b={perf:2000,epoch:9999999,rows:[row(120)]};
  expect(nativeStageEvidence(a,b).worker).toMatchObject({fps:60,mbps:.48,lifetimeMaxPauseMs:24,frameAgeMs:10});
 });
 it('keeps first, reset and missing stage evidence unknown',()=>{
  expect(nativeStageEvidence(null,{perf:1000,rows:[row(60)]}).worker.fps).toBeNull();
  expect(nativeStageEvidence({perf:1000,rows:[row(60)]},{perf:2000,rows:[row(10)]}).worker.fps).toBeNull();
  expect(nativeStageEvidence(null,null)).toBeNull();
 });
 it('preserves media-clock distributions by stage without presenting arrival jitter as latency',()=>{
  const clock={clockRateHz:90000,timestampDeltaMs:{p50:16.667},arrivalDeltaMs:{p95:32},scope:'local marker pairs'};
  const result=nativeStageEvidence(null,{perf:1000,rows:[row(60,{rtpFrameClock:clock})]});
  expect(result.worker.rtpFrameClock).toEqual(clock);
  expect(result.worker.fps).toBeNull();
  expect(nativeStageEvidence(null,{perf:1000,rows:[row(60)]}).worker.rtpFrameClock).toBeNull();
 });
 it('does not blame a healthy worker for RTP loss downstream',()=>{
  const entry={source:{fps:60},nativeStages:{worker:{fps:60,lifetimeMaxPauseMs:24},stages:[]},webInbound:{decodedFps:20,nackDelta:5}};
  expect(classifyStutter(entry,true).suspectedCause).toBe('RTP_LOSS_OR_RECOVERY');
 });
 it('distinguishes local sequence discontinuity from a producer cadence drop',()=>{
  expect(classifyStutter({nativeStages:{stages:[{sequenceGapPacketsDelta:4}],worker:{fps:60}}},true).suspectedCause).toBe('NATIVE_LOCAL_RTP_DISCONTINUITY');
  expect(classifyStutter({nativeStages:{stages:[],worker:{fps:0}}},true).suspectedCause).toBe('NATIVE_WORKER_CADENCE_DROP');
 });
 it('marks skipped callback spans as observation gaps when no other cause was measured',()=>{
  expect(classifyStutter({webInbound:{decodedFps:60},presentation:{intervalCallbackMaxGapMs:400,intervalMaxPauseMs:0}}).suspectedCause).toBe('CALLBACK_OBSERVATION_GAP');
 });
 it('preserves a WebRTC freeze observation even when intermediate callbacks were skipped',()=>{
  expect(classifyStutter({webInbound:{decodedFps:60,freezesDelta:1},presentation:{intervalCallbackMaxGapMs:400,intervalMaxPauseMs:0}}).suspectedCause).toBe('RECEIVER_STREAM_FREEZE');
 });
});
