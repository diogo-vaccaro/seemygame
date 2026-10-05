import {describe,it,expect} from 'vitest';
import {captureRendererComparisons} from '../tools/e2e/harness/capture-renderer-summary.mjs';
const route={local:{address:'192.168.15.4',protocol:'udp'},remote:{address:'192.168.15.7',protocol:'udp'}};
const geometry={visibility:'visible',innerWidth:1904,innerHeight:985,devicePixelRatio:1,canvasRect:{width:1904,height:985}};
const run=(id,repetition,p50,overrides={})=>({case:{id},repetition,status:'valid',route,sourceGeometryBeforeSample:geometry,sourceGeometryAfterSample:geometry,invalidProvenance:0,visualAgeMs:{p50},decodedFps:60,clocks:{validation:{uncertaintyMs:6}},senderConditions:{priority:{applied:true,effectiveGpuClass:id==='priority-high'?4:2}},...overrides});
describe('Controlled capture/renderer comparisons',()=>{
 it('excludes technically successful but resource-contaminated runs from ranking',()=>{
  const runs=[1,2].flatMap(n=>[run('window-wgc',n,150),run('native-receiver',n,80,{status:'resource-pressure-unqualified',mediaStatus:'valid'})]);
  expect(captureRendererComparisons({runs})[3].conclusion).toBe('invalid-evidence');
 });
 it('rejects ranking when the source changed size',()=>{
  const runs=[1,2].flatMap(n=>[run('window-wgc',n,150),run('native-receiver',n,80,{sourceGeometryAfterSample:{...geometry,innerWidth:1280}})]);
  expect(captureRendererComparisons({runs})[3].conclusion).toBe('invalid-evidence');
 });
 it('rejects receiver ranking across different routes',()=>{
  const runs=[1,2].flatMap(n=>[run('window-wgc',n,150),run('native-receiver',n,80,{route:{...route,remote:{address:'100.1.2.3',protocol:'udp'}}})]);
  expect(captureRendererComparisons({runs})[3].conclusion).toBe('invalid-evidence');
 });
 it('cannot infer a GPU priority effect when Windows did not apply it',()=>{
  const runs=[1,2].flatMap(n=>[run('priority-normal',n,180),run('priority-high',n,100,{senderConditions:{priority:{applied:false,effectiveGpuClass:2}}})]);
  expect(captureRendererComparisons({runs})[0].conclusion).toBe('invalid-evidence');
 });
 it('does not rank a difference smaller than clock uncertainty',()=>{
  const runs=[1,2].flatMap(n=>[run('window-wgc',n,150),run('native-receiver',n,142)]);
  expect(captureRendererComparisons({runs})[3].conclusion).toBe('unresolved-within-clock-error');
 });
 it('detects order effects instead of averaging them away',()=>{
  const runs=[run('monitor-wgc',1,150),run('monitor-dxgi',1,120),run('monitor-wgc',2,130),run('monitor-dxgi',2,170)];
  expect(captureRendererComparisons({runs})[2].conclusion).toBe('inconsistent-or-unresolved');
 });
 it('requires repeated, valid optical provenance',()=>{
  const runs=[1,2].flatMap(n=>[run('window-wgc',n,180),run('monitor-wgc',n,140,{invalidProvenance:n===2?1:0})]);
  expect(captureRendererComparisons({runs})[1].conclusion).toBe('invalid-evidence');
 });
 it('preserves failed attempts without optical evidence instead of crashing',()=>{
  const runs=[1,2].flatMap(n=>[run('monitor-wgc',n,150),run('monitor-dxgi',n,null,{status:'failed',visualAgeMs:undefined})]);
  const comparison=captureRendererComparisons({runs})[2];
  expect(comparison.conclusion).toBe('invalid-evidence');
  expect(comparison.rows[0].deltaMs).toBeNull();
 });
 it('compares DXGI only against monitor WGC, retaining a separate idle baseline',()=>{
  const runs=[1,2].flatMap(n=>[run('window-wgc',n,200),run('monitor-wgc',n,160),run('monitor-dxgi',n,120),run('monitor-idle-wgc',n,65),run('monitor-idle-dxgi',n,60)]);
  const comparisons=captureRendererComparisons({runs});
  expect(comparisons[2].baseline).toBe('monitor-wgc');
  expect(comparisons[2].rows.every(row=>row.deltaMs===-40)).toBe(true);
  expect(comparisons[5].conclusion).toBe('unresolved-within-clock-error');
  const windowsOnly=runs.filter(row=>row.case.id!=='monitor-wgc');
  expect(captureRendererComparisons({runs:windowsOnly})[2].conclusion).toBe('insufficient-repetitions');
 });
});
