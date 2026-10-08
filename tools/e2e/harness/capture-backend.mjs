/** Capability probes do not prove which source actually produced frames. */
import {codecName} from '../../../js/streaming/codecs.js';
export function verifyNegotiatedCodec(samples,requested){
 const codecs=[...new Set(samples.map(s=>s.codec).filter(Boolean).map(codecName))];
 if(!codecs.length||codecs.some(c=>c!==codecName(requested)))throw new Error(`Matched codec failed: requested ${requested}, negotiated ${codecs.join(',')||'unknown'}`);
 return {passed:true,requested,actual:codecs};
}
export function readCaptureBackendEvidence(log,requested){
 if(!['auto','d3d11','d3d12'].includes(requested))throw new Error('Invalid capture backend');
 const pipelineLines=log.split(/\r?\n/).filter(line=>line.includes('[GStreamer Pipeline]')&&/d3d1[12]screencapturesrc\b/.test(line));
 const actual=[...new Set(pipelineLines.map(line=>line.match(/(d3d1[12])screencapturesrc\b/)[1]))];
 const active=pipelineLines.at(-1)?.match(/(d3d1[12])screencapturesrc\b/)?.[1]??null;
 return {requested,actual,active,pipelineLines,matched:requested==='auto'?active!==null:actual.length===1&&actual[0]===requested};
}
/** Validate actual worker arguments, rather than trusting the requested env. */
export function readRawQueueEvidence(pipelineLines,requested){
 if(!['bounded','latest'].includes(requested))throw Error('Invalid raw queue policy');
 const required=requested==='latest'?['max-size-buffers=1','max-size-time=0','max-size-bytes=0','leaky=downstream']:['max-size-buffers=3','max-size-time=50000000','max-size-bytes=0'];
 const checks=(pipelineLines??[]).map(line=>{
  const elements=line.split('!').map(s=>s.trim());
  const encoder=elements.findIndex(e=>/^(nvd3d11h264enc|mfh264enc|x264enc)\b/.test(e));
  const queues=encoder<0?[]:elements.slice(0,encoder).filter(e=>/^queue\b/.test(e));
  return {queues,matched:queues.length===2&&queues.every(e=>{const tokens=e.split(/\s+/);return required.every(t=>tokens.includes(t))&&(requested==='latest'||!tokens.some(t=>t.startsWith('leaky=')));})};
 });
 return {requested,pipelineCount:checks.length,checks,matched:checks.length>0&&checks.every(c=>c.matched)};
}
