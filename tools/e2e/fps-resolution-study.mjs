/** Controlled two-machine FPS/resolution study, using the existing authenticated E2E. */
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarizeFpsResolutionCase} from './harness/fps-resolution-summary.mjs';
const project=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
const opt=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const root=path.resolve(opt('--snapshot-root',project)),seconds=Number(opt('--seconds','70')),repeats=Number(opt('--repeats','2'));
if(!Number.isInteger(seconds)||seconds<70||seconds>180||!Number.isInteger(repeats)||repeats<1||repeats>5)throw Error('Study duration 70..180, repeats 1..5');
const exe=path.resolve(opt('--exe',path.join(project,'output/playwright/d3d12-hevc-experiment-build/release/seemygame.exe')));
const gstreamer=path.resolve(opt('--gstreamer-root',path.join(project,'native-media/gstreamer')));
const output=path.join(project,'output/playwright','fps-resolution-study-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(output,{recursive:true});
const report={status:'running',seconds,repeats,source:{width:1920,height:1080,fps:60},bitrateCapKbps:7500,codec:'h264',native:{encoder:'nvenc',api:'d3d12',preview:false},receiver:'notebook/chrome',runs:[],matrices:[]};
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
await save();
const conditions=[{preset:'balanced',fps:60},{preset:'ultra',fps:30},{preset:'balanced',fps:30},{preset:'ultra',fps:60}];
let child;
try {
 const batches=[];
 if(!args.includes('--no-baseline'))for(const condition of conditions.filter(c=>c.fps===60))batches.push({...condition,workload:'off',repetition:1});
 for(let repetition=1;repetition<=repeats;repetition++)for(const condition of repetition%2?conditions:[...conditions].reverse())batches.push({...condition,workload:'gpu-unlimited',repetition});
 for(const batch of batches){
  const senders=batch.repetition%2?'native-d3d12,web':'web,native-d3d12';
  console.log(`Study ${batch.workload}, ${batch.preset}, ${batch.fps} FPS, repetition ${batch.repetition}`);
  const flags=['tools/e2e/distributed-matrix.mjs','--host',opt('--host','notebook'),'--senders',senders,'--receivers','chrome','--presets',batch.preset,'--seconds',String(seconds),'--exe',exe,'--encoder','nvenc','--codec','h264','--bitrate-kbps','7500','--native-without-preview','--matched-resolution','--matched-codec','--calibrate-clocks','--clock-max-error-ms','10','--optical-hz','8','--keep-display-awake','--receiver-frame-evidence','--stream-fps',String(batch.fps),'--source-fps','60','--source-size','1920,1080','--source-workload',batch.workload,'--workload-scene','offscreen','--workload-passes','16'];
  child=spawn(process.execPath,flags,{cwd:root,windowsHide:true,env:{...process.env,SEEMYGAME_GSTREAMER_ROOT:gstreamer,SMG_EXPERIMENT_DIRECT_H264:'0'},stdio:['ignore','pipe','pipe']});
  let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',d=>{const s=d.toString();log+=s;if(/Matrix case|Clock offset|E2E (passed|failed|inconclusive)|Distributed matrix/.test(s))process.stdout.write(s);});
  const active=child,timer=setTimeout(()=>active.kill(),2*(seconds+200)*1000);
  const code=await new Promise((resolve,reject)=>{active.once('error',reject);active.once('exit',resolve);}).finally(()=>clearTimeout(timer));child=null;
  const label=`${batch.workload}-${batch.preset}-${batch.fps}-r${batch.repetition}`;
  await writeFile(path.join(output,label+'.log'),log);
  const artifact=log.match(/Distributed matrix \w+: (.+)/)?.[1]?.trim();
  if(!artifact)throw Error('No matrix artifact for '+label);
  const matrix=JSON.parse(await readFile(path.join(artifact,'report.json'),'utf8'));
  report.matrices.push({...batch,artifact,exitCode:code,status:matrix.status,error:matrix.error});
  for(const run of matrix.runs){const result=JSON.parse(await readFile(run.artifact,'utf8'));const row={...batch,sender:run.sender,artifact:run.artifact,...summarizeFpsResolutionCase(result,run.sender)};report.runs.push(row);console.log(JSON.stringify({condition:label,sender:row.sender,status:row.status,fps:row.fpsP50,p50:row.latency?.p50Ms,p99:row.latency?.p99Ms,clockError:row.latency?.clockUncertaintyMs,quality:row.qualification?.status}));}
  await save();
  if(!matrix.runs.length)throw Error('No cases were executed: '+matrix.error);
 }
 report.status=report.runs.every(r=>r.status==='passed'&&r.measurementValid&&r.receiverOnOtherMachine)?'completed':'completed-with-invalid-cases';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{if(child&&child.exitCode===null)child.kill();await save();console.log('FPS/resolution study '+report.status+': '+output);}
