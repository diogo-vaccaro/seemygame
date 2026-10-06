export function captureVideoConstraints(settings) {
 return {width:{ideal:settings.width,max:settings.width},height:{ideal:settings.height,max:settings.height},frameRate:{ideal:settings.fps,max:settings.fps}};
}
/** Fit the actual capture inside the profile, preserving aspect ratio. */
export function videoScaleForProfile(trackSettings = {}, profile = {}, fallback = 1) {
 const ratios = ['width', 'height'].flatMap(axis => {
  const source = Number(trackSettings[axis]), target = Number(profile[axis]);
  return Number.isFinite(source) && source > 0 && Number.isFinite(target) && target > 0 ? [source / target] : [];
 });
 return ratios.length ? Math.max(1, ...ratios) : Math.max(1, Number(fallback) || 1);
}
const p=(values,q)=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(q*sorted.length)-1]:null;};
/** Evidence gate, not a hardware guarantee. A certificate is scoped to the recorded run conditions. */
export function assessQuality(samples,{fps,width,height,codec,minSeconds=60}={}) {
 const valid=samples.filter(s=>Number.isFinite(s.measuredFps)&&Number.isFinite(s.presentedFps));
 const durationMs=valid.reduce((n,s)=>n+(s.intervalMs||0),0);
 const result={status:'insufficient-evidence',durationMs,sampleCount:valid.length,fpsP10:p(valid.map(s=>s.measuredFps),.1),presentationP10:p(valid.map(s=>s.presentedFps),.1),frametimeP95Ms:p(valid.map(s=>s.frametimeP95Ms),.95),maxPauseMs:p(valid.map(s=>s.maxPauseMs),1),requested:{fps,width,height,codec:codec||null}};
 // Allow 50ms of clock/timer rounding at the boundary; never accept a short smoke run.
 if(durationMs<minSeconds*1000-50||valid.length<minSeconds*.8)return result;
 const canonical=c=>String(c||'').replace(/^video\//i,'').toLowerCase().replace(/^hevc$/,'h265');
 result.failureReasons=[];
 if(!valid.every(s=>s.width===width&&s.height===height&&s.visibility==='visible'&&s.codec&&(!codec||canonical(codec)==='auto'||canonical(s.codec)===canonical(codec))))result.failureReasons.push('profile-or-visibility-mismatch');
 if(result.fpsP10<fps*.9)result.failureReasons.push('decode-cadence-below-target');
 if(result.presentationP10<fps*.9)result.failureReasons.push('composition-cadence-below-target');
 if(Number.isFinite(result.maxPauseMs)&&result.maxPauseMs>Math.max(50,4000/fps))result.failureReasons.push('consecutive-frame-pause');
 result.pauseEvidence=Number.isFinite(result.maxPauseMs)?'observed-frame-intervals':'unavailable';
 result.status=result.failureReasons.length?'failed':result.pauseEvidence==='unavailable'?'insufficient-evidence':'passed';
 return result;
}

