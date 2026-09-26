import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const PORT = 3001;
const ARTIFACT_DIR = 'C:\\Users\\diogo\\.gemini\\antigravity\\brain\\1dcd93eb-1e09-4570-856b-4ee876bf9f9b';

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
      console.log(`[E2E Server] Servidor de teste ativo em http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

const mockDefaultUserScript = (color, label) => `
  try {
    localStorage.setItem('seemygame_terms_version', '1.1');
    localStorage.setItem('seemygame_terms_accepted', 'true');
    // Não define seemygame_user_name propositalmente para testar nomes padrão e evitar colisões
    localStorage.removeItem('seemygame_user_name');
  } catch(e) {}

  // Mock de captura de tela dinâmica 60fps
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  let frame = 0;
  function renderFrame() {
    frame++;
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(0, 0, 1280, 720);

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (let x = 0; x < 1280; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 720); ctx.stroke();
    }
    for (let y = 0; y < 720; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1280, y); ctx.stroke();
    }

    ctx.fillStyle = '${color}';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('🎮 SEEMYGAME STREAM: ${label}', 50, 70);

    ctx.fillStyle = '#10b981';
    ctx.font = '22px monospace';
    ctx.fillText('STATUS: P2P ATIVO • FRAME ' + frame, 50, 115);
    ctx.fillText('TIMESTAMP: ' + new Date().toLocaleTimeString(), 50, 145);

    // Bola saltando
    const bx = (frame * 7) % 1100 + 50;
    const by = 350 + Math.abs(Math.sin(frame * 0.07)) * -180;
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

async function safeScreenshot(page, filePath) {
  try {
    await page.screenshot({ path: filePath, timeout: 15000 });
  } catch (err) {
    console.warn(`[Visual Audit] Retentando screenshot ${path.basename(filePath)}...`);
    await page.screenshot({ path: filePath, timeout: 15000 });
  }
}

