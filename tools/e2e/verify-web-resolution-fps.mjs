// E2E Verification: Received Resolution and FPS under Web Streaming
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { assessResolutionRun } from './resolution-assessment.mjs';
import { startAssetServer } from './harness/server.mjs';
import { ensureDefaultDesktop } from './desktop-affinity.mjs';

ensureDefaultDesktop();
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL(`../../output/playwright/web-resolution-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}/`, import.meta.url);
await mkdir(output, { recursive: true });
const report = { status: 'running', scope: 'Canvas WebRTC component smoke in one browser. Paced manual requestFrame, no second canvas capture timer. No Rust, WGC/DXGI, getDisplayMedia or product UI. Not performance certification.', hashes: {}, runs: [] };
for (const file of ['tools/e2e/verify-web-resolution-fps.mjs', 'tools/e2e/resolution-assessment.mjs', 'js/webrtc/sender.js', 'js/streaming/sender-parameters.js']) report.hashes[file] = createHash('sha256').update(await readFile(new URL('../../' + file, import.meta.url))).digest('hex');
const saveReport = () => writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));

async function runTestCase({
  title,
  sourceWidth = 1920,
  sourceHeight = 1080,
  targetWidth = 1920,
  targetHeight = 1080,
  scaleResolutionDownBy = 1,
  fps = 60,
  bitrateKbps = 7500,
  degradationPreference = 'maintain-resolution',
  dynamicSwitch = null,
  durationSec = 6
}) {
  console.log(`\n===============================================================`);
  console.log(`[TESTE] ${title}`);
  console.log(`Fonte: ${sourceWidth}x${sourceHeight} | Alvo: ${targetWidth}x${targetHeight} @ ${fps} FPS | Escala: ${scaleResolutionDownBy}x | Degradação: ${degradationPreference}`);
  console.log(`===============================================================`);

  const server = await startAssetServer({
    root,
    fixtures: {
      '/test-runner.html': `<!doctype html>
<html>
<head><title>SMG Web Resolution/FPS Probe</title></head>
<body style="background:#111;color:#eee;font-family:sans-serif;margin:20px;">
  <h2>SMG Web Resolution & FPS Probe</h2>
  <div style="display:flex;gap:20px;">
    <div>
      <h4>Sender Canvas (${sourceWidth}x${sourceHeight} @ ${fps}fps)</h4>
      <canvas id="sourceCanvas" width="${sourceWidth}" height="${sourceHeight}" style="width:320px;height:${Math.round(320*sourceHeight/sourceWidth)}px;border:1px solid #444;background:#000;"></canvas>
    </div>
    <div>
      <h4>Receiver Video</h4>
      <video id="receiverVideo" autoplay playsinline muted style="width:320px;height:${Math.round(320*targetHeight/targetWidth)}px;border:1px solid #444;background:#000;"></video>
    </div>
  </div>
  <pre id="log" style="background:#222;padding:10px;margin-top:20px;max-height:200px;overflow:auto;"></pre>
  <script type="module">
    import { applySenderOptimizations } from '/js/webrtc/sender.js';
    import { observePresentation } from '/js/stats/presentation.js';

    window.__runTest = async function({
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      scaleResolutionDownBy,
      fps,
      bitrateKbps,
      degradationPreference,
      dynamicSwitch,
      durationSec
    }) {
      const canvas = document.getElementById('sourceCanvas');
      const ctx = canvas.getContext('2d');
      const video = document.getElementById('receiverVideo');
      const logElem = document.getElementById('log');
      const log = (msg) => { console.log(msg); logElem.textContent += msg + '\\n'; };

      // Animate source canvas with high detail and dynamic 60 FPS motion
      let frameNum = 0;
      let animating = true;
      let lastDraw = null;
      let requestSourceFrame = () => {};
      function draw(time = performance.now()) {
        if (!animating) return;
        requestAnimationFrame(draw);
        if (lastDraw !== null) {
          if (time - lastDraw < 1000 / fps) return;
          lastDraw += Math.floor((time - lastDraw) / (1000 / fps)) * (1000 / fps);
        } else lastDraw = time;
        frameNum++;
        ctx.fillStyle = '#0a0f18';
        ctx.fillRect(0, 0, sourceWidth, sourceHeight);

        // Moving shapes
        const x = (frameNum * 10) % (sourceWidth - 160);
        const y = (frameNum * 6) % (sourceHeight - 160);
        ctx.fillStyle = '#00f3ff';
        ctx.fillRect(x, y, 160, 160);

        ctx.fillStyle = '#ff0055';
        ctx.beginPath();
        ctx.arc((sourceWidth - x), (sourceHeight - y), 80, 0, Math.PI * 2);
        ctx.fill();

        // High frequency detail text
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 42px monospace';
        ctx.fillText('FRAME ' + frameNum + ' | ' + sourceWidth + 'x' + sourceHeight + ' @ ' + fps + ' FPS', 60, 90);
        ctx.font = '28px monospace';
        ctx.fillText('DEGRADATION: ' + degradationPreference + ' | SCALE: ' + scaleResolutionDownBy, 60, 150);
        requestSourceFrame();
      }
      draw();

      // Capture stream from canvas
      const stream = canvas.captureStream(0);
      const [track] = stream.getVideoTracks();
      if (typeof track.requestFrame !== 'function') throw new Error('Controlled canvas requestFrame is unavailable');
      requestSourceFrame = () => track.requestFrame();

      // Setup WebRTC loopback
      const pcSender = new RTCPeerConnection({ iceServers: [] });
      const pcReceiver = new RTCPeerConnection({ iceServers: [] });

      const signalErrors = [], queued = new Map([[pcSender, []], [pcReceiver, []]]);
      const candidate = async (target, value) => {
        if (!target.remoteDescription) queued.get(target).push(value);
        else await target.addIceCandidate(value);
      };
      pcSender.onicecandidate = e => { if (e.candidate) candidate(pcReceiver, e.candidate).catch(error => signalErrors.push(error.message)); };
      pcReceiver.onicecandidate = e => { if (e.candidate) candidate(pcSender, e.candidate).catch(error => signalErrors.push(error.message)); };

      const videoReady = new Promise((resolve, reject) => {
        pcReceiver.ontrack = (e) => {
          video.srcObject = e.streams[0];
          video.onloadedmetadata = () => {
            video.play().then(resolve, reject);
          };
        };
      });

      const sender = pcSender.addTrack(track, stream);
      const transceiver = pcSender.getTransceivers()[0];
      const h264Codecs = RTCRtpSender.getCapabilities('video').codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
      if (h264Codecs.length > 0) transceiver.setCodecPreferences(h264Codecs);

      const offer = await pcSender.createOffer();
      await pcSender.setLocalDescription(offer);
      await pcReceiver.setRemoteDescription(offer);
      for (const value of queued.get(pcReceiver).splice(0)) await pcReceiver.addIceCandidate(value);

      const answer = await pcReceiver.createAnswer();
      await pcReceiver.setLocalDescription(answer);
      await pcSender.setRemoteDescription(answer);
      for (const value of queued.get(pcSender).splice(0)) await pcSender.addIceCandidate(value);

      // Apply SeeMyGame sender optimizations
      const initialBitrateBps = bitrateKbps * 1000;
      await applySenderOptimizations(pcSender, initialBitrateBps, fps, scaleResolutionDownBy, degradationPreference);
      let readinessTimer;
      try { await Promise.race([videoReady, new Promise((_, reject) => { readinessTimer = setTimeout(() => reject(new Error('Video readiness timeout')), 15000); })]); }
      finally { clearTimeout(readinessTimer); }
      const presentation = observePresentation(video);

      // Verify RTCRtpSender parameters directly
      const senderParams = sender.getParameters();
      const appliedDegradation = senderParams.degradationPreference;
      const appliedScale = senderParams.encodings?.[0]?.scaleResolutionDownBy ?? 1;
      const appliedMaxBitrate = senderParams.encodings?.[0]?.maxBitrate;
      const appliedMaxFps = senderParams.encodings?.[0]?.maxFramerate;

      log('RTCRtpSender parameters applied: degradationPreference=' + appliedDegradation + ', scale=' + appliedScale + ', maxFps=' + appliedMaxFps);

      // Collect receiver inbound-rtp metrics over time
      const samples = [];
      const startTime = performance.now();
      let lastBytes = 0;
      let lastFrames = 0;
      let lastTimestamp = startTime;
      let lastSourceFrames = frameNum;

      for (let i = 0; i < durationSec; i++) {
        await new Promise(r => setTimeout(r, 1000));

        // Dynamic switch scenario (e.g. changing resolution / scale factor mid-stream)
        if (dynamicSwitch && i === Math.floor(durationSec / 2)) {
          log('TRIGGER: Dynamic Switch to ' + dynamicSwitch.targetWidth + 'x' + dynamicSwitch.targetHeight + ' (scale ' + dynamicSwitch.scaleResolutionDownBy + 'x)');
          await applySenderOptimizations(
            pcSender,
            dynamicSwitch.bitrateKbps * 1000,
            dynamicSwitch.fps || fps,
            dynamicSwitch.scaleResolutionDownBy,
            dynamicSwitch.degradationPreference || degradationPreference
          );
        }

        const stats = await pcReceiver.getStats();
        let inboundVideo = null;
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            inboundVideo = report;
          }
        });

        const now = performance.now();
        const timeDelta = (now - lastTimestamp) / 1000;
        let rxFps = null;
        let rxBitrateMbps = null;

        if (inboundVideo) {
          if (timeDelta > 0) {
            rxFps = Math.round((inboundVideo.framesDecoded - lastFrames) / timeDelta);
            rxBitrateMbps = ((inboundVideo.bytesReceived - lastBytes) * 8 / timeDelta / 1e6).toFixed(2);
          }
          lastFrames = inboundVideo.framesDecoded;
          lastBytes = inboundVideo.bytesReceived;
          lastTimestamp = now;

          const sample = {
            second: i + 1,
            phase: dynamicSwitch && i === Math.floor(durationSec / 2) ? 'transition' : dynamicSwitch && i > Math.floor(durationSec / 2) ? 'final' : 'initial',
            timeMs: Math.round(now - startTime),
            videoElementWidth: video.videoWidth,
            videoElementHeight: video.videoHeight,
            inboundFrameWidth: inboundVideo.frameWidth ?? video.videoWidth,
            inboundFrameHeight: inboundVideo.frameHeight ?? video.videoHeight,
            framesDecoded: inboundVideo.framesDecoded,
            rxFps: rxFps,
            bitrateMbps: rxBitrateMbps,
            packetsLost: inboundVideo.packetsLost ?? 0,
            jitter: inboundVideo.jitter ?? 0,
            sourceFps: (frameNum - lastSourceFrames) / timeDelta,
            codec: stats.get(inboundVideo.codecId)?.mimeType || null,
            ...presentation.sample()
          };
          samples.push(sample);
          lastSourceFrames = frameNum;
          log('  [Sec ' + sample.second + '] RX: ' + sample.inboundFrameWidth + 'x' + sample.inboundFrameHeight + ' @ ' + (sample.rxFps ?? '~') + ' FPS | Bitrate: ' + sample.bitrateMbps + ' Mbps');
        }
      }

      animating = false;
      const finalDegradation = sender.getParameters().degradationPreference;
      track.stop();
      pcSender.close();
      pcReceiver.close();
      presentation.dispose();

      return {
        appliedDegradation,
        finalDegradation,
        signalErrors,
        appliedScale,
        appliedMaxBitrate,
        appliedMaxFps,
        initialWidth: samples[0]?.inboundFrameWidth,
        initialHeight: samples[0]?.inboundFrameHeight,
        minWidth: Math.min(...samples.map(s => s.inboundFrameWidth).filter(Boolean)),
        minHeight: Math.min(...samples.map(s => s.inboundFrameHeight).filter(Boolean)),
        maxWidth: Math.max(...samples.map(s => s.inboundFrameWidth).filter(Boolean)),
        maxHeight: Math.max(...samples.map(s => s.inboundFrameHeight).filter(Boolean)),
        finalWidth: samples.at(-1)?.inboundFrameWidth,
        finalHeight: samples.at(-1)?.inboundFrameHeight,
        avgFps: Math.round(samples.slice(1).reduce((sum, s) => sum + (s.rxFps || 0), 0) / Math.max(1, samples.slice(1).length)),
        samples
      };
    };
  </script>
</body>
</html>`
    }
  });

  let browser;
  try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=960,640'
    ]
  });

  const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
  report.browserVersion = browser.version();
  const page = await context.newPage();

  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('[Sec ') || txt.includes('RTCRtpSender') || txt.includes('TRIGGER')) {
      console.log(' ', txt);
    }
  });

  await page.goto(`${server.origin}/test-runner.html`);

  let caseTimer;
  const result = await Promise.race([page.evaluate(runTestCaseArgs => window.__runTest(runTestCaseArgs), {
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    scaleResolutionDownBy,
    fps,
    bitrateKbps,
    degradationPreference,
    dynamicSwitch,
    durationSec
  }), new Promise((_, reject) => { caseTimer = setTimeout(() => reject(new Error('Component case timeout')), (durationSec + 20) * 1000); })]).finally(() => clearTimeout(caseTimer));
  const assessment = assessResolutionRun(result, { targetWidth, targetHeight, fps, degradationPreference, dynamicSwitch });
  const isExactTarget = assessment.resolutionMatches;
  console.log(`\n--- RESUMO DO RESULTADO: ${title} ---`);
  console.log(`Alvo Solicitado: ${targetWidth}x${targetHeight} @ ${fps} FPS`);
  console.log(`Resolução Recebida Inicial: ${result.initialWidth}x${result.initialHeight}`);
  console.log(`Resolução Recebida Mínima: ${result.minWidth}x${result.minHeight}`);
  console.log(`Resolução Recebida Final: ${result.finalWidth}x${result.finalHeight}`);
  console.log(`FPS Médio Recebido (inbound-rtp): ${result.avgFps} FPS`);
  console.log(`Parâmetro degradationPreference no Sender: ${result.appliedDegradation}`);
  console.log(`Resolução cravada no alvo?: ${isExactTarget ? 'SIM (RESOLUÇÃO MANTIDA)' : 'NÃO (OSCILOU OU DEGRADOU)'}`);

  const run = {
    title,
    targetWidth,
    targetHeight,
    fps,
    isExactTarget,
    assessment,
    ...result
  };
  report.runs.push(run); await saveReport();
  return run;
  } finally { await browser?.close(); await server.close(); }
}

