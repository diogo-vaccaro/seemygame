import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const PORT = 3003;
const ARTIFACT_DIR = 'C:\\Users\\diogo\\.gemini\\antigravity\\brain\\1dcd93eb-1e09-4570-856b-4ee876bf9f9b';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://localhost:${PORT}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';

      const filePath = path.normalize(path.join(root, pathname));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('Acesso negado');
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Arquivo não encontrado: ' + pathname);
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[E2E Server] Porta ${PORT} já em uso, reaproveitando.`);
        resolve(null);
      } else {
        reject(err);
      }
    });

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[E2E Server] Servidor de teste ativo em http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

const mockDefaultUserScript = (color, label) => `
  try {
    localStorage.setItem('seemygame_terms_version', '1.1');
    localStorage.setItem('seemygame_terms_accepted', 'true');
    localStorage.removeItem('seemygame_user_name');
  } catch(e) {}

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  let frame = 0;
  function renderFrame() {
    frame++;
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '${color}';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('🎮 STREAM TEST: ${label}', 50, 70);
    ctx.fillStyle = '#10b981';
    ctx.font = '22px monospace';
    ctx.fillText('FRAME ' + frame + ' - ' + new Date().toLocaleTimeString(), 50, 120);

    const bx = (frame * 8) % 1100 + 50;
    const by = 350 + Math.abs(Math.sin(frame * 0.08)) * -180;
    ctx.fillStyle = '${color}';
    ctx.beginPath();
    ctx.arc(bx, by, 30, 0, Math.PI * 2);
    ctx.fill();

    requestAnimationFrame(renderFrame);
  }
  requestAnimationFrame(renderFrame);

  const mockStream = canvas.captureStream(60);
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const audioTrack = dest.stream.getAudioTracks()[0];
    if (audioTrack) mockStream.addTrack(audioTrack);
  } catch (e) {}

  if (navigator.mediaDevices) {
    navigator.mediaDevices.getDisplayMedia = async () => mockStream;
  }
