import {describe,it,expect} from 'vitest';
import {focusedPipelines,createStudyPlan,summarizeStudy,studyMarkdown} from '../tools/e2e/harness/benchmark-study.mjs';
describe('Focused benchmark evidence',()=>{
 it('keeps workload/source size fixed across stream resolutions and rotates sender order',()=>{
  const plan=createStudyPlan();
  expect(plan).toHaveLength(36);
  expect(new Set(plan.map(c=>c.sourceSize))).toEqual(new Set(['1920,1080']));
  expect(new Set(plan.map(c=>c.resolution.width))).toEqual(new Set([1280,1920]));
  expect(plan.every(c=>c.seconds>=67&&c.fps===60)).toBe(true);
  for(const p of focusedPipelines)expect(plan.filter(c=>c.pipeline.id===p.id)).toHaveLength(12);
  expect(plan.slice(0,3).map(c=>c.pipeline.id)).not.toEqual(plan.slice(12,15).map(c=>c.pipeline.id));
  const sameCondition=plan.filter(c=>c.workload==='gpu-unlimited'&&c.resolution.name==='720p');
  for(const p of focusedPipelines)expect(sameCondition.flatMap((c,i)=>c.pipeline.id===p.id?[i%3]:[]).sort()).toEqual([0,1,2]);
 });
 const rows=(overrides={})=>focusedPipelines.flatMap((p,index)=>[1,2,3].map(repetition=>({pipelineId:p.id,workload:'gpu-unlimited',resolutionName:'720p',repetition,functionalPassed:true,medianDecodedFps:60-index*3,qualification:{status:'passed',maxPauseMs:30,frametimeP95Ms:20},...overrides})));
 it('does not turn functional success with short samples into a comparative winner',()=>{
  const [group]=summarizeStudy(rows({qualification:{status:'insufficient-evidence'}}));
  expect(group.complete).toBe(false);expect(group.descriptiveFpsLeader).toBeNull();
 });
 it('requires every pipeline and repeated measurements, while keeping measured quality failures',()=>{
  expect(summarizeStudy(rows().slice(0,6))[0].complete).toBe(false);
  const result=summarizeStudy(rows({qualification:{status:'failed',maxPauseMs:50,frametimeP95Ms:25}}))[0];
  expect(result.complete).toBe(true);expect(result.summaries.every(s=>s.qualityPassed===0)).toBe(true);
  expect(result.statisticalSignificance).toBe('not evaluated');
 });
 it('reports a pause regression as a trade-off despite higher decoded FPS',()=>{
  const evidence=rows();evidence[0].qualification={status:'passed',maxPauseMs:90,frametimeP95Ms:20};
  const [group]=summarizeStudy(evidence);
  expect(group.descriptiveFpsLeader).toBe(focusedPipelines[0].id);
  expect(group.conclusion).toContain('trade-off');
 });
 it('preserves missing pause evidence and genuine web failure errors in the report',()=>{
  const evidence=rows();evidence[0].qualification.maxPauseMs=null;
  evidence[0].error='wrong geometry | before sampling';
  const report={runId:'test',status:'running',plan:createStudyPlan(),results:evidence,analysis:summarizeStudy(evidence)};
  expect(studyMarkdown(report)).toContain('wrong geometry / before sampling');
  expect(studyMarkdown(report)).not.toContain('VENCEDOR');
 });
 it('rejects invalid duration and repetition counts',()=>{
  expect(()=>createStudyPlan({seconds:NaN})).toThrow();expect(()=>createStudyPlan({repeat:0})).toThrow();
 });
});
