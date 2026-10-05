/** A repeatable shader/CPU workload, not a substitute for a game's engine or API. */
export function validateGameWorkload({profile='off',iterations=96,passes=4,workers=0,scene='visible',maxInFlight=2}={}) {
  if(!['off','gpu-capped','gpu-unlimited','gpu-bounded','gpu-flush','mixed'].includes(profile))throw Error('Invalid source workload profile');
  if(!Number.isInteger(iterations)||iterations<16||iterations>256)throw Error('Workload shader iterations: 16..256');
  if(!Number.isInteger(passes)||passes<1||passes>32)throw Error('Workload shader passes: 1..32');
  if(!Number.isInteger(workers)||workers<0||workers>8)throw Error('Workload CPU workers: 0..8');
  if(!['visible','offscreen'].includes(scene))throw Error('Invalid workload scene');
  if(!Number.isInteger(maxInFlight)||maxInFlight<(profile==='gpu-bounded'?1:0)||maxInFlight>8)throw Error('Workload in-flight limit: 1..8 for bounded load');
  return {profile,iterations,passes,scene,flushAfterFrame:['gpu-bounded','gpu-flush'].includes(profile),maxInFlight:profile==='gpu-bounded'?maxInFlight:0,workers:profile==='mixed'?workers:0,targetFps:profile==='gpu-capped'?60:null};
}

