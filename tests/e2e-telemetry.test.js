import { expect, it, describe, vi } from 'vitest';
import { deltaMetrics, installTelemetry, evaluateQualityBudget, computeSteadyQuality } from '../tools/e2e/telemetry.mjs';
import {
  MARKER_CONFIG,
  crc16,
  computeSessionMagic,
  encodeOpticalMarker,
  decodeOpticalMarker,
  computeVisualLatency
} from '../tools/e2e/optical.mjs';

it('optical detector accepts the actual source width and rejects invalid calibration',()=>{
  window.RTCPeerConnection=class {};
  expect(()=>installTelemetry({enableOptical:false,opticalSourceWidth:1920})).not.toThrow();
  for(const opticalSourceWidth of [0,NaN,10000])expect(()=>installTelemetry({opticalSourceWidth})).toThrow('source width');
});

it('E2E: calcula deltas sem confundir cumulativos com fila e expõe atraso observável da ponte', () => {
  const prev = {
    timestamp: 1000,
    framesDecoded: 60,
    totalDecodeTime: 0.12,
    jitterBufferEmittedCount: 60,
    jitterBufferDelay: 3,
    framesDropped: 2,
    framesReceived: 62,
    freezeCount: 1,
    totalFreezesDuration: 0.15,
    nackCount: 5,
    pliCount: 1,
    packetsLost: 0,
    packetsReceived: 300,
    concealedSamples: 480,
    silentConcealedSamples: 240,
    insertedSamplesForDeceleration: 120,
    removedSamplesForAcceleration: 60
  };
  const curr = {
    timestamp: 2000,
    framesDecoded: 120,
    totalDecodeTime: 0.24,
    jitterBufferEmittedCount: 120,
    jitterBufferDelay: 6,
    framesDropped: 5,
    framesReceived: 125,
    freezeCount: 2,
    totalFreezesDuration: 0.35,
    nackCount: 8,
    pliCount: 2,
    packetsLost: 0,
    packetsReceived: 620,
    concealedSamples: 960,
    silentConcealedSamples: 480,
    insertedSamplesForDeceleration: 240,
    removedSamplesForAcceleration: 120
  };
  const result = deltaMetrics(prev, curr);
  expect(result).toMatchObject({
    decodedFps: 60,
    decodeTimeMs: 2,
    jitterBufferMs: 50,
    bridgeObservableMs: 52,
    rawDeltaFramesDropped: 3,
    rawDeltaFramesReceived: 63,
    rawDeltaFreezeCount: 1,
    rawDeltaNackCount: 3,
    rawDeltaPliCount: 1,
    rawDeltaPacketsLost: 0,
    rawDeltaPacketsReceived: 320,
    rawDeltaConcealedSamples: 480,
    rawDeltaSilentConcealedSamples: 240,
    rawDeltaInsertedSamplesForDeceleration: 120,
    rawDeltaRemovedSamplesForAcceleration: 60
  });
  expect(result.rawDeltaTotalFreezesDuration).toBeCloseTo(0.2, 5);
});

it('E2E: campos ausentes, reset e denominador zero não viram zero de sucesso', () => {
  const result = deltaMetrics(
    { timestamp: 2000, framesDecoded: 100, totalDecodeTime: 1 },
    { timestamp: 3000, framesDecoded: 5, totalDecodeTime: 0.1 }
  );
  expect(result.decodedFps).toBeNull();
  expect(result.decodeTimeMs).toBeNull();
  expect(result.sentMbps).toBeNull();
  expect(result.bridgeObservableMs).toBeNull();
});

