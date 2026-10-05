// One physical machine; sequential real application E2E runs, no SSH or remote viewer.
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {validateGameWorkload} from './fixtures/game-workload.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
const option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const seconds=Number(option('--seconds','75')),bitrate=Number(option('--bitrate-kbps','7500'));
if(!Number.isInteger(seconds)||seconds<70||seconds>180||!Number.isInteger(bitrate)||bitrate<256||bitrate>50000)throw Error('Invalid local matrix conditions');
const exe=path.resolve(root,option('--exe','output/playwright/d3d12-hevc-experiment-build/release/seemygame.exe'));
const runtime=path.resolve(root,option('--gstreamer-root','native-media/gstreamer'));
const channel=option('--channel','chrome'),only=option('--cases','').split(',').filter(Boolean),planOnly=args.includes('--plan-only');
const workload=validateGameWorkload({profile:option('--source-workload','off'),scene:option('--workload-scene','visible'),iterations:Number(option('--workload-iterations','96')),passes:Number(option('--workload-passes','24')),workers:Number(option('--workload-workers','4'))});
const output=path.join(root,'output/playwright','local-media-matrix-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex'));
await mkdir(output,{recursive:true});
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const definitions=[
 {id:'native-h264-nvenc-d3d11',sender:'native',codec:'h264',encoder:'nvenc',actualEncoder:'nvd3d11h264enc',api:'d3d11',requires:['nvd3d11h264enc','d3d11screencapturesrc','rtph264pay','rtph264depay']},
 {id:'web-h264',sender:'web',codec:'h264',encoder:'browser-auto',actualEncoder:null,api:'getDisplayMedia',requires:[]},
 {id:'native-h264-nvenc-d3d12',sender:'native',codec:'h264',encoder:'nvenc',actualEncoder:'nvd3d11h264enc',api:'d3d12',requires:['nvd3d11h264enc','d3d12screencapturesrc','d3d12convert','d3d12download']},
 {id:'native-h264-mf-d3d11',sender:'native',codec:'h264',encoder:'mf',actualEncoder:'mfh264enc',api:'d3d11',requires:['mfh264enc','d3d11screencapturesrc']},
 {id:'web-av1',sender:'web',codec:'av1',encoder:'browser-auto',actualEncoder:null,api:'getDisplayMedia',requires:[]},
 {id:'native-hevc-mf-d3d11',sender:'native',codec:'hevc',encoder:'auto',actualEncoder:'mfh265enc',api:'d3d11',requires:['mfh265enc','h265parse','rtph265pay','rtph265depay']},
 {id:'web-hevc',sender:'web',codec:'hevc',encoder:'browser-auto',actualEncoder:null,api:'getDisplayMedia',requires:[]},
 {id:'native-h264-cpu-d3d11',sender:'native',codec:'h264',encoder:'cpu',actualEncoder:'x264enc',api:'d3d11',requires:['x264enc','d3d11download']},
 {id:'native-av1-cpu-d3d11',sender:'native',codec:'av1',encoder:'auto',actualEncoder:'svtav1enc',api:'d3d11',requires:['svtav1enc','av1parse','rtpav1pay','rtpav1depay']}
];
if(only.some(id=>!definitions.some(d=>d.id===id)))throw Error('Unknown matrix case');
const report={status:'probing',startedAt:new Date().toISOString(),seconds,bitrateKbps:bitrate,executable:{path:exe,sha256:await sha(exe)},conditions:{samePhysicalMachine:true,preset:'balanced',width:1920,height:1080,fps:60,receiver:channel,receiverViewport:{width:1280,height:720},sourcePosition:'30,30',viewerPosition:'80,80',opticalHz:8,opticalReader:'gpu-roi',audio:false,replay:false,tracing:false,nativePreview:false},definitions,capabilities:null,runs:[],skipped:[],limitations:['Capture, encode, decode, source and receiver share CPU/GPU; not an isolated sender or two-machine performance benchmark.','Native uses the diagnostic no-preview adapter with real encoded RTP; not the production preview path.','Web encoder/API internals are browser-managed; requested codec does not prove selected codec.','Native capture is WGC window capture; D3D12 H264 uses D3D11 GPU-memory interop for the same NVENC encoder.','Synthetic source, no game stress; no physical panel scanout measurement.','Optical sampling is enabled identically at 8 Hz, so it adds instrumentation to every case.','Sequential single runs; external load can vary. Unsupported combinations are not benchmark results.'],notImplemented:['D3D12 with Media Foundation, CPU, HEVC or AV1','Native NVENC HEVC/AV1 selection','Native CPU HEVC selection','Manual browser hardware encoder or D3D API selection'],helperHashes:{}};
for(const file of ['tools/e2e/local-media-matrix.mjs','tools/e2e/run.mjs','tools/e2e/harness/no-preview.mjs','tools/e2e/harness/receiver-payloads.mjs'])report.helperHashes[file]=await sha(path.join(root,file));
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
report.conditions.sourceWorkload=workload;
if(workload.profile!=='off')report.limitations=report.limitations.map(s=>s.startsWith('Synthetic source, no game stress')?'Captured synthetic WebGL shader workload, not a commercial game engine; no physical panel scanout measurement.':s);
report.helperHashes['tools/e2e/fixtures/game-workload.mjs']=await sha(path.join(root,'tools/e2e/fixtures/game-workload.mjs'));
report.helperHashes['tools/e2e/fixtures/motion.mjs']=await sha(path.join(root,'tools/e2e/fixtures/motion.mjs'));
let browser,active;
try{
 await save();
 const factories=[...new Set(definitions.flatMap(d=>d.requires))],plugins={};
 for(const factory of factories){const probe=spawnSync(path.join(runtime,'bin/gst-inspect-1.0.exe'),[factory],{cwd:root,windowsHide:true,timeout:12000,encoding:'utf8',env:{...process.env,PATH:path.join(runtime,'bin')+path.delimiter+process.env.PATH}});plugins[factory]={available:probe.status===0,exitCode:probe.status,error:probe.error?.message??(probe.status!==0?probe.stderr?.trim().slice(-500):null)};await writeFile(path.join(output,'probe-'+factory+'.txt'),probe.stdout??probe.stderr??'');}
 browser=await chromium.launch({channel,headless:false});
 const page=await browser.newPage();const capabilities=await page.evaluate(()=>({send:RTCRtpSender.getCapabilities('video')?.codecs??[],receive:RTCRtpReceiver.getCapabilities('video')?.codecs??[]}));
 report.capabilities={plugins,browserVersion:browser.version(),browser:capabilities};await browser.close();browser=null;
 const mime=codec=>codec==='hevc'?'video/h265':'video/'+codec;
 const cases=definitions.filter(d=>!only.length||only.includes(d.id));
 for(const d of cases){
  const reasons=[];for(const f of d.requires)if(!plugins[f]?.available)reasons.push('Plugin unavailable: '+f);
  if(!capabilities.receive.some(c=>c.mimeType.toLowerCase()===mime(d.codec)))reasons.push('Receiver does not advertise '+d.codec);
  if(d.sender==='web'&&!capabilities.send.some(c=>c.mimeType.toLowerCase()===mime(d.codec)))reasons.push('Browser sender does not advertise '+d.codec);
  if(reasons.length){report.skipped.push({id:d.id,reasons});continue;}
  if(planOnly)continue;
  if(await sha(exe)!==report.executable.sha256)throw Error('Executable changed during matrix');
  for(const [file,expected] of Object.entries(report.helperHashes))if(await sha(path.join(root,file))!==expected)throw Error('Harness changed during matrix: '+file);
  report.status='running';console.log(`Local matrix: ${d.id}, ${seconds} intervals`);await save();
  const command=['tools/e2e/run.mjs','--sender',d.sender,'--codec',d.codec,'--preset','balanced','--seconds',String(seconds),'--bitrate-kbps',String(bitrate),'--channel',channel,'--exe',exe,'--matched-resolution','--matched-codec','--receiver-viewport','1280,720','--source-position','30,30','--viewer-position','80,80','--optical-hz','8','--optical-reader','gpu-roi','--receiver-frame-evidence'];
  if(d.sender==='native')command.push('--capture-backend',d.api,'--encoder',d.encoder,'--native-without-preview');
  command.push('--source-workload',workload.profile,'--workload-scene',workload.scene,'--workload-iterations',String(workload.iterations),'--workload-passes',String(workload.passes),'--workload-workers',String(workload.workers));
  active=spawn(process.execPath,command,{cwd:root,windowsHide:true,env:{...process.env,SEEMYGAME_GSTREAMER_ROOT:runtime,SMG_EXPERIMENT_DIRECT_H264:'0'},stdio:['ignore','pipe','pipe']});
  let log='';for(const pipe of [active.stdout,active.stderr])pipe.on('data',data=>{const value=data.toString();log+=value;process.stdout.write(value);});
  const child=active;let timer;const exit=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  const code=await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('Local matrix child timeout'));},(seconds+240)*1000);})]).finally(()=>clearTimeout(timer));active=null;
  await writeFile(path.join(output,d.id+'.log'),log);
  const artifact=log.match(/E2E \w+: (.+report\.json)/)?.[1]?.trim();
  if(!artifact)throw Error('No child artifact for '+d.id);
  const result=JSON.parse(await readFile(artifact,'utf8')),phase=d.sender==='web'?result.web:result.native;
  const pipeline=result.backendEvidence?.pipelineLines??[];
  const encoderEvidence=d.sender==='native'?pipeline.some(line=>new RegExp('\\b'+d.actualEncoder+'\\b').test(line)):null;
  report.runs.push({id:d.id,definition:d,artifact,exitCode:code,status:result.status,error:result.error??null,encoderEvidence,backendEvidence:result.backendEvidence??null,phaseComplete:!!phase,quality:phase?.qualification??null,latency:phase?.glassToGlassLatency??null,diagnostics:phase?.diagnostics??null});
  await save();
 }
 report.status=planOnly?'planned':report.runs.some(r=>r.status!=='passed'||r.encoderEvidence===false)?'completed-with-failures':'completed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{if(active&&active.exitCode===null)active.kill();if(browser?.isConnected())await browser.close();report.finishedAt=new Date().toISOString();await save();console.log('Local media matrix '+report.status+': '+output);}
