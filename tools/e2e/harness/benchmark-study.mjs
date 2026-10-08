/** Descriptive comparisons; thresholds are not statistical significance. */
export const focusedPipelines = [
  {id:'d3d11-nvenc-h264',label:'D3D11 / NVENC H.264',sender:'native',backend:'d3d11',encoder:'nvenc'},
  {id:'d3d12-nvenc-h264',label:'D3D12 / NVENC H.264',sender:'native-d3d12',backend:'d3d12',encoder:'nvenc'},
  {id:'web-chrome-h264',label:'Web / H.264',sender:'web',backend:'web',encoder:'auto'}
];
export const resolutions = [
  {name:'720p',width:1280,height:720,preset:'ultra',bitrateKbps:4500},
  {name:'1080p',width:1920,height:1080,preset:'balanced',bitrateKbps:7500}
];
export function createStudyPlan({repeat=3,seconds=75,pipelines=focusedPipelines,profiles=resolutions,workloads=['off','gpu-unlimited']}={}) {
  if(!Number.isInteger(repeat)||repeat<1||repeat>10||!Number.isInteger(seconds)||seconds<10||seconds>180)throw Error('Invalid repeat/duration');
  const plan=[];
  for(let repetition=0;repetition<repeat;repetition++){
    const conditions=workloads.flatMap(workload=>profiles.map(resolution=>({workload,resolution})));
    if(repetition%2)conditions.reverse();
    for(const condition of conditions){
      const order=pipelines.map((_,i)=>pipelines[(i+repetition)%pipelines.length]);
      for(const pipeline of order)plan.push({...condition,pipeline,repetition:repetition+1,seconds,sourceSize:'1920,1080',sourceFps:60,fps:60});
    }
  }
  return plan;
}
const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b),i=Math.floor(v.length/2);return !v.length?null:v.length%2?v[i]:(v[i-1]+v[i])/2;};
export function summarizeStudy(records,{requiredRepeats=3}={}) {
  const groups=new Map();
  for(const row of records){const key=JSON.stringify([row.workload,row.resolutionName]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  return [...groups].map(([key,rows])=>{
    const summaries=focusedPipelines.map(pipeline=>{
      const runs=rows.filter(r=>r.pipelineId===pipeline.id);
      const measured=runs.filter(r=>r.functionalPassed&&['passed','failed'].includes(r.qualification?.status)&&Number.isFinite(r.medianDecodedFps));
      const fps=measured.map(r=>r.medianDecodedFps),pauses=measured.map(r=>r.qualification.maxPauseMs).filter(Number.isFinite);
      return {pipelineId:pipeline.id,label:pipeline.label,runs:runs.length,measuredRuns:measured.length,qualityPassed:measured.filter(r=>r.qualification.status==='passed').length,
        medianDecodedFps:median(fps),fpsRange:fps.length?[Math.min(...fps),Math.max(...fps)]:null,
        frametimeP95Ms:median(measured.map(r=>r.qualification.frametimeP95Ms)),maxPauseMs:pauses.length?Math.max(...pauses):null};
    });
    const complete=summaries.every(s=>s.measuredRuns>=requiredRepeats);
    const top=[...summaries].sort((a,b)=>(b.medianDecodedFps??-1)-(a.medianDecodedFps??-1))[0];
    const noPauseRegression=Number.isFinite(top.maxPauseMs)&&summaries.every(s=>Number.isFinite(s.maxPauseMs)&&top.maxPauseMs<=s.maxPauseMs);
    return {condition:JSON.parse(key),complete,summaries,
      conclusion:!complete?'inconclusive: insufficient qualified repetitions':noPauseRegression?'descriptive FPS leader without observed pause regression':'trade-off: FPS and pauses do not establish a uniform winner',
      descriptiveFpsLeader:complete?top.pipelineId:null,statisticalSignificance:'not evaluated'};
  });
}
export function studyMarkdown(report){
  const number=value=>Number.isFinite(value)?Number(value.toFixed(2)):'—';
  let md=`# Comparação focada de captura — ${report.runId}\n\nStatus: ${report.status}. Casos: ${report.results.length}/${report.plan.length}.\n\n`;
  md+=`Relógio RTP nativo solicitado: ${report.nativeRtpClock??'arrival (histórico)'}. Leitura óptica: ${report.instrumentation?.opticalHz??8} Hz.\n\n`;
  md+='Fonte/carga fixa: 1920×1080 a 60 FPS, independente da resolução transmitida. Ordem alternada entre repetições. H.264; áudio e replay desligados; nativo sem prévia. Aprovação funcional e qualificação de qualidade são independentes. Nenhum limiar percentual comprova significância estatística.\n\n';
  md+='| Pipeline | Resolução | Carga | Repetição | FPS mediano | Frametime p95 ms | Pausa máxima ms | Latência p50 ms | CPU TX p95 % | GPU TX p95 % | Janela estável ms | Funcional | Qualidade | Erro |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|\n';
  for(const r of report.results)md+=`| ${r.pipelineId} | ${r.resolutionName} | ${r.workload} | ${r.repetition} | ${number(r.medianDecodedFps)} | ${number(r.qualification?.frametimeP95Ms)} | ${number(r.qualification?.maxPauseMs)} | ${number(r.latency?.p50Ms)} | ${number(r.senderResources?.cpuP95Percent)} | ${number(r.senderResources?.gpuBusiestP95Percent)} | ${number(r.qualification?.durationMs)} | ${r.functionalPassed?'passou':'falhou'} | ${r.qualification?.status??'sem amostras'} | ${String(r.error??'').replaceAll('|','/').replaceAll('\n',' ')} |\n`;
  md+='\n## Comparações descritivas\n\n';
  for(const group of report.analysis)md+=`- ${group.condition.join(' / ')}: ${group.conclusion}; líder descritivo: ${group.descriptiveFpsLeader??'não determinado'}.\n`;
  md+='\n## Limitações\n\nCarga WebGL sintética não representa todo jogo. Contador de apresentação não mede scanout físico. Prioridade alta não foi comparada com normal. Verificar saturação e processos externos na janela estável; não inferir pressão de GPU pelo nome do perfil. Latência deve ser interpretada com a calibração e sua incerteza nos artefatos individuais. Não há garantia de imunidade a travamentos ou recomendação universal.\n';
  return md;
}