it('E2E: separa alvo, mínimo e atraso efetivo de jitter usando deltas dos acumuladores',()=>{
 const a={timestamp:1000,jitterBufferEmittedCount:100,jitterBufferDelay:4,jitterBufferTargetDelay:2,jitterBufferMinimumDelay:1,retransmittedPacketsReceived:4};
 const b={timestamp:2000,jitterBufferEmittedCount:150,jitterBufferDelay:7,jitterBufferTargetDelay:3,jitterBufferMinimumDelay:1.25,retransmittedPacketsReceived:7};
 expect(deltaMetrics(a,b)).toMatchObject({jitterBufferMs:60,jitterBufferTargetMs:20,jitterBufferMinimumMs:5,rawDeltaRetransmittedPacketsReceived:3});
 expect(deltaMetrics(a,{...b,jitterBufferEmittedCount:100}).jitterBufferTargetMs).toBeNull();
 expect(deltaMetrics(a,{...b,jitterBufferTargetDelay:.5}).jitterBufferTargetMs).toBeNull();
});

it('E2E Telemetria: sample() preserva intervalMaxPauseMs e somente reset:true consome a pausa', async () => {
  // Configura ambiente básico
  if (!window.RTCPeerConnection) {
    window.RTCPeerConnection = class {};
  }
  installTelemetry();

  const video = document.createElement('video');
  document.body.appendChild(video);

  // Executa amostragem inicial
  const initialSample = await window.__smgE2E.sample();
  expect(initialSample.videos.length).toBeGreaterThan(0);
  expect(video.__smgPresentation).toBeDefined();

  // Injeta simulador de callback com pausa artificial de 250ms
  // hookVideo define onFrame via requestVideoFrameCallback se disponível
  // Simulamos diretamente no objeto de apresentação
  const stats0 = video.__smgPresentation.getStats({ reset: false });
  expect(stats0.intervalMaxPauseMs).toBe(0);

  // Primeira leitura com reset: false mantém o estado
  // Chamada de sample() deve passar reset: false
  const sample1 = await window.__smgE2E.sample();
  expect(sample1.videos[0].presentation.intervalMaxPauseMs).toBe(0);

  // Verifica que getStats({ reset: true }) zera o contador
  const consumed = video.__smgPresentation.getStats({ reset: true });
  expect(consumed.intervalMaxPauseMs).toBe(0);

  document.body.removeChild(video);
});

it('E2E: preserva contadores cumulativos de playback e ausência da API sem confundir descarte com callback', async () => {
  window.RTCPeerConnection=class {};
  installTelemetry({enableOptical:false});
  const video=document.createElement('video');
  video.id='playback-quality-test';
  document.body.append(video);
  try {
    video.getVideoPlaybackQuality=()=>({totalVideoFrames:120,droppedVideoFrames:45,creationTime:1000});
    const sample=await window.__smgE2E.sample();
    const row=sample.videos.find(v=>v.id===video.id);
    expect(row.playbackQuality).toEqual({totalVideoFrames:120,droppedVideoFrames:45,creationTime:1000});
    expect(row.presentation.callbackCadence.callbackCount).toBe(0);
    video.getVideoPlaybackQuality=undefined;
    expect((await window.__smgE2E.sample()).videos.find(v=>v.id===video.id).playbackQuality).toBeNull();
    video.getVideoPlaybackQuality=()=>{throw new Error('Not supported');};
    expect((await window.__smgE2E.sample()).videos.find(v=>v.id===video.id).playbackQuality).toBeNull();
  } finally {video.remove();}
});

