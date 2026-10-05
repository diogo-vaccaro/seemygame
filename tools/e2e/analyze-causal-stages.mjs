import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {summarizeNativeStageRun,summarizeBrowserStageRun,percentile,requireOpticalEvidence} from './harness/causal-summary.mjs';
const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const files=key=>option(key,'').split(',').filter(Boolean);
const output=path.resolve(option('--output','output/playwright/causal-summary'));await mkdir(output,{recursive:true});
const summary={createdAt:new Date().toISOString(),native:[],browser:[],controls:[],e2e:[],artifacts:[]};
for(const [flag,key,reader] of [['--native','native',summarizeNativeStageRun],['--browser','browser',summarizeBrowserStageRun],['--control','controls',summarizeBrowserStageRun]])for(const file of files(flag)){
 const report=JSON.parse(await readFile(file,'utf8'));if(report.status!=='passed')throw Error('Excluded incomplete/failed report: '+file);
 summary.artifacts.push({kind:key,path:path.resolve(file),runId:report.runId,conditions:report.conditions});
 for(const run of report.runs){if(key!=='native')requireOpticalEvidence(run.presentation,report.conditions.seconds,report.conditions.opticalHz);summary[key].push({artifact:path.resolve(file),...reader(run)});}
}
for(const registry of files('--e2e'))for(const record of JSON.parse(await readFile(registry,'utf8'))){
 for(const entry of record.matrix.runs){
  const report=JSON.parse(await readFile(entry.artifact,'utf8'));if(report.status!=='passed'||!report.native)throw Error('Invalid full native E2E report');
  const phase=report.native,steady=phase.timeline.filter(t=>t.phase==='steady');
  summary.e2e.push({artifact:entry.artifact,repetition:record.repetition,profile:record.profile,status:report.status,quality:phase.qualification.status,
    decodedFps:percentile(steady.map(t=>t.webInbound?.decodedFps)),latency:phase.glassToGlassLatency,
    decodeMs:percentile(steady.map(t=>t.webInbound?.decodeTimeMs)),jitterMs:percentile(steady.map(t=>t.webInbound?.jitterBufferMs)),
    sourceSubmissionFps:percentile(steady.map(t=>t.source?.workload?.fps)),completionObservedMs:percentile(steady.map(t=>t.source?.workload?.completionObservedP50Ms)),
    gpuP95:phase.resources.summary.gpuBusiestP95Percent,cpuP50:phase.resources.summary.cpuP50Percent,executable:report.executable,
    previewEnabled:false,sourceScene:report.sourceWorkload?.scene??steady[0]?.source?.workload?.scene});
 }
}
await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
const number=v=>Number.isFinite(v)?v.toFixed(2):'—';
const table=(headers,rows)=>'| '+headers.join(' | ')+' |\n| '+headers.map(()=> '---').join(' | ')+' |\n'+rows.map(row=>'| '+row.join(' | ')+' |').join('\n')+'\n';
const text=`# Sondas causais de latência — ${summary.createdAt.slice(0,10)}

Os ensaios isolam etapas e aplicam intervenções à fonte sintética. Não somam medianas de componentes para explicar latência ponta a ponta.

## Nativo: medição por quadro

${table(['Repetição','Carga','Encode p50 (ms)','Captura→encode p50 (ms)','Fila encoder p95 (ms)','Conclusão GPU observada (ms)','Submissões/s'],summary.native.map(r=>[r.repetition,r.profile,number(r.metrics.encodeMs.p50),number(r.metrics.captureToEncodedMs.p50),number(r.metrics.encoderQueueMs.p95),number(r.source.completionObservedP50Ms),number(r.source.shaderSubmissionFpsP50)]))}

Os timestamps são normalizados pelo segmento GStreamer. Tempos nas pads incluem escalonamento e espera por recursos GPU; não medem apenas execução do encoder. PTS de captura não equivale à idade óptica da imagem. A captura WGC bruta apresentou geometria diferente da captura do Chrome; o encoder recebe 1920×1080. São ensaios de localização, não uma comparação absoluta justa entre APIs.

## Navegador: remoção de encode/rede/decode

${table(['Repetição','Carga','Caminho','p50 (ms)','p99 (ms)','FPS renderizado','Encode (ms)','Conclusão GPU observada (ms)'],[...summary.browser,...summary.controls].map(r=>[r.repetition,r.profile,r.mode,number(r.latency?.p50),number(r.latency?.p99),number(r.renderedFps),number(r.encodeTimeMs),number(r.source.completionObservedP50Ms)]))}

Raw = getDisplayMedia→video; WebRTC = H264 local com dois peers na página receptora. Ambos medem timestamps ópticos à apresentação estimada do compositor, não scanout físico. A carga offscreen mantém a cena capturada igual. O controle gpu-flush separa submissão explícita da intervenção gpu-bounded, que usa fences e limita a dois lotes em voo. A disponibilidade de queries é consultada no rAF e inclui atraso de polling. Pending queries tem limite de 8 e não conta todos os trabalhos GPU em voo.

## E2E do aplicativo nativo

${table(['Repetição','Carga','FPS decode','p50 (ms)','p99 (ms)','Decode (ms)','Jitter (ms)','Qualificação'],summary.e2e.map(r=>[r.repetition,r.profile,number(r.decodedFps),number(r.latency.p50Ms),number(r.latency.p99Ms),number(r.decodeMs),number(r.jitterMs),r.quality]))}

Release já validado, frontend congelado, H264/NVENC/D3D12, 1080p60, orçamento 7500 kbps, sem áudio/replay, óptica 8 Hz. O adaptador diagnóstico transmite RTP real ao espectador sem preview local; não homologa todo o fluxo de produção. As sondas Rust rodam em processo diagnóstico com prioridade normal; o E2E usa o worker real.

## Limites e próximo passo

Fonte e receptor compartilham GPU/CPU. As intervenções mudam também a utilização GPU; não isolam exclusivamente profundidade de fila. As rodadas curtas do navegador não estabelecem um p99 de longo prazo. A melhora da fonte sintética não é uma correção aplicada ao jogo do usuário. Investigar um jogo real com rastreamento GPU/ETW e receptor separado é necessário para distinguir submissão da fonte, scheduling, captura e compositor, além de testar CPU isoladamente.

## Evidências

${[...new Set([...summary.artifacts.map(a=>a.path),...summary.e2e.map(r=>r.artifact)])].map(f=>'- ['+path.basename(path.dirname(f))+']('+f.replaceAll('\\','/')+')').join('\n')}
`;
await writeFile(path.join(output,'measurements.md'),text);console.log(output);
