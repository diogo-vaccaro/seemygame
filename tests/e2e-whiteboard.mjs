import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
async function run() {
  const server = await startAssetServer({ root });
  const signaling = await startSignalingServer();
  let browser;
  try {
  browser = await launchTestBrowser();
  const context = await prepareSessionContext(browser, signaling);
  const page = await context.newPage();
  const consoleMessages = [];
  page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleMessages.push(`[PAGE_ERROR] ${err.message}`));

    // Injeta localStorage pré-configurado para pular termos e entrar direto na sala
    await page.addInitScript(() => {
      localStorage.setItem('seemygame_terms_version', '1.1');
      localStorage.setItem('seemygame_terms_accepted', 'true');
      localStorage.setItem('seemygame_user_name', 'HostTester');
    });

    console.log(`\n======================================================`);
    console.log(`[E2E CENÁRIO 1] Teste da Lousa na Sala (room.html)`);
    console.log(`======================================================`);

    await page.goto(`${server.origin}/room.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Clica no botão Entrar na Sala (Green Room) se estiver visível
    const joinBtn = await page.$('#green-room-join-btn');
    if (joinBtn && await joinBtn.isVisible()) {
      console.log('[E2E] Clicando em #green-room-join-btn para entrar no stage...');
      await joinBtn.click();
      await page.waitForTimeout(800);
    }

    const modal = page.locator('#whiteboard-modal');
    const dockBtn = page.locator('#dock-whiteboard-btn');
    const closeBtn = page.locator('#wb-close-btn');
    const canvas = page.locator('#whiteboard-canvas');

    // 1. Estado inicial
    const initialVisible = await modal.isVisible();
    console.log(`1. Estado inicial da lousa: visível=${initialVisible} (esperado: false)`);
    if (initialVisible) throw new Error('Lousa não deveria estar visível no início');

    // 2. Abrir via dock inferior
    console.log('2. Clicando em #dock-whiteboard-btn para abrir a lousa...');
    await dockBtn.click();
    await page.waitForTimeout(400);

    const isVisibleAfterDock = await modal.isVisible();
    console.log(`   Lousa visível após clique no dock: ${isVisibleAfterDock} (esperado: true)`);
    if (!isVisibleAfterDock) throw new Error('Lousa falhou em abrir após clique no dock inferior!');

    // 3. Desenhar na lousa
    console.log('3. Testando traço do mouse/caneta no canvas da lousa...');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas bounding box não encontrado');

    const startX = box.x + 100;
    const startY = box.y + 100;
    const endX = box.x + 300;
    const endY = box.y + 250;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 50, startY + 50, { steps: 5 });
    await page.mouse.move(endX, endY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    const elementsCount = await page.evaluate(() => {
      const wbm = window.whiteboardManager || (window.__whiteboardManager);
      const canvasEl = document.getElementById('whiteboard-canvas');
      return {
        canvasWidth: canvasEl?.width,
        canvasHeight: canvasEl?.height,
        canvasHasListeners: typeof canvasEl?.onmousedown === 'function'
      };
    });
    console.log('   Canvas verificado:', elementsCount);

    // 4. Fechar via botão fechar da topbar da lousa (#wb-close-btn)
    console.log('4. Clicando em #wb-close-btn para fechar a lousa...');
    await closeBtn.click();
    await page.waitForTimeout(400);

    const isVisibleAfterClose = await modal.isVisible();
    console.log(`   Lousa visível após clicar em fechar: ${isVisibleAfterClose} (esperado: false)`);
    if (isVisibleAfterClose) throw new Error('Lousa falhou em fechar ao clicar em #wb-close-btn!');

    // 5. Abrir novamente pelo dock e fechar com tecla Escape
    console.log('5. Abrindo novamente via #dock-whiteboard-btn e fechando com Escape...');
    await dockBtn.click();
    await page.waitForTimeout(400);
    console.log(`   Lousa visível após abrir pelo dock: ${await modal.isVisible()} (esperado: true)`);
    if (!(await modal.isVisible())) throw new Error('Lousa falhou em reabrir pelo dock!');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    console.log(`   Lousa visível após pressionar Escape: ${await modal.isVisible()} (esperado: false)`);
    if (await modal.isVisible()) throw new Error('Lousa falhou em fechar com Escape!');

    // The room exposes one whiteboard action, in the dock.
    if (await page.locator('#toggle-whiteboard-btn').count()) throw new Error('A sala duplicou o botão da lousa');

    // 7. Voltar para a sala via botão destacado `#wb-back-room-btn`
    console.log('7. Abrindo lousa e testando retorno para a sala via #wb-back-room-btn...');
    await dockBtn.click();
    await page.waitForTimeout(400);
    const backRoomBtn = page.locator('#wb-back-room-btn');
    if (!(await backRoomBtn.isVisible())) throw new Error('Botão #wb-back-room-btn não está visível!');
    await backRoomBtn.click();
    await page.waitForTimeout(400);
    console.log(`   Lousa fechada via #wb-back-room-btn: ${!(await modal.isVisible())} (esperado: true)`);
    if (await modal.isVisible()) throw new Error('Lousa falhou em fechar ao clicar em #wb-back-room-btn!');

    // 8. Voltar para a sala via botão flutuante `#wb-floating-close-btn`
    console.log('8. Abrindo lousa e testando retorno para a sala via #wb-floating-close-btn...');
    await dockBtn.click();
    await page.waitForTimeout(400);
    const floatBtn = page.locator('#wb-floating-close-btn');
    if (!(await floatBtn.isVisible())) throw new Error('Botão flutuante #wb-floating-close-btn não está visível!');
    await floatBtn.click();
    await page.waitForTimeout(400);
    console.log(`   Lousa fechada via #wb-floating-close-btn: ${!(await modal.isVisible())} (esperado: true)`);
    if (await modal.isVisible()) throw new Error('Lousa falhou em fechar ao clicar em #wb-floating-close-btn!');

    console.log(`\n======================================================`);
    console.log(`[E2E CENÁRIO 2] Teste da Lousa no Streamer Clássico (streamer.html)`);
    console.log(`======================================================`);

    await page.goto(`${server.origin}/streamer.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    const streamerModal = page.locator('#whiteboard-modal');
    const streamerToggleBtn = page.locator('#toggle-whiteboard-btn');
    const streamerCloseBtn = page.locator('#wb-close-btn');

    console.log('1. Clicando em #toggle-whiteboard-btn no streamer.html...');
    await streamerToggleBtn.click();
    await page.waitForTimeout(400);

    const streamerModalVisible = await streamerModal.isVisible();
    console.log(`   Lousa visível no streamer.html: ${streamerModalVisible} (esperado: true)`);
    if (!streamerModalVisible) throw new Error('Lousa falhou em abrir no streamer.html!');

    console.log('2. Fechando com botão #wb-close-btn...');
    await streamerCloseBtn.click();
    await page.waitForTimeout(400);

    const streamerModalClosed = !(await streamerModal.isVisible());
    console.log(`   Lousa fechada no streamer.html: ${streamerModalClosed} (esperado: true)`);
    if (!streamerModalClosed) throw new Error('Lousa falhou em fechar via #wb-close-btn no streamer.html!');

    console.log(`\n======================================================`);
    console.log(`🎉 TESTE E2E DA LOUSA CONCLUÍDO COM 100% DE SUCESSO!`);
    console.log(`======================================================\n`);

  } catch (err) {
    console.error('\n❌ [E2E FALHA]:', err);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await signaling.close();
    await server.close();
  }
}

run();
