// Repair diagnostic labels only. Keep an immutable copy and the original run hashes.
import {copyFile,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {describeBenchmarkOutcome} from './harness/benchmark-outcome.mjs';
import {studyMarkdown} from './harness/benchmark-study.mjs';
if(!process.argv[2])throw Error('Usage: node tools/e2e/relabel-benchmark-outcomes.mjs <study-directory>');
const directory=path.resolve(process.argv[2]),target=path.join(directory,'master-report.json');
const original=await readFile(target,'utf8'),report=JSON.parse(original);
if(report.status!=='completed')throw Error('Only completed studies may be relabeled');
if(report.postProcessing)throw Error('Study already relabeled; inspect existing provenance');
const changes=[];
for(const [i,row] of report.results.entries()){
 const raw=JSON.parse(await readFile(row.artifact,'utf8'));
 const phase=row.pipelineId.startsWith('web-')?raw.web:raw.native;
 const outcome=describeBenchmarkOutcome({raw,phase,exitCode:row.exitCode});
 if(row.error!==outcome.error)changes.push({case:i+1,previousError:row.error,correctedError:outcome.error});
 Object.assign(row,outcome);
}
await copyFile(target,path.join(directory,'master-report.original.json'),constants.COPYFILE_EXCL);
report.postProcessing={at:new Date().toISOString(),scope:'Diagnostic labels and explicit verdict fields only; measured metrics and original source/executable hashes unchanged',originalMasterSha256:createHash('sha256').update(original).digest('hex'),changes};
await writeFile(target,JSON.stringify(report,null,2));
await writeFile(path.join(directory,'benchmark-report.md'),studyMarkdown(report));
console.log(JSON.stringify(report.postProcessing,null,2));
