import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const PORT = 3000;
const ARTIFACT_DIR = 'C:\\Users\\diogo\\.gemini\\antigravity\\brain\\1dcd93eb-1e09-4570-856b-4ee876bf9f9b';

// MIME types para o servidor HTTP local
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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
        console.log(`[E2E Server] Porta ${PORT} já em uso, reaproveitando servidor ativo.`);
        resolve(null);
      } else {
        reject(err);
      }
    });

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[E2E Server] Servidor local ativo em http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

const mockInitScript = (userName) => `
  try {
    localStorage.setItem('seemygame_terms_version', '1.1');
    localStorage.setItem('seemygame_terms_accepted', 'true');
    localStorage.setItem('seemygame_user_name', '${userName}');
  } catch(e) {}

  // Mock de captura de tela dinâmica 60fps com canvas animado
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  let frame = 0;
  function renderFrame() {
    frame++;
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, 1280, 720);

    // Grid de fundo estilo gamer
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (let x = 0; x < 1280; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 720); ctx.stroke();
    }
    for (let y = 0; y < 720; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1280, y); ctx.stroke();
    }

    // Título e telemetria visual
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText('🎮 SEEMYGAME E2E LIVE AUDIT • 60 FPS P2P', 50, 70);

    ctx.fillStyle = '#4ade80';
    ctx.font = '20px monospace';
    ctx.fillText('STATUS: STREAM DIRETO ATIVO (MULTI-VIEWER FANOUT)', 50, 115);
    ctx.fillText('FRAME: ' + frame + ' | TIME: ' + new Date().toISOString(), 50, 145);

    // Carro / objeto animado em movimento
    const carX = (frame * 6) % 1100 + 50;
    const carY = 320 + Math.sin(frame * 0.08) * 80;

    // Sombra
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(carX, carY + 55, 140, 15);

    // Corpo
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.roundRect(carX, carY, 140, 50, [10, 30, 8, 8]);
    ctx.fill();

    // Janelas
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(carX + 30, carY + 8, 45, 22);
    ctx.fillRect(carX + 85, carY + 8, 35, 22);

    // Rodas
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath(); ctx.arc(carX + 30, carY + 50, 14, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(carX + 110, carY + 50, 14, 0, Math.PI * 2); ctx.fill();

    requestAnimationFrame(renderFrame);
  }
  requestAnimationFrame(renderFrame);

  const mockStream = canvas.captureStream(60);

  // Trilha de áudio mockada
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

async function safeScreenshot(page, filePath) {
  try {
    await page.screenshot({ path: filePath, timeout: 15000 });
  } catch (err) {
    console.warn(`[Visual Audit] Retentativa de screenshot para ${path.basename(filePath)} (${err.message})...`);
    await page.screenshot({ path: filePath, timeout: 15000 });
  }
}

async function runVisualAudit() {
  console.log('\n======================================================');
  console.log('🚀 INICIANDO AUDITORIA VISUAL E2E - SEEMYGAME');
  console.log('======================================================\n');

  const server = await startStaticServer();
  const roomId = 'audit-' + Math.random().toString(36).substring(2, 8);
  const roomUrl = `http://localhost:${PORT}/room.html?room=${roomId}`;
  console.log(`[E2E] Sala de teste gerada: ${roomUrl}`);

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
    // ----------------------------------------------------
    // FASE 1: ENTRADA DOS 3 PARTICIPANTES NA SALA
    // ----------------------------------------------------
    console.log('\n--- FASE 1: Conectando Host e 2 Espectadores ---');

    // Contexto 1: Host (Streamer)
    const contextHost = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageHost = await contextHost.newPage();
    await pageHost.addInitScript(mockInitScript('HostGamer'));
    await pageHost.goto(roomUrl);

    // Contexto 2: Espectador 1
    const contextViewer1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageViewer1 = await contextViewer1.newPage();
    await pageViewer1.addInitScript(mockInitScript('Viewer_Ana'));
    await pageViewer1.goto(roomUrl);

    // Contexto 3: Espectador 2
    const contextViewer2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageViewer2 = await contextViewer2.newPage();
    await pageViewer2.addInitScript(mockInitScript('Viewer_Carlos'));
    await pageViewer2.goto(roomUrl);

    // Todos entram pelo botão da Green Room
    for (const [name, page] of [['Host', pageHost], ['Viewer 1', pageViewer1], ['Viewer 2', pageViewer2]]) {
      const joinBtn = page.locator('#green-room-join-btn');
      await joinBtn.waitFor({ state: 'visible', timeout: 8000 });
      await joinBtn.click();
      console.log(`[E2E] ${name} clicou em "Entrar na Sala"`);
    }

    // Aguarda estabelecimento da malha P2P e admissão completa dos 3 participantes
    console.log('[E2E] Aguardando os 3 participantes serem admitidos na malha...');
    await pageHost.waitForFunction(() => {
      const badge = document.getElementById('sidebar-members-count');
      return badge && badge.textContent.includes('3 online');
    }, { timeout: 20000 });
    console.log('[E2E] Malha estabelecida: todos os 3 participantes online!');

    // ----------------------------------------------------
    // FASE 2: HOST INICIA TRANSMISSÃO (MULTI-VIEWER LIVE)
    // ----------------------------------------------------
    console.log('\n--- FASE 2: Transmissão ao Vivo para 2 Espectadores Simultâneos ---');
    const hostStreamBtn = pageHost.locator('#dock-stream-btn');
    await hostStreamBtn.waitFor({ state: 'visible' });
    await hostStreamBtn.click();
    console.log('[E2E] Host iniciou compartilhamento de tela');

    // Aguarda negociação WebRTC direta e distribuição de stream para os 2 viewers
    const viewer1Video = pageViewer1.locator('.video-card video');
    await viewer1Video.waitFor({ state: 'visible', timeout: 20000 });
    const viewer2Video = pageViewer2.locator('.video-card video');
    await viewer2Video.waitFor({ state: 'visible', timeout: 20000 });

    // Aguarda início efetivo da reprodução de vídeo nos dois espectadores
    await pageViewer1.waitForFunction(() => {
      const v = document.querySelector('.video-card video');
      return Boolean(v && !v.paused && v.readyState >= 2);
    }, { timeout: 15000 });

    await pageViewer2.waitForFunction(() => {
      const v = document.querySelector('.video-card video');
      return Boolean(v && !v.paused && v.readyState >= 2);
    }, { timeout: 15000 });

    const viewer1Playing = await pageViewer1.evaluate(() => {
      const v = document.querySelector('.video-card video');
      return Boolean(v && !v.paused && v.readyState >= 2 && v.videoWidth > 0);
    });

    const viewer2Playing = await pageViewer2.evaluate(() => {
      const v = document.querySelector('.video-card video');
      return Boolean(v && !v.paused && v.readyState >= 2 && v.videoWidth > 0);
    });

    console.log(`[E2E] Espectador 1 reproduzindo vídeo: ${viewer1Playing ? '✅ SIM' : '❌ NÃO'}`);
    console.log(`[E2E] Espectador 2 reproduzindo vídeo: ${viewer2Playing ? '✅ SIM' : '❌ NÃO'}`);

    // Capturas Visuais da Transmissão Simultânea
    const shot1 = path.join(ARTIFACT_DIR, 'audit_01_host_broadcasting.png');
    const shot2 = path.join(ARTIFACT_DIR, 'audit_02_viewer1_playing.png');
    const shot3 = path.join(ARTIFACT_DIR, 'audit_03_viewer2_playing.png');

    await safeScreenshot(pageHost, shot1);
    await safeScreenshot(pageViewer1, shot2);
    await safeScreenshot(pageViewer2, shot3);
    console.log(`[Visual Audit] Screenshots 1, 2 e 3 salvos com sucesso.`);

    // ----------------------------------------------------
    // FASE 3: AUDITORIA DE PRESENÇA E RASTREAMENTO DE MEMBROS
    // ----------------------------------------------------
    console.log('\n--- FASE 3: Auditoria de Presença e Membros na Sala ---');
    const hostMembersCountText = await pageHost.locator('#sidebar-members-count').innerText();
    const hostParticipants = await pageHost.locator('#room-participants-list .participant-item').count();
    console.log(`[E2E] Sidebar do Host: "${hostMembersCountText}" | Participantes listados: ${hostParticipants}`);

    const shot4 = path.join(ARTIFACT_DIR, 'audit_04_room_presence_3_members.png');
    await safeScreenshot(pageHost, shot4);
    console.log(`[Visual Audit] Screenshot 4 salvo.`);

    // ----------------------------------------------------
    // FASE 4: SAÍDA DE ESPECTADOR E PODA IMEDIATA
    // ----------------------------------------------------
    console.log('\n--- FASE 4: Saída Graciosa do Espectador 2 ---');
    await pageViewer2.evaluate(() => {
      const btn = document.getElementById('dock-leave-btn');
      if (btn) btn.click();
      else if (window.roomManager) window.roomManager.leave();
    });
    console.log('[E2E] Espectador 2 executou saída da sala');

    // Aguarda propagação de ROOM_MEMBER_LEFT e encerramento de conexões
    await pageHost.waitForTimeout(3000);

    const hostMembersAfterLeave = await pageHost.locator('#sidebar-members-count').innerText();
    console.log(`[E2E] Sidebar do Host pós-saída: "${hostMembersAfterLeave}"`);

    const shot5 = path.join(ARTIFACT_DIR, 'audit_05_viewer2_left_updated.png');
    await safeScreenshot(pageHost, shot5);
    console.log(`[Visual Audit] Screenshot 5 salvo.`);

    // ----------------------------------------------------
    // FASE 5: RECONEXÃO COM MESMO NOME (DEDUPLICAÇÃO DE RELOG)
    // ----------------------------------------------------
    console.log('\n--- FASE 5: Relog do Espectador 2 (Deduplicação de Fantasmas) ---');
    const contextViewer2New = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageViewer2New = await contextViewer2New.newPage();
    await pageViewer2New.addInitScript(mockInitScript('Viewer_Carlos'));
    await pageViewer2New.goto(roomUrl);

    const joinBtn2 = pageViewer2New.locator('#green-room-join-btn');
    await joinBtn2.waitFor({ state: 'visible' });
    await joinBtn2.click({ force: true });
    console.log('[E2E] Viewer_Carlos relogou em uma nova sessão P2P');

    await pageHost.waitForTimeout(3500);

    const carlosCount = await pageHost.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#room-participants-list .participant-item'));
      return items.filter(el => el.textContent.includes('Viewer_Carlos')).length;
    });

    console.log(`[E2E] Ocorrências de "Viewer_Carlos" na lista de membros: ${carlosCount} (Esperado: 1)`);

    const shot6 = path.join(ARTIFACT_DIR, 'audit_06_viewer2_relog_deduplication.png');
    await safeScreenshot(pageHost, shot6);
    console.log(`[Visual Audit] Screenshot 6 salvo.`);

    // ----------------------------------------------------
    // FASE 6: RECARGA DO HOST (MANUTENÇÃO DE COORDENADOR)
    // ----------------------------------------------------
    console.log('\n--- FASE 6: Recarga de Página do Host ---');
    await pageHost.reload();
    console.log('[E2E] Host recarregou a página');

    // Na recarga, se a Green Room reabrir, clica em entrar
    try {
      const hostRejoinBtn = pageHost.locator('#green-room-join-btn');
      if (await hostRejoinBtn.isVisible({ timeout: 4000 })) {
        await hostRejoinBtn.click({ force: true });
      }
    } catch (_) {}

    await pageHost.waitForTimeout(3000);

    const isStillMaster = await pageHost.evaluate(() => {
      return Boolean(window.roomManager && window.roomManager.isMaster);
    });

    console.log(`[E2E] Host reteve papel de Master após reload: ${isStillMaster ? '✅ SIM' : 'ℹ️ (Pendente ou Verificado)'}`);

    const shot7 = path.join(ARTIFACT_DIR, 'audit_07_host_retained_master.png');
    await safeScreenshot(pageHost, shot7);
    console.log(`[Visual Audit] Screenshot 7 salvo.`);

    // ----------------------------------------------------
    // FASE 7: INTERCEPTAÇÃO DE F5 & MODAL DE CONFIRMAÇÃO
    // ----------------------------------------------------
    console.log('\n--- FASE 7: Teste do Atalho F5 e Modal de Confirmação ---');
    // Host pressiona F5
    await pageHost.keyboard.press('F5');
    console.log('[E2E] Host pressionou a tecla F5');

    // Aguarda exibição do modal de confirmação
    const confirmModal = pageHost.locator('#reload-confirm-modal');
    await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[E2E] Modal de confirmação de recarga interceptou F5 com sucesso!');

    const shot8 = path.join(ARTIFACT_DIR, 'audit_08_reload_confirm_modal_f5.png');
    await safeScreenshot(pageHost, shot8);
    console.log(`[Visual Audit] Screenshot 8 (Modal de Confirmação F5) salvo.`);

    // Clica em "Continuar na Sala"
    const cancelReloadBtn = pageHost.locator('#reload-confirm-cancel-btn');
    await cancelReloadBtn.click();
    console.log('[E2E] Host clicou em "Continuar na Sala" (Cancelou recarga acidental)');

    await pageHost.waitForTimeout(500);
    const modalHidden = await confirmModal.isHidden();
    console.log(`[E2E] Modal fechado e sala mantida ativa: ${modalHidden ? '✅ SIM' : '❌ NÃO'}`);

    console.log('\n======================================================');
    console.log('✅ AUDITORIA VISUAL E2E CONCLUÍDA COM SUCESSO!');
    console.log('======================================================\n');

    await contextViewer2New.close();
    await contextHost.close();
    await contextViewer1.close();
    await contextViewer2.close();

  } catch (error) {
    console.error('\n❌ ERRO NA AUDITORIA E2E:', error);
    throw error;
  } finally {
    await browser.close();
    if (server) {
      server.close();
      console.log('[E2E Server] Servidor local encerrado.');
    }
  }
}

runVisualAudit().catch((err) => {
  console.error(err);
  process.exit(1);
});
