// Diagnostic qualification only; never terminate another application's process.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const p95 = values => { const sorted=values.filter(finite).sort((a,b)=>a-b); return sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null; };
const toolNames = /^(node|cargo|rustc|clippy-driver|link|msbuild|cmake|ninja|vitest)(\.exe)?$/i;
export const DEFAULT_PRESSURE_LIMITS = Object.freeze({minSamples:3,externalCpuPercent:10,systemCpuPercent:85,preflightGpuPercent:90,toolCpuPercent:2});

export function assessBenchmarkPressure(samples, {phase='measurement',limits={}}={}) {
  const budget={...DEFAULT_PRESSURE_LIMITS,...limits};
  if(!['preflight','measurement'].includes(phase)||!Number.isInteger(budget.minSamples)||budget.minSamples<1
    ||Object.entries(budget).some(([key,value])=>key!=='minSamples'&&(!finite(value)||value<0||value>100)))throw Error('Invalid resource pressure budget');
  const cpu=samples.map(s=>s.cpu?.totalPercent).filter(finite);
  const external=samples.map(s=>s.processGroups?.external?.cpuPercent).filter(finite);
  const gpu=samples.map(s=>s.gpu?.busiestEnginePercent).filter(finite);
  const issues=[];
  if(cpu.length<budget.minSamples||external.length<budget.minSamples)issues.push('insufficient-cpu-process-evidence');
  if(phase==='preflight'&&gpu.length<budget.minSamples)issues.push('insufficient-gpu-evidence');
  const cpuP95=p95(cpu),externalCpuP95=p95(external),gpuP95=p95(gpu);
  if(cpuP95!==null&&cpuP95>budget.systemCpuPercent)issues.push('system-cpu-above-budget');
  if(externalCpuP95!==null&&externalCpuP95>budget.externalCpuPercent)issues.push('external-cpu-above-budget');
  // GPU contention is deliberate during these benchmarks; only check idle setup.
  if(phase==='preflight'&&gpuP95!==null&&gpuP95>budget.preflightGpuPercent)issues.push('preflight-gpu-above-budget');
  const tools=samples.flatMap(s=>s.externalTopCpu||[]).filter(p=>toolNames.test(p.name)&&finite(p.cpuPercent)&&p.cpuPercent>=budget.toolCpuPercent);
  if(tools.length)issues.push('possible-concurrent-build-or-node-workload');
  return {status:issues.length?'unqualified':'clear',phase,limits:budget,sampleCount:samples.length,
    measuredSamples:{cpu:cpu.length,externalCpu:external.length,gpu:gpu.length},cpuP95,externalCpuP95,gpuP95,issues,
    possibleConcurrentTools:[...new Map(tools.map(p=>[p.pid,{pid:p.pid,name:p.name}])).values()],
    interpretation:'Pressure is a qualification guard, not causal proof. A busy external Node process may also be a user application. Missing/protected process counters can undercount external load.'};
}

export function benchmarkPressureOptions(args) {
  const value=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:Number(args[i+1]);};
  const limits={externalCpuPercent:value('--max-external-cpu',10),systemCpuPercent:value('--max-system-cpu',85),preflightGpuPercent:value('--max-preflight-gpu',90)};
  assessBenchmarkPressure([],{limits}); // Validate before launching any process.
  return {limits,allowPressure:args.includes('--allow-resource-pressure')};
}

export async function benchmarkPreflight(sampler, {limits={},waitMs=15000,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  const start=now();let result;
  do {
    await sleep(1000);
    const samples=sampler.window(start,now()).samples;
    result=assessBenchmarkPressure(samples,{phase:'preflight',limits});
    if(samples.length>=5)return result;
  } while(now()-start<waitMs);
  return result;
}

export function qualifyBenchmarkRun(run, options) {
  const pressure=assessBenchmarkPressure(run.resources?.samples||[],{limits:options.limits});
  if(options.preflight?.status==='unqualified') {
    pressure.status='unqualified';pressure.issues.push('preflight-unqualified');
  }
  run.resourceQualification=pressure;
  run.resourcePressureOverride=options.allowPressure;
  if(pressure.status!=='clear'&&run.status==='valid') {
    run.mediaStatus=run.status;
    run.status='resource-pressure-unqualified';
  }
  return pressure;
}
