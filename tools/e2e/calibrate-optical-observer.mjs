// Local instrument control: NO encoder, WebRTC or remote receiver. Do not
// subtract these medians from network benchmarks as if they were per-frame costs.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {startAssetServer} from './harness/server.mjs';
import {launchSourceWindow} from './harness/source-window.mjs';
import {startDisplayAwakeLease} from './harness/display-awake.mjs';
import {createMotionFixture} from './fixtures/motion.mjs';
import {collectRendererEndEvidence,qualifyWindowOptics} from './harness/renderer-end-evidence.mjs';
import {correctedVisualLatency,calibrateLocalSourceClock,validateClockCheckpoints} from './harness/clock-calibration.mjs';
import {ensureDefaultDesktop} from './desktop-affinity.mjs';
ensureDefaultDesktop();
const args=process.argv.slice(2),option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const executable=path.resolve(option('--exe','src-tauri/target/debug/deps/app_lib-0d67e5ef0b738230.exe'));
const seconds=Number(option('--seconds','15')),repeat=Number(option('--repeat','3'));
const observerFps=Number(option('--observer-fps','60'));
if(![8,30,60].includes(observerFps))throw Error('Observer FPS must be 8, 30 or 60');
if(!Number.isInteger(seconds)||seconds<5||seconds>60||!Number.isInteger(repeat)||repeat<1||repeat>4)throw Error('Invalid observer calibration arguments');
const id='observer-calibration-'+new Date().toISOString().replace(/[:.]/g,'-'),output=path.resolve('output/playwright',id);
await mkdir(output,{recursive:true});
const report={id,status:'running',seconds,repeat,observerFps,runs:[],scope:'Local synthetic source CPU timestamp to common WGC observer capture arrival; includes source/compositor/observer delay; NO streaming; NOT a correction factor for another execution'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const dist=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b),q=p=>a.length?a[Math.ceil(a.length*p)-1]:null;return {samples:a.length,p50:q(.5),p90:q(.9),p99:q(.99),max:q(1)};};
let browser,server,lease,child,ready,reader,log='';
const token=randomBytes(24).toString('hex');
async function rpc(op,extra={}){const response=await fetch(`http://127.0.0.1:${ready.port}/${token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...extra}),signal:AbortSignal.timeout(15000)});const result=await response.json();if(!result.ok)throw Error(result.error);return result.data;}
try{
 report.exeSha256=createHash('sha256').update(await readFile(executable)).digest('hex');report.hashes={};
 for(const file of ['tools/e2e/calibrate-optical-observer.mjs','tools/e2e/harness/renderer-end-evidence.mjs','tools/e2e/fixtures/motion.mjs'])report.hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
 lease=await startDisplayAwakeLease();report.displayAwake=lease.evidence;
 const title='SMG E2E Motion '+id,magic=431;
 server=await startAssetServer({root:process.cwd(),fixtures:{'/fixtures/observer.html':createMotionFixture(title,magic,60,{width:1920,height:1080})}});
 const source=await launchSourceWindow(chromium,{profile:path.join(output,'source-profile'),url:server.origin+'/fixtures/observer.html',args:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
 browser=source.browser;report.windowEvidence=source.windowEvidence;
 child=spawn(executable,['run_transport_comparison_probe','--ignored','--nocapture','--test-threads=1'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,SEEMYGAME_GSTREAMER_ROOT:path.resolve('native-media/gstreamer'),PATH:path.resolve('native-media/gstreamer/bin')+';'+process.env.PATH,SMG_COMPARE_ROLE:'observer',SMG_COMPARE_TOKEN:token,SMG_COMPARE_OBSERVER_FPS:String(observerFps)}});
 reader=createInterface({input:child.stdout});reader.on('line',line=>{log+=line+'\n';const at=line.indexOf('SMG_COMPARE_READY ');if(at>=0)ready=JSON.parse(line.slice(at+18));});child.stderr.on('data',d=>log+=d);
 for(let i=0;i<150&&!ready;i++){if(child.exitCode!==null)throw Error('Observer exited: '+log.slice(-1000));await wait(100);}
 if(!ready)throw Error('Observer readiness timeout');report.probe=ready;
 for(let repetition=1;repetition<=repeat;repetition++){
  await rpc('observe',{title,magic});await wait(3000);
  const clockPage={evaluate:()=>rpc('clock')},before=await calibrateLocalSourceClock(source.page,clockPage,{samples:25});await rpc('reset');
  const start=Date.now();await wait(seconds*1000);const end=Date.now();
  const evidence=await collectRendererEndEvidence(()=>rpc('status',{full:true}),()=>source.page.evaluate(()=>window.__smgSourceStats));
  const after=await calibrateLocalSourceClock(source.page,clockPage,{samples:25}),clocks={before,after,validation:validateClockCheckpoints(before,[after],{recenter:true})};
  const offsetMs=clocks.validation.offsetMs??before.offsetMs;
  const qualification=qualifyWindowOptics(evidence.receiverEvidence.optics,evidence.sourceAfter.frameLog,{start,end,offsetMs});
  const ages=qualification.samples.filter(s=>s.provenanceValid).map(s=>correctedVisualLatency(s.captureEpoch,s.sourceTime32,offsetMs)).filter(n=>n>=0&&n<3000);
  const readbackLag=qualification.samples.map(s=>s.readbackEpoch-s.captureEpoch);
  const run={repetition,window:{start,end},...evidence,clocks,qualification,visualAgeMs:dist(ages),readbackArrivalLagMs:dist(readbackLag),actualObserverHz:ages.length*1000/(end-start),status:clocks.validation.status==='valid'&&!qualification.invalidProvenance&&!qualification.malformed&&ages.length>=seconds*3?'valid':'insufficient-evidence'};
  report.runs.push(run);console.log(JSON.stringify({repetition,status:run.status,age:run.visualAgeMs,readback:run.readbackArrivalLagMs,hz:run.actualObserverHz}));
 }
 report.status=report.runs.every(r=>r.status==='valid')?'completed':'completed-with-unqualified-runs';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{
 if(ready&&child?.exitCode===null)try{await rpc('stop');}catch{}
 if(child?.exitCode===null){await wait(300);if(child.exitCode===null)child.kill();}
 reader?.close();await browser?.close();await server?.close();if(lease)report.displayAwakeRestoration=await lease.stop();
 await writeFile(path.join(output,'probe.log'),log);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log('Observer calibration '+report.status+': '+output);
}
