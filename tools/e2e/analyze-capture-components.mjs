import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const files=process.argv.slice(2);if(!files.length)throw Error('Supply component study report.json paths');
const range=xs=>{const a=xs.filter(Number.isFinite);return a.length?[Math.min(...a),Math.max(...a)]:null;};
const result={scope:'Per-run ranges; component times after capture, not visual latency. Only valid runs included.',studies:[],totalValidRuns:0,matchedFrames:0};
for(const file of files){
 const absolute=path.resolve(root,file);if(!absolute.startsWith(path.join(root,'output/playwright')+path.sep))throw Error('Expected a project diagnostic report');
 const report=JSON.parse(await readFile(absolute));const groups=new Map();
 for(const run of report.runs.filter(r=>r.status==='valid')){const rows=groups.get(run.case.id)||[];rows.push(run);groups.set(run.case.id,rows);result.totalValidRuns++;result.matchedFrames+=run.metrics.captureToEncodedMs.samples;}
 result.studies.push({file,exeSha256:report.exeSha256,cases:[...groups].map(([id,rows])=>({id,repetitions:rows.length,encodedFps:range(rows.map(r=>r.encodedFps)),captureToEncodedP50Ms:range(rows.map(r=>r.metrics.captureToEncodedMs.p50)),captureToEncodedP99Ms:range(rows.map(r=>r.metrics.captureToEncodedMs.p99)),captureQueueP50Ms:range(rows.map(r=>r.metrics.captureQueueMs.p50)),conversionP50Ms:range(rows.map(r=>r.metrics.convertMs.p50)),encodeWallP50Ms:range(rows.map(r=>r.metrics.encodeMs.p50)),gpuBusiestP95Percent:range(rows.map(r=>r.resources.summary.gpuBusiestP95Percent)),videoEncodeP95Percent:range(rows.flatMap(r=>Object.entries(r.resources.summary.gpuEngines).filter(([key])=>key.endsWith(':VideoEncode')).map(([,v])=>v.utilizationP95Percent))),sourceWholeCaseFps:range(rows.map(r=>(r.sourceAfter.framesProduced-r.sourceBefore.framesProduced)*1000/(r.sourceAfter.lastTime-r.sourceBefore.lastTime))),priorityVerified:rows.every(r=>r.conditions.priority.applied)}))});
}
const output=path.join(root,'output/playwright/capture-component-analysis-2026-10-04');await mkdir(output,{recursive:true});await writeFile(path.join(output,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