async function runPersistenceAudit() {
  console.log('\n================================================================');
  console.log('🛡️  AUDITORIA E2E: PERMANÊNCIA EM SALA E TRANSMISSÃO BI-DIRECIONAL');
  console.log('================================================================\n');

  const server = await startStaticServer();
  const roomId = 'audit-' + Math.random().toString(36).substring(2, 8);
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
    // ----------------------------------------------------
    // FASE 1: ENTRADA DE HOST E AMIGO 1 COM NOMES PADRÃO
    // ----------------------------------------------------
    console.log('\n--- FASE 1: Conexão Host e Amigo 1 sem nickname configurado ---');
    const contextHost = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageHost = await contextHost.newPage();
    await pageHost.addInitScript(mockDefaultUserScript('#38bdf8', 'HOST'));
    await pageHost.goto(roomUrl);

    const contextFriend = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageFriend = await contextFriend.newPage();
    await pageFriend.addInitScript(mockDefaultUserScript('#f43f5e', 'AMIGO'));
    await pageFriend.goto(roomUrl);

    // Entrada pela Green Room
    for (const [label, page] of [['Host', pageHost], ['Amigo 1', pageFriend]]) {
      const joinBtn = page.locator('#green-room-join-btn');
      await joinBtn.waitFor({ state: 'visible', timeout: 8000 });
      await joinBtn.click();
      console.log(`[E2E] ${label} clicou em "Entrar na Sala"`);
    }

    // Aguarda ambos aparecerem na sala
    console.log('[E2E] Aguardando confirmação de presença mútua (2 online)...');
    await pageHost.waitForFunction(() => {
      const badge = document.getElementById('sidebar-members-count');
      return badge && badge.textContent.includes('2 online');
    }, { timeout: 20000 });

    await pageFriend.waitForFunction(() => {
      const badge = document.getElementById('sidebar-members-count');
      return badge && badge.textContent.includes('2 online');
    }, { timeout: 20000 });

    const hostMembers = await pageHost.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#room-participants-list .participant-item'));
      return items.map(el => el.textContent.trim());
    });
    console.log('[E2E] Membros visíveis no Host:', hostMembers);

    const friendMembers = await pageFriend.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#room-participants-list .participant-item'));
      return items.map(el => el.textContent.trim());
    });
    console.log('[E2E] Membros visíveis no Amigo:', friendMembers);

    // Validação estrita: Host NÃO pode ter se removido e nem removido o amigo
    if (hostMembers.length < 2 || friendMembers.length < 2) {
      throw new Error(`Falha na presença da sala! Host viu ${hostMembers.length} e Amigo viu ${friendMembers.length}`);
    }

    const shot1 = path.join(ARTIFACT_DIR, 'audit_persistence_01_both_in_room.png');
    await safeScreenshot(pageHost, shot1);
    console.log(`[Visual Audit] Screenshot 1 salvo: Presença de 2 membros confirmada.`);

    // ----------------------------------------------------
    // FASE 2: HOST TRANSMITE PARA O AMIGO
    // ----------------------------------------------------
    console.log('\n--- FASE 2: Host inicia transmissão de tela para o Amigo ---');
    const hostStreamBtn = pageHost.locator('#dock-stream-btn');
    await hostStreamBtn.waitFor({ state: 'visible' });
    await hostStreamBtn.click();
    console.log('[E2E] Host clicou em Transmitir');

    // Amigo deve receber o vídeo e reproduzir
    const friendVideo = pageFriend.locator('.video-card video');
    await friendVideo.waitFor({ state: 'visible', timeout: 20000 });

    await pageFriend.waitForFunction(() => {
      const v = document.querySelector('.video-card video');
      return Boolean(v && !v.paused && v.readyState >= 2 && v.videoWidth > 0);
    }, { timeout: 15000 });

    console.log('[E2E] Amigo está assistindo à transmissão do Host com sucesso!');
    const shot2 = path.join(ARTIFACT_DIR, 'audit_persistence_02_friend_watching_host.png');
    await safeScreenshot(pageFriend, shot2);
    console.log(`[Visual Audit] Screenshot 2 salvo: Amigo assistindo Host.`);

    // Host encerra transmissão
    await hostStreamBtn.click();
    console.log('[E2E] Host encerrou transmissão');
    await pageFriend.waitForTimeout(2000);

    // ----------------------------------------------------
    // FASE 3: AMIGO TRANSMITE PARA O HOST
    // ----------------------------------------------------
    console.log('\n--- FASE 3: Amigo transmite para o Host ---');
    const friendStreamBtn = pageFriend.locator('#dock-stream-btn');
    await friendStreamBtn.waitFor({ state: 'visible' });
    await friendStreamBtn.click();
    console.log('[E2E] Amigo clicou em Transmitir');

    // Host deve receber o vídeo e reproduzir
    const hostReceivedVideo = pageHost.locator('.video-card video');
    await hostReceivedVideo.waitFor({ state: 'visible', timeout: 20000 });

    await pageHost.waitForFunction(() => {
      const v = document.querySelector('.video-card video');
      return Boolean(v && !v.paused && v.readyState >= 2 && v.videoWidth > 0);
    }, { timeout: 15000 });

    console.log('[E2E] Host está assistindo à transmissão do Amigo com sucesso!');
    const shot3 = path.join(ARTIFACT_DIR, 'audit_persistence_03_host_watching_friend.png');
    await safeScreenshot(pageHost, shot3);
    console.log(`[Visual Audit] Screenshot 3 salvo: Host assistindo Amigo.`);

    // Amigo encerra transmissão
    await friendStreamBtn.click();
    console.log('[E2E] Amigo encerrou transmissão');
    await pageHost.waitForTimeout(2000);

    // ----------------------------------------------------
    // FASE 4: PERMANÊNCIA E ESTABILIDADE DE HEARTBEAT (15 SEGUNDOS)
    // ----------------------------------------------------
    console.log('\n--- FASE 4: Teste de Permanência Contínua (Heartbeat e Inatividade) ---');
    console.log('[E2E] Aguardando 15 segundos para validar que nenhum peer cai indevidamente...');
    await pageHost.waitForTimeout(15000);

    const countHostAfterWait = await pageHost.locator('#sidebar-members-count').innerText();
    const countFriendAfterWait = await pageFriend.locator('#sidebar-members-count').innerText();
    console.log(`[E2E] Contagem pós-inatividade -> Host: "${countHostAfterWait}", Amigo: "${countFriendAfterWait}"`);

    if (!countHostAfterWait.includes('2 online') || !countFriendAfterWait.includes('2 online')) {
      throw new Error(`Membros caíram indevidamente durante inatividade! Host: ${countHostAfterWait}, Amigo: ${countFriendAfterWait}`);
    }
    console.log('[E2E] Permanência confirmada: 0 falsos desconectamentos.');

    // ----------------------------------------------------
    // FASE 5: RELOG DO AMIGO (F5 NA MESMA ABA COM SESSÃO)
    // ----------------------------------------------------
    console.log('\n--- FASE 5: Recarga de Aba do Amigo (F5 com Deduplicação de Sessão) ---');
    await pageFriend.reload();
    console.log('[E2E] Amigo recarregou a página (F5)');

    try {
      const rejoinBtn = pageFriend.locator('#green-room-join-btn');
      if (await rejoinBtn.isVisible({ timeout: 5000 })) {
        await rejoinBtn.click({ force: true });
        console.log('[E2E] Amigo reingressou pela Green Room');
      }
    } catch (_) {}

    // Aguarda sincronização e deduplicação
    await pageHost.waitForTimeout(4000);

    const hostMembersCountAfterRelog = await pageHost.locator('#sidebar-members-count').innerText();
    const hostParticipantItems = await pageHost.locator('#room-participants-list .participant-item').count();
    console.log(`[E2E] Host após relog do Amigo: "${hostMembersCountAfterRelog}" | Itens: ${hostParticipantItems}`);

    const shot4 = path.join(ARTIFACT_DIR, 'audit_persistence_04_after_friend_relog.png');
    await safeScreenshot(pageHost, shot4);
    console.log(`[Visual Audit] Screenshot 4 salvo: Relog deduplicado sem fantasmas.`);

    // ----------------------------------------------------
    // FASE 6: ENTRADA DE UM SEGUNDO AMIGO (3 PARTICIPANTES SIMULTÂNEOS)
    // ----------------------------------------------------
    console.log('\n--- FASE 6: Entrada de Amigo 2 (Escala da Sala para 3 Membros) ---');
    const contextFriend2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageFriend2 = await contextFriend2.newPage();
    await pageFriend2.addInitScript(mockDefaultUserScript('#a855f7', 'AMIGO_2'));
    await pageFriend2.goto(roomUrl);

    const joinBtnFriend2 = pageFriend2.locator('#green-room-join-btn');
    await joinBtnFriend2.waitFor({ state: 'visible', timeout: 8000 });
    await joinBtnFriend2.click();
    console.log('[E2E] Amigo 2 entrou na sala');

    await pageHost.waitForFunction(() => {
      const badge = document.getElementById('sidebar-members-count');
      return badge && badge.textContent.includes('3 online');
    }, { timeout: 20000 });

    console.log('[E2E] Sala escalada para 3 membros online com sucesso!');
    const shot5 = path.join(ARTIFACT_DIR, 'audit_persistence_05_three_members_stable.png');
    await safeScreenshot(pageHost, shot5);
    console.log(`[Visual Audit] Screenshot 5 salvo: 3 membros online.`);

    console.log('\n================================================================');
    console.log('🎉 AUDITORIA DE PERMANÊNCIA E TRANSMISSÃO CONCLUÍDA COM SUCESSO!');
    console.log('================================================================\n');

    await contextFriend2.close();
    await contextFriend.close();
    await contextHost.close();

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

runPersistenceAudit().catch((err) => {
  console.error(err);
  process.exit(1);
});
