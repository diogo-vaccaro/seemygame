import {describe,it,expect} from 'vitest';
import {allowRendererCandidate,rendererRoute,sameRendererRoute,receiverContinuity,rendererContentReadiness} from '../tools/e2e/harness/renderer-transport.mjs';
describe('renderer comparison transport qualification',()=>{
  const candidate=(address,type='host')=>`candidate:1 1 UDP 1 ${address} 5000 typ ${type}`;
  it('permits LAN plus public reflexive candidates without mixing VPNs',()=>{
    expect(allowRendererCandidate(candidate('192.168.15.4'))).toBe(true);
    expect(allowRendererCandidate(candidate('177.1.2.3','srflx'))).toBe(true);
    for(const ip of ['100.106.174.54','172.17.144.1','127.0.0.1','::1','abc.local'])expect(allowRendererCandidate(candidate(ip))).toBe(false);
    expect(allowRendererCandidate(candidate('192.168.15.4'),'public-srflx')).toBe(false);
    expect(allowRendererCandidate(candidate('100.106.174.54'),'tailscale')).toBe(true);
    expect(allowRendererCandidate('')).toBe(true);
  });
  it('uses the transport selected pair rather than another successful pair',()=>{
    const stats=[{type:'transport',selectedCandidatePairId:'selected'},
      {id:'other',type:'candidate-pair',state:'succeeded',nominated:true},
      {id:'selected',type:'candidate-pair',localCandidateId:'a',remoteCandidateId:'b',currentRoundTripTime:.012},
      {id:'a',ip:'192.168.15.4',protocol:'udp',port:1,candidateType:'host'},
      {id:'b',address:'192.168.15.7',protocol:'udp',port:2,candidateType:'prflx'}];
    const route=rendererRoute(stats);expect(route.pairId).toBe('selected');expect(route.rttMs).toBe(12);
    expect(sameRendererRoute(route,{...route,local:{...route.local,port:99}})).toBe(true);
    expect(sameRendererRoute(route,{...route,remote:{...route.remote,address:'100.1.2.3'}})).toBe(false);
    expect(sameRendererRoute(null,null)).toBe(false);
    const incomplete={...route,local:{...route.local,protocol:undefined}};
    expect(sameRendererRoute(incomplete,incomplete)).toBe(false);
  });
  it('rejects warmup-only reception and missing/reset counters',()=>{
    expect(receiverContinuity([{receiver:{decoded:20}},{receiver:{decoded:20}}],false).valid).toBe(false);
    expect(receiverContinuity([{receiver:{decoded:20}},{receiver:{decoded:40}}],false).valid).toBe(true);
    expect(receiverContinuity([{browser:{inbound:{framesDecoded:35}}}],true,30).deltas).toEqual([5]);
    expect(receiverContinuity([{browser:{}}],true,30).valid).toBe(false);
  });
});

describe('synthetic video content readiness',()=>{
  const marker=(seq,time=seq*16)=>({seq,sourceTime32:time,captureEpoch:1000+time});
  it('rejects decoded black video despite increasing frame counters',()=>{
    const result=rendererContentReadiness({decoded:180,opticalSamples:0,optics:[],rejectedReads:24});
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no-valid-synthetic-optical-marker');
    expect(result.rejectedReads).toBe(24);
  });
  it('rejects a frozen valid marker sampled many times',()=>{
    const result=rendererContentReadiness({opticalSamples:24,optics:Array(24).fill(marker(1))});
    expect(result.valid).toBe(false);
    expect(result.distinctMarkers).toBe(1);
    expect(result.reason).toBe('synthetic-optical-marker-not-advancing');
  });
  it('requires distinct frames and accepts sequence/timestamp rollover',()=>{
    const optics=[marker(65535,0xfffffff0),marker(0,0),marker(1,16)];
    expect(rendererContentReadiness({opticalSamples:3,optics}).valid).toBe(true);
    expect(rendererContentReadiness({opticalSamples:2,optics}).valid).toBe(false);
  });
  it('rejects absent optical evidence and malformed markers',()=>{
    expect(rendererContentReadiness().valid).toBe(false);
    expect(rendererContentReadiness({opticalSamples:60}).valid).toBe(false);
    expect(rendererContentReadiness({opticalSamples:3,optics:[marker(-1),marker(2,NaN),{seq:3,sourceTime32:48}]}).valid).toBe(false);
  });
});