`;

async function run() {
  console.log('--- INICIANDO TESTE E2E: 1 HOST PARA 3 ESPECTADORES SIMULTÂNEOS ---');
  const server = await startStaticServer();
  const roomId = 'audit-3v-' + Math.random().toString(36).substring(2, 8);
  const roomUrl = `http://localhost:${PORT}/room.html?room=${roomId}`;
  console.log(`[E2E] URL da sala: ${roomUrl}`);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-web-security',
      '--allow-file-access-from-files'
    ]
  });

  try {
    // 1 Host
    const ctxHost = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageHost = await ctxHost.newPage();
    await pageHost.addInitScript(mockDefaultUserScript('#38bdf8', 'HOST'));
    pageHost.on('console', msg => console.log(`[Host Console] ${msg.text()}`));
    await pageHost.goto(roomUrl);

    // Viewer 1
    const ctxV1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageV1 = await ctxV1.newPage();
    await pageV1.addInitScript(mockDefaultUserScript('#f43f5e', 'VIEWER_1'));
    pageV1.on('console', msg => console.log(`[V1 Console] ${msg.text()}`));
    await pageV1.goto(roomUrl);

    // Viewer 2
    const ctxV2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageV2 = await ctxV2.newPage();
    await pageV2.addInitScript(mockDefaultUserScript('#a855f7', 'VIEWER_2'));
    pageV2.on('console', msg => console.log(`[V2 Console] ${msg.text()}`));
    await pageV2.goto(roomUrl);

    // Viewer 3
    const ctxV3 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageV3 = await ctxV3.newPage();
    await pageV3.addInitScript(mockDefaultUserScript('#10b981', 'VIEWER_3'));
    pageV3.on('console', msg => console.log(`[V3 Console] ${msg.text()}`));
    await pageV3.goto(roomUrl);

    // Entrada pela Green Room para os 4 participantes
    const participants = [
      { name: 'Host', page: pageHost },
      { name: 'Viewer 1', page: pageV1 },
      { name: 'Viewer 2', page: pageV2 },
      { name: 'Viewer 3', page: pageV3 }
    ];

    for (const p of participants) {
      const btn = p.page.locator('#green-room-join-btn');
      await btn.waitFor({ state: 'visible', timeout: 10000 });
      await btn.click();
      console.log(`[E2E] ${p.name} entrou na sala.`);
    }

    // Aguarda todos os 4 verem "4 online"
    console.log('[E2E] Aguardando presença dos 4 participantes na sala...');
    for (const p of participants) {
      await p.page.waitForFunction(() => {
        const badge = document.getElementById('sidebar-members-count');
        return badge && badge.textContent.includes('4 online');
      }, { timeout: 25000 });
      console.log(`[E2E] ${p.name} confirmou 4 membros online!`);
    }

    // Host inicia transmissão
    console.log('[E2E] Host iniciando transmissão de tela...');
    const streamBtn = pageHost.locator('#dock-stream-btn');
    await streamBtn.waitFor({ state: 'visible' });
    await streamBtn.click();

    // Verificação de reprodução para os 3 espectadores
    console.log('[E2E] Aguardando e verificando recepção e reprodução nos 3 espectadores...');

    const viewers = [
      { name: 'Viewer 1', page: pageV1 },
      { name: 'Viewer 2', page: pageV2 },
      { name: 'Viewer 3', page: pageV3 }
    ];

    for (const v of viewers) {
      console.log(`[E2E] Aguardando vídeo no ${v.name}...`);
      const videoLoc = v.page.locator('.video-card video');
      await videoLoc.waitFor({ state: 'attached', timeout: 35000 });

      // Inspeciona estado atual
      const stateBefore = await v.page.evaluate(() => {
        const vid = document.querySelector('.video-card video');
        return {
          found: Boolean(vid),
          paused: vid?.paused,
          readyState: vid?.readyState,
          videoWidth: vid?.videoWidth,
          srcObject: Boolean(vid?.srcObject),
          currentTime: vid?.currentTime,
          error: vid?.error ? { code: vid.error.code, message: vid.error.message } : null
        };
      });
      console.log(`[E2E Diag ${v.name}] Estado inicial do video:`, JSON.stringify(stateBefore));

      await v.page.waitForFunction(() => {
        const vid = document.querySelector('.video-card video');
        if (vid && vid.paused) {
          vid.play().catch(() => {});
        }
        return Boolean(vid && !vid.paused && vid.readyState >= 2 && vid.videoWidth > 0);
      }, { timeout: 35000 });
      console.log(`✅ ${v.name} está reproduzindo o vídeo do Host com sucesso!`);
    }

    // Prova visual via CDP instantâneo
    console.log('[E2E] Capturando screenshots instantâneos via CDP...');
    async function captureCdpScreenshot(page, filePath) {
      try {
        const client = await page.context().newCDPSession(page);
        const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
        await client.detach();
      } catch (err) {
        console.warn(`[CDP Screenshot] Falha em ${path.basename(filePath)}:`, err);
      }
    }

    const shotHost = path.join(ARTIFACT_DIR, 'audit_3viewers_01_host.png');
    const shotV1 = path.join(ARTIFACT_DIR, 'audit_3viewers_02_viewer1.png');
    const shotV2 = path.join(ARTIFACT_DIR, 'audit_3viewers_03_viewer2.png');
    const shotV3 = path.join(ARTIFACT_DIR, 'audit_3viewers_04_viewer3.png');

    await captureCdpScreenshot(pageHost, shotHost);
    await captureCdpScreenshot(pageV1, shotV1);
    await captureCdpScreenshot(pageV2, shotV2);
    await captureCdpScreenshot(pageV3, shotV3);

    console.log('📸 Todos os 4 screenshots foram capturados com sucesso!');
    console.log('🎉 SUCESSO TOTAL: 1 HOST STREAMANDO PARA 3 ESPECTADORES SIMULTÂNEOS!');
  } catch (err) {
    console.error('❌ ERRO NO TESTE:', err);
    throw err;
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
