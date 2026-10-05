/** Finish invalid measurement gates once, then isolate browser pacing/scaling and
 * compare a visible shader scene. Performance failures are never retried to pass. */
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarizeFpsResolutionCase} from './harness/fps-resolution-summary.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2),opt=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const snapshot=path.resolve(opt('--snapshot-root',path.join(root,'output/playwright/fps-resolution-snapshot-2026-10-04')));
const original=path.resolve(opt('--study',path.join(root,'output/playwright/fps-resolution-study-2026-10-04T14-27-04-520Z/report.json')));
const study=JSON.parse(await readFile(original,'utf8'));if(study.status==='running')throw Error('Run controls after the matrix has completed');
const output=path.join(root,'output/playwright','fps-resolution-controls-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(output,{recursive:true});
const report={status:'running',originalStudy:original,runs:[],batches:[],retries:'one per sender/condition with invalid measurement; do not retry performance failures',controls:'pacing/scaling/visible scene are exploratory 45-interval controls, not 60-second quality certificates'};
const plan=[];
const repairs=new Map();
for(const row of study.runs.filter(r=>!r.measurementValid)){
 const key=[row.workload,row.preset,row.fps].join('-');
 if(!repairs.has(key))repairs.set(key,{name:'measurement-repair-'+key,kind:'measurement-repair',workload:row.workload,preset:row.preset,fps:row.fps,seconds:70,senders:[],originalArtifacts:[]});
 const batch=repairs.get(key);if(!batch.senders.includes(row.sender))batch.senders.push(row.sender);batch.originalArtifacts.push(row.artifact);
}
plan.push(...repairs.values());
for(const preset of ['balanced','ultra'])plan.push({name:'web-capture60-send30-'+preset,kind:'web-pacing',workload:'gpu-unlimited',preset,fps:30,seconds:45,senders:['web'],extra:['--web-capture-fps','60']});
for(const fps of [60,30])plan.push({name:'web-scale-in-encoder-'+fps,kind:'web-scaling',workload:'gpu-unlimited',preset:'ultra',fps,seconds:45,senders:['web'],extra:['--web-capture-fps','60','--web-scale-in-encoder']});
for(const preset of ['balanced','ultra'])plan.push({name:'native-visible-'+preset,kind:'visible-scene',workload:'gpu-unlimited',preset,fps:60,seconds:45,senders:['native-d3d12'],scene:'visible'});
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await save();let child;
try {
 for(const batch of plan){
  console.log('Control '+batch.name);
  const flags=['tools/e2e/distributed-matrix.mjs','--host','notebook','--senders',batch.senders.join(','),'--receivers','chrome','--presets',batch.preset,'--seconds',String(batch.seconds),'--exe',path.join(root,'output/playwright/d3d12-hevc-experiment-build/release/seemygame.exe'),'--encoder','nvenc','--codec','h264','--bitrate-kbps','7500','--native-without-preview','--matched-resolution','--matched-codec','--calibrate-clocks','--clock-max-error-ms','10','--optical-hz','8','--keep-display-awake','--receiver-frame-evidence','--stream-fps',String(batch.fps),'--source-fps','60','--source-size','1920,1080','--source-workload',batch.workload,'--workload-scene',batch.scene??'offscreen','--workload-passes','16',...(batch.extra??[])];
  child=spawn(process.execPath,flags,{cwd:snapshot,windowsHide:true,env:{...process.env,SEEMYGAME_GSTREAMER_ROOT:path.join(root,'native-media/gstreamer'),SMG_EXPERIMENT_DIRECT_H264:'0'},stdio:['ignore','pipe','pipe']});
  let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',d=>{const s=d.toString();log+=s;if(/Matrix case|Clock offset|E2E (passed|failed|inconclusive)|Distributed matrix/.test(s))process.stdout.write(s);});
  const active=child,timer=setTimeout(()=>active.kill(),batch.senders.length*(batch.seconds+200)*1000);
  const exitCode=await new Promise((resolve,reject)=>{active.once('error',reject);active.once('exit',resolve);}).finally(()=>clearTimeout(timer));child=null;
  await writeFile(path.join(output,batch.name+'.log'),log);
  const artifact=log.match(/Distributed matrix \w+: (.+)/)?.[1]?.trim();if(!artifact)throw Error('No control matrix artifact');
  const matrix=JSON.parse(await readFile(path.join(artifact,'report.json'),'utf8'));report.batches.push({...batch,artifact,exitCode,status:matrix.status,error:matrix.error});
  for(const run of matrix.runs){const result=JSON.parse(await readFile(run.artifact,'utf8'));const row={...batch,sender:run.sender,artifact:run.artifact,...summarizeFpsResolutionCase(result,run.sender)};report.runs.push(row);console.log(JSON.stringify({control:batch.name,sender:row.sender,status:row.status,captureFps:row.browserCaptureFpsP50,fps:row.fpsP50,p50:row.latency?.p50Ms,p99:row.latency?.p99Ms}));}
  await save();if(!matrix.runs.length)throw Error('No control cases: '+matrix.error);
 }
 report.status=report.runs.every(r=>r.measurementValid&&r.receiverOnOtherMachine)?'completed':'completed-with-invalid-cases';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{if(child&&child.exitCode===null)child.kill();await save();console.log('FPS/resolution controls '+report.status+': '+output);}
