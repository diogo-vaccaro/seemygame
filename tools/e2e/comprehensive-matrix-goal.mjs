// Focused repeatable study. Child runners own GUI/task cleanup; never kill unrelated apps.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {ensureDefaultDesktop} from './desktop-affinity.mjs';
import {focusedPipelines,resolutions,createStudyPlan,summarizeStudy,studyMarkdown} from './harness/benchmark-study.mjs';
import {describeBenchmarkOutcome} from './harness/benchmark-outcome.mjs';
import {readRawQueueEvidence} from './harness/capture-backend.mjs';
ensureDefaultDesktop();
const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
const option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const select=(values,requested,key)=>{const names=requested.split(','),chosen=values.filter(v=>names.includes(v[key]));if(chosen.length!==names.length)throw Error('Unknown or duplicate selection: '+requested);return chosen;};
const host=option('--host','notebook'),repeat=Number(option('--repeat','3')),seconds=Number(option('--seconds','75'));
const opticalHz=Number(option('--optical-hz','8'));
const nativeRtpClock=option('--native-rtp-clock','arrival');
const nativeRawQueue=option('--native-raw-queue','bounded');
if(!['bounded','latest'].includes(nativeRawQueue))throw Error('Invalid native raw queue policy');
if(!['arrival','rtp'].includes(nativeRtpClock))throw Error('Invalid native RTP clock mode');
if(!Number.isFinite(opticalHz)||opticalHz<0||opticalHz>60||opticalHz>0&&opticalHz<1)throw Error('Invalid optical sampling rate (0 or 1..60 Hz)');
const pipelines=select(focusedPipelines,option('--pipelines',focusedPipelines.map(p=>p.id).join(',')),'id');
const profiles=select(resolutions,option('--resolutions','720p,1080p'),'name');
const workloads=option('--workloads','off,gpu-unlimited').split(',');
if(workloads.some(w=>!['off','gpu-unlimited'].includes(w)))throw Error('Invalid workload');
const exe=path.resolve(root,option('--exe','src-tauri/target/release/seemygame.exe'));
const runId=`focused-benchmark-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(3).toString('hex')}`;
const output=path.join(root,'output/playwright',runId);await mkdir(output,{recursive:true});
const report={runId,status:'planned',repeat,seconds,host,nativeRtpClock,nativeRawQueue,instrumentation:{opticalHz,calibrateClocks:true},plan:createStudyPlan({repeat,seconds,pipelines,profiles,workloads}),results:[],analysis:[],limitations:['Synthetic workload; no physical scanout measurement','Qualification and functional delivery are independent']};
const save=async()=>{report.analysis=summarizeStudy(report.results,{requiredRepeats:repeat});await writeFile(path.join(output,'master-report.json'),JSON.stringify(report,null,2));await writeFile(path.join(output,'benchmark-report.md'),studyMarkdown(report));};
await save();console.log(`Focused benchmark: ${output}; ${report.plan.length} cases`);
if(args.includes('--plan-only'))process.exit(0);
report.executable={path:exe,sha256:createHash('sha256').update(await readFile(exe)).digest('hex')};
report.helperHashes={};
for(const file of ['tools/e2e/comprehensive-matrix-goal.mjs','tools/e2e/distributed-matrix.mjs','tools/e2e/run.mjs','tools/e2e/harness/benchmark-study.mjs','tools/e2e/harness/benchmark-outcome.mjs','tools/e2e/harness/capture-backend.mjs','tools/e2e/harness/capture-geometry.mjs','tools/e2e/harness/stream-profile.mjs','tools/e2e/fixtures/motion.mjs','tools/e2e/fixtures/game-workload.mjs'])report.helperHashes[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
let active;
try{
 report.status='running';await save();
 for(const [index,c] of report.plan.entries()){
  if(createHash('sha256').update(await readFile(exe)).digest('hex')!==report.executable.sha256)throw Error('Executable changed during study');
  for(const [file,expected] of Object.entries(report.helperHashes))if(createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')!==expected)throw Error('Harness changed during study: '+file);
  const command=['tools/e2e/distributed-matrix.mjs','--host',host,'--senders',c.pipeline.sender,'--receivers','chrome','--presets',c.resolution.preset,'--seconds',String(seconds),'--codec','h264','--encoder',c.pipeline.encoder,'--exe',exe,'--bitrate-kbps',String(c.resolution.bitrateKbps),'--stream-fps','60','--source-fps','60','--source-size',c.sourceSize,'--source-workload',c.workload,'--workload-scene','offscreen','--workload-passes','16','--matched-resolution','--matched-codec','--native-without-preview','--receiver-frame-evidence','--keep-display-awake','--calibrate-clocks','--optical-hz',String(opticalHz)];
  console.log(`[${index+1}/${report.plan.length}] ${c.pipeline.id} ${c.resolution.name} ${c.workload} repeat ${c.repetition}`);
  active=spawn(process.execPath,command,{cwd:root,windowsHide:true,env:{...process.env,SEEMYGAME_NATIVE_VIDEO_RTP_CLOCK:nativeRtpClock,SEEMYGAME_NATIVE_RAW_QUEUE:nativeRawQueue},stdio:['ignore','pipe','pipe']});
  let log='';for(const pipe of [active.stdout,active.stderr])pipe.on('data',d=>{log+=d.toString();process.stdout.write(d);});
  const code=await new Promise((resolve,reject)=>{active.once('exit',resolve);active.once('error',reject);});active=null;
  await writeFile(path.join(output,`case-${index+1}.log`),log);
  const artifact=log.match(/Distributed matrix \w+: (.+)/)?.[1]?.trim();
  const matrix=artifact?JSON.parse(await readFile(path.join(artifact,'report.json'),'utf8')):null;
  const run=matrix?.runs?.[0];
  const raw=run?.artifact?JSON.parse(await readFile(run.artifact,'utf8')):null;
  const phase=c.pipeline.sender==='web'?raw?.web:raw?.native;
  const observedClockModes=[...new Set((phase?.timeline??[]).flatMap(t=>(t.nativeStages?.stages??[]).filter(s=>s.stage?.startsWith('bridge-')).map(s=>s.videoRtpClockMode??'unavailable')))];
  const clockModeValidated=c.pipeline.sender==='web'||observedClockModes.length===1&&observedClockModes[0]===nativeRtpClock;
  const rawQueueEvidence=c.pipeline.sender==='web'?{matched:true}:readRawQueueEvidence(raw?.backendEvidence?.pipelineLines,nativeRawQueue);
  report.results.push({pipelineId:c.pipeline.id,resolutionName:c.resolution.name,workload:c.workload,repetition:c.repetition,exitCode:code,functionalPassed:raw?.verdict?.functionalPassed===true,clockModeValidated,observedClockModes,rawQueueEvidence,qualification:phase?.qualification??null,medianDecodedFps:phase?.performance?.medianDecodedFps??null,latency:phase?.glassToGlassLatency??null,senderResources:phase?.resources?.summary??null,receiverResources:phase?.receiverResources?.summary??null,artifact:run?.artifact??artifact,...describeBenchmarkOutcome({raw,phase,run,matrix,exitCode:code})});
  await save();
  if(!rawQueueEvidence.matched){report.status='blocked-by-raw-queue-mismatch';process.exitCode=1;break;}
  if(!clockModeValidated){report.status='blocked-by-clock-mode-mismatch';process.exitCode=1;break;}
  if(!report.results.at(-1).functionalPassed){report.status='blocked-by-case-failure';process.exitCode=1;break;}
 }
 if(report.status==='running')report.status='completed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{if(active&&active.exitCode===null)active.kill();await save();console.log(`Focused benchmark ${report.status}: ${output}`);}
