import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {summarizeFpsResolutionCase} from './harness/fps-resolution-summary.mjs';
const args=process.argv.slice(2),opt=key=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
const mainPath=opt('--study'),controlsPath=opt('--controls'),previewPath=opt('--preview');if(!mainPath||!controlsPath)throw Error('Use --study report.json --controls report.json [--preview matrix-report.json]');
const main=JSON.parse(await readFile(mainPath,'utf8')),controls=JSON.parse(await readFile(controlsPath,'utf8'));
const preview=previewPath?JSON.parse(await readFile(previewPath,'utf8')):null;
if([main,controls,preview].some(r=>r?.status==='running'))throw Error('Wait for all bounded studies to finish');
const output=opt('--output')??path.join(path.dirname(mainPath),'analysis');await mkdir(output,{recursive:true});
const rows=[];
for(const entry of [...main.runs.map(r=>({...r,kind:'matrix'})),...controls.runs,...(preview?.runs??[]).map(r=>({...r,name:'normal-preview-'+r.preset,kind:'production-preview',scene:'visible',workload:'gpu-unlimited',fps:60}))]){
 const result=JSON.parse(await readFile(entry.artifact,'utf8'));
 const summary=summarizeFpsResolutionCase(result,entry.sender);
 rows.push({...entry,...summary,sourceHashes:result.sourceHashes,executable:result.executable,delivered:result.status==='passed'||result.verdict?.functionalPassed===true,invalidReason:result.error??(entry.sender==='web'?result.web:result.native)?.diagnostics?.measurementReason});
}
const valid=rows.filter(r=>r.measurementValid&&r.receiverOnOtherMachine),invalid=rows.filter(r=>!r.measurementValid||!r.receiverOnOtherMachine);
const groups=new Map();
for(const row of valid.filter(r=>['matrix','measurement-repair'].includes(r.kind))){
 const key=[row.workload,row.sender,row.preset,row.fps].join('/');
 if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
}
const range=values=>{const numbers=values.filter(Number.isFinite);return numbers.length?{min:Math.min(...numbers),max:Math.max(...numbers)}:null;};
const grouped=[...groups].map(([condition,runs])=>({condition,n:runs.length,fpsP50:range(runs.map(r=>r.fpsP50)),latencyP50Ms:range(runs.map(r=>r.latency.p50Ms)),latencyP99Ms:range(runs.map(r=>r.latency.p99Ms)),maxClockErrorMs:Math.max(...runs.map(r=>r.latency.clockUncertaintyMs)),artifacts:runs.map(r=>r.artifact)}));
const report={status:'consolidated',mainPath,controlsPath,previewPath,attemptedCases:rows.length,validCases:valid.length,invalidCases:invalid.length,qualityPassed:valid.filter(r=>r.qualification?.status==='passed').length,groups:grouped,runs:rows,invalid:invalid.map(r=>({kind:r.kind,sender:r.sender,preset:r.preset,fps:r.fps,workload:r.workload,reason:r.invalidReason,artifact:r.artifact})),limitations:['Ranges of per-run statistics, never pooled percentiles','Measurement validity is not a performance/quality pass','Repairs do not hide the original attempts','Two repetitions are exploratory and cannot establish a universal or population-level advantage','Visible scene and browser stage controls have 45 intervals and do not certify 60-second quality','Stutter causes reclassified against requested FPS; original labels retained in exports and raw artifacts remain unchanged']};
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
const number=n=>Number.isFinite(n)?n.toFixed(1):'—';
let text='# FPS/resolução: resultados por execução\n\n';
text+=`${rows.length} tentativas; ${valid.length} com medida válida; ${invalid.length} excluídas da comparação de latência. Somente ${report.qualityPassed} casos válidos passaram todos os critérios de qualidade.\n\n`;
text+='| Grupo | Emissor | Resolução | FPS alvo | Carga | FPS recebido | Captura browser | Latência p50/p99 (ms) | Erro relógio ±ms | Pausas >150ms | Perdas RTP | Qualificação |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
for(const r of valid)text+=`| ${r.kind} | ${r.sender} | ${r.requested.requestedWidth}×${r.requested.requestedHeight} | ${r.fps} | ${r.scene??'offscreen'}/${r.workload} | ${number(r.fpsP50)} | ${number(r.browserCaptureFpsP50)} | ${number(r.latency.p50Ms)}/${number(r.latency.p99Ms)} | ${number(r.latency.clockUncertaintyMs)} | ${r.severeStutterIntervals??'—'} | ${r.packetsLostDelta??'—'} | ${r.qualification?.status??'—'} |\n`;
text+='\n## Faixas por condição\n\n| Condição | N válido | FPS p50 | Latência p50 (ms) | Latência p99 (ms) |\n| --- | --- | --- | --- | --- |\n';
const span=r=>r?`${number(r.min)}–${number(r.max)}`:'—';
for(const g of grouped)text+=`| ${g.condition} | ${g.n} | ${span(g.fpsP50)} | ${span(g.latencyP50Ms)} | ${span(g.latencyP99Ms)} |\n`;
text+='\n## Tentativas sem latência válida\n\n';
for(const r of report.invalid)text+=`- ${r.workload}/${r.sender}/${r.preset}/${r.fps}: ${r.reason}. Artefato: ${r.artifact}\n`;
await writeFile(path.join(output,'measurements.md'),text);
console.log(JSON.stringify({output,attempted:rows.length,valid:valid.length,invalid:invalid.length,groups:grouped.map(({artifacts,...g})=>g),controls:valid.filter(r=>!['matrix','measurement-repair'].includes(r.kind)).map(r=>({name:r.name,fps:r.fpsP50,capture:r.browserCaptureFpsP50,p50:r.latency.p50Ms,p99:r.latency.p99Ms,quality:r.qualification?.status}))},null,2));
