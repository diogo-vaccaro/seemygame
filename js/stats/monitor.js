import { collectPeerMetrics } from './metrics.js';
import { renderStatsHud } from './hud.js';
import { observePresentation } from './presentation.js';
import { createDiagnostic, downloadDiagnostic, safeSample } from './diagnostic.js';
import { diagnoseSample } from './diagnosis.js';
import { getSenderParameterStatus } from '../streaming/sender-parameters.js';
/** Bounded, session-owned history and no overlapping async stats polls. */
export function createStatsMonitorScope({historyLimit=120}={}) {
 const monitors=new Map(),metrics=new Map(),histories=new Map(),cards=new Map();
 function releaseCard(binding) { binding.button?.removeEventListener('click',binding.exportHandler);binding.select?.removeEventListener('change',binding.changeHandler);if(binding.button)binding.button.disabled=true; }
 function renderCard(cardId,id,isLocal,sample) {
  const card=typeof document==='undefined'?null:document.getElementById(`card-${cardId}`);
  const button=card?.querySelector('.stats-export'),select=card?.querySelector('.stats-source');
  let binding=cards.get(cardId);
  if(button&&binding?.button!==button) {
   if(binding)releaseCard(binding);
   binding={button,select,exportHandler:()=>downloadDiagnostic(createDiagnostic(histories)),changeHandler:()=>{const value=metrics.get(select.value);if(value)renderStatsHud(cardId,value.direction==='outbound',value,histories.get(select.value));}};
   button.disabled=false;button.addEventListener('click',binding.exportHandler);select?.addEventListener('change',binding.changeHandler);cards.set(cardId,binding);
  }
  if(select) {
   const sources=[...monitors].filter(([,entry])=>entry.cardId===cardId).map(([key])=>key);
   if([...select.options].map(o=>o.value).join('|')!==sources.join('|')) {
    const chosen=select.value;select.replaceChildren(...sources.map((key,index)=>new Option(`Conexão ${index+1}`,key)));if(sources.includes(chosen))select.value=chosen;
   }
   select.hidden=sources.length<2;
   if(select.value!==id)return;
  }
  renderStatsHud(cardId,isLocal,sample,histories.get(id)||[]);
 }
 function stopStatsMonitor(id) {
  const e=monitors.get(id);if(e){clearInterval(e.timer);e.presentation?.dispose();}
  monitors.delete(id);metrics.delete(id);
  if(e&&!([...monitors.values()].some(entry=>entry.cardId===e.cardId))){const binding=cards.get(e.cardId);if(binding)releaseCard(binding);cards.delete(e.cardId);}
 }
 function startStatsMonitor(id,pc,isLocal=false,onTelemetry=null,options={}) {
  stopStatsMonitor(id);
  const e={busy:false,timer:null,video:null,cardId:options.cardId||id};monitors.set(id,e);metrics.set(id,{});
  if(!histories.has(id)){if(histories.size>=16){const oldest=histories.keys().next().value;stopStatsMonitor(oldest);histories.delete(oldest);}histories.set(id,[]);}
  e.timer=setInterval(async()=>{
   if(!pc||pc.connectionState==='closed'){stopStatsMonitor(id);return;}if(e.busy)return;e.busy=true;
   try {
    const reports=await pc.getStats();if(monitors.get(id)!==e)return;
    const cardId=options.cardId||id,card=typeof document==='undefined'?null:document.getElementById(`card-${cardId}`);
    const video=options.video||(!isLocal&&card?.querySelector('video'));
    if(video&&e.video!==video){e.presentation?.dispose();e.video=video;e.presentation=observePresentation(video);}
    const sample={...collectPeerMetrics(reports,{peerId:id,isLocal,previous:metrics.get(id),now:performance.now()}),...e.presentation?.sample(),...options.context?.()};
    sample.iceConnectionState=pc.iceConnectionState ?? sample.iceConnectionState;
    sample.connectionState=pc.connectionState ?? sample.connectionState;
    if(isLocal) {
     const sender=pc.getSenders?.().find(sender=>sender.track?.kind==='video');
     Object.assign(sample,sender?getSenderParameterStatus(sender):null);
    }
    sample.diagnosis=diagnoseSample(sample);
    metrics.set(id,sample);const history=histories.get(id);history.push(safeSample(sample));if(history.length>historyLimit)history.shift();
    renderCard(cardId,id,isLocal,sample);onTelemetry?.(sample);
   }catch(_) {
    if(monitors.get(id)===e){const sample={timestamp:performance.now(),sampleError:'stats-unavailable'};metrics.set(id,sample);const h=histories.get(id);h.push(sample);if(h.length>historyLimit)h.shift();renderCard(e.cardId,id,isLocal,sample);}
   }finally{e.busy=false;}
  },1000);
 }
 const getLastMetrics=(id=null)=>id?metrics.get(id)||null:Object.fromEntries(metrics);
 return {startStatsMonitor,stopStatsMonitor,getLastMetrics,getHistory:id=>id?(histories.get(id)||[]).map(safeSample):Object.fromEntries([...histories].map(([k,v])=>[k,v.map(safeSample)])),exportDiagnostic:()=>createDiagnostic(histories),dispose:()=>{[...monitors.keys()].forEach(stopStatsMonitor);histories.clear();}};
}
