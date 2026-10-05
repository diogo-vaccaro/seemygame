import {describe,it,expect} from 'vitest';
import {validateClockCheckpoints,correctedVisualLatency} from '../tools/e2e/harness/clock-calibration.mjs';
const point=(offsetMs,uncertaintyMs,extra={})=>({status:'valid',sourceTimeOrigin:1,receiverTimeOrigin:2,sourceAnchorMs:0,offsetMs,uncertaintyMs,...extra});
describe('Optional centered bookend envelope',()=>{
 it('covers the union of both causal intervals without increasing the budget',()=>{
  const a=point(0,4),b=point(3,5);
  expect(validateClockCheckpoints(a,[b],{maxErrorMs:7}).status).toBe('invalid');
  const v=validateClockCheckpoints(a,[b],{maxErrorMs:7,recenter:true});
  expect(v).toMatchObject({status:'valid',offsetMs:2,lowerMs:-4,upperMs:8,uncertaintyMs:7,maxErrorMs:7});
  for(const p of [a,b]){
   expect(v.lowerMs).toBeLessThanOrEqual(p.offsetMs-p.uncertaintyMs);
   expect(v.upperMs).toBeGreaterThanOrEqual(p.offsetMs+p.uncertaintyMs);
  }
 });
 it('rejects a genuinely wide envelope, uncertain points or a clock step',()=>{
  expect(validateClockCheckpoints(point(0,5),[point(20,5)],{recenter:true}).status).toBe('invalid');
  for(const extra of [{status:'too-uncertain'},{sourceAnchorMs:4},{receiverTimeOrigin:3}]){
   expect(validateClockCheckpoints(point(0,4),[point(1,4,extra)],{recenter:true}).status).toBe('invalid');
  }
 });
 it('corrects optical ages with the centered offset while preserving both bounds',()=>{
  const a=point(100,4),b=point(103,5);
  const envelope=validateClockCheckpoints(a,[b],{maxErrorMs:7,recenter:true});
  expect(correctedVisualLatency(1210,1000,envelope.offsetMs)).toBe(108);
  for(const offset of [envelope.lowerMs,envelope.upperMs]){
   const boundAge=correctedVisualLatency(1210,1000,offset);
   expect(Math.abs(boundAge-108)).toBeLessThanOrEqual(envelope.uncertaintyMs);
  }
 });
});
