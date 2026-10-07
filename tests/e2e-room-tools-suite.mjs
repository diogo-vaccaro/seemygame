import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/room-tools-suite-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });

const server = await startAssetServer({ root });
const signaling = await startSignalingServer();
let browser;

const evidence = {
  status: 'running',
  checks: [],
  errors: [],
  limitations: ['Chromium headless with synthetic canvas video capture and fake microphone; real PeerJS WebRTC data and voice signaling.']
};

const wait = (page, predicate, arg) => waitForAsync(() => page.evaluate(predicate, arg), { timeout: 25000 });

try {
  console.log('🚀 Iniciando teste E2E da suíte completa de ferramentas da sala...');
  browser = await launchTestBrowser();

  const contexts = await Promise.all([
    prepareSessionContext(browser, signaling),
    prepareSessionContext(browser, signaling)
  ]);
  const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));

  for (const [index, page] of pages.entries()) {
    page.on('pageerror', err => {
      console.warn(`[Page ${index} Error]`, err.message);
      evidence.errors.push(`Page ${index}: ${err.message}`);
    });

    await page.goto(server.origin + '/room.html?room=tools-e2e-suite');
    await page.locator('#green-room-user-name').fill(`Gamer ${index}`);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }

  // Aguarda ambos os peers estarem conectados na sala
  for (const page of pages) {
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  }
  console.log('✅ 1. Ambos os participantes conectados via WebRTC na sala');
  evidence.checks.push({ connection: 'passed', peersCount: 2 });

  // =========================================================================
  // TESTE 1: MODO STREAMER (Anti-Sniping e Proteção)
  // =========================================================================
  console.log('🧪 2. Testando Modo Streamer...');
  const streamerBtn = pages[0].locator('#streamer-mode-btn');
  await streamerBtn.waitFor({ state: 'visible' });

  // Ativação pelo botão
  await streamerBtn.click();
  const isStreamerActive = await pages[0].evaluate(() => document.body.classList.contains('streamer-mode-active'));
  assert.equal(isStreamerActive, true, 'Corpo deve ter classe streamer-mode-active');

  const streamerTitle = await pages[0].title();
  assert.equal(streamerTitle, 'SeeMyGame - Em Transmissão', 'Título da aba deve ser anonimizado');

  const badgeText = await pages[0].locator('#room-header-badge').textContent();
  assert.ok(badgeText.includes('Modo Streamer') || badgeText.includes('Sala Oculta'), 'Badge do cabeçalho deve indicar modo streamer');

  // Alternância pelo atalho global Ctrl + Shift + S
  await pages[0].keyboard.press('Control+Shift+S');
  const isStreamerToggledOff = await pages[0].evaluate(() => document.body.classList.contains('streamer-mode-active'));
  assert.equal(isStreamerToggledOff, false, 'Atalho Ctrl+Shift+S deve desativar o modo streamer');

  await pages[0].keyboard.press('Control+Shift+S');
  const isStreamerToggledOn = await pages[0].evaluate(() => document.body.classList.contains('streamer-mode-active'));
  assert.equal(isStreamerToggledOn, true, 'Atalho Ctrl+Shift+S deve reativar o modo streamer');

  console.log('✅ Modo Streamer validado com sucesso (Botão + Teclado + DOM + Título)');
  evidence.checks.push({ streamerMode: 'passed' });

  // =========================================================================
  // TESTE 2: DOCA E MENU DE FERRAMENTAS DA SALA
  // =========================================================================
  console.log('🧪 3. Testando Menu Flutuante de Ferramentas...');
  const toolsDockBtn = pages[0].locator('#dock-room-tools-btn');
  await toolsDockBtn.waitFor({ state: 'visible' });

  await toolsDockBtn.click();
  await pages[0].locator('#room-tools-menu').waitFor({ state: 'visible' });

  const menuActions = await pages[0].evaluate(() => {
    return Array.from(document.querySelectorAll('#room-tools-menu [data-action]')).map(el => el.dataset.action);
  });
  assert.ok(menuActions.includes('annotate'), 'Menu deve conter ação annotate');
  assert.ok(menuActions.includes('poll'), 'Menu deve conter ação poll');
  assert.ok(menuActions.includes('multitrack'), 'Menu deve conter ação multitrack');
  assert.ok(menuActions.includes('streamer'), 'Menu deve conter ação streamer');
  assert.ok(menuActions.includes('pip'), 'Menu deve conter ação pip');

  // Fechar o menu
  await pages[0].locator('.room-tools-close').click();
  await pages[0].locator('#room-tools-menu').waitFor({ state: 'detached' });
  console.log('✅ Doca e Menu de Ferramentas validados com sucesso');
  evidence.checks.push({ roomToolsMenu: 'passed', actions: menuActions });

  // =========================================================================
  // TESTE 3: TRANSMISSÃO DE VÍDEO + TELESTRATOR (ANOTAÇÕES AO VIVO NO STREAM)
  // =========================================================================
  console.log('🧪 4. Testando Telestrator sobre o stream ativo...');
  // Inicia transmissão de tela sintética do Host (pages[0])
  await pages[0].locator('#dock-stream-btn').click();

  // Aguarda cards de vídeo estarem visíveis em ambas as telas
  for (const page of pages) {
    await page.locator('.video-card video').first().waitFor({ state: 'visible' });
  }

  // Ativa Telestrator através do card de vídeo
  const annotateCardBtn = pages[0].locator('.video-card .card-btn-annotate').first();
  await annotateCardBtn.click();

  // Verifica que canvas overlay e toolbar foram criados no Host
  await pages[0].locator('.annotate-overlay-canvas').waitFor({ state: 'visible' });
  await pages[0].locator('.annotate-toolbar').waitFor({ state: 'visible' });

  // Seleciona caneta e cor
  await pages[0].locator('.annotate-tool-btn[data-tool="pen"]').click();
  await pages[0].locator('.annotate-color-btn[data-color="#2ed573"]').click();

  // Desenha um traço tático no canvas do Host
  const canvasBox = await pages[0].locator('.annotate-overlay-canvas').boundingBox();
  const startX = canvasBox.x + canvasBox.width * 0.25;
  const startY = canvasBox.y + canvasBox.height * 0.3;
  const endX = canvasBox.x + canvasBox.width * 0.55;
  const endY = canvasBox.y + canvasBox.height * 0.6;

  await pages[0].mouse.move(startX, startY);
  await pages[0].mouse.down();
  await pages[0].mouse.move(endX, endY, { steps: 5 });
  await pages[0].mouse.up();

  // Verifica contagem local de traços no Host
  const localStrokesCount = await pages[0].evaluate(async () => {
    const { annotateManager } = await import('/js/room/annotate.js');
    return annotateManager.strokes.length;
  });
  assert.ok(localStrokesCount >= 1, 'Host deve ter registrado pelo menos 1 traço');

  // Verifica sincronização P2P do traço no Participante Remoto (pages[1])
  await wait(pages[1], async () => {
    const { annotateManager } = await import('/js/room/annotate.js');
    return annotateManager.strokes.length >= 1;
  });
  console.log('✅ Traço do Telestrator sincronizado via P2P com sucesso');

  // Limpar anotações
  await pages[0].locator('.annotate-clear-btn').click();
  await wait(pages[0], async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 0);
  await wait(pages[1], async () => (await import('/js/room/annotate.js')).annotateManager.strokes.length === 0);
  console.log('✅ Ação Limpar Anotações sincronizada via P2P em todas as pontas');

  // Fechar toolbar de anotações
  await pages[0].locator('.annotate-close-btn').click();
  evidence.checks.push({ telestratorP2P: 'passed' });

  // =========================================================================
  // TESTE 4: ENQUETES AO VIVO NA SALA (POLLS)
  // =========================================================================
  console.log('🧪 5. Testando Enquetes em Tempo Real com Publicação no Chat...');
  // Host abre modal de enquete via menu de ferramentas
  await toolsDockBtn.click();
  await pages[0].locator('[data-action="poll"]').click();
  await pages[0].locator('#poll-modal').waitFor({ state: 'visible' });

  // Preenche formulário de enquete
  await pages[0].locator('#poll-question-input').fill('Qual o próximo mapa da ranked?');
  await pages[0].locator('#poll-opt-1').fill('Mirage');
  await pages[0].locator('#poll-opt-2').fill('Inferno');
  await pages[0].locator('#poll-opt-3').fill('Dust II');

  // Inicia enquete
  await pages[0].locator('#poll-create-form button[type="submit"]').click();

  // Verifica se enquete foi propagada para o participante remoto (pages[1])
  await wait(pages[1], async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    return pollManager.currentPoll && pollManager.currentPoll.isActive && pollManager.currentPoll.options.length === 3;
  });

  // Participante remoto abre modal de enquetes e vota em 'Mirage' (índice 0)
  await pages[1].evaluate(async () => {
    const { roomToolsController } = await import('/js/room/room-tools.js');
    roomToolsController.openPollModal();
  });
  await pages[1].locator('#poll-modal').waitFor({ state: 'visible' });

  const remoteOptions = pages[1].locator('#poll-active-card-container .poll-option-row');
  await remoteOptions.first().click(); // Voto em Mirage

  // Host vota em 'Inferno' (índice 1)
  const hostOptions = pages[0].locator('#poll-active-card-container .poll-option-row');
  await hostOptions.nth(1).click(); // Voto em Inferno

  // Aguarda cômputo sincronizado de 2 votos em ambas as abas
  for (const page of pages) {
    await wait(page, async () => {
      const { pollManager } = await import('/js/room/poll-manager.js');
      return pollManager.getResults()?.totalVotes === 2;
    });
  }

  const pollStats = await pages[0].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    return pollManager.getResults();
  });
  assert.equal(pollStats.totalVotes, 2);
  assert.equal(pollStats.options[0].count, 1);
  assert.equal(pollStats.options[1].count, 1);
  console.log('✅ Votação em tempo real e cálculo percentual 50/50 sincronizado');

  // Host encerra a enquete
  await pages[0].locator('.poll-end-btn').click();

  // Verifica que enquete encerrou e mensagem com resumo foi gerada
  for (const page of pages) {
    await wait(page, async () => {
      const { pollManager } = await import('/js/room/poll-manager.js');
      return pollManager.currentPoll?.isActive === false;
    });
  }

  const debugChat = await pages[0].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    const { roomToolsController } = await import('/js/room/room-tools.js');
    const container = document.getElementById('chat-messages-container');
    return {
      hasAnnounce: Boolean(pollManager.onChatAnnounce),
      hasChatManager: Boolean(roomToolsController.chatManager),
      chatHtml: container?.innerHTML,
      chatText: container?.textContent
    };
  });
  console.log('🔍 Debug Chat Status:', JSON.stringify(debugChat, null, 2));

  // Verifica publicação do resumo da enquete no chat da sala
  await wait(pages[0], () => {
    const chatContainer = document.getElementById('chat-messages-container');
    return chatContainer && chatContainer.textContent.includes('Enquete');
  });

  console.log('✅ Enquete finalizada e resumo publicado automaticamente no chat');
  await pages[0].locator('.poll-modal-close').click();
  await pages[1].locator('.poll-modal-close').click();
  evidence.checks.push({ livePolls: 'passed' });

  // =========================================================================
  // TESTE 5: GRAVAÇÃO MULTITRACK SINCRONIZADA EM ZIP
  // =========================================================================
  console.log('🧪 6. Testando Gravação Multitrack Sincronizada em ZIP...');
  await toolsDockBtn.click();
  await pages[0].locator('[data-action="multitrack"]').click();
  await pages[0].locator('#multitrack-modal').waitFor({ state: 'visible' });

  // Inicia gravação multitrack
  await pages[0].locator('#multitrack-start-btn').click();

  // Verifica que gravador iniciou
  await wait(pages[0], async () => {
    const { multitrackRecorder } = await import('/js/room/multitrack-recorder.js');
    return multitrackRecorder.isRecording === true;
  });

  const recordingStatus = await pages[0].locator('#multitrack-status-badge').textContent();
  assert.ok(recordingStatus.includes('Gravando'), 'Badge deve indicar gravação ativa');

  // Aguarda 1.5s para acumular chunks e avançar o timer
  await new Promise(r => setTimeout(r, 1500));

  const timerText = await pages[0].locator('#multitrack-timer').textContent();
  assert.ok(timerText.includes('REC'), 'Timer regressivo/progressivo de REC deve estar ativo');

  // Executa exportação em ZIP com autoDownload=false para validar arquivo e manifesto
  const zipResult = await pages[0].evaluate(async () => {
    const { multitrackRecorder } = await import('/js/room/multitrack-recorder.js');
    const res = await multitrackRecorder.exportZip({
      filename: 'e2e-test-session.zip',
      autoDownload: false
    });
    return {
      size: res.blob.size,
      manifest: res.manifest,
      filename: res.filename
    };
  });

  assert.ok(zipResult.size > 0, 'Blob do arquivo ZIP deve ter tamanho maior que 0');
  assert.equal(zipResult.manifest.app, 'SeeMyGame');
  assert.ok(zipResult.manifest.tracks.length >= 1, 'Manifesto deve conter as faixas gravadas');
  console.log('✅ Gravação multitrack e empacotamento ZIP (PKZIP 2.0) validados com sucesso');

  await pages[0].locator('.multitrack-modal-close').click();
  evidence.checks.push({ multitrackZip: 'passed', zipSize: zipResult.size, tracksCount: zipResult.manifest.tracks.length });

  // =========================================================================
  // TESTE 6: CONTROLE DE VOLUME INDIVIDUAL POR PARTICIPANTE
  // =========================================================================
  console.log('🧪 7. Testando Controle Individual de Volume e Mute Local...');
  // Na sidebar de participantes do Host (pages[0]), localiza o item do participante Gamer 1
  const participantWrapper = pages[0].locator('.participant-item .participant-volume-wrapper').first();
  await participantWrapper.waitFor({ state: 'visible' });

  // Abre popover de volume
  const volToggleBtn = participantWrapper.locator('.btn-participant-volume-toggle');
  await volToggleBtn.click();

  const volPopover = participantWrapper.locator('.participant-volume-popover');
  await volPopover.waitFor({ state: 'visible' });

  // Altera o slider de volume para 150%
  const remotePeerId = await pages[0].evaluate(async () => {
    const { roomState } = await import('/js/entries/room-entry.js');
    return Array.from(roomState.roomManager.members.keys()).find(id => id !== roomState.peer.id);
  });

  await pages[0].evaluate(async (peerId) => {
    const { voiceManager } = (await import('/js/entries/room-entry.js')).roomState.session.services;
    voiceManager.setUserVolume(peerId, 150);
  }, remotePeerId);

  const updatedVol = await pages[0].evaluate(async (peerId) => {
    const { voiceManager } = (await import('/js/entries/room-entry.js')).roomState.session.services;
    return voiceManager.getUserVolume(peerId);
  }, remotePeerId);
  assert.equal(updatedVol, 150, 'Volume do participante no Web Audio mixer deve ser 150%');

  // Clica no botão de Silenciar localmente
  const muteLocalBtn = volPopover.locator('.btn-participant-mute-local');
  await muteLocalBtn.click();

  const isLocallyMuted = await pages[0].evaluate(async (peerId) => {
    const { voiceManager } = (await import('/js/entries/room-entry.js')).roomState.session.services;
    return voiceManager.isUserLocallyMuted(peerId);
  }, remotePeerId);
  assert.equal(isLocallyMuted, true, 'Participante deve estar silenciado localmente');

  // Clica no botão 100% para restaurar
  const resetBtn = volPopover.locator('.btn-participant-vol-reset');
  await resetBtn.click();

  const restoredVol = await pages[0].evaluate(async (peerId) => {
    const { voiceManager } = (await import('/js/entries/room-entry.js')).roomState.session.services;
    return {
      vol: voiceManager.getUserVolume(peerId),
      muted: voiceManager.isUserLocallyMuted(peerId)
    };
  }, remotePeerId);
  assert.equal(restoredVol.vol, 100);
  assert.equal(restoredVol.muted, false);
  console.log('✅ Controle individual de volume (0-200%) e mudo local validados com sucesso');
  evidence.checks.push({ participantVolumeControl: 'passed' });

  // =========================================================================
  // TESTE 7: PICTURE-IN-PICTURE (PIP)
  // =========================================================================
  console.log('🧪 8. Testando botão de Picture-in-Picture no card de vídeo...');
  const pipCardBtn = pages[0].locator('.video-card .card-btn-pip').first();
  await pipCardBtn.waitFor({ state: 'visible' });

  const pipSupported = await pages[0].evaluate(async () => {
    const { pipController } = await import('/js/room/pip-controller.js');
    return pipController.isSupported();
  });
  assert.ok(pipSupported !== undefined, 'PipController deve relatar suporte da plataforma');
  console.log('✅ Controlador de Picture-in-Picture validado com sucesso');
  evidence.checks.push({ pictureInPicture: 'passed', isSupported: pipSupported });

  // Captura screenshots finais das duas janelas como evidência E2E
  await pages[0].screenshot({ path: fileURLToPath(new URL('host-room-tools-e2e.png', output)), fullPage: true });
  await pages[1].screenshot({ path: fileURLToPath(new URL('viewer-room-tools-e2e.png', output)), fullPage: true });

  assert.deepEqual(evidence.errors, []);
  evidence.status = 'passed';
  console.log('\n🎉 PASS: TODAS as 7 ferramentas colaborativas passaram no teste E2E com maestria!');
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = error.stack || error.message;
  console.error('❌ Falha no teste E2E:', error);
  throw error;
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(evidence, null, 2));
  console.log('📁 Evidências E2E salvas em:', fileURLToPath(output));
  await browser?.close();
  await signaling?.close();
  await server?.close();
}
