import {describe,it,expect,vi} from 'vitest';
import {validateGameWorkload,gameWorkloadScript,installGameWorkload} from '../tools/e2e/fixtures/game-workload.mjs';
import {readSourceStatsSummary} from '../tools/e2e/harness/source-summary.mjs';

describe('E2E game-like load safety and measurement',()=>{
  it('prevents invalid/unbounded work and workers on GPU-only cases',()=>{
    expect(validateGameWorkload({profile:'gpu-unlimited',workers:4})).toMatchObject({workers:0,targetFps:null});
    expect(validateGameWorkload({profile:'gpu-capped'})).toMatchObject({targetFps:60});
    for(const options of [{profile:'unknown'},{passes:100},{iterations:NaN},{workers:9},{workers:-1}])expect(()=>validateGameWorkload(options)).toThrow();
  });
  it('disabled load creates no GPU context or worker',()=>{
    window.__smgSourceStats={};
    installGameWorkload(validateGameWorkload());
    expect(window.__smgSourceStats.workload).toMatchObject({status:'disabled',frames:0});
    delete window.__smgSourceStats;
  });
  it('keeps source workload evidence in hot-path summaries without copying the frame log',()=>{
    const stats={framesProduced:60,frameLog:[{seq:1,timeMs:0}],workload:{status:'running',renderer:'hardware',gpuMs:8,frames:100}};
    const read=readSourceStatsSummary(stats);
    expect(read.workload).toEqual(stats.workload);
    expect(read.frameLog).toBeUndefined();
    expect(read.frameLogLength).toBe(1);
    read.workload.frames=0;expect(stats.workload.frames).toBe(100);
  });
  it('serializes into the fixture with bounded self-expiry and CPU worker cleanup',()=>{
    const code=gameWorkloadScript({profile:'mixed',workers:3});
    expect(()=>new Function(code)).not.toThrow();
    expect(code).toContain('600000');expect(code).toContain('w.terminate()');
  });
  it('allows a fixed captured scene while applying GPU load offscreen',()=>{
    expect(validateGameWorkload({scene:'offscreen'})).toMatchObject({scene:'offscreen'});
    expect(()=>validateGameWorkload({scene:'unbounded'})).toThrow();
    const code=gameWorkloadScript({profile:'gpu-unlimited',scene:'offscreen'});
    expect(()=>new Function(code)).not.toThrow();
    expect(code).toContain('FRAMEBUFFER_COMPLETE');
  });
  it('is idempotent when a validated workload is passed through the fixture again',()=>{
    for(const profile of ['off','gpu-capped','gpu-unlimited','gpu-bounded','gpu-flush','mixed']){
      const config=validateGameWorkload({profile,scene:'offscreen'});
      expect(validateGameWorkload(config)).toEqual(config);
    }
    expect(validateGameWorkload({profile:'gpu-bounded'})).toMatchObject({targetFps:null,maxInFlight:2});
    for(const maxInFlight of [0,9,NaN])expect(()=>validateGameWorkload({profile:'gpu-bounded',maxInFlight})).toThrow();
  });
  it('bounds submissions without waiting on the GPU and distinguishes elapsed GPU from observed completion time',()=>{
    vi.useFakeTimers();
    let callback,clock=100,available=false;
    const gl={QUERY_RESULT_AVAILABLE:1,QUERY_RESULT:2,RENDERER:3,FRAMEBUFFER_COMPLETE:4,ALREADY_SIGNALED:5,CONDITION_SATISFIED:6,WAIT_FAILED:7,
      getExtension:name=>name==='EXT_disjoint_timer_query_webgl2'?{TIME_ELAPSED_EXT:8,GPU_DISJOINT_EXT:9}:null,
      getParameter:p=>p===9?false:'Test hardware',getShaderParameter:()=>true,getProgramParameter:()=>true,checkFramebufferStatus:()=>4,
      getQueryParameter:(_,p)=>p===1?available:8e6,clientWaitSync:()=>available?5:0,
      createShader:()=>({}),createProgram:()=>({}),createTexture:()=>({}),createFramebuffer:()=>({}),createQuery:()=>({}),fenceSync:()=>({}),
      drawArrays:vi.fn(),flush:vi.fn(),deleteSync:vi.fn(),deleteQuery:vi.fn()};
    const proxy=new Proxy(gl,{get:(o,k)=>k in o?o[k]:(()=>{})});
    const canvas=document.createElement('canvas');document.body.append(canvas);
    const getContext=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(proxy);
    vi.spyOn(performance,'now').mockImplementation(()=>clock);
    vi.stubGlobal('requestAnimationFrame',fn=>{callback=fn;return 1;});vi.stubGlobal('cancelAnimationFrame',()=>{});
    const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
    URL.createObjectURL=()=> 'blob:test';URL.revokeObjectURL=()=>{};
    window.__smgSourceStats={width:1920,height:1080};
    try{
      installGameWorkload(validateGameWorkload({profile:'gpu-bounded',scene:'offscreen',passes:1}));
      callback(clock);clock=120;callback(clock);clock=140;callback(clock);
      expect(gl.drawArrays).toHaveBeenCalledTimes(2);
      expect(window.__smgSourceStats.workload).toMatchObject({frames:2,skippedSubmissions:1,fencePending:2});
      available=true;clock=170;callback(clock);
      expect(gl.drawArrays).toHaveBeenCalledTimes(3);
      expect(window.__smgSourceStats.workload).toMatchObject({gpuMs:8,completionObservedP50Ms:70});
      window.__smgStopWorkload();expect(gl.deleteSync).toHaveBeenCalledTimes(3);
    }finally{window.__smgStopWorkload?.();delete window.__smgSourceStats;document.querySelectorAll('canvas').forEach(c=>c.remove());URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;getContext.mockRestore();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();}
  });
});