async function main() {
  console.log('=============================================================================');
  console.log('SMOKE DE COMPONENTE WEB: RESOLUÇÃO E CADÊNCIA EM LOOPBACK CANVAS (SEM CAPTURA NATIVA OU UI)');
  console.log('=============================================================================');

  const results = [];

  // Component 1: canvas 1080p with maintain-resolution.
  results.push(await runTestCase({
    title: '1. Canvas Full HD (1080p @ 60 FPS) com maintain-resolution',
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetWidth: 1920,
    targetHeight: 1080,
    scaleResolutionDownBy: 1,
    fps: 60,
    bitrateKbps: 7500,
    degradationPreference: 'maintain-resolution',
    durationSec: 5
  }));

  // Component 2: canvas 720p with maintain-resolution.
  results.push(await runTestCase({
    title: '2. Modo Competitivo (720p @ 60 FPS) com maintain-resolution',
    sourceWidth: 1280,
    sourceHeight: 720,
    targetWidth: 1280,
    targetHeight: 720,
    scaleResolutionDownBy: 1,
    fps: 60,
    bitrateKbps: 4500,
    degradationPreference: 'maintain-resolution',
    durationSec: 5
  }));

  // Teste 3: Monitor 1440p (2560x1440) -> Streamer perfil 1080p (escala dinâmica 1.33x)
  results.push(await runTestCase({
    title: '3. Monitor 1440p -> Stream FHD 1080p com escala dinâmica (1.33x)',
    sourceWidth: 2560,
    sourceHeight: 1440,
    targetWidth: 1920,
    targetHeight: 1080,
    scaleResolutionDownBy: 1.333333,
    fps: 60,
    bitrateKbps: 7500,
    degradationPreference: 'maintain-resolution',
    durationSec: 5
  }));

  // Teste 4: Monitor 1440p (2560x1440) -> Streamer perfil 720p (escala dinâmica 2.0x)
  results.push(await runTestCase({
    title: '4. Monitor 1440p -> Stream HD 720p Modo Competitivo com escala dinâmica (2.0x)',
    sourceWidth: 2560,
    sourceHeight: 1440,
    targetWidth: 1280,
    targetHeight: 720,
    scaleResolutionDownBy: 2.0,
    fps: 60,
    bitrateKbps: 4500,
    degradationPreference: 'maintain-resolution',
    durationSec: 5
  }));

  // Teste 5: Troca dinâmica ao vivo de Perfil de Qualidade (1080p -> 720p em conexão ativa)
  results.push(await runTestCase({
    title: '5. Troca Dinâmica ao Vivo: 1080p -> 720p sem queda de conexão',
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetWidth: 1920,
    targetHeight: 1080,
    scaleResolutionDownBy: 1,
    fps: 60,
    bitrateKbps: 7500,
    degradationPreference: 'maintain-resolution',
    dynamicSwitch: {
      targetWidth: 1280,
      targetHeight: 720,
      scaleResolutionDownBy: 1.5,
      bitrateKbps: 4500,
      fps: 60,
      degradationPreference: 'maintain-resolution'
    },
    durationSec: 6
  }));

  console.log('\n=============================================================================================================');
  console.log('TABELA FINAL DE COMPROVAÇÃO DE RESOLUÇÃO E FPS RECEBIDOS NO RECEPTOR (inbound-rtp)');
  console.log('=============================================================================================================');
  console.log('| Caso de Teste | Alvo Solicitado | Resolução Inicial RX | Resolução Final RX | FPS Médio RX | Degrad. Pref. | Status |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const status = r.assessment.passed ? 'PASSOU (COMPONENTE)' : 'FALHOU: ' + r.assessment.reasons.join(', ');
    console.log(`| ${r.title.slice(0, 35).padEnd(35)} | ${(r.targetWidth + 'x' + r.targetHeight + ' @ ' + r.fps).padEnd(15)} | ${(r.initialWidth + 'x' + r.initialHeight).padEnd(16)} | ${(r.finalWidth + 'x' + r.finalHeight).padEnd(14)} | ${(r.avgFps + ' FPS').padEnd(12)} | ${(r.appliedDegradation || '-').padEnd(13)} | ${status} |`);
  }
  console.log('=============================================================================================================\n');

  const allPassed = results.every(r => r.assessment.passed);
  report.status = allPassed ? 'passed' : 'failed'; await saveReport();
  if (!allPassed) {
    console.error('Um ou mais testes de resolução/fps não atingiram o alvo esperado.');
    process.exitCode = 1; return;
  }
  console.log('Smoke de componente aprovado; não homologa captura nem desempenho sob carga.');
}

main().catch(async err => {
  report.status = 'failed'; report.error = err.message; await saveReport();
  console.error('Falha na execução dos testes:', err);
  process.exitCode = 1;
}).finally(() => console.log('Report:', fileURLToPath(new URL('report.json', output))));
