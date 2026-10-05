// Isolated diagnostics using the production capture builder and native RTP bridge.
// Receiver transport is observed WebRTC, never the SSH control tunnel.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startAssetServer} from './harness/server.mjs';
import {startResourceSampler,summarizeResources} from './harness/resources.mjs';
import {createMotionFixture} from './fixtures/motion.mjs';
import {readSourceStatsSummary} from './harness/source-summary.mjs';
import {calibrateLocalSourceClock,retryUncertainCalibration,validateClockCheckpoints,correctedVisualLatency} from './harness/clock-calibration.mjs';
import {readViewerControl,prepareRemoteViewer,machineFingerprint} from './harness/remote-viewer.mjs';
import {ensureDefaultDesktop} from './desktop-affinity.mjs';
import {launchSourceWindow} from './harness/source-window.mjs';
import {startDisplayAwakeLease} from './harness/display-awake.mjs';
import {collectRendererEndEvidence,qualifyWindowOptics} from './harness/renderer-end-evidence.mjs';
import {captureRendererComparisons} from './harness/capture-renderer-summary.mjs';
import {allowRendererCandidate,rendererRoute,receiverContinuity,rendererContentReadiness} from './harness/renderer-transport.mjs';
import {benchmarkPressureOptions,benchmarkPreflight,qualifyBenchmarkRun} from './harness/benchmark-pressure.mjs';
ensureDefaultDesktop();
const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
const option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const pressureOptions=benchmarkPressureOptions(args);
const seconds=Number(option('--seconds','30')),repeat=Number(option('--repeat','2')),host=option('--host','notebook');
const observerFps=Number(option('--observer-fps','60'));
if(![8,30,60].includes(observerFps))throw Error('Observer FPS must be 8, 30 or 60');
const debugOptics=args.includes('--debug-optics');
const failFast=args.includes('--fail-fast');
if(debugOptics&&seconds>10)throw Error('Optical debug runs limited to 10 seconds and are not benchmarks');
const privateNetwork=args.includes('--private-network');
const allowedReceiverUdp=option('--allow-private-receiver-udp-from',null);
if(allowedReceiverUdp&&!/^192\.168\.\d{1,3}\.\d{1,3}$/.test(allowedReceiverUdp))throw Error('One explicitly authorized private IPv4 sender required');
const mediaPolicy=privateNetwork?'tailscale':args.includes('--public-srflx-only')?'public-srflx':'local-and-public';
if(!privateNetwork&&!args.includes('--public-stun'))throw Error('Select --private-network or explicitly authorized --public-stun; no implicit public STUN');
if(!Number.isInteger(seconds)||seconds<5||seconds>90||!Number.isInteger(repeat)||repeat<1||repeat>4||!/^\w[\w.-]*$/.test(host))throw Error('Invalid comparison arguments');
const study='compare-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex');
const output=path.join(root,'output/playwright',study);await mkdir(output,{recursive:true});
const remote='C:/Users/Diogo/SeeMyGame',ssh='C:/Windows/System32/OpenSSH/ssh.exe',scp='C:/Windows/System32/OpenSSH/scp.exe';
const sshArgs=['-o','BatchMode=yes','-o','ConnectTimeout=5','-o','StrictHostKeyChecking=yes'];
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const percentile=(xs,q)=>{const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.ceil(q*a.length)-1]:null;};
const distribution=xs=>({samples:xs.filter(Number.isFinite).length,p50:percentile(xs,.5),p90:percentile(xs,.9),p99:percentile(xs,.99),max:percentile(xs,1)});
const report={status:'running',study,seconds,repeat,runs:[],conditions:{source:'1920x1080 synthetic canvas at 60 FPS; actual browser CSS viewport recorded, DOM fullscreen is not evidence of 1920x1080 client area',stream:'720p60 H264 NVENC 7.5 Mbps',topology:'desktop sender, interactive notebook receiver; WebRTC route must be observed; SSH control only',measurement:'COMMON receiver WGC optical observer at 8 Hz; includes observer capture latency; not physical scanout',scope:'Diagnostic host uses production capture builder/bridge; audio/replay/preview disabled'},hashes:{}};
const background=['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-features=CalculateNativeWinOcclusion'];
let localBrowser,server,resources,displayAwake,child,tunnel,remoteBrowser,caseId,viewerId,nativeActive=false,viewerActive=false;
let nativeToken,senderToken,sendReady,receiverReady;
let interrupted=false;process.once('SIGINT',()=>{interrupted=true;});
const sourceGeometry=()=>({fullscreen:!!document.fullscreenElement,visibility:document.visibilityState,innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,canvasRect:(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()});
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
report.conditions.debugOptics=debugOptics;report.conditions.mediaPolicy=mediaPolicy;report.conditions.authorizedReceiverUdpPeer=allowedReceiverUdp;
report.conditions.observerFps=observerFps;report.conditions.measurement=`COMMON receiver WGC optical observer at requested ${observerFps} Hz; actual cadence recorded; includes observer capture latency; not physical scanout`;
async function command(exe,argv,{timeout=60000}={}){
 const p=spawn(exe,argv,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
 const timer=setTimeout(()=>p.kill(),timeout);const code=await new Promise((r,j)=>{p.once('exit',r);p.once('error',j);}).finally(()=>clearTimeout(timer));
 if(code!==0)throw Error(`${path.basename(exe)} exited ${code}: ${err.slice(-2500)} ${out.slice(-1500)}`);return out;
}
const remotePs=ps=>command(ssh,[...sshArgs,host,'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "+ps,'utf16le').toString('base64')]);
const jsonLines=s=>s.split(/\r?\n/).flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});
async function rpc(port,token,op,extra={}){const response=await fetch(`http://127.0.0.1:${port}/${token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...extra}),signal:AbortSignal.timeout(15000)});const r=await response.json();if(!r.ok)throw Error(r.error);return r.data;}
const sender=(op,extra)=>rpc(sendReady.port,senderToken,op,extra);
const receiver=(op,extra)=>rpc(19337,nativeToken,op,extra);
async function nativeTask(mode,role='receiver'){return jsonLines(await remotePs(`& ${quote(remote+'/tools/e2e/native-probe-task.ps1')} -RunId ${quote(caseId)} -Mode ${mode} -Role ${role} -ObserverFps ${observerFps} ${privateNetwork?'-PrivateNetwork':''} ${mode==='start'?'-Token '+quote(nativeToken):''} ${mode==='start'&&role==='receiver'&&allowedReceiverUdp?'-AllowPrivateMediaFrom '+quote(allowedReceiverUdp):''} ${mode==='start'&&debugOptics?'-DebugOptics':''}`)).at(-1);}
async function viewerTask(mode,resourcesOnly=false){return jsonLines(await remotePs(`& ${quote(remote+'/tools/e2e/viewer-task.ps1')} -RunId ${quote(viewerId)} -Runtime chrome -Mode ${mode} -KeepDisplayAwake -DiagnosticIceAddresses ${resourcesOnly?'-ResourcesOnly':''}`)).at(-1);}
async function cleanup(){
 if(nativeActive){try{await receiver('stop');}catch{}try{await nativeTask('stop');}catch(e){report.cleanupError=e.message;}nativeActive=false;}
 if(sendReady&&child?.exitCode===null){try{await sender('stop');}catch{}await delay(200);if(child.exitCode===null)child.kill();}child=null;sendReady=null;
 if(remoteBrowser){try{await remoteBrowser.close();}catch{}remoteBrowser=null;}
 if(viewerActive){try{await viewerTask('stop');}catch(e){report.cleanupError=e.message;}viewerActive=false;}
 if(tunnel?.exitCode===null){tunnel.kill();await delay(150);}tunnel=null;
}
try{
 displayAwake=await startDisplayAwakeLease();report.displayAwake=displayAwake.evidence;
 for(const f of ['src-tauri/src/media/pipeline.rs','src-tauri/src/media/config.rs','src-tauri/src/media/transport_comparison_probe.rs','src-tauri/src/media/frame_journey_probe.rs','src-tauri/src/webrtc_bridge.rs','src-tauri/Cargo.lock','tools/e2e/compare-capture-renderer.mjs','tools/e2e/native-probe-task.ps1','tools/e2e/fixtures/motion.mjs','tools/e2e/fixtures/game-workload.mjs','tools/e2e/harness/source-window.mjs','tools/e2e/harness/benchmark-pressure.mjs','tools/e2e/harness/renderer-transport.mjs','tools/e2e/harness/capture-renderer-summary.mjs','tools/e2e/viewer-agent.mjs','tools/e2e/viewer-task.ps1','tools/e2e/harness/resources.mjs','tools/e2e/harness/clock-calibration.mjs','tests/fixtures/e2e-optical-odd-origin-row.bgra'])report.hashes[f]=createHash('sha256').update(await readFile(path.join(root,f))).digest('hex');
 for(const f of ['tools/e2e/harness/display-awake.mjs','tools/e2e/keep-display-awake.ps1','tools/e2e/harness/renderer-end-evidence.mjs'])report.hashes[f]=createHash('sha256').update(await readFile(path.join(root,f))).digest('hex');
 for(const [f,hash] of Object.entries(report.hashes)){const target=path.join(output,'source-snapshot',f);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(root,f),target);if(createHash('sha256').update(await readFile(target)).digest('hex')!==hash)throw Error('Source snapshot mismatch');}
 let executable=option('--exe',null);
 if(!executable){const log=await command('cargo',['test','--manifest-path','src-tauri/Cargo.toml','--locked','--offline','--lib','--no-run','--message-format=json'],{timeout:180000});executable=jsonLines(log).find(m=>m.reason==='compiler-artifact'&&m.target?.name==='app_lib'&&m.profile?.test&&m.executable)?.executable;}
 if(!executable)throw Error('Test artifact not found');executable=path.resolve(root,executable);const archived=path.join(output,'probe.exe');await copyFile(executable,archived);report.exeSha256=createHash('sha256').update(await readFile(archived)).digest('hex');report.senderExecutionPath=executable;
 await remotePs(`New-Item -ItemType Directory -Force -Path ${quote(remote+'/output/native-comparisons/'+study)} | Out-Null`);
 await command(scp,[...sshArgs,archived,host+':'+remote+'/output/native-comparisons/'+study+'/probe.exe']);
 await command(scp,[...sshArgs,path.join(root,'tools/e2e/native-probe-task.ps1'),host+':'+remote+'/tools/e2e/native-probe-task.ps1']);
 for(const helper of ['viewer-task.ps1','viewer-agent.mjs'])await command(scp,[...sshArgs,path.join(root,'tools/e2e',helper),host+':'+remote+'/tools/e2e/'+helper]);
 await remotePs(`if((Get-FileHash -LiteralPath ${quote(remote+'/output/native-comparisons/'+study+'/probe.exe')}).Hash -ne ${quote(report.exeSha256)}){throw 'Probe binary hash mismatch'}`);
 const cases=[
  {id:'baseline-browser',capture:'window-wgc',backend:'d3d11',priority:'normal',receiver:'browser',load:'off'},
  {id:'baseline-native',capture:'window-wgc',backend:'d3d11',priority:'normal',receiver:'native',load:'off'},
  {id:'priority-normal',capture:'window-wgc',backend:'d3d12',priority:'normal',receiver:'browser',load:'gpu-unlimited'},
  {id:'priority-high',capture:'window-wgc',backend:'d3d12',priority:'high',receiver:'browser',load:'gpu-unlimited'},
  {id:'window-wgc',capture:'window-wgc',backend:'d3d11',priority:'normal',receiver:'browser',load:'gpu-unlimited'},
  {id:'monitor-wgc',capture:'monitor-wgc',backend:'d3d11',priority:'normal',receiver:'browser',load:'gpu-unlimited'},
  {id:'monitor-dxgi',capture:'monitor-dxgi',backend:'d3d11',priority:'normal',receiver:'browser',load:'gpu-unlimited'},
  {id:'native-receiver',capture:'window-wgc',backend:'d3d11',priority:'normal',receiver:'native',load:'gpu-unlimited'},
  {id:'monitor-idle-wgc',capture:'monitor-wgc',backend:'d3d11',priority:'normal',receiver:'browser',load:'off'},
  {id:'monitor-idle-dxgi',capture:'monitor-dxgi',backend:'d3d11',priority:'normal',receiver:'browser',load:'off'},
 ];
 const selected=option('--cases',cases.filter(c=>!privateNetwork||!['native-receiver','baseline-browser'].includes(c.id)).map(c=>c.id).join(',')).split(',');if(selected.some(id=>!cases.some(c=>c.id===id)))throw Error('Unknown comparison case');
 if(privateNetwork&&selected.some(id=>['native-receiver','baseline-browser'].includes(id)))throw Error('Private mode fixes the native receiver; it cannot compare browser vs native renderer');
 if(privateNetwork){for(const c of cases)c.receiver='native';report.conditions.privateNetwork=true;report.conditions.receiverPolicy='Native receiver fixed for priority/API isolation; no public STUN/TURN; explicit Tailscale host candidates only';}
 const title=`SMG E2E Motion ${study}`;
 const fixtures=Object.fromEntries(cases.filter(c=>selected.includes(c.id)).map((c,i)=>['/fixtures/'+c.id+'.html',createMotionFixture(title,100+i,60,{width:1920,height:1080,workload:{profile:c.load,scene:'offscreen',iterations:96,passes:16,workers:0}})]));
 for(const [i,c]of cases.filter(c=>selected.includes(c.id)).entries())c.magic=100+i;
 resources=await startResourceSampler({enabled:true});report.pressurePolicy=pressureOptions;report.preflight=await benchmarkPreflight(resources,pressureOptions);await save();
 if(report.preflight.status!=='clear'&&!pressureOptions.allowPressure)throw Error('Resource preflight unqualified: '+report.preflight.issues.join(', ')+'; do not run builds/tests concurrently. Explicit --allow-resource-pressure preserves unqualified results.');
 fixtures['/fixtures/receiver.html']='<!doctype html><title>Receiver</title><style>html,body{margin:0;background:black;overflow:hidden}</style>'; server=await startAssetServer({root,fixtures});
 const sourceWindow=await launchSourceWindow(chromium,{profile:path.join(output,'source-profile'),url:server.origin+'/fixtures/'+cases.find(c=>selected.includes(c.id)).id+'.html',args:background});
 localBrowser=sourceWindow.browser;const source=sourceWindow.page;report.sourceWindow=sourceWindow.windowEvidence;
 await source.evaluate(()=>{document.documentElement.onclick=()=>document.documentElement.requestFullscreen();});await source.locator('canvas').last().click({position:{x:100,y:200}});
 await source.waitForFunction(()=>document.fullscreenElement!==null);
 report.sourceBrowser=localBrowser.version();report.geometry=await source.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio}));
 for(let repetition=1;repetition<=repeat;repetition++)for(const c of (repetition%2?cases:[...cases].reverse()).filter(c=>selected.includes(c.id))){
  if(interrupted)throw Error('Study interrupted by operator');
  // Reverse all case orders on the second pass to expose drift.
  // Idle controls also reverse order for receiver qualification.
  caseId=study+'-'+report.runs.length;viewerId=caseId.replace(/^compare-/,'matrix-');nativeToken=randomBytes(24).toString('hex');senderToken=randomBytes(24).toString('hex');
  let senderLog='',receiverPage; const run={case:c,repetition,status:'running',timeline:[]};report.runs.push(run);await save();console.log(`[Comparison] ${repetition}/${repeat}: ${c.id}`);
  try{
   // Navigation exits HTML fullscreen. Reenter with a real user gesture.
   await source.goto(server.origin+'/fixtures/'+c.id+'.html');await source.evaluate(()=>{document.documentElement.onclick=()=>document.documentElement.requestFullscreen();document.querySelector('canvas').style.width='100vw';document.querySelector('canvas').style.height='100vh';});
   await source.locator('canvas').last().click({position:{x:100,y:200}});await source.waitForFunction(()=>document.fullscreenElement!==null);await source.bringToFront();await delay(2500);
   if(createHash('sha256').update(await readFile(executable)).digest('hex')!==report.exeSha256)throw Error('Executable changed during study');
   child=spawn(executable,['run_transport_comparison_probe','--ignored','--nocapture','--test-threads=1'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,SEEMYGAME_GSTREAMER_ROOT:path.join(root,'native-media/gstreamer'),PATH:path.join(root,'native-media/gstreamer/bin')+';'+process.env.PATH,SMG_COMPARE_PRIVATE_NETWORK:privateNetwork?'1':'0',SMG_COMPARE_ROLE:'sender',SMG_COMPARE_TOKEN:senderToken,SMG_COMPARE_TITLE:title,SMG_COMPARE_CAPTURE:c.capture,SMG_COMPARE_BACKEND:c.backend,SMG_COMPARE_GPU_PRIORITY:c.priority,GST_DEBUG:'*:2'}});
   const reader=createInterface({input:child.stdout});reader.on('line',l=>{senderLog+=l+'\n';const at=l.indexOf('SMG_COMPARE_READY ');if(at>=0)sendReady=JSON.parse(l.slice(at+18));});child.stderr.on('data',d=>senderLog+=d);
   for(let i=0;i<200&&!sendReady;i++){if(child.exitCode!==null)throw Error('Sender start failed: '+senderLog.slice(-3000));await delay(100);}if(!sendReady)throw Error('Sender readiness timeout');run.senderConditions=sendReady;console.log('[Comparison] sender ready');
   await remotePs(`$base=${quote(remote+'/output/native-comparisons/'+study+'/probe.exe')}; $stage=${quote(remote+'/output/native-comparisons/'+caseId)}; New-Item -ItemType Directory -Force -Path $stage | Out-Null; Copy-Item -LiteralPath $base -Destination (Join-Path $stage 'probe.exe')`);
   nativeActive=true;receiverReady=await nativeTask('start',c.receiver==='native'?'receiver':'observer');run.receiverConditions=receiverReady;console.log('[Comparison] remote probe ready');
   let viewerReady;
   viewerActive=true;viewerReady=await viewerTask('start',c.receiver==='native');console.log('[Comparison] remote resource helper ready');
   tunnel=spawn(ssh,[...sshArgs,'-N','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:19337:127.0.0.1:${receiverReady.port}`,...(viewerReady?['-L','127.0.0.1:19333:127.0.0.1:19333','-L','127.0.0.1:19334:127.0.0.1:19334']:[]),'-R',`127.0.0.1:19336:127.0.0.1:${new URL(server.origin).port}`,host],{windowsHide:true,stdio:['ignore','ignore','pipe']});let tunnelError='';tunnel.stderr.on('data',d=>tunnelError+=d);
   for(let i=0;i<40;i++){try{await receiver('clock');break;}catch(e){if(tunnel.exitCode!==null)throw Error(tunnelError);if(i===39)throw e;await delay(200);}}
   run.controlNetwork=jsonLines(await remotePs('$c=$env:SSH_CONNECTION -split '+quote(' ')+'; [pscustomobject]@{senderIPv4=$c[0];receiverIPv4=$c[2]} | ConvertTo-Json -Compress')).at(-1);  const receiveTitle=`SMG E2E Motion Receiver ${caseId}`;let page,offer;
   if(c.receiver==='browser'){
    const metadata=await readViewerControl(viewerReady.controlEndpoint,'metadata');const localVersion=JSON.parse(await readFile(path.join(root,'node_modules/playwright/package.json'))).version;
    const remoteConnection=prepareRemoteViewer(metadata,viewerReady.controlEndpoint,{localPlaywrightVersion:localVersion,localFingerprint:machineFingerprint()});run.viewer={...remoteConnection.conditions,browserVersion:metadata.browserVersion};
    remoteBrowser=await chromium.connect(remoteConnection.wsEndpoint);const cx=await remoteBrowser.newContext({viewport:{width:1280,height:720}});page=receiverPage=await cx.newPage();await page.goto('http://127.0.0.1:19336/fixtures/receiver.html');
    await page.evaluate(title=>{document.title=title;document.body.innerHTML='<video autoplay muted playsinline style="width:1280px;height:720px;display:block"></video>';},receiveTitle);
    offer=await page.evaluate(async()=>{const pc=window.pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});window.ice=[];pc.onicecandidate=e=>{if(e.candidate)window.ice.push(e.candidate.toJSON());};pc.ontrack=e=>{document.querySelector('video').srcObject=new MediaStream([e.track]);};const tr=pc.addTransceiver('video',{direction:'recvonly'});const codecs=RTCRtpReceiver.getCapabilities('video').codecs.filter(c=>c.mimeType.toLowerCase()==='video/h264');tr.setCodecPreferences(codecs);try{tr.receiver.jitterBufferTarget=0;}catch{}const offer=await pc.createOffer();await pc.setLocalDescription(offer);return offer.sdp;});
   }else offer=(await receiver('offer')).sdp;
   const answer=await sender('answer',{sdp:offer});console.log('[Comparison] SDP negotiated');await writeFile(path.join(output,c.id+'-'+repetition+'-offer.sdp'),offer);await writeFile(path.join(output,c.id+'-'+repetition+'-answer.sdp'),answer.sdp);answer.sdp=answer.sdp.split('\r\n').filter(l=>!l.startsWith('a=candidate:')||allowRendererCandidate(l.slice(2),mediaPolicy)).join('\r\n');if(page)await page.evaluate(async sdp=>window.pc.setRemoteDescription({type:'answer',sdp}),answer.sdp);else await receiver('answer',{sdp:answer.sdp});
   let sentRx=0,sentTx=0;
   const exchange=async()=>{const tx=await sender('status');const rxIce=page?await page.evaluate(()=>window.ice):(await receiver('status')).candidates;for(const original of rxIce.slice(sentRx)){if(original.candidate&&!allowRendererCandidate(original.candidate,mediaPolicy))continue;const ice={...original};const parts=ice.candidate.split(' ');if(parts[4]?.endsWith('.local')){parts[4]=run.controlNetwork.receiverIPv4;ice.candidate=parts.join(' ');run.mdnsDiagnosticSubstitution=true;}await sender('candidate',ice);}sentRx=rxIce.length;for(const ice of tx.candidates.slice(sentTx)){if(ice.candidate&&!allowRendererCandidate(ice.candidate,mediaPolicy))continue;if(page)await page.evaluate(c=>window.pc.addIceCandidate(c),ice);else await receiver('candidate',ice);}sentTx=tx.candidates.length;};
   run.sourceGeometryBeforeMedia=await source.evaluate(sourceGeometry);let received=false;run.readiness=[];for(let i=0;i<100;i++){await exchange();received=page?await page.evaluate(()=>document.querySelector('video').videoWidth>0):(await receiver('status')).presentCalls>2;if(i%10===0&&page)run.readiness.push(await page.evaluate(async()=>({at:Date.now(),state:pc.connectionState,iceState:pc.iceConnectionState,stats:Array.from((await pc.getStats()).values()).filter(r=>['transport','candidate-pair','local-candidate','remote-candidate','inbound-rtp'].includes(r.type))})));if(received)break;await delay(250);}if(!received){run.transportDebug={sender:await sender('status'),receiver:page?await page.evaluate(async()=>({state:pc.connectionState,iceState:pc.iceConnectionState,ice:window.ice,stats:Array.from((await pc.getStats()).values())})):await receiver('status')};throw Error('Receiver media readiness timeout');}
   // Remote setup can take long enough for another window to cover the monitor.
   // Restore our source immediately before the content check; DOM visibility alone
   // does not prove the monitor actually displays this synthetic window.
   await source.bringToFront();
   console.log('[Comparison] receiving video');await receiver('observe',{title:receiveTitle,magic:c.magic});run.warmup={startedAt:Date.now(),minimumSeconds:3};await delay(3000);run.warmup.endedAt=Date.now();
   const warmupEvidence=await receiver('status',{full:true});
   run.contentReadiness=rendererContentReadiness(warmupEvidence);
   if(!run.contentReadiness.valid){
    run.contentFailureEvidence=warmupEvidence;
    run.sourceGeometryAtFailure=await source.evaluate(sourceGeometry);
    await source.screenshot({path:path.join(output,c.id+'-'+repetition+'-source-at-failure.png')});
    if(page)run.browserContentFailure=await page.evaluate(async()=>({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,inbound:Array.from((await pc.getStats()).values()).find(row=>row.type==='inbound-rtp'&&row.kind==='video')}));
    throw Error('No advancing valid synthetic content before measurement: decoded FPS is insufficient evidence; inspect receiver screenshot and capture stage');
   }
   run.sourceGeometryBeforeSample=await source.evaluate(sourceGeometry);await source.screenshot({path:path.join(output,c.id+'-'+repetition+'-source.png')});const clockPage={evaluate:()=>receiver('clock')};const before=await retryUncertainCalibration(()=>calibrateLocalSourceClock(source,clockPage,{samples:100}),{attempts:3,desiredUncertaintyMs:7});
   await sender('reset');await receiver('reset');const start=Date.now();const sourceBefore=await source.evaluate(readSourceStatsSummary);
   let browserFirst;if(page)browserFirst=await page.evaluate(async()=>Array.from((await window.pc.getStats()).values()).find(r=>r.type==='inbound-rtp'&&r.kind==='video'));run.browserBefore=browserFirst;
   while(Date.now()-start<seconds*1000){if(interrupted)throw Error('Study interrupted by operator');await delay(1000);await exchange();const row={at:Date.now(),source:await source.evaluate(readSourceStatsSummary),receiver:await receiver('status')};if(page)row.browser=await page.evaluate(async()=>{const rows=Array.from((await window.pc.getStats()).values());const r=rows.find(r=>r.type==='inbound-rtp'&&r.kind==='video');return {width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,stats:rows.filter(r=>['transport','candidate-pair','local-candidate','remote-candidate'].includes(r.type)),inbound:r,codec:rows.find(c=>c.id===r?.codecId),transport:rows.find(c=>c.type==='candidate-pair'&&c.state==='succeeded'&&c.nominated)};});run.timeline.push(row);}
   run.sourceAtEnd=await source.evaluate(readSourceStatsSummary);const end=Date.now();run.measurementWindow={start,end};run.sourceBefore=sourceBefore;run.sourceFps=(run.sourceAtEnd.framesProduced-sourceBefore.framesProduced)*1000/(end-start);
   Object.assign(run,await collectRendererEndEvidence(()=>receiver('status',{full:true}),()=>source.evaluate(()=>window.__smgSourceStats)));
   run.sourceGeometryAfterSample=await source.evaluate(sourceGeometry);run.senderEvidence=await sender('status',{full:true});
   console.log('[Comparison] sampled; checking clocks');const after=await retryUncertainCalibration(()=>calibrateLocalSourceClock(source,clockPage,{samples:100}),{attempts:3,desiredUncertaintyMs:7});run.clocks={before,after,validation:validateClockCheckpoints(before,[after],{recenter:true})};
   run.opticalWindow=qualifyWindowOptics(run.receiverEvidence.optics,run.sourceAfter.frameLog,{start,end,offsetMs:run.clocks.validation.offsetMs??before.offsetMs});run.invalidProvenance=run.opticalWindow.invalidProvenance;
   const latencies=run.opticalWindow.samples.map(s=>s.provenanceValid?correctedVisualLatency(s.captureEpoch,s.sourceTime32,run.clocks.validation.offsetMs):null).filter(v=>v!==null&&v>=0&&v<3000);
   run.visualAgeMs=distribution(latencies);run.readbackCpuMs=distribution(run.receiverEvidence.readbackCpuMs);run.decodedFps=page?(run.timeline.at(-1).browser.inbound.framesDecoded-browserFirst.framesDecoded)*1000/(end-start):run.receiverEvidence.decoded*1000/(end-start);run.nativePresentFps=page?null:run.receiverEvidence.presentCalls*1000/(end-start);run.resources=resources.window(start,end);const remoteResources=await readViewerControl(viewerReady.controlEndpoint,'resources');const remoteSamples=remoteResources.samples.filter(s=>s.timestamp>=start+before.offsetMs&&s.timestamp<=end+before.offsetMs);run.receiverResources={metadata:remoteResources.metadata,summary:summarizeResources(remoteSamples),samples:remoteSamples,windowQualification:'Receiver OS sample epochs approximated with native probe clock offset; context only, not frame timestamps'};
   run.route=rendererRoute(run.senderEvidence.networkStats);run.receiverRoute=page?rendererRoute(run.timeline.at(-1).browser.stats):rendererRoute(run.receiverEvidence.networkStats);run.routeObservationSide='sender';run.continuity=receiverContinuity(run.timeline,!!page,browserFirst?.framesDecoded??0);run.resolutionValid=page?run.timeline.every(row=>row.browser.width===1280&&row.browser.height===720):/width=\(int\)1280.*height=\(int\)720/.test(run.receiverEvidence.decodedCaps??'');
   run.status=run.route&&run.continuity.valid&&run.resolutionValid&&run.clocks.validation.status==='valid'&&!run.invalidProvenance&&!run.opticalWindow.malformed&&latencies.length>=seconds*3?'valid':'insufficient-evidence';
   qualifyBenchmarkRun(run,{...pressureOptions,preflight:report.preflight});
   if(debugOptics)run.status='debug-only';
   if(!sendReady.priority.applied)run.priorityQualification='Requested process GPU class was NOT verified applied; cannot establish priority effect';
   await writeFile(path.join(output,c.id+'-'+repetition+'-sender.log'),senderLog);if(page)await page.screenshot({path:path.join(output,c.id+'-'+repetition+'-receiver.png')});
   console.log(JSON.stringify({case:c.id,rep:repetition,status:run.status,fps:run.decodedFps,visualAge:run.visualAgeMs,clockError:run.clocks.validation.uncertaintyMs,gpuPriority:sendReady.priority,sourceFps:run.sourceFps}));
  }catch(e){run.status='failed';run.error=e.message;if(e.sourceClockAgreement)run.sourceClockFailure=e.sourceClockAgreement;console.log('Case failed: '+e.message);try{run.remoteLog=await remotePs(`Get-Content -LiteralPath ${quote(remote+'/output/native-comparisons/'+caseId+'/probe.log')} -Tail 50`);}catch{}if(receiverPage)try{await receiverPage.screenshot({path:path.join(output,c.id+'-'+repetition+'-failure.png')});}catch{}if(failFast||interrupted)throw e;}
  finally{if(debugOptics){for(let n=0;n<3;n++)for(const ext of ['json','bgra']){try{await command(scp,[...sshArgs,host+':'+remote+'/output/native-comparisons/'+caseId+'/optical-reject-'+n+'.'+ext,path.join(output,c.id+'-'+repetition+'-reject-'+n+'.'+ext)]);}catch{}}}await writeFile(path.join(output,c.id+'-'+repetition+'-sender.log'),senderLog);await cleanup();await save();await delay(1000);}
 }
 report.comparisons=captureRendererComparisons(report);report.status=report.runs.some(r=>r.status==='failed')?'completed-with-failures':report.runs.some(r=>r.status!=='valid')?'completed-with-unqualified-runs':'completed';
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1;}
finally{await cleanup();await resources?.stop();report.resources=resources?.report();await localBrowser?.close();await server?.close();if(displayAwake)report.displayAwakeRestoration=await displayAwake.stop();await save();console.log('Capture/renderer comparison '+report.status+': '+output);}
