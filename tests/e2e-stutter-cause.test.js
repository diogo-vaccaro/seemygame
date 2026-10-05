import {describe,it,expect} from 'vitest';
import {classifyStutter} from '../tools/e2e/harness/stutter-cause.mjs';
describe('Stutter evidence',()=>{
 it('respects separate stream and source cadence targets at 30 FPS',()=>{
  const options={targetFps:30,sourceFps:60};
  const entry={source:{fps:60},nativeStages:{worker:{fps:29.5}},bridge:{decodedFps:29},webInbound:{nackDelta:3}};
  expect(classifyStutter(entry,true,options).suspectedCause).toBe('RTP_LOSS_OR_RECOVERY');
  expect(classifyStutter({...entry,nativeStages:{worker:{fps:14}}},true,options).suspectedCause).toBe('NATIVE_WORKER_CADENCE_DROP');
  expect(classifyStutter({...entry,source:{fps:20}},true,options).suspectedCause).toBe('SOURCE_WINDOW_THROTTLING');
  expect(classifyStutter({source:{fps:29.5}},false,{targetFps:30,sourceFps:30}).suspectedCause).toBe('UNRESOLVED_PRESENTATION_STALL');
 });
 it('does not blame the compositor from a callback pause alone',()=>{
  expect(classifyStutter({webInbound:{decodedFps:60},presentation:{intervalMaxPauseMs:500}})).toEqual({suspectedCause:'UNRESOLVED_PRESENTATION_STALL',confidence:'low'});
 });
 it('distinguishes current loss/recovery feedback from historical cumulative loss',()=>{
  expect(classifyStutter({webInbound:{packetsLost:100,packetsLostDelta:0,nackDelta:0,pliDelta:0}}).suspectedCause).toBe('UNRESOLVED_PRESENTATION_STALL');
  expect(classifyStutter({webInbound:{decodedFps:0,nackDelta:3}}).suspectedCause).toBe('RTP_LOSS_OR_RECOVERY');
 });
 it('identifies a stalled native bridge including exactly zero FPS without masking the symptom',()=>{
  expect(classifyStutter({source:{fps:60},bridge:{decodedFps:0},webInbound:{decodedFps:0}},true).suspectedCause).toBe('NATIVE_CAPTURE_OR_BRIDGE_THROTTLING');
 });
 it('retains observed source, CPU, bandwidth and jitter limitations',()=>{
  expect(classifyStutter({source:{fps:20}}).suspectedCause).toBe('SOURCE_WINDOW_THROTTLING');
  expect(classifyStutter({outbound:{limitation:'cpu'}}).suspectedCause).toBe('STREAMER_CPU_SATURATION');
  expect(classifyStutter({outbound:{limitation:'bandwidth'}}).suspectedCause).toBe('WEBRTC_BANDWIDTH_LIMITATION');
  expect(classifyStutter({webInbound:{jitterBufferMs:120}}).suspectedCause).toBe('RECEIVER_JITTER_BUFFER_STALL');
 });
});
