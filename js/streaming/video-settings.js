import { QUALITY_PROFILES, DEFAULT_PROFILE } from '../config.js';
import { isDesktopApp } from '../desktop.js';

const preferenceKeys = {
 'stream-resolution-select':'seemygame_stream_resolution',
 'stream-fps-select':'seemygame_stream_fps',
 'bitrate-slider':'seemygame_stream_bitrate_kbps',
 'stream-performance-mode':'seemygame_stream_performance'
};
const canonicalProfile = key => QUALITY_PROFILES[key === 'hd60' ? 'ultra' : key === 'fhd60' ? 'balanced' : key] || DEFAULT_PROFILE;
export function readVideoSettings(root = document) {
 const value = id => root.getElementById(id)?.value;
 const profile = canonicalProfile(value('quality-preset'));
 const height = [720,1080].includes(Number(value('stream-resolution-select'))) ? Number(value('stream-resolution-select')) : profile.height;
 const fps = [30,60,120].includes(Number(value('stream-fps-select'))) ? Number(value('stream-fps-select')) : profile.fps;
 const bitrate = Number(value('bitrate-slider'));
 const mode = value('stream-performance-mode') === 'responsive' ? 'responsive' : 'smooth';
 return {width:height===720?1280:1920,height,fps,bitrateKbps:Number.isFinite(bitrate)&&bitrate>=256&&bitrate<=50000?bitrate:Math.round(profile.bitrate/1000),performanceMode:mode,rawVideoQueue:mode==='responsive'?'latest':'bounded'};
}
export function bindVideoSettings(session, {desktop = isDesktopApp()} = {}) {
 if(session.videoSettingsBound)return;
 session.videoSettingsBound=true;
 const mode=document.getElementById('stream-performance-mode');
 const update=()=>{
  const settings=readVideoSettings();
  const label=document.getElementById('bitrate-display');
  if(label)label.textContent=`${(settings.bitrateKbps/1000).toFixed(2).replace(/0$/,'')} Mbps`;
  if(mode){
   mode.disabled=!desktop;
   const note=document.getElementById('stream-performance-note');
   if(note)note.textContent=!desktop?'No navegador, as filas de captura são gerenciadas pelo browser. Este modo de descarte é exclusivo do app; resolução, FPS e bitrate continuam disponíveis.':settings.performanceMode==='responsive'?'Prioriza frames recentes, descartando os antigos antes de codificar. Pode reduzir FPS ou aumentar engasgos; menor latência remota não é garantida. Aplicado ao reiniciar.':'Preserva mais frames para compartilhar com amigos. Sob carga, pode acumular atraso; não elimina stutters de GPU ou rede. Aplicado ao reiniciar.';
   mode.title=note?.textContent||'';
  }
 };
 for(const [id,key] of Object.entries(preferenceKeys)){
  const el=document.getElementById(id);
  if(!el)continue;
  try{const saved=localStorage.getItem(key);if(saved && (el.tagName==='SELECT'?[...el.options].some(o=>o.value===saved):Number(saved)>=500&&Number(saved)<=50000))el.value=saved;}catch{}
  session.addEventListener(el,'change',()=>{
   if(['stream-resolution-select','stream-fps-select'].includes(id)){
    const preset=document.getElementById('quality-preset');if(preset)preset.value='custom';
   }
   update();
   for(const [field,storageKey] of Object.entries(preferenceKeys)){
    const value=document.getElementById(field)?.value;
    if(value)try{localStorage.setItem(storageKey,value);}catch{}
   }
  });
  if(id==='bitrate-slider')session.addEventListener(el,'input',update);
 }
 session.addEventListener(document.getElementById('quality-preset'),'change',event=>{
  const p=canonicalProfile(event.target.value);
  for(const [id,value] of [['stream-resolution-select',p.height],['stream-fps-select',p.fps],['bitrate-slider',p.bitrate/1000]]){
   const el=document.getElementById(id);if(el)el.value=String(value);
  }
  update();
 });
 update();
}
