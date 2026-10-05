import {describe,it,expect} from 'vitest';
import {assessBenchmarkPressure,benchmarkPressureOptions,benchmarkPreflight,qualifyBenchmarkRun} from '../tools/e2e/harness/benchmark-pressure.mjs';
const sample=(cpu=10,external=2,gpu=4)=>({cpu:{totalPercent:cpu},processGroups:{external:{cpuPercent:external}},gpu:{busiestEnginePercent:gpu},externalTopCpu:[]});
const rows=(s=sample())=>Array.from({length:5},()=>structuredClone(s));
describe('benchmark resource guard',()=>{
  it('accepts quiet setup and intentional measurement GPU contention',()=>{
    expect(assessBenchmarkPressure(rows(),{phase:'preflight'}).status).toBe('clear');
    expect(assessBenchmarkPressure(rows(sample(20,2,100))).status).toBe('clear');
    expect(assessBenchmarkPressure(rows(sample(20,2,100)),{phase:'preflight'}).issues).toContain('preflight-gpu-above-budget');
  });
  it('rejects missing counters, external CPU bursts and busy system CPU',()=>{
    expect(assessBenchmarkPressure([{cpu:{totalPercent:0}}]).status).toBe('unqualified');
    expect(assessBenchmarkPressure(rows(sample(20,30,0))).issues).toContain('external-cpu-above-budget');
    expect(assessBenchmarkPressure(rows(sample(91,2,0))).issues).toContain('system-cpu-above-budget');
  });
  it('flags possible builds and Node validation without assuming every Node process is a test',()=>{
    const samples=rows();samples[2].externalTopCpu=[{pid:10,name:'node.exe',cpuPercent:15},{pid:11,name:'rustc.exe',cpuPercent:3}];
    const result=assessBenchmarkPressure(samples);
    expect(result.issues).toContain('possible-concurrent-build-or-node-workload');
    expect(result.possibleConcurrentTools).toHaveLength(2);
    samples[2].externalTopCpu[0].cpuPercent=.1;samples[2].externalTopCpu.pop();
    expect(assessBenchmarkPressure(samples).status).toBe('clear');
  });
  it('preserves measurements but never turns an override into valid attribution',()=>{
    const run={status:'valid',decodedFps:60,resources:{samples:rows(sample(30,25,100))}};
    qualifyBenchmarkRun(run,{allowPressure:true,limits:{}});
    expect(run.status).toBe('resource-pressure-unqualified');expect(run.mediaStatus).toBe('valid');expect(run.decodedFps).toBe(60);
    expect(run.resourcePressureOverride).toBe(true);
  });
  it('validates configurable budgets before launch',()=>{
    expect(benchmarkPressureOptions(['--max-external-cpu','20']).limits.externalCpuPercent).toBe(20);
    for(const value of ['NaN','101','-1'])expect(()=>benchmarkPressureOptions(['--max-system-cpu',value])).toThrow();
  });
  it('does not erase a failed setup when its explicit override has a quiet measurement',()=>{
    const run={status:'valid',resources:{samples:rows()}};
    qualifyBenchmarkRun(run,{allowPressure:true,limits:{},preflight:{status:'unqualified'}});
    expect(run.status).toBe('resource-pressure-unqualified');
    expect(run.resourceQualification.issues).toContain('preflight-unqualified');
  });
  it('waits for fresh samples and returns an explicit failure at the deadline',async()=>{
    let time=0;const sampler={window:()=>({samples:time>=5000?rows():[]})};
    expect((await benchmarkPreflight(sampler,{now:()=>time,sleep:async ms=>{time+=ms;}})).status).toBe('clear');
    time=0;const empty={window:()=>({samples:[]})};
    expect((await benchmarkPreflight(empty,{waitMs:3000,now:()=>time,sleep:async ms=>{time+=ms;}})).status).toBe('unqualified');
    expect(time).toBe(3000);
  });
});
