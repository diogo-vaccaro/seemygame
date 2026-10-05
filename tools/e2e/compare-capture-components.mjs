// No public STUN/TURN, no receiver: isolate source -> production capture/encode.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMotionFixture} from './fixtures/motion.mjs';
import {startAssetServer} from './harness/server.mjs';
import {startResourceSampler} from './harness/resources.mjs';
import {ensureDefaultDesktop} from './desktop-affinity.mjs';
import {benchmarkPressureOptions,benchmarkPreflight,qualifyBenchmarkRun} from './harness/benchmark-pressure.mjs';
ensureDefaultDesktop();
const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
const option=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const pressureOptions=benchmarkPressureOptions(args);
const seconds=Number(option('--seconds','20')),repeat=Number(option('--repeat','2')),exe=option('--exe',null);
if(!exe||!Number.isInteger(seconds)||seconds<5||seconds>60||!Number.isInteger(repeat)||repeat<1||repeat>3)throw Error('Explicit compiled --exe and bounded --seconds/--repeat required');
const id='components-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex'),title='SMG E2E Motion '+id;
const output=path.join(root,'output/playwright',id);await mkdir(output,{recursive:true});await copyFile(exe,path.join(output,'probe.exe'));
const report={id,status:'running',seconds,repeat,runs:[],scope:'Capture components only: no remote receiver, audio, replay, preview or WebRTC. GPU contention generated on source machine. Not an end-to-end latency measurement.',hashes:{}};
for(const f of ['src-tauri/src/media/pipeline.rs','src-tauri/src/media/config.rs','src-tauri/src/media/transport_comparison_probe.rs','src-tauri/src/media/frame_journey_probe.rs','tools/e2e/compare-capture-components.mjs','tools/e2e/harness/benchmark-pressure.mjs','tools/e2e/fixtures/motion.mjs','tools/e2e/fixtures/game-workload.mjs'])report.hashes[f]=createHash('sha256').update(await readFile(path.join(root,f))).digest('hex');
report.exeSha256=createHash('sha256').update(await readFile(exe)).digest('hex');
const cases=[{id:'d12-latest',backend:'d3d12',capture:'window-wgc',priority:'normal',rawQueue:'latest'},{id:'priority-normal',backend:'d3d12',capture:'window-wgc',priority:'normal'},{id:'priority-high',backend:'d3d12',capture:'window-wgc',priority:'high'},{id:'window-wgc',backend:'d3d11',capture:'window-wgc',priority:'normal'},{id:'monitor-wgc',backend:'d3d11',capture:'monitor-wgc',priority:'normal'},{id:'monitor-dxgi',backend:'d3d11',capture:'monitor-dxgi',priority:'normal'}];
const selected=option('--cases',cases.map(c=>c.id).join(',')).split(',');if(selected.some(id=>!cases.some(c=>c.id===id)))throw Error('Unknown case');
const wait=ms=>new Promise(r=>setTimeout(r,ms));let browser,server,resources,child,ready,token;
async function rpc(op,extra={}){const r=await (await fetch(`http://127.0.0.1:${ready.port}/${token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...extra}),signal:AbortSignal.timeout(5000)})).json();if(!r.ok)throw Error(r.error);return r.data;}
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
async function stop(){if(child?.exitCode===null){try{await rpc('stop');}catch{}await wait(250);if(child.exitCode===null)child.kill();}child=null;ready=null;}
try{
 resources=await startResourceSampler({enabled:true});report.pressurePolicy=pressureOptions;report.preflight=await benchmarkPreflight(resources,pressureOptions);await save();
 if(report.preflight.status!=='clear'&&!pressureOptions.allowPressure)throw Error('Resource preflight unqualified: '+report.preflight.issues.join(', ')+'; do not run builds/tests concurrently. Explicit --allow-resource-pressure preserves unqualified results.');
 server=await startAssetServer({root,fixtures:{'/fixtures/components.html':createMotionFixture(title,42,60,{width:1920,height:1080,workload:{profile:'gpu-unlimited',scene:'offscreen',iterations:96,passes:16,workers:0}})}});
 browser=await chromium.launch({channel:'chrome',headless:false,args:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-features=CalculateNativeWinOcclusion','--window-position=0,0','--window-size=1920,1080']});
 const context=await browser.newContext({viewport:null}),page=await context.newPage();await page.goto(server.origin+'/fixtures/components.html');await page.evaluate(()=>{document.documentElement.onclick=()=>document.documentElement.requestFullscreen();});await page.locator('canvas').last().click({position:{x:100,y:200}});await page.waitForFunction(()=>document.fullscreenElement!==null);report.geometry=await page.evaluate(()=>({innerWidth,innerHeight,devicePixelRatio}));report.sourceBrowser=browser.version();
 for(let rep=1;rep<=repeat;rep++)for(const c of(rep%2?cases:[...cases].reverse()).filter(c=>selected.includes(c.id))){
  const run={case:c,repetition:rep,status:'running'};report.runs.push(run);await save();console.log('[Components] '+rep+'/'+repeat+' '+c.id);
  token=randomBytes(24).toString('hex');let log='';
  try{
   await page.bringToFront();await wait(1500);run.sourceBefore=await page.evaluate(()=>({...window.__smgSourceStats,frameLog:undefined}));
   child=spawn(path.join(output,'probe.exe'),['run_transport_comparison_probe','--ignored','--nocapture','--test-threads=1'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,SEEMYGAME_GSTREAMER_ROOT:path.join(root,'native-media/gstreamer'),PATH:path.join(root,'native-media/gstreamer/bin')+';'+process.env.PATH,SMG_COMPARE_RAW_QUEUE:c.rawQueue??'bounded',SMG_COMPARE_PRIVATE_NETWORK:'1',SMG_COMPARE_ROLE:'sender',SMG_COMPARE_TITLE:title,SMG_COMPARE_TOKEN:token,SMG_COMPARE_CAPTURE:c.capture,SMG_COMPARE_BACKEND:c.backend,SMG_COMPARE_GPU_PRIORITY:c.priority,GST_DEBUG:'*:2'}});
   const reader=createInterface({input:child.stdout});reader.on('line',l=>{log+=l+'\n';const i=l.indexOf('SMG_COMPARE_READY ');if(i>=0)ready=JSON.parse(l.slice(i+18));});child.stderr.on('data',d=>log+=d);
   const watchdog=setTimeout(()=>child?.kill(),(seconds+45)*1000);
   try{
    for(let i=0;i<200&&!ready;i++){if(child.exitCode!==null)throw Error('Capture probe startup failed');await wait(100);}if(!ready)throw Error('Capture readiness timeout');run.conditions=ready;
    await wait(3000);await rpc('reset');const start=Date.now();await wait(seconds*1000);const end=Date.now();run.evidence=await rpc('status',{full:true});run.steadySeconds=(end-start)/1000;run.resources=resources.window(start,end);
    const frames=run.evidence.journey.frames;run.encodedFps=frames.length/run.steadySeconds;run.metrics=run.evidence.journey.metrics;const complete=run.metrics.captureToEncodedMs.samples;run.status=frames.length>seconds*10&&complete>=frames.length*.95?'valid':'insufficient-evidence';qualifyBenchmarkRun(run,{...pressureOptions,preflight:report.preflight});run.priorityApplied=ready.priority.applied;console.log(JSON.stringify({case:c.id,rep,status:run.status,fps:run.encodedFps,priority:ready.priority,captureToEncoded:run.metrics.captureToEncodedMs,captureQueue:run.metrics.captureQueueMs,encode:run.metrics.encodeMs}));
   }finally{clearTimeout(watchdog);await stop();reader.close();}
   // Read the source only after restoring the priority context by stopping the probe.
   run.sourceAfter=await page.evaluate(()=>({...window.__smgSourceStats,frameLog:undefined}));
  }catch(e){run.status='failed';run.error=e.message;console.log('Case failed: '+e.message);await stop();}
  finally{await writeFile(path.join(output,c.id+'-'+rep+'.log'),log);await save();await wait(1000);}
 }
 report.status=report.runs.every(r=>r.status==='valid')?'completed':'completed-with-failures';
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1;}
finally{await stop();await resources?.stop();report.resources=resources?.report();await browser?.close();await server?.close();await save();console.log('Capture components: '+output);}
