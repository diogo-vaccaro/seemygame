import {describe,it,expect} from 'vitest';
import {allowRendererCandidate,rendererRoute,sameRendererRoute,receiverContinuity} from '../tools/e2e/harness/renderer-transport.mjs';
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
