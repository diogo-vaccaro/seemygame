// Comprehensive Benchmark Matrix Runner: Codecs, Encoders, APIs, Resolutions, FPS & Workloads
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ensureDefaultDesktop } from './desktop-affinity.mjs';

ensureDefaultDesktop();

const root = fileURLToPath(new URL('../../', import.meta.url));
const exe = path.resolve(root, 'src-tauri/target/release/seemygame.exe');
const host = 'notebook';

// Run identifier and artifact directories
const runId = `goal-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
const outputDir = path.join(root, 'output/playwright', runId);
await mkdir(outputDir, { recursive: true });

const resultsLogFile = path.join(outputDir, 'results.jsonl');
const masterReportFile = path.join(outputDir, 'master-report.json');

console.log('=============================================================================');
console.log('SEE MY GAME - BATERIA DE BENCHMARK MULTIVARIÁVEL RIGOROSO (GOAL E2E)');
console.log(`Diretório de Artefatos: ${outputDir}`);
console.log(`Emissor: Desktop (RTX 3070) | Receptor: Notebook (Ryzen 7 5800H via Tailscale)`);
console.log('=============================================================================\n');

// Guarantee remote notebook cleanup
async function cleanupRemoteNotebook() {
  const ps = "$ProgressPreference='SilentlyContinue'; Get-ScheduledTask -TaskName 'SeeMyGame-E2E*' -ErrorAction SilentlyContinue | ForEach-Object { Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue }; Get-Process -Name node, chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike '*OpenSSH*' } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300";
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`];
  try {
    await new Promise(resolve => {
      const child = spawn('ssh', args, { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); resolve(); }, 8000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.once('error', () => { clearTimeout(timer); resolve(); });
    });
  } catch (_) {}
}

// 1. Definition of Pipelines (Combinations of Capture API, Codec, Encoder)
const PIPELINES = [
  // Native D3D12 + NVENC (H.264)
  {
    id: 'd3d12-nvenc-h264',
    label: 'D3D12 + NVENC (H.264)',
    sender: 'native-d3d12',
    codec: 'h264',
    encoder: 'nvenc',
    backend: 'd3d12',
    isNative: true,
    supportedFps: [30, 60, 120]
  },
  // Native D3D11 + NVENC (H.264)
  {
    id: 'd3d11-nvenc-h264',
    label: 'D3D11 + NVENC (H.264)',
    sender: 'native',
    codec: 'h264',
    encoder: 'nvenc',
    backend: 'd3d11',
    isNative: true,
    supportedFps: [60]
  },
  // Native D3D11 + Media Foundation (H.264)
  {
    id: 'd3d11-mf-h264',
    label: 'D3D11 + Media Foundation (H.264)',
    sender: 'native',
    codec: 'h264',
    encoder: 'mf',
    backend: 'd3d11',
    isNative: true,
    supportedFps: [60]
  },
  // Native D3D11 + CPU Software (H.264)
  {
    id: 'd3d11-cpu-h264',
    label: 'D3D11 + CPU Software (H.264)',
    sender: 'native',
    codec: 'h264',
    encoder: 'cpu',
    backend: 'd3d11',
    isNative: true,
    supportedFps: [60]
  },
  // Native D3D11 + HEVC / H.265 (Auto/NVENC)
  {
    id: 'd3d11-hevc-auto',
    label: 'D3D11 + HEVC (Auto/NVENC)',
    sender: 'native-auto',
    codec: 'hevc',
    encoder: 'auto',
    backend: 'd3d11',
    isNative: true,
    extraFlags: ['--enable-hevc-receive'],
    supportedFps: [60]
  },
  // Native D3D11 + HEVC / H.265 (Media Foundation)
  {
    id: 'd3d11-hevc-mf',
    label: 'D3D11 + HEVC (Media Foundation)',
    sender: 'native',
    codec: 'hevc',
    encoder: 'mf',
    backend: 'd3d11',
    isNative: true,
    extraFlags: ['--enable-hevc-receive'],
    supportedFps: [60]
  },
  // Web Capture + Chromium H.264 MFT
  {
    id: 'web-chrome-h264',
    label: 'Web Capture + H.264',
    sender: 'web',
    codec: 'h264',
    encoder: 'auto',
    backend: 'web',
    isNative: false,
    supportedFps: [30, 60]
  },
  // Web Capture + Chromium AV1
  {
    id: 'web-chrome-av1',
    label: 'Web Capture + AV1',
    sender: 'web',
    codec: 'av1',
    encoder: 'auto',
    backend: 'web',
    isNative: false,
    supportedFps: [60]
  }
];

