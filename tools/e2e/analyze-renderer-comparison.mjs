// Read-only consolidation: no filtering away failed/unqualified attempts.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {captureRendererComparisons} from './harness/capture-renderer-summary.mjs';
const input=process.argv[2],output=process.argv[3];
if(!input||!output)throw Error('Usage: node analyze-renderer-comparison.mjs report.json output-directory');
const report=JSON.parse(await readFile(input,'utf8'));
const rows=report.runs.map(r=>({case:r.case.id,repetition:r.repetition,status:r.status,error:r.error??null,
  receiver:r.case.receiver,load:r.case.load,decodedFps:r.decodedFps??null,presentSubmissionFps:r.nativePresentFps??null,
  sourceFps:r.sourceFps??null,visualAgeMs:r.visualAgeMs??null,clockUncertaintyMs:r.clocks?.validation.uncertaintyMs??null,
  opticalRejections:r.receiverEvidence?.rejectedReads??null,provenanceFailures:r.invalidProvenance??null,
  stalledIntervals:r.continuity?.stalledIntervals??null,route:r.route??null,sourceGeometry:r.sourceGeometryBeforeSample??null,
  senderCpuP50:r.resources?.summary.cpuP50Percent??null,senderCpuP95:r.resources?.summary.cpuP95Percent??null,
  senderExternalCpuP50:r.resources?.summary.processGroups?.external?.cpuP50Percent??null,
  senderExternalCpuP95:r.resources?.summary.externalCpuP95Percent??null,
  senderGpuP95:r.resources?.summary.gpuBusiestP95Percent??null,
  receiverCpuP50:r.receiverResources?.summary.cpuP50Percent??null,receiverCpuP95:r.receiverResources?.summary.cpuP95Percent??null,
  receiverExternalCpuP95:r.receiverResources?.summary.externalCpuP95Percent??null,
  receiverGpuP95:r.receiverResources?.summary.gpuBusiestP95Percent??null,
  resourceWarnings:{sender:r.resources?.summary.warnings??[],receiver:r.receiverResources?.summary.warnings??[]},
  resourceQualification:r.resourceQualification??null,
  captureToEncodedMs:r.senderEvidence?.journey?.metrics?.captureToEncodedMs??null,
  readbackCpuMs:r.readbackCpuMs??null}));
const result={input:path.resolve(input),study:report.study,status:report.status,seconds:report.seconds,
  validRuns:rows.filter(r=>r.status==='valid').length,unqualifiedRuns:rows.filter(r=>r.status!=='valid').length,
  conditions:report.conditions,preflight:report.preflight??null,pressurePolicy:report.pressurePolicy??null,rows,comparisons:captureRendererComparisons(report),
  limitations:['Common WGC observer includes its capture delay; no physical scanout measurement.',
    'This compares full receiver implementations, including different WebRTC engines, not the renderer alone.',
    '15-second runs and fewer than 100 optical samples per run do not establish a reliable p99 population estimate.',
    'All senders are native WGC/D3D11/NVENC H264 at 720p60; this is not native capture versus getDisplayMedia.',
    'Two reversed repetitions are exploratory; CPU/GPU activity and source geometry remain explicit.',
    'Background CPU must be reviewed per run; inspect resource qualifications before attributing a difference to the receiver.',
    'External process groups on the native receiver may include its separately scheduled diagnostic probe.',
    'The native receiver probe is not proof that the production frontend invokes native_viewer.']};
await mkdir(output,{recursive:true});await writeFile(path.join(output,'summary.json'),JSON.stringify(result,null,2));
const columns=['case','repetition','status','decodedFps','sourceFps','clockUncertaintyMs','opticalRejections','senderCpuP50','senderCpuP95','senderExternalCpuP50','senderExternalCpuP95','senderGpuP95','receiverCpuP50','receiverCpuP95','receiverExternalCpuP95','receiverGpuP95'];
await writeFile(path.join(output,'summary.csv'),columns.join(',')+'\n'+rows.map(r=>columns.map(k=>r[k]??'').join(',')).join('\n')+'\n');
console.log(JSON.stringify({validRuns:result.validRuns,unqualifiedRuns:result.unqualifiedRuns,comparisons:result.comparisons.filter(c=>c.comparison.startsWith('native-renderer'))},null,2));
