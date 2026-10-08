// Post-process frozen artifacts. Correlation labels are observations, not causal verdicts.
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const directory=path.resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Usage: node tools/e2e/analyze-benchmark-study.mjs <study-directory>');
const study=JSON.parse(await readFile(path.join(directory,'master-report.json'),'utf8'));
const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b),i=Math.floor(v.length/2);return v.length?(v.length%2?v[i]:(v[i-1]+v[i])/2):null;};
const range=values=>{const v=values.filter(Number.isFinite);return v.length?[Math.min(...v),Math.max(...v)]:null;};
const rows=[];
for(const record of study.results){
 const raw=JSON.parse(await readFile(record.artifact,'utf8'));
 const phase=record.pipelineId.startsWith('web-')?raw.web:raw.native;
 const steady=(phase?.timeline??[]).filter(t=>t.phase==='steady');
 const clock=raw.clockCalibrations?.[raw.web?'web':'native'];
 const pauses=steady.filter(t=>t.presentation?.intervalMaxPauseMs>100).map(t=>{
  const loss=t.webInbound?.packetsLostDelta;
  const worker=t.nativeStages?.worker?.fps;
  return {second:t.second,pauseMs:t.presentation.intervalMaxPauseMs,lossDelta:loss??null,
   nackDelta:t.webInbound?.nackDelta??null,pliDelta:t.webInbound?.pliDelta??null,
   decodedFps:t.webInbound?.decodedFps??null,sourceFps:t.source?.fps??null,workerFps:worker??null,
   observation:Number.isFinite(loss)&&loss>0?'same-interval-packet-loss':(t.webInbound?.nackDelta>0||t.webInbound?.pliDelta>0)?'same-interval-recovery-feedback':Number.isFinite(loss)?'no-observed-loss-or-recovery-feedback-in-this-interval':'packet-loss-unavailable',
   workerAvailable:Number.isFinite(worker),scope:'One-second correlation; no causal attribution or packet-level recovery timing'};
 });
 rows.push({pipelineId:record.pipelineId,resolutionName:record.resolutionName,workload:record.workload,repetition:record.repetition,
  artifact:record.artifact,functionalPassed:raw.verdict?.functionalPassed===true,overallStatus:raw.verdict?.overallStatus,
  measurementValid:raw.verdict?.measurementValid??null,qualification:phase?.qualification??null,
  medianDecodedFps:phase?.performance?.medianDecodedFps??null,
  latency:raw.verdict?.measurementValid===true?phase?.glassToGlassLatency:null,
  clockValidation:clock?.validation??null,resources:phase?.resources?.summary??null,
  receiverResources:phase?.receiverResources?.summary??null,
  instrumentationOverhead:phase?.performance?.presentation?.instrumentationOverheadMs??null,
  steadyIntervals:steady.length,packetLossDeltaSum:steady.reduce((n,t)=>n+Math.max(0,t.webInbound?.packetsLostDelta??0),0),
  pauses,sourceHashes:raw.sourceHashes});
}
const groups=[];
for(const condition of new Set(rows.map(r=>JSON.stringify([r.workload,r.resolutionName])))){
 const [workload,resolutionName]=JSON.parse(condition);
 for(const pipelineId of new Set(rows.map(r=>r.pipelineId))){
  const runs=rows.filter(r=>r.workload===workload&&r.resolutionName===resolutionName&&r.pipelineId===pipelineId);
  const measured=runs.filter(r=>r.functionalPassed&&['passed','failed'].includes(r.qualification?.status));
  const latencies=measured.filter(r=>r.measurementValid&&Number.isFinite(r.latency?.p50Ms));
  groups.push({workload,resolutionName,pipelineId,runs:runs.length,measuredRuns:measured.length,
   qualifiedRuns:measured.filter(r=>r.qualification.status==='passed').length,
   medianDecodedFps:median(measured.map(r=>r.medianDecodedFps)),decodedFpsRange:range(measured.map(r=>r.medianDecodedFps)),
   medianPresentationP10:median(measured.map(r=>r.qualification.presentationP10)),
   medianFrametimeP95Ms:median(measured.map(r=>r.qualification.frametimeP95Ms)),
   worstPauseMs:range(measured.map(r=>r.qualification.maxPauseMs))?.[1]??null,
   validLatencyRuns:latencies.length,medianLatencyP50Ms:median(latencies.map(r=>r.latency.p50Ms)),latencyP50Range:range(latencies.map(r=>r.latency.p50Ms)),
   medianSenderGpuP95Percent:median(measured.map(r=>r.resources?.gpuBusiestP95Percent)),
   medianSenderCpuP95Percent:median(measured.map(r=>r.resources?.cpuP95Percent)),
   medianExternalCpuP95Percent:median(measured.map(r=>r.resources?.externalCpuP95Percent)),
   sameIntervalLossPauses:measured.flatMap(r=>r.pauses).filter(p=>p.observation==='same-interval-packet-loss').length,
   sameIntervalRecoveryFeedbackPauses:measured.flatMap(r=>r.pauses).filter(p=>p.observation==='same-interval-recovery-feedback').length,
   noObservedNetworkFeedbackPauses:measured.flatMap(r=>r.pauses).filter(p=>p.observation==='no-observed-loss-or-recovery-feedback-in-this-interval').length,
   statisticalSignificance:'not evaluated'});
 }
}
const sourceHashVariants={};
for(const row of rows)for(const [file,hash] of Object.entries(row.sourceHashes??{})){
 const values=sourceHashVariants[file]??new Set();values.add(JSON.stringify(hash));sourceHashVariants[file]=values;
}
const changedSourceFiles=Object.entries(sourceHashVariants).filter(([,values])=>values.size>1).map(([file])=>file);
const report={studyId:study.runId,studyStatus:study.status,generatedAt:new Date().toISOString(),cases:rows.length,groups,rows,
 sourceHashComparison:{files:Object.keys(sourceHashVariants).length,changedSourceFiles},
 limitations:['Median of run summaries is not a pooled distribution','Invalid clocks excluded from latency summaries only','Loss-free interval does not exclude prior loss, concealment, receiver stalls or local timing problems','No physical glass-to-glass scanout evidence']};
await writeFile(path.join(directory,'detailed-analysis.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:study.status,cases:rows.length,groups},null,2));
