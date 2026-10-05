import {sameRendererRoute,sameRendererSource} from './renderer-transport.mjs';
/** Keep exploratory comparisons honest: use only calibrated/provenance-valid
 * runs; priority must be read back from the OS, and order reversals must agree. */
export function captureRendererComparisons(report) {
 const groups=new Map();
 for(const r of report.runs||[]){const xs=groups.get(r.case.id)||[];xs.push(r);groups.set(r.case.id,xs);}
 const pairs=[['priority','priority-normal','priority-high'],['monitor-wgc','window-wgc','monitor-wgc'],['monitor-dxgi','monitor-wgc','monitor-dxgi'],['native-renderer','window-wgc','native-receiver'],['native-renderer-idle','baseline-browser','baseline-native'],['monitor-dxgi-idle','monitor-idle-wgc','monitor-idle-dxgi']];
 return pairs.map(([comparison,baseline,candidate])=>{
  const a=groups.get(baseline)||[],b=groups.get(candidate)||[];
  const evidence=a.map(x=>[x,b.find(y=>y.repetition===x.repetition)]).filter(x=>x[1]);
  const rows=evidence.map(([x,y])=>{
   const comparableRoute=sameRendererRoute(x.route,y.route);
   const comparableSource=sameRendererSource(x,y);
   const verified=x.status==='valid'&&y.status==='valid'&&comparableRoute&&comparableSource&&(!x.invalidProvenance&&!y.invalidProvenance)&&Number.isFinite(x.visualAgeMs?.p50)&&Number.isFinite(y.visualAgeMs?.p50);
   const priorityApplied=comparison!=='priority'||x.senderConditions?.priority?.applied===true&&y.senderConditions?.priority?.applied===true&&y.senderConditions.priority.effectiveGpuClass===4;
   const deltaMs=Number.isFinite(x.visualAgeMs?.p50)&&Number.isFinite(y.visualAgeMs?.p50)?y.visualAgeMs.p50-x.visualAgeMs.p50:null;
   const errorMs=(x.clocks?.validation?.uncertaintyMs??Infinity)+(y.clocks?.validation?.uncertaintyMs??Infinity);
   return {repetition:x.repetition,valid:verified&&priorityApplied,comparableRoute,comparableSource,deltaMs,errorMs,direction:!verified||!priorityApplied?'invalid':Math.abs(deltaMs)<=errorMs?'within-clock-error':deltaMs<0?'candidate-faster':'candidate-slower',fpsDelta:y.decodedFps-x.decodedFps};
  });
  const directions=rows.map(r=>r.direction);
  const conclusion=rows.length<2?'insufficient-repetitions':rows.some(r=>!r.valid)?'invalid-evidence':directions.every(d=>d==='candidate-faster')?'candidate-faster-in-both-orders':directions.every(d=>d==='candidate-slower')?'candidate-slower-in-both-orders':directions.every(d=>d==='within-clock-error')?'unresolved-within-clock-error':'inconsistent-or-unresolved';
  return {comparison,baseline,candidate,rows,conclusion,qualification:'Two order-reversed repetitions are exploratory, not population-level statistical proof or isolated causal attribution. Background resource pressure must be reviewed separately. Common observer measures visual age, not physical panel latency.'};
 });
}
