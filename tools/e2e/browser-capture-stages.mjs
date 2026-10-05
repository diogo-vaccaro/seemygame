// Controlled causal experiment, not the application's end-to-end quality test.
// Raw capture deliberately removes encoding, WebRTC transport and decoding.
import {chromium} from 'playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMotionFixture} from './fixtures/motion.mjs';
import {validateGameWorkload} from './fixtures/game-workload.mjs';
import {installTelemetry} from './telemetry.mjs';
import {startAssetServer} from './harness/server.mjs';
import {startResourceSampler} from './harness/resources.mjs';
import {readSourceStatsSummary} from './harness/source-summary.mjs';
import {readDisplayModes} from './harness/displays.mjs';
import {calibrateCaptureWindow} from './harness/capture-geometry.mjs';
import {ensureDefaultDesktop} from './desktop-affinity.mjs';
import {requireOpticalEvidence} from './harness/causal-summary.mjs';
ensureDefaultDesktop();
const root=fileURLToPath(new URL('../../',import.meta.url));
const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const seconds=Number(option('--seconds','15')),repeat=Number(option('--repeat','2')),opticalHz=Number(option('--optical-hz','8'));
const modes=option('--modes','raw,webrtc').split(',');
if(!Number.isInteger(seconds)||seconds<5||seconds>60||!Number.isInteger(repeat)||repeat<1||repeat>5||!Number.isFinite(opticalHz)||opticalHz<0||opticalHz>60||modes.some(m=>!['raw','webrtc'].includes(m)))throw Error('Invalid capture probe conditions');
const workloads=option('--profiles','off,gpu-unlimited,gpu-capped').split(',').map(profile=>validateGameWorkload({profile,scene:option('--workload-scene','offscreen'),passes:Number(option('--workload-passes','16')),iterations:96}));
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex'),magic=42,title=`SMG E2E Motion ${runId}`;
const output=path.join(root,'output/playwright',`browser-capture-stages-${runId}`);await mkdir(output,{recursive:true});
const report={status:'running',runId,conditions:{seconds,repeat,opticalHz,modes,workloads,width:1920,height:1080,fps:60,sourceFullscreen:false,receiverPosition:'-1800,80',samePhysicalMachine:true},runs:[],sourceHashes:{},limitations:['Raw capture measures source + browser capture + local presentation; it cannot split those three stages.','WebRTC mode is an isolated local microbenchmark with two peers in the receiver page, not the production application.','No physical panel scanout; optical timestamp is drawn on CPU and receiver time uses rVFC presentation metadata.','GPU completion-observed wall time includes polling; it is not exact GPU queue latency.','PTS/pad probes and optical samples belong to separate runs; do not subtract their medians as a causal breakdown.']};
let sourceBrowser,captureBrowser,server,resources,source,receiver;
try{
 for(const file of ['tools/e2e/browser-capture-stages.mjs','tools/e2e/fixtures/motion.mjs','tools/e2e/fixtures/game-workload.mjs','tools/e2e/telemetry/installer.mjs','tools/e2e/telemetry/metrics.mjs','tools/e2e/harness/causal-summary.mjs','tools/e2e/harness/capture-geometry.mjs','tools/e2e/harness/server.mjs','tools/e2e/harness/source-summary.mjs','tools/e2e/harness/resources.mjs','tools/e2e/harness/resource-counters.ps1','tools/e2e/harness/resource-counters.cs'])report.sourceHashes[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
 report.displays=await readDisplayModes();
 if(!report.displays.displays?.some(d=>d.x===-1920))throw Error('This controlled experiment requires the observed left secondary display to avoid covering the source');
 server=await startAssetServer({root,fixtures:{...Object.fromEntries(workloads.map(w=>[`/source-${w.profile}.html`,createMotionFixture(title,magic,60,{width:1920,height:1080,workload:w})])), '/receiver.html':'<!doctype html><title>SMG Capture Probe Receiver</title><style>body{margin:0;background:#111}video{width:100%;height:auto}</style><button id="start">Start diagnostic capture</button><video autoplay muted playsinline></video>'}});
 resources=await startResourceSampler({enabled:true});
 const common=['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-features=CalculateNativeWinOcclusion','--autoplay-policy=no-user-gesture-required'];
 sourceBrowser=await chromium.launch({channel:'chrome',headless:false,args:[...common,'--window-position=0,0','--window-size=1920,1080']});
 source=await sourceBrowser.newPage({viewport:{width:1920,height:1080}});await source.goto(server.origin+`/source-${workloads[0].profile}.html`);
 report.captureGeometry=await calibrateCaptureWindow({source,title,width:1920,height:1080,root});
 captureBrowser=await chromium.launch({channel:'chrome',headless:false,args:[...common,'--window-position=-1800,80','--window-size=1340,840',`--auto-select-desktop-capture-source=${title}`,'--enable-usermedia-screen-capturing','--allow-http-screen-capture']});
 const context=await captureBrowser.newContext({viewport:{width:1280,height:720}});
 await context.addInitScript(installTelemetry,{expectedSessionMagic:magic,enableOptical:opticalHz>0,opticalSampleHz:opticalHz||8,opticalReaderMode:'gpu-roi',opticalSourceWidth:1920});
 receiver=await context.newPage();report.browserVersion=captureBrowser.version();
 for(let repetition=1;repetition<=repeat;repetition++)for(const workload of repetition%2?workloads:[...workloads].reverse())for(const mode of repetition%2?modes:[...modes].reverse()){
  console.log(`[Browser capture] ${repetition}/${repeat} ${workload.profile} ${mode}`);
  await source.goto(server.origin+`/source-${workload.profile}.html`);await source.evaluate(()=>document.querySelectorAll('canvas').forEach(c=>{c.style.width='100vw';c.style.height='100vh';}));await source.bringToFront();await source.waitForTimeout(2500);
  await receiver.goto(server.origin+'/receiver.html');
  await receiver.evaluate(mode=>{
    document.querySelector('#start').onclick=async()=>{
      try{
        const stream=window.__probeStream=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60,max:60}},audio:false});
        const track=stream.getVideoTracks()[0];window.__probeSettings=track.getSettings();track.contentHint='motion';
        const video=document.querySelector('video');
        if(mode==='raw'){video.srcObject=stream;await video.play();window.__probeReady=true;return;}
        const a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]});window.__probePeers=[a,b];
        a.onicecandidate=e=>{if(e.candidate)b.addIceCandidate(e.candidate).catch(e=>window.__probeError=e.message);};
        b.onicecandidate=e=>{if(e.candidate)a.addIceCandidate(e.candidate).catch(e=>window.__probeError=e.message);};
        b.ontrack=e=>{try{e.receiver.jitterBufferTarget=0;}catch{}video.srcObject=e.streams[0];video.play().then(()=>window.__probeReady=true).catch(e=>window.__probeError=e.message);};
        const sender=a.addTrack(track,stream),transceiver=a.getTransceivers()[0];
        const codecs=RTCRtpSender.getCapabilities('video').codecs.filter(c=>c.mimeType.toLowerCase()==='video/h264');
        if(!codecs.length)throw Error('H264 unavailable');transceiver.setCodecPreferences(codecs);
        await b.setRemoteDescription(await a.createOffer().then(async s=>{await a.setLocalDescription(s);return s;}));
        await b.setLocalDescription(await b.createAnswer());await a.setRemoteDescription(b.localDescription);
        const p=sender.getParameters();p.encodings[0].maxBitrate=7500000;p.encodings[0].maxFramerate=60;p.encodings[0].scaleResolutionDownBy=1;p.degradationPreference='maintain-resolution';await sender.setParameters(p);
      }catch(error){window.__probeError=error.message;}
    };
  },mode);
  await receiver.locator('#start').click();
  await receiver.waitForFunction(()=>window.__probeReady||window.__probeError,{},{timeout:45000});
  const error=await receiver.evaluate(()=>window.__probeError);if(error)throw Error(error);
  await receiver.evaluate(()=>window.__smgE2E.resetSession());
  await receiver.waitForFunction(()=>document.querySelector('video').__smgPresentation,{},{timeout:10000});
  await receiver.waitForTimeout(3000);
  await receiver.evaluate(()=>{window.__smgE2E.resetSession();document.querySelector('video').__smgPresentation.setPhase('steady');});
  const startedAt=Date.now(),sourceBefore=await source.evaluate(readSourceStatsSummary),before=await receiver.evaluate(()=>window.__smgE2E.sample()),timeline=[];
  for(let i=0;i<seconds;i++){await receiver.waitForTimeout(1000);timeline.push({at:Date.now(),source:await source.evaluate(readSourceStatsSummary),receiver:await receiver.evaluate(()=>window.__smgE2E.sample())});}
  const endedAt=Date.now(),sourceAfter=await source.evaluate(readSourceStatsSummary),after=timeline.at(-1).receiver;
  const presentation=await receiver.evaluate(()=>document.querySelector('video').__smgPresentation.getStats());
  const run={repetition,workload,mode,startedAt,endedAt,sourceBefore,sourceAfter,before,after,timeline,presentation,trackSettings:await receiver.evaluate(()=>window.__probeSettings),resources:resources.window(startedAt,endedAt)};
  if(run.trackSettings.width!==1920||run.trackSettings.height!==1080)throw Error('Unexpected capture dimensions');
  if(after.videos[0]?.width!==1920||after.videos[0]?.height!==1080)throw Error('Unexpected presented dimensions');
  report.runs.push(run);console.log(JSON.stringify({repetition,profile:workload.profile,mode,latency:presentation.steadyLatency,overhead:presentation.instrumentationOverheadMs,resources:run.resources.summary}));
  run.opticalEvidence=requireOpticalEvidence(presentation,seconds,opticalHz);
  await receiver.evaluate(()=>{window.__probeStream?.getTracks().forEach(t=>t.stop());window.__probePeers?.forEach(p=>p.close());});
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
 }
 report.status='passed';
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1;await receiver?.screenshot({path:path.join(output,'receiver-failure.png')}).catch(()=>{});await source?.screenshot({path:path.join(output,'source-failure.png')}).catch(()=>{});}
finally{await resources?.stop();report.resources=resources?.report();await captureBrowser?.close();await sourceBrowser?.close();await server?.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(output);}