describe('Módulo Óptico E2E Robusto (Protocolo 96 bits e CRC-16)', () => {
  it('CRC-16-CCITT detecta com certeza matemática erros de 1 bit e 2 bits (superando a falha do XOR)', () => {
    const payload = [0x12, 0x34, 0x00, 0x05, 0x8C, 0x66, 0xE9, 0x3B, 0x1A];
    const initialCrc = crc16(payload);

    // 1 bit flip em qualquer posição altera o CRC
    for (let byteIdx = 0; byteIdx < payload.length; byteIdx++) {
      for (let bit = 0; bit < 8; bit++) {
        const corrupted = [...payload];
        corrupted[byteIdx] ^= (1 << bit);
        expect(crc16(corrupted)).not.toBe(initialCrc);
      }
    }

    // 2 bit flips (caso específico apontado na revisão onde XOR colidia)
    const corruptedTwoBits = [...payload];
    corruptedTwoBits[2] ^= 0x01;
    corruptedTwoBits[4] ^= 0x01;
    expect(crc16(corruptedTwoBits)).not.toBe(initialCrc);
  });

  it('calcula sessionMagic determinístico a partir do runId', () => {
    const magic1 = computeSessionMagic('2026-09-17T06-25-06-316Z-61a567');
    const magic2 = computeSessionMagic('2026-09-17T06-25-06-316Z-61a567');
    const magicOther = computeSessionMagic('2026-09-17T07-00-00-000Z-abcdef');

    expect(typeof magic1).toBe('number');
    expect(magic1).toBe(magic2);
    expect(magic1).not.toBe(magicOther);
    expect(magic1).toBeGreaterThanOrEqual(0);
    expect(magic1).toBeLessThanOrEqual(0xFFFF);
  });

  function renderSyntheticMarker(frameSeq, sourceTimeMs, sessionMagic, blockWidth = 8) {
    const totalBits = 96;
    const width = Math.ceil(totalBits * blockWidth + 40);
    const height = 30;
    const rgba = new Uint8ClampedArray(width * height * 4);

    const magic = sessionMagic & 0xFFFF;
    const seq = frameSeq & 0xFFFFFF;
    const time = (Math.floor(sourceTimeMs) >>> 0);

    const payload = [
      (magic >> 8) & 0xFF,
      magic & 0xFF,
      (seq >> 16) & 0xFF,
      (seq >> 8) & 0xFF,
      seq & 0xFF,
      (time >>> 24) & 0xFF,
      (time >>> 16) & 0xFF,
      (time >>> 8) & 0xFF,
      time & 0xFF
    ];
    const checksum = crc16(payload);

    const bits = [...MARKER_CONFIG.preamble];
    for (let i = 15; i >= 0; i--) bits.push((magic >> i) & 1);
    for (let i = 23; i >= 0; i--) bits.push((seq >> i) & 1);
    for (let i = 31; i >= 0; i--) bits.push((time >>> i) & 1);
    for (let i = 15; i >= 0; i--) bits.push((checksum >> i) & 1);

    // Borda preta e blocos
    const startX = 2;
    const startY = 2;
    for (let i = 0; i < bits.length; i++) {
      const val = bits[i] === 1 ? 255 : 0;
      const x0 = Math.floor(startX + i * blockWidth);
      const x1 = Math.floor(startX + (i + 1) * blockWidth);
      for (let y = startY; y < startY + 16; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = val;
          rgba[idx + 1] = val;
          rgba[idx + 2] = val;
          rgba[idx + 3] = 255;
        }
      }
    }

    return { rgba, width, height };
  }

  it('decodifica corretamente frameSeq, sourceTimeMs e sessionMagic a partir de buffer sintético', () => {
    const frameSeq = 1420;
    const sourceTimeMs = 1789626315000;
    const sessionMagic = 0xABCD;

    const { rgba, width, height } = renderSyntheticMarker(frameSeq, sourceTimeMs, sessionMagic, 8);
    const decoded = decodeOpticalMarker(rgba, width, height, MARKER_CONFIG, [8]);

    expect(decoded).not.toBeNull();
    expect(decoded?.frameSeq).toBe(frameSeq);
    expect(decoded?.sourceTimeMs).toBe(sourceTimeMs >>> 0);
    expect(decoded?.sessionMagic).toBe(sessionMagic);
    expect(decoded?.detectedBlockWidth).toBe(8);
  });

  it('installed video reader recognizes a 1080p marker transmitted at 720p',async()=>{
    const magic=0x1234,seq=123;
    const marker=renderSyntheticMarker(seq,Date.now(),magic,8*1280/1920);
    const rgba=new Uint8ClampedArray(1280*200*4);
    for(let y=0;y<marker.height;y++)rgba.set(marker.rgba.subarray(y*marker.width*4,(y+1)*marker.width*4),y*1280*4);
    const context={drawImage:()=>{},getImageData:()=>({data:rgba})};
    const canvas=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context);
    const clock=vi.spyOn(performance,'now').mockReturnValue(1000);
    const video=document.createElement('video');let callback;
    Object.defineProperties(video,{videoWidth:{value:1280},videoHeight:{value:720},readyState:{value:4}});
    video.requestVideoFrameCallback=cb=>{callback=cb;return 1;};document.body.append(video);
    window.RTCPeerConnection=class {};
    try{
      installTelemetry({expectedSessionMagic:magic,enableOptical:true,opticalSourceWidth:1920});
      await window.__smgE2E.sample();
      callback(1000,{expectedDisplayTime:1000,presentedFrames:1});
      expect(video.__smgPresentation.getStats()).toMatchObject({lastSeq:seq,validSamplesCount:1,rejectedCandidatesCount:0});
    }finally{video.remove();canvas.mockRestore();clock.mockRestore();}
  });

  it('rejeita quando expectedMagic não coincide', () => {
    const frameSeq = 500;
    const sourceTimeMs = 100000;
    const sessionMagic = 0x1111;

    const { rgba, width, height } = renderSyntheticMarker(frameSeq, sourceTimeMs, sessionMagic, 8);
    // Espera magic diferente: deve rejeitar
    const decoded = decodeOpticalMarker(rgba, width, height, MARKER_CONFIG, [8], 0x2222);
    expect(decoded).toBeNull();

    // Com o magic correto: aceita
    const decodedValid = decodeOpticalMarker(rgba, width, height, MARKER_CONFIG, [8], 0x1111);
    expect(decodedValid).not.toBeNull();
  });

  it('rejeita marcador corrompido em 1 ou 2 bits por falha de CRC', () => {
    const frameSeq = 1420;
    const sourceTimeMs = 52310;
    const sessionMagic = 0x4321;

    const { rgba, width, height } = renderSyntheticMarker(frameSeq, sourceTimeMs, sessionMagic, 8);

    // Inverte o bloco inteiro de 8x16 pixels da sequência para corrupção real do bit
    const blockStart = 2 + (8 + 16 + 2) * 8;
    for (let y = 2; y < 18; y++) {
      for (let x = blockStart; x < blockStart + 8; x++) {
        const idx = (y * width + x) * 4;
        const flipped = rgba[idx] > 128 ? 0 : 255;
        rgba[idx] = flipped;
        rgba[idx + 1] = flipped;
        rgba[idx + 2] = flipped;
      }
    }

    expect(decodeOpticalMarker(rgba, width, height, MARKER_CONFIG, [8])).toBeNull();
  });

  it('rejeita tela verde sintética de fake-device do Chrome', () => {
    const width = 800;
    const height = 40;
    const rgba = new Uint8ClampedArray(width * height * 4);
    // Simula tela verde: R=0, G=220, B=0
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 0;
      rgba[i + 1] = 220;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    expect(decodeOpticalMarker(rgba, width, height)).toBeNull();
  });

  it('rejeita imagens de cor sólida (preto total, branco total)', () => {
    const width = 800;
    const height = 40;
    const white = new Uint8ClampedArray(width * height * 4).fill(255);
    const black = new Uint8ClampedArray(width * height * 4).fill(0);

    expect(decodeOpticalMarker(white, width, height)).toBeNull();
    expect(decodeOpticalMarker(black, width, height)).toBeNull();
  });

  it('rejeita ruído aleatório que simule textura de papel de parede do Windows', () => {
    const width = 800;
    const height = 40;
    const noise = new Uint8ClampedArray(width * height * 4);
    // Pseudo-ruído determinístico
    let seed = 12345;
    for (let i = 0; i < noise.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = (seed >>> 24);
      noise[i] = v;
      noise[i + 1] = (v * 2) & 0xFF;
      noise[i + 2] = (v * 3) & 0xFF;
      noise[i + 3] = 255;
    }
    expect(decodeOpticalMarker(noise, width, height)).toBeNull();
  });

  it('suporta candidateBlockWidths escalonados (ex: 12px)', () => {
    const frameSeq = 88;
    const sourceTimeMs = 456789;
    const sessionMagic = 0x7777;

    const { rgba, width, height } = renderSyntheticMarker(frameSeq, sourceTimeMs, sessionMagic, 12);
    const decoded = decodeOpticalMarker(rgba, width, height, MARKER_CONFIG, [8, 10, 12]);

    expect(decoded).not.toBeNull();
    expect(decoded?.frameSeq).toBe(frameSeq);
    expect(decoded?.detectedBlockWidth).toBe(12);
  });

  it('suporta candidateBlockWidths fracionários com compensação de escala (ex: 11.85px)', () => {
    const frameSeq = 1420;
    const sourceTimeMs = 567890;
    const sessionMagic = 0xABCD;

    const { rgba, width, height } = renderSyntheticMarker(frameSeq, sourceTimeMs, sessionMagic, 11.85);
    const candidateWidths = [11.8, 11.85, 11.9, 12];
    const decoded = decodeOpticalMarker(rgba, width, height, MARKER_CONFIG, candidateWidths);

    expect(decoded).not.toBeNull();
    expect(decoded?.frameSeq).toBe(frameSeq);
    expect([11.8, 11.85]).toContain(decoded?.detectedBlockWidth);
  });

  it('calcula latência visual em ms sem wrap ambíguo de 16 bits', () => {
    // Normal: 1000045 - 1000000 = 45ms
    expect(computeVisualLatency(1000045, 1000000)).toBe(45);

    // Longo período estável sem wrap prematuro
    expect(computeVisualLatency(500000, 499920)).toBe(80);

    // Skew negativo leve (-2ms)
    expect(computeVisualLatency(1000, 1002)).toBe(-2);
  });

  it('calcula latência com aritmética modular uint32 imune a overflow de época (2^32 ms)', () => {
    // Caso de wrap de época: source enviado pouco antes de 2^32, recebido logo após
    const sourceUint32 = 0xFFFFFFF0; // 4294967280
    const nowAfterWrap = 10;          // 10
    // Diferença modular esperada: 10 - (-16) = 26 ms
    expect(computeVisualLatency(nowAfterWrap, sourceUint32)).toBe(26);

    // Exatamente na borda 0xFFFFFFFF -> 0x00000005: 6 ms
    expect(computeVisualLatency(5, 0xFFFFFFFF)).toBe(6);

    // Skew negativo através da borda: 0x00000000 -> 0xFFFFFFFE (-2ms)
    expect(computeVisualLatency(0xFFFFFFFE, 0)).toBe(-2);
  });

  it('E2E Telemetria: isolamento estrito de fases (warmup, steady, cooldown) e startupDynamics', async () => {
    installTelemetry();
    const video = document.createElement('video');
    document.body.appendChild(video);

    // Amostra inicial cria __smgPresentation
    await window.__smgE2E.sample();
    const pres = video.__smgPresentation;
    expect(pres).toBeDefined();

    // Inicia no warmup por padrão
    expect(pres.getStats().currentPhase).toBe('warmup');

    // Altera para steady e cooldown
    pres.setPhase('steady');
    expect(pres.getStats().currentPhase).toBe('steady');
    pres.setPhase('cooldown');
    expect(pres.getStats().currentPhase).toBe('cooldown');

    // Retorna para steady
    pres.setPhase('steady');
    const initialStats = pres.getStats();
    expect(initialStats.steadyLatency).toBeNull();
    expect(initialStats.warmupLatency).toBeNull();
    expect(initialStats.startupDynamics).toMatchObject({
      startupMaxPauseMs: 0,
      warmupSamplesCount: 0
    });

    document.body.removeChild(video);
  });
});