// Serialized into the dedicated captured page; never inject into product pages.
export function installGameWorkload(config) {
  const stats=window.__smgSourceStats.workload={...config,status:'initializing',draws:0,frames:0,fps:0,gpuMs:null,gpuDisjointCount:0,cpuIterations:0,renderer:null,contextLost:false};
  if(config.profile==='off'){stats.status='disabled';return;}
  const canvas=document.createElement('canvas');canvas.width=window.__smgSourceStats.width;canvas.height=window.__smgSourceStats.height;
  canvas.style.cssText='position:absolute;inset:0;z-index:0;';
  document.body.prepend(canvas);
  const overlay=document.querySelectorAll('canvas')[1];overlay.style.cssText='position:relative;z-index:1;';
  const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'high-performance'});
  if(!gl){stats.status='unavailable';stats.error='WebGL2 unavailable';return;}
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  stats.renderer=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;};
  const program=gl.createProgram();
  try{
    gl.attachShader(program,compile(gl.VERTEX_SHADER,`#version 300 es
      void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`#version 300 es
      precision highp float;
      uniform vec2 resolution;uniform float time;uniform float pass;
      out vec4 color;
      void main(){
        vec2 uv=(gl_FragCoord.xy*2.-resolution)/resolution.y;
        vec3 q=vec3(uv*1.2+vec2(sin(time*.14),cos(time*.19)),sin(time*.11)+pass*.013);
        float energy=0.;
        for(int i=0;i<${config.iterations};i++){
          q=abs(q)/max(dot(q,q),.13)-vec3(.73,.81,.62);
          q.xy=mat2(.998,-.063,.063,.998)*q.xy;
          energy+=exp(-abs(length(q)-1.35))*float(i+1)/float(${config.iterations});
        }
        float a=energy/float(${config.iterations});
        color=vec4(.5+.5*cos(vec3(0.,2.2,4.1)+a*18.+length(uv)*2.+time*.25),1.);
      }`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  }catch(error){stats.status='failed';stats.error=error.message;return;}
  gl.useProgram(program);gl.viewport(0,0,canvas.width,canvas.height);
  // Render the same expensive shader without changing the captured image. This
  // separates GPU contention from differences in compression complexity.
  if(config.scene==='offscreen'){
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,canvas.width,canvas.height);
    const framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){stats.status='failed';stats.error='Incomplete workload framebuffer';return;}
  }
  gl.uniform2f(gl.getUniformLocation(program,'resolution'),canvas.width,canvas.height);
  const time=gl.getUniformLocation(program,'time'),pass=gl.getUniformLocation(program,'pass');
  const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2'),pending=[],timings=[],completionTimes=[],fences=[];
  stats.skippedSubmissions=0;stats.fencePending=0;
  stats.completionObservedP50Ms=null;stats.completionObservedP95Ms=null;stats.pendingQueries=0;stats.maxPendingQueries=0;
  stats.completionScope='CPU submission to query availability observed at rAF polling; includes polling delay, not scanout';
  stats.gpuTimerAvailable=!!timer;
  let active=true,lastDraw=0,lastRate=performance.now(),framesAtRate=0,raf;
  const workers=[];
  // Owned workers self-expire even if controller/browser cleanup is interrupted.
  const workerScript=`let alive=true,total=0,last=performance.now(),until=Date.now()+600000;
    onmessage=e=>{if(e.data==='stop'){alive=false;close();}};
    function step(){if(!alive||Date.now()>until){close();return;}let v=.37,n=0,start=performance.now();
      while(performance.now()-start<40){for(let i=0;i<2000;i++){v=Math.sin(v+1.001)*Math.cos(v*.999)+.3;}n+=2000;}
      total+=n;if(performance.now()-last>=1000){postMessage({iterations:total,result:v});last=performance.now();}setTimeout(step,0);}
    step();`;
  const workerUrl=URL.createObjectURL(new Blob([workerScript],{type:'application/javascript'}));
  const totals=[];
  for(let i=0;i<config.workers;i++){const w=new Worker(workerUrl);w.onmessage=e=>{totals[i]=e.data.iterations;stats.cpuIterations=totals.reduce((a,b)=>a+b,0);};workers.push(w);}
  URL.revokeObjectURL(workerUrl);
  const stop=()=>{active=false;if(stats.status==='running')stats.status='stopped';cancelAnimationFrame(raf);workers.forEach(w=>w.terminate());pending.forEach(q=>gl.deleteQuery(q.query));pending.length=0;fences.forEach(f=>gl.deleteSync(f));fences.length=0;};
  window.__smgStopWorkload=stop;
  addEventListener('pagehide',stop,{once:true});
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();stats.contextLost=true;stats.status='context-lost';stop();});
  setTimeout(stop,600000);
  stats.status='running';
  function draw(now){
    if(!active)return;raf=requestAnimationFrame(draw);
    while(pending.length&&gl.getQueryParameter(pending[0].query,gl.QUERY_RESULT_AVAILABLE)){
      const q=pending.shift();
      if(gl.getParameter(timer.GPU_DISJOINT_EXT)){stats.gpuDisjointCount++;timings.length=0;completionTimes.length=0;stats.gpuMs=null;stats.completionObservedP50Ms=null;stats.completionObservedP95Ms=null;}
      else{
        timings.push(gl.getQueryParameter(q.query,gl.QUERY_RESULT)/1e6);if(timings.length>64)timings.shift();const sorted=[...timings].sort((a,b)=>a-b);stats.gpuMs=sorted[Math.floor(sorted.length/2)];
        completionTimes.push(performance.now()-q.submittedAt);if(completionTimes.length>64)completionTimes.shift();
        const wall=[...completionTimes].sort((a,b)=>a-b);stats.completionObservedP50Ms=wall[Math.floor(wall.length/2)];stats.completionObservedP95Ms=wall[Math.ceil(wall.length*.95)-1];
      }
      gl.deleteQuery(q.query);
    }
    stats.pendingQueries=pending.length;
    while(fences.length){
      const ready=gl.clientWaitSync(fences[0],0,0);
      if(ready===gl.WAIT_FAILED){stats.status='failed';stats.error='GPU fence wait failed';stop();return;}
      if(ready!==gl.ALREADY_SIGNALED&&ready!==gl.CONDITION_SATISFIED)break;
      gl.deleteSync(fences.shift());
    }
    stats.fencePending=fences.length;
    // Never block the main thread waiting for the GPU; skip new work instead.
    if(config.maxInFlight&&fences.length>=config.maxInFlight){stats.skippedSubmissions++;return;}
    if(config.targetFps&&now-lastDraw<1000/config.targetFps-1)return;
    if(config.targetFps){const interval=1000/config.targetFps;lastDraw+=Math.max(1,Math.floor((now-lastDraw+1)/interval))*interval;}else lastDraw=now;
    const query=timer&&pending.length<8?gl.createQuery():null;
    const submittedAt=performance.now();
    if(query)gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
    gl.uniform1f(time,now/1000);
    for(let i=0;i<config.passes;i++){gl.uniform1f(pass,i);gl.drawArrays(gl.TRIANGLES,0,3);stats.draws++;}
    if(query){gl.endQuery(timer.TIME_ELAPSED_EXT);pending.push({query,submittedAt});}
    if(config.maxInFlight){fences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0));gl.flush();stats.fencePending=fences.length;}
    else if(config.flushAfterFrame)gl.flush();
    stats.pendingQueries=pending.length;stats.maxPendingQueries=Math.max(stats.maxPendingQueries,pending.length);
    stats.frames++;
    if(now-lastRate>=1000){stats.fps=(stats.frames-framesAtRate)*1000/(now-lastRate);framesAtRate=stats.frames;lastRate=now;}
  }
  raf=requestAnimationFrame(draw);
}

export function gameWorkloadScript(options) {
  const config=validateGameWorkload(options);
  return `(${installGameWorkload.toString()})(${JSON.stringify(config)});`;
}