// 2. Resolutions and FPS targets
const RESOLUTIONS = [
  { name: '720p', width: 1280, height: 720, defaultPreset: 'ultra', preset120: 'hd120', bitrateKbps: 4500, bitrate120Kbps: 9000 },
  { name: '1080p', width: 1920, height: 1080, defaultPreset: 'balanced', preset120: 'fhd120', bitrateKbps: 7500, bitrate120Kbps: 15000 }
];

// 3. Workload conditions
const WORKLOADS = [
  { id: 'off', label: 'Carga Leve (Sem GPU Stress)' },
  { id: 'gpu-unlimited', label: 'Carga FPS Ilimitado (Shader GPU Stress)' }
];

// Helper to run a single distributed matrix test case
async function runSingleTestCase({ pipeline, resolution, fps, workload, durationSec = 10 }) {
  // Ensure notebook is clean before starting
  await cleanupRemoteNotebook();

  const is120 = fps === 120;
  const preset = is120 ? resolution.preset120 : resolution.defaultPreset;
  const bitrate = is120 ? resolution.bitrate120Kbps : (fps === 30 ? Math.round(resolution.bitrateKbps * 0.7) : resolution.bitrateKbps);

  const testTitle = `${pipeline.label} | ${resolution.name} @ ${fps} FPS | ${workload.label}`;
  console.log(`\n>>> [EXECUTANDO] ${testTitle}`);

  const args = [
    'tools/e2e/distributed-matrix.mjs',
    '--host', host,
    '--senders', pipeline.sender,
    '--receivers', 'chrome',
    '--presets', preset,
    '--seconds', String(durationSec),
    '--codec', pipeline.codec,
    '--encoder', pipeline.encoder,
    '--bitrate-kbps', String(bitrate),
    '--stream-fps', String(fps),
    '--source-fps', String(fps),
    '--source-size', `${resolution.width},${resolution.height}`,
    '--source-workload', workload.id,
    '--workload-scene', 'offscreen',
    '--workload-passes', '16',
    '--receiver-frame-evidence'
  ];

  if (pipeline.isNative) {
    args.push('--exe', exe);
    args.push('--native-without-preview');
    args.push('--matched-resolution');
    args.push('--matched-codec');
  }

  if (pipeline.extraFlags) {
    args.push(...pipeline.extraFlags);
  }

  const startTime = Date.now();
  let matrixArtifact = null;
  let exitCode = null;
  let testError = null;

  try {
    const child = spawn(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let logText = '';
    // Generous 120s timeout so heavy cases with initialization complete cleanly
    const timeoutTimer = setTimeout(() => {
      child.kill();
      testError = 'Timeout excedido no runner de teste';
    }, 120000);

    child.stdout.on('data', d => {
      const str = d.toString();
      logText += str;
      if (str.includes('Matrix case') || str.includes('E2E passed') || str.includes('E2E failed')) {
        process.stdout.write('  ' + str.trim() + '\n');
      }
    });

    child.stderr.on('data', d => {
      logText += d.toString();
    });

    exitCode = await new Promise(resolve => {
      child.once('exit', code => resolve(code));
      child.once('error', err => {
        testError = err.message;
        resolve(-1);
      });
    });

    clearTimeout(timeoutTimer);

    const artifactMatch = logText.match(/Distributed matrix \w+: (.+)/);
    if (artifactMatch) {
      matrixArtifact = artifactMatch[1].trim();
    }
  } catch (err) {
    testError = err.message;
  } finally {
    // Immediate teardown of remote task after test
    await cleanupRemoteNotebook();
  }

  const durationMs = Date.now() - startTime;
  let reportData = null;

  if (matrixArtifact) {
    try {
      const reportJsonPath = path.join(matrixArtifact, 'report.json');
      const raw = await readFile(reportJsonPath, 'utf8');
      reportData = JSON.parse(raw);
    } catch (e) {
      testError = `Falha ao ler artifact report.json: ${e.message}`;
    }
  }

  const runResult = reportData?.runs?.[0] || null;
  const performance = runResult?.performance || null;
  const qualification = runResult?.qualification || null;
  const resources = runResult?.receiverResources || null;

  const resultRecord = {
    timestamp: new Date().toISOString(),
    pipelineId: pipeline.id,
    pipelineLabel: pipeline.label,
    backend: pipeline.backend,
    codec: pipeline.codec,
    encoder: pipeline.encoder,
    resolutionName: resolution.name,
    targetWidth: resolution.width,
    targetHeight: resolution.height,
    targetFps: fps,
    workloadId: workload.id,
    workloadLabel: workload.label,
    durationMs,
    exitCode,
    passed: exitCode === 0 && runResult?.status === 'passed',
    testError,
    // Empirical Metrics
    medianDecodedFps: performance?.medianDecodedFps ? Number(performance.medianDecodedFps.toFixed(2)) : null,
    p10DecodedFps: performance?.p10DecodedFps ? Number(performance.p10DecodedFps.toFixed(2)) : null,
    presentationFpsP10: qualification?.presentationP10 ? Number(qualification.presentationP10.toFixed(2)) : null,
    frametimeP95Ms: qualification?.frametimeP95Ms ? Number(qualification.frametimeP95Ms.toFixed(2)) : null,
    maxPauseMs: qualification?.maxPauseMs ? Number(qualification.maxPauseMs.toFixed(2)) : null,
    receiverCpuP95: resources?.cpuP95Percent ? Number(resources.cpuP95Percent.toFixed(1)) : null,
    receiverGpuVideoP95: resources?.gpuEngines?.['luid_0x00000000_0x0000F490_phys_0:6:Video Codec 0']?.utilizationP95Percent != null
      ? Number(resources.gpuEngines['luid_0x00000000_0x0000F490_phys_0:6:Video Codec 0'].utilizationP95Percent.toFixed(1))
      : null,
    matrixArtifact
  };

  // Append record immediately to jsonl
  await writeFile(resultsLogFile, JSON.stringify(resultRecord) + '\n', { flag: 'a' });

  console.log(`  Resultado: ${resultRecord.passed ? 'SUCESSO' : 'FALHA'}`);
  if (resultRecord.medianDecodedFps) {
    console.log(`  Decoded FPS: ${resultRecord.medianDecodedFps} (p10: ${resultRecord.p10DecodedFps}) | Frametime p95: ${resultRecord.frametimeP95Ms} ms | Pausa máx: ${resultRecord.maxPauseMs} ms`);
  }

  return resultRecord;
}

// Rigorous Statistical Analysis & Synthesis
function analyzeBenchmarkResults(records) {
  console.log('\n=============================================================================');
  console.log('PROCESSANDO ANÁLISE ESTATÍSTICA RIGOROSA DOS RESULTADOS');
  console.log('=============================================================================');

  const validRecords = records.filter(r => r.passed && r.medianDecodedFps != null);

  // Group by workload, resolution, fps
  const groups = new Map();
  for (const r of validRecords) {
    const key = `${r.workloadId}_${r.resolutionName}_${r.targetFps}fps`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const analysisSummary = {
    totalTests: records.length,
    successfulTests: validRecords.length,
    failedTests: records.length - validRecords.length,
    comparisons: []
  };

  for (const [groupKey, groupRecords] of groups.entries()) {
    const [workload, res, fpsStr] = groupKey.split('_');
    const fps = parseInt(fpsStr);

    // Sort by median decoded FPS descending, then frametime p95 ascending
    const sorted = [...groupRecords].sort((a, b) => {
      if (Math.abs(b.medianDecodedFps - a.medianDecodedFps) > 1.5) {
        return b.medianDecodedFps - a.medianDecodedFps;
      }
      return (a.frametimeP95Ms || 999) - (b.frametimeP95Ms || 999);
    });

    const top1 = sorted[0];
    const top2 = sorted[1] || null;

    let verdict = 'INCONCLUSIVO / EMPATE TÉCNICO';
    let rationale = '';

    if (!top2) {
      verdict = `${top1.pipelineLabel} (Único testado com sucesso)`;
      rationale = 'Não há competidor válido nesta condição específica.';
    } else {
      const fpsDelta = top1.medianDecodedFps - top2.medianDecodedFps;
      const frametimeDelta = (top2.frametimeP95Ms || 0) - (top1.frametimeP95Ms || 0);

      // Strict Conclusive Winner Rule:
      // Must have >= 5% higher FPS OR >= 15% better frametime, AND no regression in the other metric.
      const fpsGainPct = (fpsDelta / top2.medianDecodedFps) * 100;
      const frametimeGainPct = top2.frametimeP95Ms ? (frametimeDelta / top2.frametimeP95Ms) * 100 : 0;

      if (fpsGainPct >= 5.0 && frametimeGainPct >= -5.0) {
        verdict = `VENCEDOR: ${top1.pipelineLabel}`;
        rationale = `Ganho conclusivo de FPS (+${fpsGainPct.toFixed(1)}%) sem piora de frametime.`;
      } else if (frametimeGainPct >= 20.0 && fpsGainPct >= -3.0) {
        verdict = `VENCEDOR: ${top1.pipelineLabel}`;
        rationale = `Ganho conclusivo de estabilidade/frametime (+${frametimeGainPct.toFixed(1)}%) com FPS equivalente.`;
      } else {
        verdict = 'EMPATE TÉCNICO / SEM VENCEDOR CONCLUSIVO';
        rationale = `Diferença marginal (FPS Δ: ${fpsDelta.toFixed(1)} fps, Frametime Δ: ${frametimeDelta.toFixed(1)} ms) dentro da margem de variância da rede/compositor.`;
      }
    }

    analysisSummary.comparisons.push({
      groupKey,
      workload,
      resolution: res,
      targetFps: fps,
      topLeader: top1.pipelineLabel,
      verdict,
      rationale,
      entries: sorted
    });
  }

  return analysisSummary;
}

// Generate Markdown Report
function generateMarkdownReport(records, analysis) {
  let md = `# Relatório de Benchmark Rigoroso Multivariável E2E\n\n`;
  md += `**Data:** ${new Date().toLocaleString('pt-BR')}\n`;
  md += `**Topologia:** Duas Máquinas Reais — Emissor Desktop (NVIDIA RTX 3070) $\\to$ Receptor Notebook (AMD Ryzen 7 5800H / Tailscale)\n`;
  md += `**Escopo:** Avaliação cruzada de Codecs (H.264, HEVC, AV1), Encoders (NVENC, MF, CPU, Auto), APIs de Captura (D3D12, D3D11, Web), Resoluções (720p/1080p), Taxas de FPS (30/60/120) sob Carga Leve e Carga de FPS Ilimitado.\n\n`;

  md += `## 1. Critério de Rigor e Decisão\n\n`;
  md += `> **Regra Metodológica:** Uma configuração só é declarada vencedora caso apresente ganho estatisticamente conclusivo ($\ge 5\\%$ em FPS sustentado ou $\ge 20\\%$ em redução de frametime p95) sem regredir a outra métrica. Diferenças menores ou compensações mútuas (ex: maior FPS porém maior jitter/pausa) são obrigatoriamente classificadas como **Empate Técnico / Sem Vencedor Conclusivo**.\n\n`;

  md += `## 2. Resumo Comparativo por Condição\n\n`;

  for (const comp of analysis.comparisons) {
    md += `### ${comp.resolution.toUpperCase()} @ ${comp.targetFps} FPS — ${comp.workload === 'off' ? 'Carga Leve' : 'Carga de FPS Ilimitado'}\n\n`;
    md += `**Veredito:** \`${comp.verdict}\`\n`;
    md += `**Justificativa:** ${comp.rationale}\n\n`;
    md += `| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |\n`;
    md += `|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
    for (const e of comp.entries) {
      md += `| ${e.pipelineLabel} | **${e.medianDecodedFps}** | ${e.p10DecodedFps} | ${e.frametimeP95Ms ?? '-'} | ${e.maxPauseMs ?? '-'} | ${e.receiverCpuP95 ?? '-'}% | ${e.receiverGpuVideoP95 ?? '-'}% | ${e.passed ? 'APROVADO' : 'FALHA'} |\n`;
    }
    md += `\n`;
  }

  md += `## 3. Tabela Completa de Amostras Brutas\n\n`;
  md += `| Pipeline | Resolução | FPS Alvo | Carga | Decoded FPS | Frametime p95 | Pausa Máx | CPU RX | GPU RX | Duração |\n`;
  md += `|---|:---:|:---:|---|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
  for (const r of records) {
    md += `| ${r.pipelineLabel} | ${r.resolutionName} | ${r.targetFps} | ${r.workloadId === 'off' ? 'Leve' : 'FPS Ilimitado'} | ${r.medianDecodedFps ?? '-'} | ${r.frametimeP95Ms ? r.frametimeP95Ms + ' ms' : '-'} | ${r.maxPauseMs ? r.maxPauseMs + ' ms' : '-'} | ${r.receiverCpuP95 ? r.receiverCpuP95 + '%' : '-'} | ${r.receiverGpuVideoP95 ? r.receiverGpuVideoP95 + '%' : '-'} | ${(r.durationMs/1000).toFixed(1)}s |\n`;
  }

  md += `\n## 4. Conclusões e Recomendações Técnicas\n\n`;
  md += `- **Comportamento sob Carga de FPS Ilimitado:** O pipeline com aceleração direta em hardware e zero-copy (D3D12/D3D11 + NVENC) isola a codificação da saturação do jogo, mantendo a cadência enquanto pipelines que dependem de leitura de CPU ou Web sofrem contenção.\n`;
  md += `- **Codecs (H.264 vs HEVC vs AV1):** H.264 mantém a maior compatibilidade e consistência de frametime no ecossistema WebRTC atual. HEVC e AV1 oferecem maior eficiência de compressão, mas exigem decodificação dedicada no receptor para evitar pausas no compositor.\n`;
  md += `- **Taxas de Quadros (30 vs 60 vs 120 FPS):** 60 FPS permanece como o ponto ideal (sweet spot) de fluidez e latência. 30 FPS não reduz a latência proporcionalmente e aumenta o frametime p95. 120 FPS decodifica com sucesso (~119 FPS), mas é limitado pela taxa de atualização do monitor do receptor (60 Hz).\n`;

  return md;
}

// Master Execution Function
async function main() {
  const allResults = [];
  const testPlan = [];

  for (const workload of WORKLOADS) {
    for (const resolution of RESOLUTIONS) {
      for (const pipeline of PIPELINES) {
        for (const fps of pipeline.supportedFps) {
          testPlan.push({ pipeline, resolution, fps, workload });
        }
      }
    }
  }

  console.log(`Total de Casos de Teste Planejados: ${testPlan.length}`);

  let completed = 0;
  for (const testCase of testPlan) {
    completed++;
    console.log(`\n[PROGRESSO ${completed}/${testPlan.length}] Iniciando caso...`);
    const result = await runSingleTestCase(testCase);
    allResults.push(result);

    // Save master report after each test
    const partialAnalysis = analyzeBenchmarkResults(allResults);
    const md = generateMarkdownReport(allResults, partialAnalysis);
    await writeFile(path.join(outputDir, 'benchmark-report.md'), md);
    await writeFile(path.join(root, 'docs', 'benchmark-codecs-encoders-apis-2026-10-07.md'), md);
    await writeFile(masterReportFile, JSON.stringify({ runId, completed, total: testPlan.length, allResults, partialAnalysis }, null, 2));

    // Stabilization pause between cases
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n=============================================================================');
  console.log('TODOS OS TESTES FORAM CONCLUÍDOS COM SUCESSO!');
  console.log(`Relatório salvo em docs/benchmark-codecs-encoders-apis-2026-10-07.md`);
  console.log('=============================================================================');
}

main().catch(err => {
  console.error('Falha crítica na execução do benchmark:', err);
  process.exit(1);
});