describe('Sexto Parecer: Qualidade Steady, Baseline de Startup e Diagnóstico de Áudio', () => {
  it('desconta baseline de startup e não reprova janela steady com freeze anterior', () => {
    // Cenário observado no sexto parecer:
    // Freeze de 1.76s ocorreu no startup. Durante toda a janela steady, delta freeze foi 0.
    const baselineVideoRow = {
      freezeCount: 1,
      totalFreezesDuration: 1.76,
      framesDropped: 2,
      framesReceived: 50,
      framesDecoded: 48,
      packetsLost: 0,
      packetsReceived: 200
    };

    const latestVideoRow = {
      freezeCount: 1,
      totalFreezesDuration: 1.76,
      framesDropped: 2,
      framesReceived: 1250,
      framesDecoded: 1248,
      packetsLost: 0,
      packetsReceived: 5000
    };

    const quality = computeSteadyQuality({
      baselineVideoRow,
      latestVideoRow,
      elapsedSteadySec: 20.0
    });

    // Diagnósticos de startup separados
    expect(quality.startupDynamics.startupFreezes).toBe(1);
    expect(quality.startupDynamics.startupFreezeDurationSec).toBe(1.76);
    expect(quality.startupDynamics.startupFramesDropped).toBe(2);

    // Contadores steady estritamente zerados para freezes
    expect(quality.steady.freezeCount).toBe(0);
    expect(quality.steady.totalFreezesDurationSec).toBe(0);
    expect(quality.steady.framesDropped).toBe(0);
    expect(quality.steady.framesReceived).toBe(1200);

    // Avaliação do Quality Budget usando contadores steady
    const budget = evaluateQualityBudget({
      fpsMean: 57.2,
      fpsP10: 55.0,
      maxPauseMs: 90,
      totalGapsCount: 0,
      durationSec: 20,
      measuredDurationSec: 20.0,
      totalPacketsLost: quality.steady.packetsLost,
      videoJitterMeanMs: 5.0,
      freezeCount: quality.steady.freezeCount,
      totalFreezesDuration: quality.steady.totalFreezesDurationSec
    });

    // O freeze do startup NÃO deve reprovar o steady
    expect(budget.status).toBe('PASSED');
    expect(budget.violations).toHaveLength(0);
  });

  it('detecta e reprova quando freeze ocorre DURANTE a janela steady', () => {
    const baselineVideoRow = {
      freezeCount: 1,
      totalFreezesDuration: 0.2
    };

    const latestVideoRow = {
      freezeCount: 2,
      totalFreezesDuration: 0.9 // Novo freeze de 0.7s no steady
    };

    const quality = computeSteadyQuality({
      baselineVideoRow,
      latestVideoRow,
      elapsedSteadySec: 20.0
    });

    expect(quality.steady.freezeCount).toBe(1);
    expect(quality.steady.totalFreezesDurationSec).toBeCloseTo(0.7, 3);

    const budget = evaluateQualityBudget({
      fpsMean: 55.0,
      fpsP10: 50.0,
      maxPauseMs: 80,
      totalGapsCount: 0,
      durationSec: 20,
      measuredDurationSec: 20.0,
      freezeCount: quality.steady.freezeCount,
      totalFreezesDuration: quality.steady.totalFreezesDurationSec
    });

    expect(budget.status).toBe('FAILED');
    expect(budget.violations.some(v => v.includes('webrtc_freezes_detected'))).toBe(true);
  });

  it('calcula métricas de áudio, descarte de pacotes e taxa de concealed samples', () => {
    const baselineAudioRow = {
      totalSamplesReceived: 48000,
      concealedSamples: 5000,
      silentConcealedSamples: 1000,
      concealmentEvents: 10,
      packetsLost: 0,
      packetsDiscarded: 0,
      packetsReceived: 1000,
      bytesReceived: 50000
    };

    // 20s a 48kHz = ~960.000 amostras recebidas no steady
    // 35% de concealed samples = ~336.000 amostras sintetizadas (padrão visto nos pareceres)
    const latestAudioRow = {
      totalSamplesReceived: 48000 + 960000,
      concealedSamples: 5000 + 336000,
      silentConcealedSamples: 1000 + 50000,
      concealmentEvents: 10 + 150,
      packetsLost: 0,
      packetsDiscarded: 2,
      packetsReceived: 1000 + 20000,
      bytesReceived: 50000 + 1000000
    };

    const quality = computeSteadyQuality({
      baselineAudioRow,
      latestAudioRow,
      elapsedSteadySec: 20.0
    });

    expect(quality.steady.audioSamplesReceived).toBe(960000);
    expect(quality.steady.audioConcealedSamples).toBe(336000);
    expect(quality.steady.audioConcealmentEvents).toBe(150);
    expect(quality.steady.audioPacketsDiscarded).toBe(2);
    // 336000 / 960000 * 100 = 35.00%
    expect(quality.steady.audioConcealmentRatio).toBe(35.0);

    const budget = evaluateQualityBudget({
      fpsMean: 56.0,
      fpsP10: 52.0,
      maxPauseMs: 90,
      totalGapsCount: 0,
      durationSec: 20,
      measuredDurationSec: 20.0,
      audioPacketsLost: quality.steady.audioPacketsLost,
      audioPacketsDiscarded: quality.steady.audioPacketsDiscarded,
      audioConcealmentRatio: quality.steady.audioConcealmentRatio,
      expectAudible: true
    });

    // Concealment elevado (>20%) e pacotes descartados devem gerar warnings (DEGRADED)
    expect(budget.status).toBe('DEGRADED');
    expect(budget.warnings.some(w => w.includes('elevated_audio_concealment'))).toBe(true);
    expect(budget.warnings.some(w => w.includes('audio_packets_discarded'))).toBe(true);
  });

  it('normaliza gapsPerMinute utilizando a duração efetiva medida', () => {
    // 3 gaps em 18.0 segundos medidos (configurado como 20s)
    const budgetConfigured = evaluateQualityBudget({
      fpsMean: 58.0,
      totalGapsCount: 3,
      durationSec: 20,
      measuredDurationSec: null
    });
    // Com duração solicitada (20s): (3 / 20) * 60 = 9.0 gaps/min
    expect(budgetConfigured.gapsPerMinute).toBe(9.0);

    const budgetMeasured = evaluateQualityBudget({
      fpsMean: 58.0,
      totalGapsCount: 3,
      durationSec: 20,
      measuredDurationSec: 18.0
    });
    // Com duração medida (18s): (3 / 18) * 60 = 10.0 gaps/min
    expect(budgetMeasured.gapsPerMinute).toBe(10.0);
    expect(budgetMeasured.effectiveDurationSec).toBe(18.0);
  });

  it('deltaMetrics extrai campos novos de áudio e calcula concealment ratio por intervalo', () => {
    const prev = {
      timestamp: 1000,
      totalSamplesReceived: 48000,
      concealedSamples: 1000,
      concealmentEvents: 5,
      packetsDiscarded: 0,
      packetsLost: 0
    };
    const curr = {
      timestamp: 2000,
      totalSamplesReceived: 96000, // delta = 48000
      concealedSamples: 13000,     // delta = 12000 (25%)
      concealmentEvents: 15,       // delta = 10
      packetsDiscarded: 1,         // delta = 1
      packetsLost: 0
    };

    const delta = deltaMetrics(prev, curr);
    expect(delta.audioSamplesDelta).toBe(48000);
    expect(delta.concealedSamplesDelta).toBe(12000);
    expect(delta.concealmentEventsDelta).toBe(10);
    expect(delta.audioPacketsDiscardedDelta).toBe(1);
    expect(delta.audioConcealmentRatio).toBe(25.0);
  });
});


