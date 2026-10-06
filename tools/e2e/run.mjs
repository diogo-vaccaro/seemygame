import { startAssetServer } from './harness/server.mjs';
import { resolveDesktopTestProfile, readInstanceProfileEvidence } from './harness/desktop-profile.mjs';
import { startSignalingServer } from './harness/signaling.mjs';
import { bounded, createCleanupCollector } from './harness/lifecycle.mjs';
import { listFrontendFiles, listRustFiles, frontendSourceMatches } from './harness/provenance.mjs';
import { createMotionFixture } from './fixtures/motion.mjs';
import {validateGameWorkload} from './fixtures/game-workload.mjs';
import { chromium } from 'playwright';
import { createServer as createTcpServer } from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import { installTelemetry, deltaMetrics } from './telemetry.mjs';
import { computeSessionMagic, crc16, MARKER_CONFIG } from './optical.mjs';
import { waitForAsync } from './wait.mjs';
import { exerciseVoiceControls } from './harness/voice-controls.mjs';
import { ensureDefaultDesktop } from './desktop-affinity.mjs';
import { QUALITY_PROFILES } from '../../js/config.js';
import {resolveTestProfiles,installTestStreamProfile,isSevereCadenceDrop,resolveWebCaptureStages} from './harness/stream-profile.mjs';
import { assessQuality } from '../../js/streaming/quality.js';
import { startResourceSampler } from './harness/resources.mjs';
import { evaluateStreamVerdict, assessVideoContinuity } from './harness/verdict.mjs';
import { readSourceStatsSummary } from './harness/source-summary.mjs';
import { createRequire } from 'node:module';
import { machineFingerprint, readViewerControl, prepareRemoteViewer, resourceWindow, redactViewerSecrets } from './harness/remote-viewer.mjs';
import { summarizeResources } from './harness/resources.mjs';
import { readDisplayModes, validateWindowPosition } from './harness/displays.mjs';
import { calibrateCaptureWindow } from './harness/capture-geometry.mjs';
import { readCaptureBackendEvidence } from './harness/capture-backend.mjs';
import {inspectPhaseConditions} from './harness/phase-validation.mjs';
import { terminateOwnedMediaWorker } from './harness/worker-failure.mjs';
import { installNativeWithoutPreview } from './harness/no-preview.mjs';
import { installNativeReceiverPayloads } from './harness/receiver-payloads.mjs';
import {classifyStutter} from './harness/stutter-cause.mjs';
import {nativeStageEvidence} from './harness/native-stage-evidence.mjs';
import {calibrateBrowserClocks,calibrateBrowserClocksReliably,validateClockCheckpoints} from './harness/clock-calibration.mjs';
import {startBrowserTrace,installFrameEvidence} from './harness/browser-trace.mjs';
import {startForwardedFixtures} from './harness/forwarded-fixtures.mjs';

