import {describe,it,expect} from 'vitest';
import {requireOpticalEvidence,percentile,summarizeNativeStageRun,summarizeBrowserStageRun} from '../tools/e2e/harness/causal-summary.mjs';

describe('causal diagnostic evidence',()=>{
  it('fails closed for missing optical evidence, including null percentiles and missing sample count',()=>{
    for(const value of [null,{}, {steadyLatency:null},{steadyLatency:{p50:10,p99:20}},{steadyLatency:{p50:10,p99:20,samplesCount:2}},{steadyLatency:{p50:null,p99:20,samplesCount:100}}])expect(()=>requireOpticalEvidence(value,12,8)).toThrow();
    expect(requireOpticalEvidence(null,12,0)).toMatchObject({status:'not-measured'});
    expect(requireOpticalEvidence({steadyLatency:{p50:10,p99:20,samplesCount:90}},12,8)).toMatchObject({status:'measured'});
  });
  it('keeps null measurements distinct from zero',()=>{
    expect(percentile([null,undefined,NaN])).toBeNull();
    expect(percentile([null,0,2])).toBe(0);
  });
  it('checks component additivity for matched frames, never by summing interval medians',()=>{
    const r=summarizeNativeStageRun({repetition:1,workload:{profile:'off'},stages:{encoded:{fps:60},capture:{frames:3}},frameJourney:{metrics:{},frames:[{captureToEncodedMs:10,captureToEncoderInputMs:1,encodeMs:9},{captureToEncodedMs:10,captureToEncoderInputMs:9,encodeMs:1},{captureToEncodedMs:null}],pendingUnmatched:1,evicted:0}});
    expect(r).toMatchObject({matchedFrames:2,capturedFrames:3,maxSameFrameAdditivityErrorMs:0,unmatched:1});
  });
  it('reads the real telemetry schema and handles capture without RTP',()=>{
    const snapshot=(at,n)=>({at,rows:[],videos:[{playbackQuality:{totalVideoFrames:n,droppedVideoFrames:0}}]});
    const r=summarizeBrowserStageRun({repetition:1,workload:{profile:'off'},mode:'raw',before:snapshot(1000,60),after:snapshot(2000,120),timeline:[],presentation:{steadyLatency:{p50:20}}});
    expect(r).toMatchObject({renderedFps:60,encodeTimeMs:null,decodeTimeMs:null,decodedFps:null});
    expect(r.resources.gpu3DP50Percent).toBeNull();
  });
});
