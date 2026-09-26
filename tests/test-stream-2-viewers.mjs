import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const PORT = 3002;
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
  console.log('--- INICIANDO TESTE E2E: 1 HOST PARA 2 ESPECTADORES SIMULTÂNEOS ---');
  const server = await startStaticServer();
  const roomId = 'audit-multi-' + Math.random().toString(36).substring(2, 8);
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

  async function safeScreenshot(page, filePath) {
    try {
      await page.screenshot({ path: filePath, timeout: 15000 });
    } catch (err) {
      console.warn(`[Visual Audit] Retentando screenshot ${path.basename(filePath)} (${err.message})...`);
      await page.screenshot({ path: filePath, timeout: 15000 });
    }
  }

  try {
    const ctxHost = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageHost = await ctxHost.newPage();
    await pageHost.addInitScript(mockDefaultUserScript('#38bdf8', 'HOST'));
    pageHost.on('console', msg => console.log(`[Host Console] ${msg.text()}`));
    await pageHost.goto(roomUrl);

    const ctxViewer1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageViewer1 = await ctxViewer1.newPage();
    await pageViewer1.addInitScript(mockDefaultUserScript('#f43f5e', 'VIEWER_1'));
    pageViewer1.on('console', msg => console.log(`[Viewer 1 Console] ${msg.text()}`));
    await pageViewer1.goto(roomUrl);

    const ctxViewer2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageViewer2 = await ctxViewer2.newPage();
    await pageViewer2.addInitScript(mockDefaultUserScript('#a855f7', 'VIEWER_2'));
    pageViewer2.on('console', msg => console.log(`[Viewer 2 Console] ${msg.text()}`));
    await pageViewer2.goto(roomUrl);

    // Entrada pela Green Room
    for (const [name, page] of [['Host', pageHost], ['Viewer 1', pageViewer1], ['Viewer 2', pageViewer2]]) {
      const btn = page.locator('#green-room-join-btn');
      await btn.waitFor({ state: 'visible', timeout: 8000 });
      await btn.click();
      console.log(`[E2E] ${name} entrou na sala.`);
    }

    // Aguarda todos os 3 verem "3 online"
    console.log('[E2E] Aguardando presença dos 3 participantes...');
    await pageHost.waitForFunction(() => {
      const badge = document.getElementById('sidebar-members-count');
      return badge && badge.textContent.includes('3 online');
    }, { timeout: 20000 });
    await pageViewer1.waitForFunction(() => {
      const badge = document.getElementById('sidebar-members-count');
      return badge && badge.textContent.includes('3 online');
    }, { timeout: 20000 });
    await pageViewer2.waitForFunction(() => {
      const badge = document.getElementById('sidebar-members-count');
      return badge && badge.textContent.includes('3 online');
    }, { timeout: 20000 });
    console.log('[E2E] Todos os 3 participantes estão confirmados online!');

    // Host inicia transmissão
    console.log('[E2E] Host iniciando transmissão de tela...');
    const streamBtn = pageHost.locator('#dock-stream-btn');
    await streamBtn.waitFor({ state: 'visible' });
    await streamBtn.click();

    // Verifica se Viewer 1 recebe e reproduz
    console.log('[E2E] Verificando se Viewer 1 recebe stream...');
    const v1Video = pageViewer1.locator('.video-card video');
    await v1Video.waitFor({ state: 'visible', timeout: 20000 });
    await pageViewer1.waitForFunction(() => {
      const v = document.querySelector('.video-card video');
      return Boolean(v && !v.paused && v.readyState >= 2 && v.videoWidth > 0);
    }, { timeout: 15000 });
    console.log('✅ Viewer 1 está reproduzindo o vídeo do Host!');

    // Verifica se Viewer 2 recebe e reproduz
    console.log('[E2E] Verificando se Viewer 2 recebe stream...');
    const diagV2 = await pageViewer2.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.video-card')).map(c => ({
        id: c.id,
        html: c.innerHTML.slice(0, 150),
        display: window.getComputedStyle(c).display,
        video: Boolean(c.querySelector('video')),
        videoSrc: Boolean(c.querySelector('video')?.srcObject),
        videoPaused: c.querySelector('video')?.paused,
        videoReadyState: c.querySelector('video')?.readyState
      }));
      const grid = document.getElementById('video-grid');
      return {
        cards,
        gridDisplay: grid ? window.getComputedStyle(grid).display : 'no grid',
        watchingHosts: window.watchingHosts ? Array.from(window.watchingHosts.entries()).map(([k, v]) => ({ k, state: v.state, call: Boolean(v.call) })) : null
      };
    });
    console.log('[E2E Diagnostics Viewer 2]:', JSON.stringify(diagV2, null, 2));

    const v2Video = pageViewer2.locator('.video-card video');
    await v2Video.waitFor({ state: 'attached', timeout: 20000 });
    const isVis = await v2Video.isVisible();
    console.log(`[E2E] v2Video isVisible: ${isVis}`);
    await pageViewer2.waitForFunction(() => {
      const v = document.querySelector('.video-card video');
      return Boolean(v && !v.paused && v.readyState >= 2 && v.videoWidth > 0);
    }, { timeout: 20000 });
    console.log('✅ Viewer 2 está reproduzindo o vídeo do Host!');

    // Salva screenshots como prova visual via CDP instantâneo
    const shotHost = path.join(ARTIFACT_DIR, 'audit_multi_01_host.png');
    const shotV1 = path.join(ARTIFACT_DIR, 'audit_multi_02_viewer1.png');
    const shotV2 = path.join(ARTIFACT_DIR, 'audit_multi_03_viewer2.png');
    
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

    await captureCdpScreenshot(pageHost, shotHost);
    await captureCdpScreenshot(pageViewer1, shotV1);
    await captureCdpScreenshot(pageViewer2, shotV2);
    console.log('📸 Screenshots salvos com sucesso!');

    console.log('🎉 SUCESSO TOTAL: 1 HOST STREAMANDO PARA 2 ESPECTADORES SIMULTÂNEOS!');
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