ensureDefaultDesktop();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const productionSignaling = args.includes('--production-signaling');
const exerciseVoice = args.includes('--exercise-voice-controls');
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const exe = path.resolve(option('--exe', path.join(root, 'src-tauri/target/debug/seemygame.exe')));
const duration = Number(option('--seconds', '30'));
const receiverTraceSeconds=Number(option('--receiver-trace-seconds','0'));
const receiverTraceTriggerMs=Number(option('--receiver-trace-trigger-ms','0')),traceSender=args.includes('--trace-sender');
if(!Number.isFinite(receiverTraceTriggerMs)||receiverTraceTriggerMs<0||receiverTraceTriggerMs>1000||receiverTraceTriggerMs>0&&receiverTraceSeconds===0||traceSender&&receiverTraceSeconds===0)throw new Error('Invalid trace trigger/sender');
const receiverFrameEvidence=args.includes('--receiver-frame-evidence')||receiverTraceSeconds>0;
const receiverViewportOption=option('--receiver-viewport','1280,720');
const receiverViewport=receiverViewportOption?.split(',').map(Number)??null;
if(receiverViewport&&(receiverViewport.length!==2||receiverViewport.some(v=>!Number.isInteger(v)||v<240||v>3840)))throw new Error('Invalid receiver viewport (width,height; 240..3840)');
if(!Number.isInteger(receiverTraceSeconds)||receiverTraceSeconds<0||receiverTraceSeconds>0&&receiverTraceSeconds>Math.min(60,duration-8))throw new Error('Invalid trace duration');
if (!Number.isFinite(duration) || duration < 5 || duration > 1800) throw new Error('--seconds: intervalo permitido 5..1800');
const minFps = Number(option('--min-fps', '0'));
if (!Number.isFinite(minFps) || minFps < 0 || minFps > 240) throw new Error('--min-fps: intervalo permitido 0..240');
const remoteViewerEndpoint = option('--viewer-endpoint', null);
const desktopProfileOption = option('--desktop-profile', null);
const desktopCdpPort = Number(option('--desktop-cdp-port', '0'));
if (!Number.isInteger(desktopCdpPort) || desktopCdpPort < 0 || desktopCdpPort > 65535 || desktopCdpPort > 0 && (desktopCdpPort < 1024 || !desktopProfileOption || !remoteViewerEndpoint || !args.includes('--allow-same-machine-remote'))) throw new Error('Shared desktop CDP requires a test profile and same-machine viewer endpoint');
const nativeAudioMode = option('--native-audio', 'none');
if (!['none', 'system', 'process'].includes(nativeAudioMode)) throw new Error('Invalid native audio mode');
const viewerSshHost=option('--viewer-ssh-host',null);
const calibrateClocks=args.includes('--calibrate-clocks');
const clockMaxErrorMs=Number(option('--clock-max-error-ms','10'));
if(!Number.isFinite(clockMaxErrorMs)||clockMaxErrorMs<=0||clockMaxErrorMs>100)throw new Error('--clock-max-error-ms: 0 < error <= 100');
if(calibrateClocks&&!remoteViewerEndpoint)throw new Error('--calibrate-clocks requires a remote receiver');
if(viewerSshHost&&!remoteViewerEndpoint)throw new Error('--viewer-ssh-host requires --viewer-endpoint');
const opticalHz = Number(option('--optical-hz', remoteViewerEndpoint ? '0' : '8'));
const opticalReaderMode = option('--optical-reader', 'gpu-roi');
if (!['legacy', 'roi', 'gpu-roi'].includes(opticalReaderMode)) throw new Error('Invalid optical reader mode');
if (!Number.isFinite(opticalHz) || opticalHz < 0 || opticalHz > 60) throw new Error('--optical-hz: 0 (desativado) ou 1..60');
if (opticalHz > 0 && opticalHz < 1) throw new Error('--optical-hz: 0 (desativado) ou 1..60');
const requireQuality = args.includes('--require-quality');
const channel = option('--channel', 'msedge');
const preset = option('--preset', 'balanced');
const sourceWorkload=validateGameWorkload({profile:option('--source-workload','off'),scene:option('--workload-scene','visible'),iterations:Number(option('--workload-iterations','96')),passes:Number(option('--workload-passes','4')),workers:Number(option('--workload-workers',String(Math.min(4,Math.max(1,os.cpus().length-2)))))});
if (!QUALITY_PROFILES[preset]) throw new Error('Preset de transmissão inválido');
const testProfiles=resolveTestProfiles(QUALITY_PROFILES[preset],{streamFps:option('--stream-fps',undefined),sourceFps:option('--source-fps',undefined),sourceSize:option('--source-size',undefined)});
testProfiles.override ||= args.includes('--web-capture-fps')||args.includes('--web-scale-in-encoder');
const streamProfile=testProfiles.stream,sourceProfile=testProfiles.source;
const webCaptureFps=Number(option('--web-capture-fps',String(streamProfile.fps)));
if(!Number.isInteger(webCaptureFps)||webCaptureFps<1||webCaptureFps>120)throw Error('Invalid web capture FPS');
const webCaptureStages=resolveWebCaptureStages(streamProfile,sourceProfile,{captureFps:webCaptureFps,scaleInEncoder:args.includes('--web-scale-in-encoder')});
const requestedCodec = option('--codec', 'h264');
if (!['auto', 'h264', 'av1', 'hevc'].includes(requestedCodec)) throw new Error('Codec nativo inválido');
const isCompareMode = args.includes('--compare');
const senderMode=option('--sender','native');
const captureBackend=option('--capture-backend','auto');
const experimentalHevcReceive=args.includes('--enable-hevc-receive');
const nativeWithoutPreview=args.includes('--native-without-preview');
if(nativeWithoutPreview&&senderMode!=='native')throw new Error('No-preview diagnostic requires native sender');
if(nativeWithoutPreview&&requestedCodec==='auto')throw new Error('No-preview diagnostic requires an explicit codec');
const exerciseCaptureFallback=args.includes('--exercise-capture-fallback');
if(exerciseCaptureFallback&&(senderMode!=='native'||captureBackend!=='auto'))throw new Error('Fallback fault injection requires native sender with automatic backend');
if(!['auto','d3d11','d3d12'].includes(captureBackend))throw new Error('Invalid capture backend');
if(senderMode==='web'&&captureBackend==='d3d12')throw new Error('Capture backend applies only to native sender');
if(captureBackend==='d3d12'&&requestedCodec!=='h264')throw new Error('D3D12 experiment requires H264');
const matchedResolution=args.includes('--matched-resolution');
const matchedCodec=args.includes('--matched-codec');
if(matchedCodec&&requestedCodec==='auto')throw new Error('Matched codec requires an explicit codec');
const encoder=option('--encoder',captureBackend==='d3d12'?'nvenc':'auto');
if(!['auto','nvenc','mf','cpu'].includes(encoder))throw new Error('Invalid encoder');
if(captureBackend==='d3d12'&&encoder!=='nvenc')throw new Error('D3D12 experiment requires NVENC');
const bitrateKbps=Number(option('--bitrate-kbps',String(QUALITY_PROFILES[preset].bitrate/1000)));
if(!Number.isInteger(bitrateKbps)||bitrateKbps<256||bitrateKbps>50000)throw new Error('Invalid bitrate budget');
if(!['native','web'].includes(senderMode))throw new Error('--sender must be native or web');
if(senderMode==='web'&&isCompareMode)throw new Error('--sender web is a single forward-direction run, not --compare');
if(remoteViewerEndpoint&&isCompareMode)throw new Error('Remote receiver currently supports the native phase only; --compare reverses the local sender/receiver roles and is not valid across machines yet');
if(remoteViewerEndpoint&&opticalHz>0&&!calibrateClocks)throw new Error('Remote optical latency requires --calibrate-clocks, or use --optical-hz 0');
const nativeReplay = args.includes('--native-replay');
const viewerReplay = args.includes('--viewer-replay');
const isWebFirst = args.includes('--web-first') || option('--order', 'native-first') === 'web-first';
const customWebOrigin = option('--web-url', option('--web-origin', null));
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
const sessionMagic = computeSessionMagic(runId);
const output = path.join(root, 'output/playwright', runId);
await mkdir(output, { recursive: true });
const report = {
  runId,
  sessionMagic,
  mode: isCompareMode ? 'compare' : senderMode==='web'?'web-single':'single',
  senderConditions:{runtime:senderMode==='web'?'chrome':'tauri',capture:senderMode==='web'?'getDisplayMedia':`${captureBackend}/WGC`,requestedEncoder:encoder,matchedResolution,bitrateBudgetKbps:bitrateKbps},
  status: 'running',
  steps: [],
  measurements: [],
  checks: [],
  replayConditions: { nativePhase: { transmitter: nativeReplay, receiver: viewerReplay } },
  qualityConditions: { preset, requestedCodec, matchedCodec, matchedResolution, requestedFps: streamProfile.fps, requestedWidth: streamProfile.width, requestedHeight: streamProfile.height },
  instrumentation: {opticalHz, opticalReaderMode, receiverTraceSeconds,receiverFrameEvidence,systemMetrics:!args.includes('--no-system-metrics')},
  sourceWorkload,
  sourceProfile,
  streamProfile,
  testStreamOverride:testProfiles.override,
  webCaptureFps,
  webCaptureStages,
  limitations: [
    'Transmitter, synthetic source and receiver share one physical CPU/GPU; performance does not isolate real two-machine usage.',
    'LAN/local test: not a two-network TURN test',
    'Dedicated synthetic window; requested canvas size does not prove compositor/capture dimensions. Delivered dimensions are qualified separately.'
  ]
};
let desktop, viewerBrowser, sourceBrowser, nativeBrowser, hostPage, viewerPage, server, remoteViewer;
let sharedReceiverTargetId;
const resources = await startResourceSampler({enabled:!args.includes('--no-system-metrics')});
let signaling,reverseTunnel;
let activeReceiverTrace,pendingReceiverTrace,activeSenderTrace,pendingSenderTrace;
let viewerContext = null;
let nativeLogSize = 0;
let hostId, viewerId;
const previous = new Map();
const serializeReport = () => JSON.stringify(report, (_,value)=>redactViewerSecrets(value,{controlEndpoint:remoteViewerEndpoint,wsEndpoint:remoteViewer?.wsEndpoint}), 2);
if(sourceWorkload.profile!=='off')report.limitations.push('Captured WebGL shader/worker workload approximates resource contention, not a commercial game engine, VRAM pressure or anti-cheat behavior.');
const checkpoint = () => writeFile(path.join(output, 'report.json'), serializeReport());
const cleanup = createCleanupCollector(report);
// Tauri rewrites HTML at build time (CSP/bootstrap); compare unmodified JS assets.
const frontendFiles = await listFrontendFiles(root);
let sourceStats = null;
let previousNativeSample = null;
const sampleBoth = async () => {
  const activeSourcePage = sourceBrowser && sourceBrowser.contexts().length > 0 && sourceBrowser.contexts()[0].pages()[0];
  if (activeSourcePage && !activeSourcePage.isClosed()) {
    sourceStats = await activeSourcePage.evaluate(readSourceStatsSummary).catch(() => null);
  }
  for (const [side, page] of [['desktop', hostPage], ['web', viewerPage]]) {
    if (!page || page.isClosed()) continue;
    const sample = await page.evaluate(() => window.__smgE2E?.sample()).catch(() => null);
    if (!sample) continue;
    if(side==='desktop'&&report.partialPhase?.isNative) {
      sample.native = await page.evaluate(async viewerId => {
        const start=performance.now();
        try {
          const state=(await import('/js/entries/room-entry.js')).roomState;
          const sessionId=state.features.nativeMedia.senders.get(viewerId);
          if(!sessionId)return null;
          const rows=await (await import('/js/desktop/webrtc.js')).getNativeStreamStats(sessionId,viewerId);
          return {rows,epoch:Date.now(),perf:performance.now(),collectionMs:performance.now()-start};
        } catch(error) { return {rows:[],epoch:Date.now(),perf:performance.now(),error:error.message,collectionMs:performance.now()-start}; }
      },viewerId);
      sample.nativeStages=nativeStageEvidence(previousNativeSample,sample.native);
      previousNativeSample=sample.native;
    }
    for (const row of sample.rows) {
      const id = `${side}:${row.pcId}:${row.id}`;
      if (previous.has(id)) row.delta = deltaMetrics(previous.get(id), row);
      previous.set(id, row);
    }
    report.measurements.push({ side, sourceStats, ...sample });
  }
};
const watchErrors = (page, side) => {
  page.on('pageerror', error => {
    (report.pageErrors ||= []).push({ side, at: Date.now(), message: error.message });
  });
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type()) && (report.browserMessages ||= []).length < 200)
      report.browserMessages.push({ side, type: message.type(), message: message.text() });
  });
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// In this Playwright version, waitForFunction treats the returned Promise as
// truthy before inspecting its resolved value. Await every async observation.
const waitApp = async (page, predicate, argument, timeout = 45000) => {
  await waitForAsync(() => bounded('application state', () => page.evaluate(predicate, argument)), { timeout });
};
const awaitMatchedReceiver = async (page,peerId,label) => {
  if(!matchedResolution)return;
  const started=Date.now(),target=QUALITY_PROFILES[preset],observations=[];
  let streak=0;
  report.resolutionStartup ||= {};
  report.resolutionStartup[label]={requested:{width:target.width,height:target.height},observations};
  await waitForAsync(async()=>{
    const dimensions=await page.evaluate(id=>{const v=document.getElementById(`card-${id}`)?.querySelector('video');return {width:v?.videoWidth||0,height:v?.videoHeight||0};},peerId);
    observations.push({elapsedMs:Date.now()-started,...dimensions});
    streak=dimensions.width===target.width&&dimensions.height===target.height?streak+1:0;
    return streak>=5;
  },{timeout:90000,interval:1000});
  report.resolutionStartup[label].waitMs=Date.now()-started;
  report.resolutionStartup[label].stableSamples=streak;
};
const record = async (name, action) => { const started = Date.now(); console.log(name); try { const value = await action(); report.steps.push({ name, status: 'passed', ms: Date.now() - started }); return value; } catch (error) { report.steps.push({ name, status: 'failed', error: error.message }); throw error; } };
const hash = data => createHash('sha256').update(data).digest('hex');
const freePort = async () => { const s = createTcpServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; };
const syntheticTitle = `SMG E2E Motion ${runId}`;
const fixture = createMotionFixture(syntheticTitle, sessionMagic, sourceProfile.fps, {...sourceProfile,workload:sourceWorkload});
const serve = async () => {
  const assets = await startAssetServer({ root, fixtures: { '/e2e-motion.html': fixture } });
  server = assets.server; return assets.origin;
};
const isolatedInit = async context => {
  await context.route('**/peerjs.min.js', route => route.fulfill({ path: path.join(root, 'node_modules/peerjs/dist/peerjs.min.js') }));
  if (!productionSignaling) await context.route('**/api/turn', route => route.fulfill({ status: 404, body: '{}' }));
  if (!productionSignaling) await context.addInitScript(config => { window.__SEEMYGAME_PEER_CONFIG__ = config; }, signaling.config);
  await context.addInitScript(installTelemetry, { expectedSessionMagic: sessionMagic, enableOptical:opticalHz>0, opticalSampleHz:opticalHz||8, opticalReaderMode, opticalSourceWidth:sourceProfile.width });
  // Test fixture state in a fresh profile. No personal account/profile is used.
  await context.addInitScript(() => { localStorage.setItem('seemygame_terms_version', '1.1'); localStorage.setItem('seemygame_terms_accepted', 'true'); });
};
const join = async (page, url, name) => {
  // A second room URL differs only in its hash: force a document navigation so
  // a reused receiver cannot keep the previous room/session/signaling fixture.
  if (new URL(page.url()).pathname.endsWith('/room.html')) await page.goto(new URL('/lobby.html', url).href);
  await page.goto(url); await page.locator('#green-room-join-btn').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('#green-room-user-name').fill(name);
  await page.locator('#green-room-join-btn').click();
  await waitApp(page, async () => { const app = (await import('/js/diagnostics/session-api.js')).getActiveSession(); return app.roomManager?.isInRoom === true && typeof app.roomManager?.myPeerId === 'string'; });
};
try {
  await record('preflight', async () => {
    if (process.platform !== 'win32') throw new Error('Desktop E2E requer Windows/WebView2');
    if(senderMode==='native'){await stat(exe); report.executable = { path: exe, sha256: hash(await readFile(exe)) };}
    report.displayModes=await readDisplayModes();
    report.sourceHashes = Object.fromEntries(await Promise.all([...frontendFiles, ...await listRustFiles(root),'tools/e2e/run.mjs','tools/e2e/harness/stream-profile.mjs','tools/e2e/harness/no-preview.mjs','tools/e2e/harness/native-stage-evidence.mjs','tools/e2e/harness/stutter-cause.mjs','tools/e2e/harness/phase-validation.mjs','tools/e2e/telemetry/metrics.mjs','tools/e2e/harness/capture-geometry.mjs','tools/e2e/harness/capture-backend.mjs','tools/e2e/harness/browser-trace.mjs','tools/e2e/harness/forwarded-fixtures.mjs','tools/e2e/fixtures/motion.mjs','tools/e2e/fixtures/game-workload.mjs','tools/e2e/telemetry/installer.mjs','tools/e2e/harness/resources.mjs','tools/e2e/harness/resource-counters.cs','tools/e2e/harness/resource-counters.ps1','tools/e2e/harness/verdict.mjs','tools/e2e/harness/source-summary.mjs','tools/e2e/harness/clock-calibration.mjs','tools/e2e/harness/remote-viewer.mjs','tools/e2e/harness/ssh-reverse.mjs','tools/e2e/harness/displays.mjs','tools/e2e/harness/display-info.ps1'].map(async p => [p, hash(await readFile(path.join(root, p)))])));
    if(remoteViewerEndpoint){
      const metadata=await readViewerControl(remoteViewerEndpoint,'metadata');
      remoteViewer=prepareRemoteViewer(metadata,remoteViewerEndpoint,{localPlaywrightVersion:createRequire(import.meta.url)('playwright/package.json').version,localFingerprint:machineFingerprint(),wsPort:option('--viewer-ws-port',undefined),allowSameMachine:args.includes('--allow-same-machine-remote')});
      report.receiverConditions=remoteViewer.conditions;
      report.limitations=report.limitations.filter(s=>!s.startsWith('Transmitter, synthetic source and receiver share'));
      report.limitations.push(remoteViewer.conditions.sameMachine?'Remote-browser harness self-test on one physical machine; not a two-machine performance result':'Receiver runs on a machine with a different hostname/platform/CPU fingerprint; transmitter and synthetic source still share their machine');
      report.limitations.push(`${calibrateClocks?'Browser clock offset will be calibrated with bounded uncertainty; optical latency requires valid checkpoints':'Independent clocks: optical latency disabled'}. Receiver resource/quality windows use its own clock. HTTP/signaling use ${viewerSshHost?'explicit reverse SSH forwarding':'requested Playwright loopback forwarding (must be verified across hosts)'}; WebRTC media must establish its own ICE route.`);
      if(calibrateClocks)report.receiverConditions.clockPolicy='Browser clock offset calibration with before/during/after checkpoints; receiver resource windows remain in receiver clock; physical scanout not certified';
      if(remoteViewer.conditions.headless)report.limitations.push('Headless receiver: decode/network/callback cadence tested; physical display presentation is not certified.');
    }
  });
  if (args.includes('--check')) { report.status = 'preflight-only'; console.log('Preflight OK; no capture was started.'); }
  else {
    let localOrigin;
    report.signalingMode = productionSignaling ? 'production-public' : 'local-fixture';
    if (productionSignaling && viewerSshHost) throw new Error('Production signaling test does not support fixture SSH forwarding');
    if(viewerSshHost){
      const forwarded=await record('forward fixture and signaling to receiver loopback',()=>startForwardedFixtures({host:viewerSshHost,startAssets:()=>startAssetServer({root,fixtures:{'/e2e-motion.html':fixture}}),startSignaling:startSignalingServer}));
      server=forwarded.assets.server;signaling=forwarded.signaling;reverseTunnel=forwarded.tunnel;localOrigin=forwarded.assets.origin;report.forwardingAttempts=forwarded.attempts;
      report.receiverConditions.localServersTransport='explicit SSH reverse forwarding (HTTP/signaling only)';
    }else{localOrigin=await serve();signaling=await startSignalingServer();}
    const webOrigin = customWebOrigin || localOrigin;
    report.webOrigin = webOrigin;
    let nativeOrigin;
    if(senderMode==='native'){
    const port = desktopCdpPort || await freePort();
    let previousDesktopPages = new Set();
    if (desktopCdpPort) {
      if (remoteViewer?.connectionType !== 'cdp' || !remoteViewer.conditions.sameMachine) throw new Error('Shared profile requires a local CDP desktop receiver');
      nativeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      previousDesktopPages = new Set(nativeBrowser.contexts()[0].pages());
      if (previousDesktopPages.size !== 1) throw new Error('Shared profile test requires exactly one existing receiver WebView');
      const receiverPage = [...previousDesktopPages][0];
      const receiverCdp = await receiverPage.context().newCDPSession(receiverPage);
      sharedReceiverTargetId = (await receiverCdp.send('Target.getTargetInfo')).targetInfo.targetId;
      await receiverCdp.detach();
    }
    const desktopProfile = resolveDesktopTestProfile(root, desktopProfileOption, path.join(output, 'webview-profile'));
    await mkdir(desktopProfile, { recursive: true });
    report.desktopProfile = { path: desktopProfile, sharedCdp: Boolean(desktopCdpPort), nativeAudioMode };
    const env = {
      ...process.env,
      SEEMYGAME_NATIVE_CAPTURE_BACKEND: captureBackend,
      WEBVIEW2_USER_DATA_FOLDER: desktopProfile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required${experimentalHevcReceive?' --enable-features=WebRtcAllowH265Receive':''}`
    };
    if (desktopCdpPort) {
      // WebView2 requires identical browser arguments for a shared user-data folder.
      env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [...remoteViewer.conditions.browserArgs, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'].join(' ');
    }
    if (args.includes('--cold-gstreamer-registry')) {
      env.GST_REGISTRY_1_0 = path.join(output, 'gst-registry.bin');
      report.gstreamerRegistry = { mode: 'isolated-cold', path: env.GST_REGISTRY_1_0 };
    }
    const logPath = path.join(path.dirname(exe), 'native_debug.log');
    nativeLogSize = await stat(logPath).then(s => s.size).catch(() => 0);
    desktop = spawn(exe, [], { cwd: path.dirname(exe), env, windowsHide: false, stdio: 'ignore' });
    let spawnError; desktop.on('error', e => { spawnError = e; });
    await record('attach isolated WebView2', async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (desktop.exitCode !== null) throw new Error(`Desktop exited: ${desktop.exitCode}`);
        try { nativeBrowser ||= await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; } catch { await sleep(400); }
      }
      if (!nativeBrowser) throw new Error('WebView2 CDP indisponível; confira runtime e executável');
      const context = nativeBrowser.contexts()[0]; await isolatedInit(context);
      report.senderBrowserVersion=nativeBrowser.version();
      report.experimentalHevcReceive=experimentalHevcReceive;
      if (desktopCdpPort) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !hostPage) {
          hostPage = context.pages().find(page => !previousDesktopPages.has(page));
          if (!hostPage) await sleep(200);
        }
        if (!hostPage) throw new Error('Second desktop instance did not create a new WebView');
      } else hostPage = context.pages()[0] || await context.newPage();
      // The shipping CSP intentionally rejects arbitrary localhost signaling ports.
      // Scope the bypass to this isolated E2E WebView; do not relax application CSP.
      const cdp = await context.newCDPSession(hostPage);
      if (!productionSignaling) {
        await cdp.send('Page.setBypassCSP', { enabled: true });
        report.limitations.push('Isolated desktop page bypasses CSP to use ephemeral local signaling; shipping CSP is not validated by this run.');
      }
      watchErrors(hostPage, 'desktop');
      if (!hostPage.url() || hostPage.url() === 'about:blank') {
        await hostPage.waitForURL(u => u && u.href !== 'about:blank', { timeout: 15000 });
      }
      await hostPage.evaluate(async () => {
        const t = window.__TAURI__;
        if (t && await t.core?.invoke('is_always_on_top')) {
          await t.core?.invoke('toggle_always_on_top');
        }
      }).catch(() => {});
    });
    console.log('hostPage URL:', hostPage.url());
    nativeOrigin = new URL(hostPage.url()).origin;
    await record('check embedded frontend matches checkout', async () => {
      for (const p of frontendFiles) {
        const embedded = await hostPage.evaluate(async p => (await fetch('/' + p)).text(), p);
        if (!frontendSourceMatches(embedded,await readFile(path.join(root,p),'utf8'))) throw new Error(`Build desatualizado: ${p}. Execute npm run build:dist e cargo build --manifest-path src-tauri/Cargo.toml --locked --offline`);
      }
    });

    }else{
      nativeBrowser=await chromium.launch({channel,headless:false,args:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-features=CalculateNativeWinOcclusion','--autoplay-policy=no-user-gesture-required','--window-position=80,80','--window-size=1280,800',`--auto-select-desktop-capture-source=${syntheticTitle}`,'--enable-usermedia-screen-capturing','--allow-http-screen-capture',...(exerciseVoice?['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']:[])]});
      const senderContext=await nativeBrowser.newContext();await senderContext.grantPermissions(['camera','microphone']);await isolatedInit(senderContext);
      hostPage=await senderContext.newPage();watchErrors(hostPage,'desktop');nativeOrigin=localOrigin;
      report.senderBrowserVersion=nativeBrowser.version();
    }
    let sourceWindowPos = '50,50';
    let viewerWindowPos = '600,100';
    try {
      const stdout = execSync('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Select-Object -ExpandProperty Bounds | Select-Object -ExpandProperty X"', { timeout: 4000 }).toString();
      const xs = stdout.trim().split(/\r?\n/).map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
      if (xs.some(x => x < 0)) {
        sourceWindowPos = '-1900,50';
        viewerWindowPos = '50,50';
      }
    } catch {}
    sourceWindowPos=validateWindowPosition(option('--source-position',sourceWindowPos));
    viewerWindowPos=validateWindowPosition(option('--viewer-position',viewerWindowPos));
    report.windowPositions={source:sourceWindowPos,viewer:viewerWindowPos};

    sourceBrowser = await chromium.launch({
      channel,
      headless: false,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        `--window-position=${sourceWindowPos}`,
        `--window-size=${sourceProfile.width},${sourceProfile.height}`
      ],
      timeout: 30000
    });
    const sourceContext = await sourceBrowser.newContext({ viewport: matchedResolution?null:{ width: sourceProfile.width, height: sourceProfile.height } });
    const source = (await sourceContext.pages())[0] || await sourceContext.newPage();
    report.sourceLifecycle = [];
    const sourceEvent = event => report.sourceLifecycle.push({event, at:Date.now(), duringCleanup:report.status!=='running'});
    source.on('close',()=>sourceEvent('page-close'));
    source.on('crash',()=>sourceEvent('page-crash'));
    sourceBrowser.on('disconnected',()=>sourceEvent('browser-disconnected'));
    if (source.url() !== `${localOrigin}/e2e-motion.html`) {
      await source.goto(`${localOrigin}/e2e-motion.html`);
    }
    await source.bringToFront();
    if(matchedResolution){
      report.captureGeometry=await record('calibrate actual window capture dimensions',()=>calibrateCaptureWindow({source,title:syntheticTitle,width:sourceProfile.width,height:sourceProfile.height,root,channel}));
      // Keep the entire synthetic scene visible within the calibrated client area.
      await source.evaluate(()=>{document.querySelectorAll('canvas').forEach(c=>{c.style.width='100vw';c.style.height='100vh';});});
    }
    viewerBrowser = remoteViewer ? (remoteViewer.connectionType==='cdp'?await chromium.connectOverCDP(remoteViewer.wsEndpoint,{timeout:30000}):await chromium.connect(remoteViewer.wsEndpoint,{...(viewerSshHost?{}:{exposeNetwork:'<loopback>'}),timeout:30000})) : await chromium.launch({
      channel,
      headless: false,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        '--autoplay-policy=no-user-gesture-required',
        `--window-position=${viewerWindowPos}`,
        '--window-size=1280,720',
        `--auto-select-desktop-capture-source=${syntheticTitle}`,
        '--enable-usermedia-screen-capturing',
        '--allow-http-screen-capture',
        ...(exerciseVoice ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [])
      ],
      timeout: 30000
    });
    report.receiverBrowserVersion=viewerBrowser.version();
    viewerContext = remoteViewer?.connectionType==='cdp'?viewerBrowser.contexts()[0]:await viewerBrowser.newContext();
    if(remoteViewer?.connectionType!=='cdp')await viewerContext.grantPermissions(['camera', 'microphone']);
    await isolatedInit(viewerContext);
    viewerPage = remoteViewer?.connectionType==='cdp'?(viewerContext.pages()[0]||await viewerContext.newPage()):await viewerContext.newPage();
    if (sharedReceiverTargetId) {
      viewerPage = null;
      for (const candidate of viewerContext.pages()) {
        const cdp = await viewerContext.newCDPSession(candidate);
        const targetId = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
        await cdp.detach();
        if (targetId === sharedReceiverTargetId) { viewerPage = candidate; break; }
      }
      if (!viewerPage) throw new Error('Original receiver WebView was lost');
    }
    if(receiverViewport)await record('set equal receiver viewport',async()=>{
      await viewerPage.setViewportSize({width:receiverViewport[0],height:receiverViewport[1]});
      const actual=await viewerPage.evaluate(()=>({width:innerWidth,height:innerHeight}));
      if(actual.width!==receiverViewport[0]||actual.height!==receiverViewport[1])throw new Error('Receiver viewport was not applied');
      report.receiverViewport={requested:{width:receiverViewport[0],height:receiverViewport[1]},actual};
    });
    let receiverOrigin=webOrigin;
    if(remoteViewer?.connectionType==='cdp'&&remoteViewer.conditions.runtime==='tauri'){
      await viewerPage.waitForURL(u=>u.href!=='about:blank',{timeout:15000});receiverOrigin=new URL(viewerPage.url()).origin;
      const cdp=await viewerContext.newCDPSession(viewerPage);if(!productionSignaling)await cdp.send('Page.setBypassCSP',{enabled:true});
      await record('check receiver embedded frontend matches checkout',async()=>{
        for(const p of frontendFiles){const embedded=await viewerPage.evaluate(async p=>(await fetch('/'+p)).text(),p);if(!frontendSourceMatches(embedded,await readFile(path.join(root,p),'utf8')))throw new Error('Receiver build desatualizado: '+p);}
      });
      if(!productionSignaling)report.limitations.push('Isolated receiver WebView2 bypasses CSP for ephemeral test signaling; shipping CSP is not validated.');
    }
    watchErrors(viewerPage, 'web');
    const room = `e2e-${randomBytes(6).toString('hex')}`, key = randomBytes(16).toString('hex');
    const fragment = `#room=${room}&key=${key}`;
    await record('local sender joins room', () => join(hostPage, `${nativeOrigin}/room.html${fragment}`, senderMode==='native'?'E2E Desktop Sender':'E2E Web Sender'));
    await record('remote receiver joins same room', () => join(viewerPage, `${receiverOrigin}/room.html${fragment}`, remoteViewer?.conditions.runtime==='tauri'?'E2E Desktop Receiver':'E2E Web Receiver'));
    await viewerPage.evaluate(async enabled => {
      (await import('/js/entries/room-entry.js')).roomState.features.clipping.recorder.setPreferences({ enabled, recordLocal: false });
    }, viewerReplay);
    await record('verify mutual authenticated membership', async () => {
      await waitApp(hostPage, async () => (await import('/js/diagnostics/session-api.js')).getActiveSession().roomManager?.myPeerId != null);
      await waitApp(viewerPage, async () => (await import('/js/diagnostics/session-api.js')).getActiveSession().roomManager?.myPeerId != null);
      hostId = await hostPage.evaluate(async () => (await import('/js/diagnostics/session-api.js')).getActiveSession().roomManager?.myPeerId);
      viewerId = await viewerPage.evaluate(async () => (await import('/js/diagnostics/session-api.js')).getActiveSession().roomManager?.myPeerId);
      if (!hostId || !viewerId || hostId === viewerId) throw new Error('Identidades dos clientes inválidas');
      for (const [page, expected] of [[hostPage, viewerId], [viewerPage, hostId]]) await waitApp(page, async id => { const r = (await import('/js/diagnostics/session-api.js')).getActiveSession().roomManager; return r?.members.has(id) && r.isPeerAuthorized(id); }, expected);
    });
    report.senderWindowLayout=await hostPage.evaluate(()=>({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,visibility:document.visibilityState,hasFocus:document.hasFocus()}));
    try{
      const gpuSession=await nativeBrowser.newBrowserCDPSession();
      const info=await gpuSession.send('SystemInfo.getInfo');
      report.senderGpuEnvironment={devices:info.gpu.devices.map(d=>({vendorId:d.vendorId,deviceId:d.deviceId,vendorString:d.vendorString,deviceString:d.deviceString})),glRenderer:info.gpu.auxAttributes?.glRenderer,glVendor:info.gpu.auxAttributes?.glVendor};
      await gpuSession.detach();
    }catch(error){report.senderGpuEnvironment={available:false,reason:error.message};}
    if (exerciseVoice) {
      report.limitations.push('Voice controls use fake microphone devices; actual WebRTC audio tracks and remote output gains are asserted, physical audio hardware is not tested.');
      report.voiceControls = await record('verify microphone, deafen, drawer and quick controls on both endpoints', () => exerciseVoiceControls([hostPage, viewerPage]));
    }
    const averageOf = (arr, fn) => {
      const vals = arr.map(fn).filter(n => Number.isFinite(n) && n !== null);
      return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null;
    };

    const sampleAndAnalyze = async ({ label, streamerSide, receiverSide, streamerPage, receiverPage, targetPeerId, durationSec, isNative = false }) => {
      const receiverLayout=await receiverPage.evaluate(id=>{
        const v=document.getElementById(`card-${id}`)?.querySelector('video'),rect=v?.getBoundingClientRect();
        return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},screen:{width:screen.width,height:screen.height,x:screenX,y:screenY},videoRect:rect?{width:rect.width,height:rect.height}:null,visibility:document.visibilityState,userAgent:navigator.userAgent};
      },targetPeerId);
      let receiverTrace=null,frameEvidence=null,senderTrace=null,senderFrameEvidence=null,traceTrigger=null,traceClockCalibration=null;
      if(receiverFrameEvidence)await installFrameEvidence(receiverPage);
      if(traceSender){await installFrameEvidence(streamerPage);traceClockCalibration=await calibrateBrowserClocks(streamerPage,receiverPage,{samples:7,maxErrorMs:20});}
      const endTraces=async()=>{receiverTrace=await activeReceiverTrace.stop({deferRead:true});pendingReceiverTrace=activeReceiverTrace;activeReceiverTrace=null;if(activeSenderTrace){senderTrace=await activeSenderTrace.stop({deferRead:true});pendingSenderTrace=activeSenderTrace;activeSenderTrace=null;}};
      let clockCalibration=null;
      if(calibrateClocks){
        const before=await record(`${label} calibrate browser clocks`,()=>bounded('clock calibration',()=>calibrateBrowserClocksReliably(source,receiverPage,{maxErrorMs:clockMaxErrorMs})));
        clockCalibration={before,checkpoints:[],after:null,validation:null};
        (report.clockCalibrations??={})[label]=clockCalibration;
        await checkpoint();
        if(before.status!=='valid')throw new Error(`Clock calibration ${before.status}: uncertainty ${before.uncertaintyMs} ms; allowed ${clockMaxErrorMs} ms`);
        await receiverPage.evaluate(calibration=>{
          window.__smgClockCalibration=calibration;
          document.querySelectorAll('video').forEach(v=>v.__smgPresentation?.resetSession());
        },{status:before.status,offsetMs:before.offsetMs,uncertaintyMs:before.uncertaintyMs});
        console.log(`Clock offset ${before.offsetMs.toFixed(2)} ms, uncertainty +/-${before.uncertaintyMs.toFixed(2)} ms`);
      }
      const startIndex = report.measurements.length;
      const videoTimes = [];
      const timeline = [];
      // Retain observations even when a functional gate aborts the phase.
      previousNativeSample=null;
      report.partialPhase={label,isNative,videoTimes,timeline};
      const measurementStartedAt = Date.now();
      let steadyStartedAt = null, steadyEndedAt = null, receiverSteadyStart = null, receiverSteadyEnd = null;

      for (let i = 0; i < durationSec; i++) {
        if(receiverTraceSeconds&&i===6){activeReceiverTrace=await startBrowserTrace(viewerBrowser,receiverPage,{label,file:path.join(output,label+'-receiver-trace.json'),ringBufferKb:receiverTraceTriggerMs?8192:0});if(traceSender)activeSenderTrace=await startBrowserTrace(nativeBrowser,streamerPage,{label:label+'-sender',file:path.join(output,label+'-sender-trace.json'),ringBufferKb:receiverTraceTriggerMs?8192:0});}
        if(activeReceiverTrace&&(!receiverTraceTriggerMs&&i===6+receiverTraceSeconds||receiverTraceTriggerMs&&i===durationSec-3))await endTraces();
        if(clockCalibration&&i>0&&i%15===0){
          clockCalibration.checkpoints.push(await bounded('clock checkpoint',()=>calibrateBrowserClocksReliably(source,receiverPage,{maxErrorMs:clockMaxErrorMs})));
        }
        if(source.isClosed()||!sourceBrowser.isConnected()||report.sourceLifecycle.some(e=>e.event==='page-crash')) {
          await checkpoint();
          throw new Error(`${label}: janela sintética fechou ou falhou; medição invalidada (sourceLifecycle/partialPhase)`);
        }
        const currentPhase = i < 5 ? 'warmup' : (i < durationSec - 2 ? 'steady' : 'cooldown');
        if(currentPhase==='steady'&&steadyStartedAt===null){steadyStartedAt=Date.now();receiverSteadyStart=await receiverPage.evaluate(()=>({perf:performance.now(),epoch:Date.now()}));}
        if(currentPhase==='cooldown'&&steadyEndedAt===null){steadyEndedAt=Date.now();receiverSteadyEnd=await receiverPage.evaluate(()=>({perf:performance.now(),epoch:Date.now()}));}
        await bounded(`${label} stream telemetry`, sampleBoth);
        const receiverVid = await receiverPage.evaluate(({ id, phase }) => {
          const v = document.getElementById(`card-${id}`)?.querySelector('video');
          if (v?.__smgPresentation?.setPhase) {
            v.__smgPresentation.setPhase(phase);
          }
          return v && !v.paused && v.readyState >= 2 ? {
            epoch:Date.now(),perf:performance.now(),
            currentTime: v.currentTime,
            presentation: v.__smgPresentation?.getStats({ reset: true })
          } : null;
        }, { id: targetPeerId, phase: currentPhase }).catch(() => null);

        videoTimes.push(receiverVid?.currentTime ?? null);

        const recentStreamer = report.measurements.filter(m => m.side === streamerSide).slice(-1)[0];
        const recentReceiver = report.measurements.filter(m => m.side === receiverSide).slice(-1)[0];

        // Resolução estrita: seleciona conexões conectadas com tráfego real de vídeo (D03)
        const bridgeInbound = isNative ? (recentStreamer?.rows?.find(r =>
          r.kind === 'video' && r.type === 'inbound-rtp' && r.connectionState === 'connected' &&
          (r.framesDecoded > 0 || r.bytesReceived > 0)
        ) || recentStreamer?.rows?.find(r => r.kind === 'video' && r.type === 'inbound-rtp')) : null;

        const outbound = recentStreamer?.rows?.find(r =>
          r.kind === 'video' && r.type === 'outbound-rtp' && r.connectionState === 'connected' &&
          (r.framesEncoded > 0 || r.bytesSent > 0)
        ) || recentStreamer?.rows?.find(r => r.kind === 'video' && r.type === 'outbound-rtp' && r.connectionState === 'connected') || null;

        const remoteInbound = recentReceiver?.rows?.find(r =>
          r.kind === 'video' && r.type === 'inbound-rtp' && r.connectionState === 'connected' &&
          (r.framesDecoded > 0 || r.bytesReceived > 0)
        ) || recentReceiver?.rows?.find(r => r.kind === 'video' && r.type === 'inbound-rtp' && r.connectionState === 'connected') || null;

        const presentation = receiverVid?.presentation;

        timeline.push({
          receiverSampleEpoch:receiverVid?.epoch??null,receiverSamplePerf:receiverVid?.perf??null,
          second: i + 1,
          phase: i < 5 ? 'warmup' : (i < durationSec - 2 ? 'steady' : 'cooldown'),
          source: {
            fps: recentStreamer?.sourceStats?.fps ?? null,
            rafFps: recentStreamer?.sourceStats?.rafFps ?? null,
            framesProduced: recentStreamer?.sourceStats?.framesProduced ?? null,
            workload: recentStreamer?.sourceStats?.workload ?? null
          },
          nativeStages:recentStreamer?.nativeStages??null,
          bridge: {
            decodedFps: bridgeInbound?.delta?.decodedFps ?? null,
            decodeTimeMs: bridgeInbound?.delta?.decodeTimeMs ?? null,
            jitterBufferMs: bridgeInbound?.delta?.jitterBufferMs ?? null,
            observableLatencyMs: bridgeInbound?.delta?.bridgeObservableMs ?? null,
            packetsLost: bridgeInbound?.packetsLost ?? 0
          },
          outbound: {
            sentFps: outbound?.framesPerSecond ?? outbound?.delta?.decodedFps ?? null,
            encodeTimeMs: outbound?.delta?.encodeTimeMs ?? null,
            sentMbps: outbound?.delta?.sentMbps ?? null,
            limitation: outbound?.qualityLimitationReason ?? 'none',
            encoderImplementation: outbound?.encoderImplementation ?? null
          },
          webInbound: {
            width: remoteInbound?.frameWidth ?? null,
            height: remoteInbound?.frameHeight ?? null,
            decodedFps: remoteInbound?.delta?.decodedFps ?? null,
            decodeTimeMs: remoteInbound?.delta?.decodeTimeMs ?? null,
            jitterBufferMs: remoteInbound?.delta?.jitterBufferMs ?? null,
            jitterBufferTargetMs:remoteInbound?.delta?.jitterBufferTargetMs??null,
            jitterBufferMinimumMs:remoteInbound?.delta?.jitterBufferMinimumMs??null,
            requestedJitterBufferTargetMs:recentReceiver?.receivers?.find(r=>r.kind==='video'&&r.pcId===remoteInbound?.pcId)?.jitterBufferTarget??null,
            retransmittedPacketsReceivedDelta:remoteInbound?.delta?.rawDeltaRetransmittedPacketsReceived??null,
            freezesDelta:remoteInbound?.delta?.rawDeltaFreezeCount??null,
            packetsLost: remoteInbound?.packetsLost ?? 0,
            packetsLostDelta:remoteInbound?.delta?.rawDeltaPacketsLost??null,
            nackDelta:remoteInbound?.delta?.rawDeltaNackCount??null,
            pliDelta:remoteInbound?.delta?.rawDeltaPliCount??null,
            decoderImplementation: remoteInbound?.decoderImplementation ?? null
          },
          presentation: {
            presentedFrames: presentation?.presentedFrames ?? null,
            duplicateFrames: presentation?.duplicateFrames ?? null,
            intervalMaxPauseMs: presentation?.intervalMaxPauseMs ?? 0,
            intervalCallbackMaxGapMs:presentation?.intervalCallbackMaxGapMs??null,
            callbackSilenceMs:presentation?.callbackSilenceMs??null,
            intervalSkippedCallbackSpans:presentation?.intervalSkippedCallbackSpans??null,
            intervalConsecutiveFrameIntervals:presentation?.intervalConsecutiveFrameIntervals??null,
            pauseEvidence:presentation?.pauseEvidence??'unavailable',
            gapsCount: presentation?.gapsCount ?? 0,
            validSamplesCount: presentation?.validSamplesCount ?? 0,
            rejectedCandidatesCount: presentation?.rejectedCandidatesCount ?? 0,
            overheadP50Ms: presentation?.instrumentationOverheadMs?.p50 ?? null,
            latencyP50: presentation?.latency?.recentP50 ?? presentation?.latency?.p50 ?? null
          },
          system: {
            freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
            totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
            resourceSampleTimestamp:resources.latest()?.timestamp??null,
            resourceSampleAgeMs:resources.latest()?Date.now()-resources.latest().timestamp:null,
            cpu:resources.latest()?.cpu??null,
            gpuBusiestEnginePercent:resources.latest()?.gpu?.busiestEnginePercent??null,
            processGroups:resources.latest()?.processGroups??null
          }
        });

        const observedPause=Math.max(presentation?.intervalMaxPauseMs??0,presentation?.intervalCallbackMaxGapMs??0);
        if(receiverTraceTriggerMs&&activeReceiverTrace&&currentPhase==='steady'&&observedPause>=receiverTraceTriggerMs){
          traceTrigger={second:i+1,pauseMs:observedPause,pauseEvidence:presentation.intervalMaxPauseMs>=receiverTraceTriggerMs?'consecutive-frame-metadata':'callback-gap-only',receiverPerf:receiverVid.perf,receiverEpoch:receiverVid.epoch};
          await receiverPage.evaluate(detail=>performance.mark('smg-trace-trigger',{detail}),traceTrigger);await endTraces();
        }
        await checkpoint();
        await sleep(1000);
      }

      if(clockCalibration){
        clockCalibration.after=await bounded('final clock calibration',()=>calibrateBrowserClocksReliably(source,receiverPage,{maxErrorMs:clockMaxErrorMs}));
        clockCalibration.validation=validateClockCheckpoints(clockCalibration.before,[...clockCalibration.checkpoints,clockCalibration.after],{maxErrorMs:clockMaxErrorMs});
        await checkpoint();
      }
      const decoded = report.measurements.slice(startIndex).filter(s => s.side === receiverSide).flatMap(s => s.rows).filter(r => r.kind === 'video' && r.type === 'inbound-rtp');
      const progressing = videoTimes.slice(1).filter((t, i) => t !== null && videoTimes[i] !== null && t > videoTimes[i]).length;
      if (progressing < Math.ceil((videoTimes.length - 1) * 0.7)) {
        throw new Error(`${label}: vídeo não progrediu satisfatoriamente nos intervalos de teste`);
      }
      const fps = decoded.map(r => r.delta?.decodedFps).filter(Number.isFinite).sort((a, b) => a - b);
      if (!fps.length || !fps.some(n => n > 0)) {
        throw new Error(`${label}: nenhum progresso de frames decodificados no receptor`);
      }

      const finalPresentation = await receiverPage.evaluate(id => {
        const v = document.getElementById(`card-${id}`)?.querySelector('video');
        return v?.__smgPresentation?.getStats() || null;
      }, targetPeerId).catch(() => null);

      const activeSourcePage = sourceBrowser && sourceBrowser.contexts().length > 0 && sourceBrowser.contexts()[0].pages()[0];
      if (activeSourcePage && !activeSourcePage.isClosed()) {
        const fresh = await activeSourcePage.evaluate(() => window.__smgSourceStats).catch(() => null);
        if (fresh) sourceStats = fresh;
      }
      const sourceEvidenceFile = `${label.replace(/[^a-z0-9]/gi, '-')}-source.json`;
      // Save the full provenance once, outside the hot measurement loop.
      await writeFile(path.join(output,sourceEvidenceFile),JSON.stringify(sourceStats));

      // Isolamento de fases: métricas de performance calculadas exclusivamente no steady state
      const steadyTimeline = timeline.filter(t => t.phase === 'steady');
      const steadyFps = steadyTimeline.map(t => t.webInbound.decodedFps).filter(Number.isFinite).sort((a, b) => a - b);

      const perf = {
        totalSamples: fps.length,
        steadySamples: steadyFps.length,
        medianDecodedFps: steadyFps.length ? steadyFps[Math.floor(steadyFps.length / 2)] : (fps.length ? fps[Math.floor(fps.length / 2)] : null),
        p10DecodedFps: steadyFps.length ? steadyFps[Math.floor((steadyFps.length - 1) * 0.1)] : (fps.length ? fps[Math.floor((fps.length - 1) * 0.1)] : null),
        minFps,
        videoTimes,
        presentation: finalPresentation
      };

      // Validação rigorosa de proveniência óptica (D02)
      const sourceLog = sourceStats?.frameLog || [];
      const sourceSeqMap = new Map(sourceLog.map(f => [f.seq, f.timeMs]));
      const lastDecodedSeq = finalPresentation?.lastSeq;
      const recentDecodedSeqs = finalPresentation?.recentSeqs?.length ? finalPresentation.recentSeqs : (lastDecodedSeq != null && lastDecodedSeq > 0 ? [lastDecodedSeq] : []);
      const isProvenanceValid = recentDecodedSeqs.some(s => sourceSeqMap.has(s));
      const validSamples = finalPresentation?.validSamplesCount || 0;
      const clockValid=!clockCalibration||clockCalibration.validation?.status==='valid';
      const measurementValid = opticalHz>0 ? validSamples >= 5 && isProvenanceValid && clockValid : null;

      let glassToGlassLatency = null;
      // Prioridade metodológica estrita: steadyLatency isola o regime permanente sem contaminação do warmup
      const steadyLat = finalPresentation?.steadyLatency;
      const targetLatency = (steadyLat && steadyLat.samplesCount >= 3) ? steadyLat : finalPresentation?.latency;

      if (measurementValid && targetLatency?.p50 !== null && targetLatency?.p50 !== undefined) {
        glassToGlassLatency = {
          phase: (steadyLat && steadyLat.samplesCount >= 3) ? 'steady' : 'total',
          p50Ms: targetLatency.p50,
          p90Ms: targetLatency.p90,
          p99Ms: targetLatency.p99,
          minMs: targetLatency.min,
          maxMs: targetLatency.max,
          clockUncertaintyMs: clockCalibration?.validation?.uncertaintyMs ?? null,
          p50ClockBoundsMs: clockCalibration ? {
            lower: targetLatency.p50-clockCalibration.validation.uncertaintyMs,
            upper: targetLatency.p50+clockCalibration.validation.uncertaintyMs
          } : null,
          measurementScope: 'source marker draw timestamp to expected compositor presentation; physical panel scanout not measured',
          validSamplesCount: (steadyLat && steadyLat.samplesCount >= 3) ? steadyLat.samplesCount : validSamples
        };
      }

      const stutters = [];
      for (const entry of steadyTimeline) {
        const isPause = entry.presentation.intervalMaxPauseMs > 150;
        const isCallbackGap = entry.presentation.intervalCallbackMaxGapMs > 150;
        const isFpsDrop = isSevereCadenceDrop(entry.webInbound.decodedFps,streamProfile.fps);
        if (isPause || isCallbackGap || isFpsDrop || entry.webInbound.freezesDelta > 0) {
          const {suspectedCause,confidence}=classifyStutter(entry,isNative,{targetFps:streamProfile.fps,sourceFps:sourceProfile.fps});
          stutters.push({
            second: entry.second,
            pauseMs: entry.presentation.intervalMaxPauseMs,
            callbackGapMs:entry.presentation.intervalCallbackMaxGapMs,
            pauseEvidence:isPause?'consecutive-frame-metadata':entry.webInbound.freezesDelta>0?'rtc-freeze-counter':isCallbackGap?'callback-gap-only':'decode-cadence-drop',
            workerFps:entry.nativeStages?.worker?.fps??null,
            workerLifetimeMaxPauseMs:entry.nativeStages?.worker?.lifetimeMaxPauseMs??null,
            decodedFps: entry.webInbound.decodedFps,
            suspectedCause,
            confidence
          });
        }
      }

      const diagnostics = {
        steadyDurationSec: steadyTimeline.length,
        stuttersDetected: stutters.length,
        metadataPauseEvents:stutters.filter(s=>s.pauseEvidence==='consecutive-frame-metadata').length,
        callbackOnlyEvents:stutters.filter(s=>s.pauseEvidence==='callback-gap-only').length,
        stutterEvents: stutters,
        measurementValid,
        measurementReason: opticalHz===0 ? 'Medição óptica desativada; latência visual não avaliada' : !clockValid ? 'Calibração dos relógios inválida; latência não qualificada' : measurementValid ? 'Proveniência óptica e CRC-16 validados; calibração verificada quando remota' : 'Leituras ópticas insuficientes ou sequência ausente no log da fonte',
        provenance: {
          isProvenanceValid,
          lastDecodedSeq,
          validSamplesCount: validSamples,
          rejectedCandidatesCount: finalPresentation?.rejectedCandidatesCount || 0
        }
      };

      const startupDynamics = finalPresentation?.startupDynamics || null;
      const warmupLatency = finalPresentation?.warmupLatency || null;
      const cooldownLatency = finalPresentation?.cooldownLatency || null;
      const readProductionDiagnostic = page => page.evaluate(async () => {
        const runtime = (await import('/js/entries/room-entry.js')).roomState;
        const diagnostic=runtime.session?.services?.statsScope?.exportDiagnostic();
        return diagnostic ? {...diagnostic,clockTimeOrigin:performance.timeOrigin} : null;
      }).catch(() => null);
      const receiverDiagnostic = await readProductionDiagnostic(receiverPage);
      const senderDiagnostic = await readProductionDiagnostic(streamerPage);
      const qualitySamples=(receiverDiagnostic?.streams||[]).flatMap(s=>s.samples).filter(s=>s.timestamp>=(receiverSteadyStart?.perf??Infinity)&&s.timestamp<=(receiverSteadyEnd?.perf??Infinity));
      const qualification=assessQuality(qualitySamples,{...streamProfile,codec:requestedCodec});
      await writeFile(path.join(output, `${label.replace(/[^a-z0-9]/gi, '-')}-diagnostic.json`), JSON.stringify({ receiver: receiverDiagnostic, sender: senderDiagnostic }, null, 2));
      let receiverResources=null;
      if(remoteViewer&&receiverPage===viewerPage){
        const remoteResources=await readViewerControl(remoteViewerEndpoint,'resources');
        const samples=resourceWindow(remoteResources,receiverSteadyStart?.epoch??Infinity,receiverSteadyEnd?.epoch??Infinity);
        receiverResources={metadata:remoteResources.metadata,clock:'receiver-epoch',summary:summarizeResources(samples),samples};
        await writeFile(path.join(output,`${label}-receiver-resources.json`),JSON.stringify(receiverResources,null,2));
      }

      const {resolutionValidation,codecValidation,validationErrors}=inspectPhaseConditions({timeline,qualitySamples,width:QUALITY_PROFILES[preset].width,height:QUALITY_PROFILES[preset].height,codec:requestedCodec,matchedResolution,matchedCodec});
      const samplingGaps=timeline.slice(1).flatMap((t,i)=>Number.isFinite(t.receiverSamplePerf)&&Number.isFinite(timeline[i].receiverSamplePerf)?[t.receiverSamplePerf-timeline[i].receiverSamplePerf]:[]);
      const samplingEvidence={maxGapMs:samplingGaps.length?Math.max(...samplingGaps):null,gapsOver2Seconds:samplingGaps.filter(g=>g>2000).length,scope:'E2E telemetry sampling gaps; independent of video presentation gaps'};
      if(receiverFrameEvidence){frameEvidence=await receiverPage.evaluate(()=>window.__smgFrameEvidence.finish());await writeFile(path.join(output,label+'-receiver-frame-evidence.json'),JSON.stringify(frameEvidence,null,2));}
      if(traceSender){senderFrameEvidence=await streamerPage.evaluate(()=>window.__smgFrameEvidence.finish());await writeFile(path.join(output,label+'-sender-frame-evidence.json'),JSON.stringify(senderFrameEvidence,null,2));}
      // Transfer the large trace over SSH only after metric/resource/frame windows close.
      if(receiverTrace?.pending){receiverTrace=await receiverTrace.collect();pendingReceiverTrace=null;}
      if(senderTrace?.pending){senderTrace=await senderTrace.collect();pendingSenderTrace=null;}
      delete report.partialPhase;
      return {
        receiverLayout,
        samplingEvidence,
        traceTrigger,traceClockCalibration,
        senderTrace:senderTrace?{file:senderTrace.file,start:senderTrace.start,end:senderTrace.end,bytes:senderTrace.bytes,dataLossOccurred:senderTrace.dataLossOccurred,ringBufferKb:senderTrace.ringBufferKb}:null,
        senderFrameEvidenceFile:senderFrameEvidence?path.join(output,label+'-sender-frame-evidence.json'):null,
        receiverTrace:receiverTrace?{file:receiverTrace.file,start:receiverTrace.start,end:receiverTrace.end,bytes:receiverTrace.bytes,dataLossOccurred:receiverTrace.dataLossOccurred}:null,
        receiverFrameEvidenceFile:frameEvidence?path.join(output,label+'-receiver-frame-evidence.json'):null,
        resolutionValidation,
        codecValidation,
        validationErrors,
        steadyWindow:{senderStart:steadyStartedAt,senderEnd:steadyEndedAt,receiverStart:receiverSteadyStart,receiverEnd:receiverSteadyEnd},
        sourceEvidenceFile,
        receiverResources,
        qualification,
        resources:resources.window(steadyStartedAt??measurementStartedAt,steadyEndedAt??Date.now()),
        deliveredResolutions: [...new Set(steadyTimeline.map(t => t.webInbound.width && t.webInbound.height
          ? `${t.webInbound.width}x${t.webInbound.height}` : null).filter(Boolean))],
        productionDiagnostic: { receiver: receiverDiagnostic, sender: senderDiagnostic },
        timeline,
        performance: perf,
        clockCalibration,
        glassToGlassLatency,
        startupDynamics,
        warmupLatency,
        cooldownLatency,
        diagnostics
      };
    };

    const cleanStageAndCards = async () => {
      await hostPage.evaluate(async () => {
        const ui = await import('/js/ui.js');
        document.querySelectorAll('.video-card').forEach(card => {
          const id = card.id?.replace(/^card-/, '');
          if (id) {
            ui.removeVideoCard?.(id);
          }
        });
        ui.removeVideoCard?.('local-me');
      }).catch(() => {});
      await viewerPage.evaluate(async () => {
        const ui = await import('/js/ui.js');
        document.querySelectorAll('.video-card').forEach(card => {
          const id = card.id?.replace(/^card-/, '');
          if (id) {
            ui.removeVideoCard?.(id);
          }
        });
        ui.removeVideoCard?.('local-me');
      }).catch(() => {});
      await sleep(1000);
    };

    const executeNativePhase = async () => {
      console.log(`\n--- Executando Fase: Captura Nativa (${captureBackend} / WGC) ---`);
      if(testProfiles.override)report.nativeTestStreamProfile=await hostPage.evaluate(installTestStreamProfile,{preset,profile:streamProfile,web:false});
      if(nativeWithoutPreview){
        await hostPage.evaluate(installNativeWithoutPreview);
        await viewerPage.evaluate(installNativeReceiverPayloads,{codec:requestedCodec});
        report.nativeWithoutPreview=true;
        report.limitations.push('Diagnostic adapter bypasses local WebView2 preview and its codec fallback, and normalizes the receiver offer to the requested codec with video payload types 96..127. Real native worker sends encoded RTP directly to the remote receiver; all compared codecs must use this same adapter. Not a production preview/compatibility benchmark.');
      }
      await hostPage.evaluate(async enabled => {
        (await import('/js/entries/room-entry.js')).roomState.features.clipping.recorder.setPreferences({ enabled, recordLocal: enabled });
      }, nativeReplay);
      await record('select native synthetic window and transmit', async () => {
        const readCapabilities=async()=>({send:RTCRtpSender.getCapabilities('video'),receive:RTCRtpReceiver.getCapabilities('video')});
        report.codecCapabilities={host:await hostPage.evaluate(readCapabilities),viewer:await viewerPage.evaluate(readCapabilities)};
        await hostPage.locator('#audio-mode-select').selectOption(nativeAudioMode, { force: true });
        await hostPage.locator('#quality-preset').selectOption(preset, { force: true });
        report.selectedNativePreset=await hostPage.locator('#quality-preset').inputValue();
        if(report.selectedNativePreset!==preset)throw new Error('Native quality preset was not applied');
        await hostPage.locator('#video-codec-select').selectOption(requestedCodec, { force: true });
        if (await hostPage.locator('#capture-backend-select').count()) await hostPage.locator('#capture-backend-select').selectOption(captureBackend, { force: true });
        await hostPage.locator('#h264-encoder-select').selectOption(encoder,{force:true});
        await hostPage.locator('#bitrate-slider').evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},bitrateKbps);
        await hostPage.locator('#dock-stream-btn').click({ force: true });
        await hostPage.locator('.window-item').first().waitFor({ state: 'visible', timeout: 45000 });

        let targetWindow = hostPage.locator('.window-item').filter({ hasText: syntheticTitle }).first();
        let hasTarget = (await targetWindow.count().catch(() => 0)) > 0;
        if (!hasTarget) {
          const availableItems = await hostPage.locator('.window-item .window-title').allInnerTexts().catch(() => []);
          throw new Error(`Janela sintética "${syntheticTitle}" não foi encontrada no seletor nativo. Janelas listadas: ${JSON.stringify(availableItems)}`);
        }
        console.log(`Picker selecionando janela sintética dedicada: ${syntheticTitle}`);
        await source.bringToFront().catch(() => {});
        await source.evaluate(() => window.focus()).catch(() => {});
        await sleep(400);
        await targetWindow.click();
        await source.bringToFront().catch(() => {});
        await source.evaluate(() => window.focus()).catch(() => {});

        const deadline = Date.now() + 45000;
        let ready = false;
        while (Date.now() < deadline) {
          ready = await viewerPage.evaluate(id => {
            const unmuteBtn = document.querySelector('.audio-unmute-overlay button');
            if (unmuteBtn) unmuteBtn.click();
            const v = document.getElementById(`card-${id}`)?.querySelector('video');
            if (v && v.paused) {
              v.muted = true;
              v.play().catch(() => {});
            }
            return !!v && v.videoWidth > 0 && v.readyState >= 2 && !v.paused;
          }, hostId).catch(() => false);
          if (ready) break;
          await sleep(1000);
        }
        if (!ready) throw new Error('Espectador não reproduziu vídeo do host em 45s; veja measurements e native-debug.log');
        report.videoNegotiation=await viewerPage.evaluate(()=>window.__smgPeers.map(pc=>({state:pc.connectionState,remaps:pc.__smgPayloadRemaps??null,offer:pc.localDescription?.sdp.split(/\r?\n/).filter(line=>/^m=video |^a=(rtpmap|fmtp|rtcp-fb):/.test(line))??[]})));
        report.nativeState = await hostPage.evaluate(async () => (await import('/js/desktop.js')).getNativeCaptureState());
        if(testProfiles.override&&nativeWithoutPreview){
          report.nativeTestStreamProfile=await hostPage.evaluate(()=>window.__smgTestStreamProfile);
          const effective=report.nativeTestStreamProfile.nativeRequested;
          if(effective?.fps!==streamProfile.fps||effective.width!==streamProfile.width||effective.height!==streamProfile.height)throw Error('Native capture did not receive the requested test profile');
        }
        if (!report.nativeState.sessionId) throw new Error('Vídeo sem sessão nativa ativa');
        if(matchedCodec&&report.nativeState.videoCodec!==requestedCodec)throw new Error(`Native codec fallback before benchmark: requested ${requestedCodec}, worker ${report.nativeState.videoCodec}`);
        report.nativeTransport = await hostPage.evaluate(async () => {
          const state = (await import('/js/entries/room-entry.js')).roomState;
          return { browserMediaCalls: state.screenCalls.size, directNativePeers: state.features.nativeMedia.senders.size };
        });
        if (report.nativeTransport.browserMediaCalls !== 0 || report.nativeTransport.directNativePeers !== 1)
          throw new Error('A fase nativa deve usar envio direto GStreamer, sem recodificação no navegador');
        await awaitMatchedReceiver(viewerPage,hostId,'native');
      });

      if(exerciseCaptureFallback) await record('recover owned D3D12 worker failure using D3D11 without renegotiating viewer',async()=>{
        const before=await hostPage.evaluate(async()=>(await import('/js/desktop.js')).getNativeCaptureState());
        if(before.captureBackend!=='d3d12')throw new Error('Fallback test requires D3D12 to be active first');
        const injected=terminateOwnedMediaWorker(desktop.pid),started=injected.killedAtMs;
        await waitApp(hostPage,async()=>{
          const state=await (await import('/js/desktop.js')).getNativeCaptureState();
          return state.state==='live'&&state.captureBackend==='d3d11'&&!!state.captureFallbackReason;
        },null,15000);
        // Observe progress after the fallback state; frames produced before fault injection
        // must not satisfy the recovery assertion.
        const framesAfterSwitch=await viewerPage.evaluate(id=>document.getElementById(`card-${id}`)?.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames??0,hostId);
        await viewerPage.waitForFunction(({id,frames})=>{
          const video=document.getElementById(`card-${id}`)?.querySelector('video');
          return video?.readyState>=2&&video.getVideoPlaybackQuality().totalVideoFrames>frames+6;
        },{id:hostId,frames:framesAfterSwitch},{timeout:15000});
        const after=await hostPage.evaluate(async()=>(await import('/js/desktop.js')).getNativeCaptureState());
        if(after.sessionId!==before.sessionId)throw new Error('Fallback unexpectedly replaced capture session');
        if(after.videoRtpPort!==before.videoRtpPort||after.audioRtpPort!==before.audioRtpPort||after.videoCodec!==before.videoCodec||after.h264Encoder!==before.h264Encoder)throw new Error('Fallback changed transport ports or codec');
        report.captureFallback={passed:true,injected,recoveryMs:Date.now()-started,before,after};
        report.nativeState=after;
      });

      const res = await record('sample native bridge, outbound and remote receiver', async () => {
        return await sampleAndAnalyze({
          label: 'native',
          streamerSide: 'desktop',
          receiverSide: 'web',
          streamerPage: hostPage,
          receiverPage: viewerPage,
          targetPeerId: hostId,
          durationSec: duration,
          isNative: true
        });
      });

      report.timeline = res.timeline;
      report.performance = res.performance;
      report.glassToGlassLatency = res.glassToGlassLatency;
      report.diagnostics = res.diagnostics;
      report.native = res;
      if (nativeReplay) report.nativeReplay = await record('export native replay and decode MP4', async () => hostPage.evaluate(async () => {
        const registry = (await import('/js/entries/room-entry.js')).roomState.features.clipping.recorder;
        const recorder = registry.getRecorder('local-me'); await recorder?.ready;
        if (!recorder?.sessionId || recorder.mediaRecorder) throw new Error('Replay must reuse native encoded data');
        const blob = await registry.exportClip(null, 'local-me');
        if (!blob?.size) throw new Error('Empty native clip');
        const url = URL.createObjectURL(blob), video = document.createElement('video');
        video.src = url; video.muted = true; video.style.cssText = 'position:fixed;bottom:0;left:0;width:320px;z-index:100000';
        document.body.appendChild(video);
        try {
          await Promise.race([new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Native MP4 does not decode')); }), new Promise((_, reject) => setTimeout(() => reject(new Error('Native MP4 decode timeout')), 10000))]);
          await video.play(); await new Promise(resolve => setTimeout(resolve, 700));
          const decodedFrames = video.getVideoPlaybackQuality().totalVideoFrames;
          if (decodedFrames < 3) throw new Error('Native clip has no moving video');
          const dataBase64 = await new Promise(resolve => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result.slice(reader.result.lastIndexOf(',') + 1)); reader.readAsDataURL(blob);
          });
          return { bytes: blob.size, mime: blob.type, width: video.videoWidth, height: video.videoHeight, decodedFrames, mediaRecorder: false, dataBase64 };
        } finally { video.pause(); video.remove(); URL.revokeObjectURL(url); }
      }));
      if (report.nativeReplay?.dataBase64) {
        await writeFile(path.join(output, 'native-replay.mp4'), Buffer.from(report.nativeReplay.dataBase64, 'base64'));
        delete report.nativeReplay.dataBase64;
        report.nativeReplay.artifact = path.join(output, 'native-replay.mp4');
      }

      report.checks.push({ name: 'remote decoded frames progress', status: 'passed' });

      await hostPage.screenshot({ path: path.join(output, isCompareMode ? 'desktop-native.png' : 'desktop.png') });
      await viewerPage.screenshot({ path: path.join(output, isCompareMode ? 'viewer-native.png' : 'viewer.png') });

      await record('stop native capture via desktop UI and verify idle', async () => {
        await hostPage.locator('#dock-stream-btn').click({ force: true });
        await waitApp(hostPage, async () => (await (await import('/js/desktop.js')).getNativeCaptureState()).state === 'idle', null, 15000);
      });

      if(res.validationErrors.length)throw new Error(res.validationErrors.join('; '));
      return res;
    };

    const executeWebPhase = async () => {
      console.log('\n--- Executando Fase: Web Capture (getDisplayMedia) ---');
      const forward=senderMode==='web';
      const webSenderPage=forward?hostPage:viewerPage,webReceiverPage=forward?viewerPage:hostPage;
      const webSenderId=forward?hostId:viewerId;
      if(testProfiles.override)await webSenderPage.evaluate(installTestStreamProfile,{preset,profile:streamProfile,web:true,captureProfile:webCaptureStages.capture,senderScale:webCaptureStages.senderScale});
      await record('start web capture transmission', async () => {
        await webSenderPage.locator('#audio-mode-select').selectOption('none', { force: true });
        await webSenderPage.locator('#quality-preset').selectOption(preset, { force: true });
        await webSenderPage.locator('#video-codec-select').selectOption(requestedCodec, { force: true });
        await webSenderPage.locator('#bitrate-slider').evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},bitrateKbps);
        await webSenderPage.evaluate(async ()=>(await import('/js/entries/room-entry.js')).roomState.features.clipping.recorder.setPreferences({enabled:false,recordLocal:false}));
        await source.bringToFront().catch(() => {});
        await source.evaluate(() => window.focus()).catch(() => {});
        await sleep(500);
        await webSenderPage.evaluate(async () => {
          const app = (await import('/js/diagnostics/session-api.js')).getActiveSession();
          return app.startLocalStream({
            displaySurface: 'window'
          });
        });
        report.webCapture=await webSenderPage.evaluate(async()=>{
          const app=(await import('/js/diagnostics/session-api.js')).getActiveSession(),track=app.localStream?.getVideoTracks()[0];
          const senderParameters=(window.__smgPeers??[]).flatMap(pc=>pc.getSenders().filter(sender=>sender.track===track).map(sender=>{const p=sender.getParameters();return {encodings:p.encodings,degradationPreference:p.degradationPreference};}));
          return track?{label:track.label,settings:track.getSettings(),constraints:track.getConstraints(),senderParameters,testProfile:window.__smgTestStreamProfile??null,readyState:track.readyState,audioTracks:app.localStream.getAudioTracks().length}:null;
        });
        if(!report.webCapture||report.webCapture.settings.displaySurface!=='window'||report.webCapture.audioTracks!==0)throw new Error('Expected a live getDisplayMedia window track without audio');
        const deadline = Date.now() + 45000;
        let ready = false;
        while (Date.now() < deadline) {
          ready = await webReceiverPage.evaluate(id => {
            const unmuteBtn = document.querySelector('.audio-unmute-overlay button');
            if (unmuteBtn) unmuteBtn.click();
            const v = document.getElementById(`card-${id}`)?.querySelector('video');
            if (v && v.paused) {
              v.muted = true;
              v.play().catch(() => {});
            }
            return !!v && v.videoWidth > 0 && v.readyState >= 2 && !v.paused;
          }, webSenderId).catch(() => false);
          if (ready) break;
          await sleep(1000);
        }
        if (!ready) throw new Error('Host não reproduziu vídeo web em 45s');
        await awaitMatchedReceiver(webReceiverPage,webSenderId,'web');
        report.sourceFocusAfterWebCapture=await source.evaluate(()=>({hasFocus:document.hasFocus(),visibility:document.visibilityState,x:screenX,y:screenY}));
        // Capture settings can change after initial constraint negotiation.
        report.webCapture=await webSenderPage.evaluate(async()=>{
          const app=(await import('/js/diagnostics/session-api.js')).getActiveSession(),track=app.localStream?.getVideoTracks()[0];
          const senderParameters=(window.__smgPeers??[]).flatMap(pc=>pc.getSenders().filter(sender=>sender.track===track).map(sender=>{const p=sender.getParameters();return {encodings:p.encodings,degradationPreference:p.degradationPreference};}));
          return track?{label:track.label,settings:track.getSettings(),constraints:track.getConstraints(),senderParameters,testProfile:window.__smgTestStreamProfile??null,readyState:track.readyState,audioTracks:app.localStream.getAudioTracks().length}:null;
        });
        if(testProfiles.override){
          const settings=report.webCapture?.settings;
          if(!settings||Math.abs(settings.frameRate-webCaptureFps)>0.5||settings.width!==webCaptureStages.capture.width||settings.height!==webCaptureStages.capture.height)throw Error('Web capture did not apply the requested test profile');
        }
      });

      const res = await record('sample web capture outbound and receiver', async () => {
        return await sampleAndAnalyze({
          label: 'web',
          streamerSide: forward?'desktop':'web',
          receiverSide: forward?'web':'desktop',
          streamerPage: webSenderPage,
          receiverPage: webReceiverPage,
          targetPeerId: webSenderId,
          durationSec: duration,
          isNative: false
        });
      });

      report.web = res;
      if(forward){report.timeline=res.timeline;report.performance=res.performance;report.glassToGlassLatency=res.glassToGlassLatency;report.diagnostics=res.diagnostics;}
      await hostPage.screenshot({ path: path.join(output, 'desktop-web.png') });
      await viewerPage.screenshot({ path: path.join(output, 'viewer-web.png') });

      await record('stop web capture stream', async () => {
        await webSenderPage.evaluate(async () => {
          const app = (await import('/js/diagnostics/session-api.js')).getActiveSession();
          return app.stopLocalStream();
        });
        await waitApp(webSenderPage,async()=>!(await import('/js/diagnostics/session-api.js')).getActiveSession().localStream,null,15000);
      });

      if(res.validationErrors.length)throw new Error(res.validationErrors.join('; '));
      return res;
    };

    let nativeResult = null;
    let webResult = null;

    if(senderMode==='web'){
      webResult=await executeWebPhase();await cleanStageAndCards();
    }else if (isCompareMode && isWebFirst) {
      console.log('\n=== Ordem Solicitada: Web Capture Primeiro (--web-first) ===');
      webResult = await executeWebPhase();
      await cleanStageAndCards();
      await sleep(3000);
      nativeResult = await executeNativePhase();
      await cleanStageAndCards();
    } else {
      nativeResult = await executeNativePhase();
      await cleanStageAndCards();
      if (isCompareMode) {
        await sleep(3000);
        webResult = await executeWebPhase();
        await cleanStageAndCards();
      }
    }

    if (isCompareMode) {
      const nativeBackendLabel = report.nativeState?.captureBackend || report.nativeState?.capture_backend || 'unknown';
      // Matriz Comparativa A/B Rigorosa
      const natLat = nativeResult.glassToGlassLatency?.p50Ms ?? null;
      const webLat = webResult.glassToGlassLatency?.p50Ms ?? null;
      const natFps = nativeResult.performance.medianDecodedFps;
      const webFps = webResult.performance.medianDecodedFps;
      const natEncodeMs = averageOf(nativeResult.timeline.filter(t => t.phase === 'steady'), t => t.outbound.encodeTimeMs);
      const webEncodeMs = averageOf(webResult.timeline.filter(t => t.phase === 'steady'), t => t.outbound.encodeTimeMs);
      const bridgeDecodeMs = averageOf(nativeResult.timeline.filter(t => t.phase === 'steady'), t => t.bridge.decodeTimeMs);
      const bridgeJitterMs = averageOf(nativeResult.timeline.filter(t => t.phase === 'steady'), t => t.bridge.jitterBufferMs);
      const bridgeObservableMs = (bridgeDecodeMs !== null || bridgeJitterMs !== null)
        ? Number(((bridgeDecodeMs ?? 0) + (bridgeJitterMs ?? 0)).toFixed(2))
        : null;

      const measurementValidBoth = nativeResult.diagnostics.measurementValid && webResult.diagnostics.measurementValid;

      report.comparison = {
        captureMethodIsolated: false,
        declaredFactors: [
          'Streamer: WebView2 (Nativo) vs Chromium (Web)',
          'Receiver: Chromium (Nativo) vs WebView2 (Web)',
          `Fonte: Janela sintética idêntica SMG E2E Motion (${sourceProfile.width}x${sourceProfile.height})`,
          `Superfície de Captura: Janela vs Janela (${nativeBackendLabel}/WGC vs getDisplayMedia)`,
          `Fonte solicitada: ${sourceProfile.width}x${sourceProfile.height} @ ${sourceProfile.fps} FPS; resolução entregue registrada separadamente`,
          'Os receptores são diferentes; esta execução não isola apenas o método de captura'
        ],
        deliveredResolutions: { native: nativeResult.deliveredResolutions, web: webResult.deliveredResolutions },
        native: {
          medianDecodedFps: natFps,
          glassToGlassP50Ms: natLat,
          glassToGlassP90Ms: nativeResult.glassToGlassLatency?.p90Ms ?? null,
          glassToGlassP99Ms: nativeResult.glassToGlassLatency?.p99Ms ?? null,
          latencyPhase: nativeResult.glassToGlassLatency?.phase ?? 'total',
          startupDynamics: nativeResult.startupDynamics,
          warmupLatency: nativeResult.warmupLatency,
          cooldownLatency: nativeResult.cooldownLatency,
          outboundEncodeTimeMs: natEncodeMs,
          localPreviewDecodeTimeMs: bridgeDecodeMs,
          localPreviewJitterBufferMs: bridgeJitterMs,
          localPreviewObservableLatencyMs: bridgeObservableMs,
          measurementValid: nativeResult.diagnostics.measurementValid,
          stuttersDetected: nativeResult.diagnostics.stuttersDetected
        },
        web: {
          medianDecodedFps: webFps,
          glassToGlassP50Ms: webLat,
          glassToGlassP90Ms: webResult.glassToGlassLatency?.p90Ms ?? null,
          glassToGlassP99Ms: webResult.glassToGlassLatency?.p99Ms ?? null,
          latencyPhase: webResult.glassToGlassLatency?.phase ?? 'total',
          startupDynamics: webResult.startupDynamics,
          warmupLatency: webResult.warmupLatency,
          cooldownLatency: webResult.cooldownLatency,
          outboundEncodeTimeMs: webEncodeMs,
          localPreviewDecodeTimeMs: 0,
          localPreviewJitterBufferMs: 0,
          localPreviewObservableLatencyMs: 0,
          measurementValid: webResult.diagnostics.measurementValid,
          stuttersDetected: webResult.diagnostics.stuttersDetected
        },
        delta: {
          latencyOverheadMs: natLat !== null && webLat !== null ? (natLat - webLat) : null,
          fpsDelta: natFps !== null && webFps !== null ? Number((natFps - webFps).toFixed(2)) : null,
          encodeTimeDeltaMs: natEncodeMs !== null && webEncodeMs !== null ? Number((natEncodeMs - webEncodeMs).toFixed(2)) : null,
          stuttersDelta: nativeResult.diagnostics.stuttersDetected - webResult.diagnostics.stuttersDetected
        },
        verdict: {
          measurementValid: measurementValidBoth,
          localPreviewCostMs: bridgeObservableMs,
          latencyEvaluation: 'Comparação exploratória: receptores distintos; deltas não isolam o método de captura',
          observedLatencyDifference: measurementValidBoth && natLat !== null && webLat !== null
            ? (natLat <= webLat
                ? `Envio nativo direto é ${(webLat - natLat).toFixed(0)}ms mais rápido que web capture`
                : (natLat <= webLat + 35
                    ? 'Latência nativa competitiva com o navegador'
                    : `Nativo adiciona ${(natLat - webLat).toFixed(0)}ms em relação ao navegador`))
            : 'Medição óptica inconclusiva para veredito comparativo',
          stutterComparison: nativeResult.diagnostics.stuttersDetected <= webResult.diagnostics.stuttersDetected
            ? 'Captura nativa apresentou estabilidade igual ou superior'
            : 'Web capture apresentou menos quedas transitórias'
        }
      };

      console.log('\n=== Comparação observada (Nativo vs Web; veja condições no relatório) ===');
      console.table({
        [`Nativo (${nativeBackendLabel})`]: {
          'FPS Mediano (Steady)': natFps?.toFixed(1),
          'Latência p50 Steady (ms)': natLat ?? 'Inconclusivo',
          'Latência p90 Steady (ms)': nativeResult.glassToGlassLatency?.p90Ms ?? 'N/A',
          'Latência p99 Steady (ms)': nativeResult.glassToGlassLatency?.p99Ms ?? 'N/A',
          'Encode Outbound (ms)': natEncodeMs ?? 'N/A (encoder nativo não medido)',
          'Preview Local Obs. (ms)': bridgeObservableMs ?? 'N/A',
          'Pausa Warmup (ms)': nativeResult.startupDynamics?.startupMaxPauseMs ?? 0,
          'Stutters Steady': nativeResult.diagnostics.stuttersDetected,
          'Medição Válida': nativeResult.diagnostics.measurementValid ? 'SIM' : 'NÃO'
        },
        'Web (getDisplayMedia)': {
          'FPS Mediano (Steady)': webFps?.toFixed(1),
          'Latência p50 Steady (ms)': webLat ?? 'Inconclusivo',
          'Latência p90 Steady (ms)': webResult.glassToGlassLatency?.p90Ms ?? 'N/A',
          'Latência p99 Steady (ms)': webResult.glassToGlassLatency?.p99Ms ?? 'N/A',
          'Encode Outbound (ms)': webEncodeMs ?? 'N/A',
          'Preview Local Obs. (ms)': '0.00 (sem preview local)',
          'Pausa Warmup (ms)': webResult.startupDynamics?.startupMaxPauseMs ?? 0,
          'Stutters Steady': webResult.diagnostics.stuttersDetected,
          'Medição Válida': webResult.diagnostics.measurementValid ? 'SIM' : 'NÃO'
        }
      });
    }

    const primaryResult=senderMode==='web'?webResult:nativeResult;
    report.videoContinuity = [primaryResult, ...(isCompareMode ? [webResult] : [])].map(result => assessVideoContinuity(result.timeline));
    const functionalPassed = report.videoContinuity.every(result => result.passed);
    report.checks.push({ name: 'receiver video keeps presenting frames throughout sampling', status: functionalPassed ? 'passed' : 'failed' });
    const measurementValid = isCompareMode
      ? (report.comparison?.verdict?.measurementValid ?? false)
      : (primaryResult.diagnostics.measurementValid);
    const qualifications=[primaryResult.qualification,...(isCompareMode?[webResult.qualification]:[])];
    const qualificationStatus=qualifications.some(q=>q.status==='failed')?'failed':qualifications.every(q=>q.status==='passed')?'passed':'insufficient-evidence';
    const fpsResults=[primaryResult.performance.p10DecodedFps,...(isCompareMode?[webResult.performance.p10DecodedFps]:[])];
    report.verdict = evaluateStreamVerdict({functionalPassed,measurementRequested:opticalHz>0,measurementValid,qualificationStatus,requireQuality,minFps,p10Fps:fpsResults.every(Number.isFinite)?Math.min(...fpsResults):null});

    report.status = report.verdict.overallStatus;
  }
} catch (error) { report.status = 'failed'; report.error = error.message;if(error.forwardingAttempts)report.forwardingAttempts=error.forwardingAttempts; process.exitCode = 1; }
finally {
  await activeReceiverTrace?.abort().catch(()=>{});
  await pendingReceiverTrace?.abort().catch(()=>{});
  await activeSenderTrace?.abort().catch(()=>{});await pendingSenderTrace?.abort().catch(()=>{});
  await resources.stop();report.resources=resources.report();
  await checkpoint();
  if (report.status === 'failed') {
    for (const [side, page] of [['desktop', hostPage], ['viewer', viewerPage]]) {
      if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, `${side}-failure.png`), timeout: 3000 }).catch(() => {});
    }
  }
  if (hostPage) {
    // Stop only this isolated session; never taskkill processes by name.
    if (!hostPage.isClosed()) await cleanup('stop owned capture', () => hostPage.evaluate(async sender=>sender==='web'?(await import('/js/diagnostics/session-api.js')).getActiveSession()?.stopLocalStream():(await import('/js/desktop.js')).stopNativeCapture(),senderMode));
  }
  if(remoteViewer&&viewerContext&&remoteViewer.connectionType!=='cdp')await cleanup('close owned remote viewer context',()=>viewerContext.close());
  for (const [name, browser] of [['viewer', viewerBrowser], ['source', sourceBrowser], ['desktop CDP', nativeBrowser]]) if (browser) await cleanup(`close ${name}`, () => browser.close());
  if (desktop && desktop.exitCode === null) { desktop.kill(); }
  if (desktop) {
    const log = await readFile(path.join(path.dirname(exe), 'native_debug.log')).catch(() => Buffer.alloc(0));
    if (log.length > nativeLogSize) await writeFile(path.join(output, 'native-debug.log'), log.subarray(nativeLogSize));
    report.instanceProfile = readInstanceProfileEvidence(log.subarray(nativeLogSize).toString());
    if (args.includes('--expect-profile-isolation') && report.instanceProfile?.mode !== 'isolated-secondary') {
      report.status = 'failed'; report.error = 'Expected automatic secondary WebView2 profile isolation was not observed';
    }
    report.backendEvidence=readCaptureBackendEvidence(log.subarray(nativeLogSize).toString(),captureBackend);
    if(report.native&&!report.backendEvidence.matched){
      report.status='failed';report.error='Actual native capture backend could not be verified against requested backend';
    }
  }
  if (server) { server.closeAllConnections(); await cleanup('close HTTP server', () => new Promise(r => server.close(r))); }
  if (signaling) await cleanup('close local signaling', () => signaling.close());
  if (reverseTunnel) await cleanup('close reverse SSH forwarding',()=>reverseTunnel.stop());
  await writeFile(path.join(output, 'report.json'), serializeReport());
  console.log(`E2E ${report.status}: ${path.join(output, 'report.json')}`);
}
if(report.status==='failed')process.exitCode=1;else if(report.status==='inconclusive')process.exitCode=2;
