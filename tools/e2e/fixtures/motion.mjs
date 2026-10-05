import {gameWorkloadScript,validateGameWorkload} from './game-workload.mjs';

export function createMotionFixture(syntheticTitle, sessionMagic, fps = 60, {width=1280,height=720,workload}={}) {
const load=validateGameWorkload(workload);
if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('Cadência sintética inválida');
if (![width,height].every(v=>Number.isInteger(v)&&v>=240&&v<=3840)) throw new Error('Dimensão sintética inválida');
return `<!doctype html>
<title>${syntheticTitle}</title>
<style>
  html, body { background:#0a0f18; color:white; font:24px monospace; margin:0; padding:0; overflow:hidden; }
  canvas { display:block; width:${width}px; height:${height}px; }
</style>
<canvas width="${width}" height="${height}"></canvas>
<script>
const c = document.querySelector('canvas'), x = c.getContext('2d');
let frame = 0;
let lastSec = performance.now();
let framesThisSec = 0;
let instantFps = ${fps};
const runMagic = ${sessionMagic};

window.__smgSourceStats = {
  framesProduced: 0,
  fps: ${fps},
  rafFps: null,
  rafTicks: 0,
  lastTime: Date.now(),
  sessionMagic: runMagic,
  width:${width},height:${height},
  frameLog: []
};

function crc16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

function encodeOptical(seq, timeMs) {
  const magic = runMagic & 0xFFFF;
  const s = seq & 0xFFFFFF;
  const t = (Math.floor(timeMs) >>> 0);
  const payload = [
    (magic >> 8) & 0xFF, magic & 0xFF,
    (s >> 16) & 0xFF, (s >> 8) & 0xFF, s & 0xFF,
    (t >>> 24) & 0xFF, (t >>> 16) & 0xFF, (t >>> 8) & 0xFF, t & 0xFF
  ];
  const checksum = crc16(payload);

  const bits = [1, 0, 1, 0, 1, 1, 0, 0];
  for (let i = 15; i >= 0; i--) bits.push((magic >> i) & 1);
  for (let i = 23; i >= 0; i--) bits.push((s >> i) & 1);
  for (let i = 31; i >= 0; i--) bits.push((t >>> i) & 1);
  for (let i = 15; i >= 0; i--) bits.push((checksum >> i) & 1);

  const blockW = 8;
  const blockH = 16;
  x.fillStyle = '#000000';
  x.fillRect(0, 0, bits.length * blockW + 4, blockH + 4);
  for (let i = 0; i < bits.length; i++) {
    x.fillStyle = bits[i] === 1 ? '#FFFFFF' : '#000000';
    x.fillRect(2 + i * blockW, 2, blockW, blockH);
  }
}

let lastFrameTime = 0;
const targetIntervalMs = 1000 / ${fps};

function renderFrame(now) {
  if (!lastFrameTime) lastFrameTime = now;
  const elapsed = now - lastFrameTime;
  if (elapsed < targetIntervalMs - 1.0) {
    return;
  }
  const steps = Math.max(1, Math.floor((elapsed + 1.0) / targetIntervalMs));
  lastFrameTime += steps * targetIntervalMs;
  if (now - lastFrameTime > targetIntervalMs * 2) {
    lastFrameTime = now;
  }
  const nowMs = Date.now();
  framesThisSec++;
  if (now - lastSec >= 1000) {
    instantFps = Math.round((framesThisSec * 1000) / (now - lastSec));
    framesThisSec = 0;
    lastSec = now;
  }
  window.__smgSourceStats.framesProduced = frame;
  window.__smgSourceStats.fps = instantFps;
  window.__smgSourceStats.lastTime = nowMs;
  window.__smgSourceStats.frameLog.push({ seq: frame, timeMs: nowMs });
  if (window.__smgSourceStats.frameLog.length > 10000) {
    window.__smgSourceStats.frameLog.shift();
  }

  if (${load.profile!=='off'&&load.scene==='visible'}) x.clearRect(0, 0, c.width, c.height);
  else { x.fillStyle = '#142033'; x.fillRect(0, 0, c.width, c.height); }

  // Marcador óptico no topo esquerdo (772px de largura, 20px de altura)
  encodeOptical(frame, nowMs);

  // Bloco de movimento suave de alta visibilidade
  const posX = (now * 0.5) % 1100;
  const posY = 180 + Math.sin(now / 200) * 80;
  x.fillStyle = '#00e5bb';
  x.fillRect(posX, posY, 80, 80);

  // Segundo bloco em contra-fase para teste de judder
  x.fillStyle = '#ff4081';
  x.fillRect((1100 - posX), 320, 60, 60);

  // Informações de telemetria legíveis
  x.fillStyle = 'white';
  x.font = '36px monospace';
  x.fillText('SeeMyGame Glass-to-Glass Source', 380, 70);
  x.font = '28px monospace';
  x.fillText('Frame: ' + frame + '  |  FPS: ' + instantFps + '  |  Magic: ' + runMagic, 40, 130);

  frame++;
}

let rafLastSec = performance.now(), rafTicksThisSec = 0;
function onRaf(t) {
  window.__smgSourceStats.rafTicks++;
  rafTicksThisSec++;
  if (t - rafLastSec >= 1000) {
    window.__smgSourceStats.rafFps = rafTicksThisSec * 1000 / (t - rafLastSec);
    rafTicksThisSec = 0;
    rafLastSec = t;
  }
  requestAnimationFrame(onRaf);
  renderFrame(t);
}
requestAnimationFrame(onRaf);

// Heartbeat resiliente a backgrounding / oclusão do DWM
setInterval(() => {
  renderFrame(performance.now());
}, 8);
${gameWorkloadScript(load)}
</script>`;

}
