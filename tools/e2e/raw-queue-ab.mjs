// Directed ABAB comparison, same executable and capture profile; no broad matrix.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const id=`raw-queue-ab-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(3).toString('hex')}`;
const output=path.join(root,'output/playwright',id);await mkdir(output,{recursive:true});
const exe=path.join(root,'src-tauri/target/release/seemygame.exe');
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b),i=Math.floor(v.length/2);return v.length?(v.length%2?v[i]:(v[i-1]+v[i])/2):null;};
const report={id,status:'running',executableSha256:await sha(exe),helperHashes:{},plan:[...['bounded','latest','bounded','latest'].map(queue=>({clock:'rtp',queue,workload:'gpu-unlimited'})),{clock:'rtp',queue:'latest',workload:'off'}],runs:[],limitations:['Two loaded runs per raw queue policy; exploratory, not statistical significance','Recent RTP windows overlap; stage summaries are descriptive','Audio/replay disabled; Wi-Fi and physical scanout not controlled']};
for(const file of ['tools/e2e/raw-queue-ab.mjs','tools/e2e/comprehensive-matrix-goal.mjs','tools/e2e/distributed-matrix.mjs','tools/e2e/run.mjs','tools/e2e/harness/capture-backend.mjs','tools/e2e/harness/native-stage-evidence.mjs','tools/e2e/telemetry/installer.mjs'])report.helperHashes[file]=await sha(path.join(root,file));
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
await save();console.log(`Raw queue study: ${output}`);
let active;
try { for(const [index,c] of report.plan.entries()){
 if(await sha(exe)!==report.executableSha256)throw Error('Executable changed during ABAB study');
 for(const [file,expected] of Object.entries(report.helperHashes))if(await sha(path.join(root,file))!==expected)throw Error('Harness changed during ABAB study: '+file);
 console.log(`[${index+1}/${report.plan.length}] ${c.queue} / ${c.workload}`);
 const command=['tools/e2e/comprehensive-matrix-goal.mjs','--repeat','1','--seconds','75','--pipelines','d3d12-nvenc-h264','--resolutions','720p','--workloads',c.workload,'--native-rtp-clock',c.clock,'--native-raw-queue',c.queue];
 const child=spawn(process.execPath,command,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
 active=child;
 let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',d=>{log+=d;process.stdout.write(d);});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 active=null;
 await writeFile(path.join(output,`case-${index+1}.log`),log);
 const directory=log.match(/Focused benchmark \w[\w-]*: (.+)/)?.[1]?.trim();
 const master=directory?JSON.parse(await readFile(path.join(directory,'master-report.json'),'utf8')):null;
 const record=master?.results?.[0];
 if(!record?.functionalPassed||!record.clockModeValidated||!record.rawQueueEvidence?.matched){report.status='blocked-by-case-failure';report.error=record?.error??`Case ${index+1} failed with exit ${code}`;await save();process.exitCode=1;break;}
 const raw=JSON.parse(await readFile(record.artifact,'utf8')),phase=raw.native;
 const timeline=phase.timeline.filter(t=>t.phase==='steady');
 const stages=['worker-handoff','bridge-input','bridge-output'].map(stage=>{
  const rows=timeline.flatMap(t=>(t.nativeStages?.stages??[]).filter(s=>s.stage===stage));
  return {stage,samples:rows.length,observedClockModes:[...new Set(rows.map(s=>s.videoRtpClockMode).filter(Boolean))],
   timestampStepP50Ms:median(rows.map(s=>s.rtpFrameClock?.timestampDeltaMs?.p50)),timestampStepP95Ms:median(rows.map(s=>s.rtpFrameClock?.timestampDeltaMs?.p95)),
   arrivalStepP95Ms:median(rows.map(s=>s.rtpFrameClock?.arrivalDeltaMs?.p95)),arrivalMinusTimestampP95Ms:median(rows.map(s=>s.rtpFrameClock?.arrivalMinusTimestampMs?.p95)),
   queueTimeP50Ms:median(rows.map(s=>s.queueLevelTimeMs))};
 });
 report.runs.push({...c,artifact:record.artifact,clockModeValidated:record.clockModeValidated,rawQueueEvidence:record.rawQueueEvidence,qualification:phase.qualification,medianDecodedFps:phase.performance.medianDecodedFps,latency:record.measurementValid?phase.glassToGlassLatency:null,clockValidation:record.clockValidation,resources:phase.resources.summary,stages});await save();
}
if(report.status==='running')report.status='completed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{if(active&&active.exitCode===null)active.kill();await save();console.log(`Raw queue study ${report.status}: ${output}`);}
