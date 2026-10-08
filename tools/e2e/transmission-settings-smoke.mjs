// Functional UI/IPC integration only. This is not a latency/FPS benchmark.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readRawQueueEvidence} from './harness/capture-backend.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const exe=path.join(root,'src-tauri/target/release/seemygame.exe');
const output=path.join(root,'output/playwright',`transmission-settings-${Date.now()}-${randomBytes(3).toString('hex')}`);
await mkdir(output,{recursive:true});
const sha=async()=>createHash('sha256').update(await readFile(exe)).digest('hex');
const report={status:'running',scope:'Native app UI → IPC → actual GStreamer worker → Chrome viewer on the same machine; no performance certification; audio/replay disabled',executableSha256:await sha(),runs:[]};
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
let active;
try{
 for(const policy of ['bounded','latest']){
  if(await sha()!==report.executableSha256)throw Error('Executable changed during functional smoke');
  console.log(`[Settings smoke] ${policy} / 720p30 / 4500 kbps`);
  active=spawn(process.execPath,['tools/e2e/run.mjs','--exe',exe,'--seconds','8','--channel','chrome','--preset','ultra','--stream-fps','30','--bitrate-kbps','4500','--capture-backend','d3d12','--encoder','nvenc','--codec','h264','--matched-resolution','--matched-codec','--optical-hz','0'],{cwd:root,windowsHide:true,env:{...process.env,SEEMYGAME_NATIVE_RAW_QUEUE:policy},stdio:['ignore','pipe','pipe']});
  let log='';for(const p of [active.stdout,active.stderr])p.on('data',d=>{log+=d;process.stdout.write(d);});
  const code=await new Promise((resolve,reject)=>{active.once('exit',resolve);active.once('error',reject);});active=null;
  await writeFile(path.join(output,`${policy}.log`),log);
  const artifact=log.match(/E2E passed: (.+report\.json)/)?.[1]?.trim();
  if(code!==0||!artifact)throw Error(`Functional E2E failed for ${policy}; see its log`);
  const raw=JSON.parse(await readFile(artifact,'utf8'));
  const evidence=readRawQueueEvidence(raw.backendEvidence?.pipelineLines,policy);
  const pipeline=raw.backendEvidence?.pipelineLines?.at(-1)||'';
  const controls={queue:evidence.matched,fps30:/framerate=30\/1\b/.test(pipeline),bitrate4500:/\bbitrate=4500\b/.test(pipeline),nativeDirect:raw.nativeTransport?.directNativePeers===1&&raw.nativeTransport.browserMediaCalls===0,resolution:raw.native?.resolutionValidation?.passed===true};
  report.runs.push({policy,artifact,controls,evidence,nativeState:raw.nativeState,resolution:raw.native?.resolutionValidation,qualification:raw.native?.qualification});await save();
  if(Object.values(controls).some(v=>!v))throw Error(`Settings were not observed in the actual pipeline: ${JSON.stringify(controls)}`);
 }
 report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{if(active?.exitCode===null)active.kill();await save();console.log(`Transmission settings smoke ${report.status}: ${output}`);}
