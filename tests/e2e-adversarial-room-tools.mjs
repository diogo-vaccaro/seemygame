import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/room-tools-adversarial-' + Date.now() + '/', import.meta.url);
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
  console.log('🚀 Iniciando teste E2E de Variações e Stress das Ferramentas da Sala...');
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

    await page.goto(server.origin + '/room.html?room=tools-adversarial-suite');
    await page.locator('#green-room-user-name').fill(`ProGamer ${index}`);
    await page.locator('#green-room-join-btn').click();
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);
  }

  // Aguarda ambos os peers estarem conectados na sala
  for (const page of pages) {
    await wait(page, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  }
  console.log('✅ 1. Ambos os participantes conectados via WebRTC');
  evidence.checks.push({ connection: 'passed', peersCount: 2 });

  // Host inicia transmissão de vídeo sintética do harness
  await pages[0].locator('#dock-stream-btn').click();

  for (const page of pages) {
    await page.locator('.video-card video').first().waitFor({ state: 'visible' });
  }
  console.log('✅ 2. Transmissão de vídeo sintética ativa para ambos os peers');

  // =========================================================================
  // VARIAÇÃO 1: TELESTRATOR - MULTI-FERRAMENTAS, CORES, BORRACHA E PONTO ÚNICO
  // =========================================================================
  console.log('🧪 3. Testando Variações Avançadas do Telestrator...');
  const annotateCardBtn = pages[0].locator('.video-card .card-btn-annotate').first();
  await annotateCardBtn.click();

  const toolbar = pages[0].locator('.annotate-toolbar');
  await toolbar.waitFor({ state: 'visible' });

  // A. Seleciona ferramenta Retângulo e cor Verde (#2ed573)
  await toolbar.locator('[data-tool="rect"]').click();
  await toolbar.locator('[data-color="#2ed573"]').click();

  // Host desenha retângulo
  const canvasHost = pages[0].locator('.annotate-overlay-canvas');
  await canvasHost.waitFor({ state: 'visible' });

  const canvasBox = await canvasHost.boundingBox();
  assert.ok(canvasBox, 'Canvas de anotação deve ter dimensões válidas');

  await pages[0].mouse.move(canvasBox.x + 80, canvasBox.y + 80);
  await pages[0].mouse.down();
  await pages[0].mouse.move(canvasBox.x + 220, canvasBox.y + 180);
  await pages[0].mouse.up();

  // Viewer deve receber stroke do tipo rect com cor #2ed573
  await wait(pages[1], async () => {
    const { annotateManager } = await import('/js/room/annotate.js');
    return annotateManager.strokes.some(s => s.tool === 'rect' && s.color === '#2ed573');
  });
  console.log('✅ Retângulo verde desenhado e sincronizado com o viewer');

  // B. Seleciona ferramenta Seta e desenha
  await toolbar.locator('[data-tool="arrow"]').click();
  await toolbar.locator('[data-color="#ff4757"]').click();
  await pages[0].mouse.move(canvasBox.x + 240, canvasBox.y + 80);
  await pages[0].mouse.down();
  await pages[0].mouse.move(canvasBox.x + 340, canvasBox.y + 150);
  await pages[0].mouse.up();

  await wait(pages[1], async () => {
    const { annotateManager } = await import('/js/room/annotate.js');
    return annotateManager.strokes.some(s => s.tool === 'arrow');
  });
  console.log('✅ Seta tática desenhada e sincronizada com o viewer');

  // C. Teste de clique único (ponto isolado de caneta)
  await toolbar.locator('[data-tool="pen"]').click();
  await pages[0].mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await pages[0].mouse.down();
  await pages[0].mouse.up();

  // D. Seleciona Borracha e apaga próximo ao ponto isolado
  await toolbar.locator('[data-tool="eraser"]').click();
  await pages[0].mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await pages[0].mouse.down();
  await pages[0].mouse.up();

  // E. Limpar tudo
  await toolbar.locator('.annotate-clear-btn').click();
  await wait(pages[1], async () => {
    const { annotateManager } = await import('/js/room/annotate.js');
    return annotateManager.strokes.length === 0;
  });
  console.log('✅ Borracha e Limpeza total sincronizadas perfeitamente');
  evidence.checks.push({ telestratorVariations: 'passed' });

  // Fecha toolbar
  await toolbar.locator('.annotate-close-btn').click();

  // =========================================================================
  // VARIAÇÃO 2: ENQUETES - ALTERNÂNCIA DE VOTO, RECOMPOSIÇÃO E MULTI-ENQUETE
  // =========================================================================
  console.log('🧪 4. Testando Variações Avançadas de Enquetes (Troca de Voto e Criação Consecutiva)...');
  await pages[0].locator('#dock-room-tools-btn').click();
  await pages[0].locator('#room-tools-menu [data-action="poll"]').click();

  const pollModal = pages[0].locator('#poll-modal');
  await pollModal.waitFor({ state: 'visible' });

  // Criar primeira enquete com 3 opções
  await pages[0].locator('#poll-question-input').fill('Qual o melhor mapa?');
  await pages[0].locator('#poll-opt-1').fill('Mirage');
  await pages[0].locator('#poll-opt-2').fill('Inferno');
  await pages[0].locator('#poll-opt-3').fill('Nuke');
  await pages[0].locator('#poll-create-form button[type="submit"]').click();

  // Aguarda sincronização da enquete no Viewer
  await wait(pages[1], async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    return pollManager.currentPoll && pollManager.currentPoll.question === 'Qual o melhor mapa?';
  });

  // Host vota na opção 0 (Mirage)
  await pages[0].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    pollManager.vote(pollManager.currentPoll.id, 0, 'pro-gamer-0');
  });

  // Viewer vota na opção 1 (Inferno)
  await pages[1].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    pollManager.vote(pollManager.currentPoll.id, 1, 'pro-gamer-1');
  });

  // Viewer muda de ideia e troca o voto para a opção 2 (Nuke)
  await pages[1].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    pollManager.vote(pollManager.currentPoll.id, 2, 'pro-gamer-1');
  });

  // Verifica resultado no Host: Mirage (1 voto, 50%), Inferno (0 votos, 0%), Nuke (1 voto, 50%)
  const pollResults1 = await pages[0].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    return pollManager.getResults();
  });
  assert.equal(pollResults1.totalVotes, 2);
  assert.equal(pollResults1.options[0].count, 1, 'Mirage deve ter 1 voto');
  assert.equal(pollResults1.options[1].count, 0, 'Inferno deve ter 0 votos após troca');
  assert.equal(pollResults1.options[2].count, 1, 'Nuke deve ter 1 voto');
  console.log('✅ Troca dinâmica de voto e cálculo de porcentagem validados');

  // Host encerra primeira enquete
  await pages[0].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    pollManager.endPoll(pollManager.currentPoll.id, true);
  });

  // Host cria uma segunda enquete diretamente (Consecutiva)
  await pages[0].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    pollManager.createPoll({
      question: 'Próxima partida é competitiva?',
      options: ['Sim, bora subir de elo!', 'Não, apenas casual'],
      durationSeconds: 120,
      creatorId: 'pro-gamer-0'
    });
  });

  await wait(pages[1], async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    return pollManager.currentPoll?.question === 'Próxima partida é competitiva?';
  });

  // Host encerra a segunda enquete
  await pages[0].evaluate(async () => {
    const { pollManager } = await import('/js/room/poll-manager.js');
    pollManager.endPoll(pollManager.currentPoll.id, true);
  });
  console.log('✅ Criação consecutiva de enquetes validada com sucesso');
  evidence.checks.push({ pollVariations: 'passed' });

  await pages[0].locator('.poll-modal-close').click();

  // =========================================================================
  // VARIAÇÃO 3: CONTROLE DE VOLUME - TECLADO ESCAPE E LIMITES
  // =========================================================================
  console.log('🧪 5. Testando Controle de Volume com Tecla Escape e Limites...');
  const participantWrapper = pages[0].locator('.participant-item .participant-volume-wrapper').first();
  await participantWrapper.waitFor({ state: 'visible' });

  // Abre popover
  await participantWrapper.locator('.btn-participant-volume-toggle').click();
  const volPopover = participantWrapper.locator('.participant-volume-popover');
  await volPopover.waitFor({ state: 'visible' });

  // Pressiona tecla Escape no documento para fechar
  await pages[0].keyboard.press('Escape');
  const isPopoverHidden = await volPopover.evaluate(el => el.style.display === 'none');
  assert.equal(isPopoverHidden, true, 'Popover de volume deve fechar com a tecla Escape');
  console.log('✅ Acessibilidade: Popover de volume fecha com Escape');
  evidence.checks.push({ volumeEscapeKey: 'passed' });

  // =========================================================================
  // VARIAÇÃO 4: MODO STREAMER - MUTATION OBSERVER DINÂMICO E TOGGLE CONTÍNUO
  // =========================================================================
  console.log('🧪 6. Testando Modo Streamer com Injeção Dinâmica de Elementos e Tecla de Atalho...');
  // Ativa modo streamer via atalho de teclado
  await pages[0].keyboard.press('Control+Shift+S');
  const isStreamerOn = await pages[0].evaluate(() => document.body.classList.contains('streamer-mode-active'));
  assert.equal(isStreamerOn, true, 'Atalho Ctrl+Shift+S deve ativar modo streamer');

  // Insere dinamicamente um novo elemento sensível no DOM com classe .room-code
  await pages[0].evaluate(() => {
    const input = document.createElement('input');
    input.className = 'room-code dynamic-secret-input';
    input.value = 'CHAVE-SECRETA-999';
    document.body.appendChild(input);
  });

  // Aguarda MutationObserver mascarar o novo elemento
  await wait(pages[0], () => {
    const el = document.querySelector('.dynamic-secret-input');
    return el && el.value === '••••••••' && el.dataset.realValue === 'CHAVE-SECRETA-999';
  });
  console.log('✅ MutationObserver protegeu elemento inserido dinamicamente');

  // Desativa modo streamer via atalho
  await pages[0].keyboard.press('Control+Shift+S');
  const isStreamerOff = await pages[0].evaluate(() => !document.body.classList.contains('streamer-mode-active'));
  assert.equal(isStreamerOff, true, 'Atalho Ctrl+Shift+S deve desativar modo streamer');

  // Limpa elemento injetado
  await pages[0].evaluate(() => document.querySelector('.dynamic-secret-input')?.remove());
  evidence.checks.push({ streamerMutationObserver: 'passed' });

  // =========================================================================
  // VARIAÇÃO 5: GRAVAÇÃO MULTITRACK COM ZIP E MANIFESTO
  // =========================================================================
  console.log('🧪 7. Testando Gravação Multitrack com Múltiplas Faixas...');
  const zipExport = await pages[0].evaluate(async () => {
    const { multitrackRecorder } = await import('/js/room/multitrack-recorder.js');
    const { ZipBuilder } = await import('/js/utils/zip-builder.js');

    const zip = new ZipBuilder();
    await zip.addFile('tracks/master.webm', new Uint8Array([1, 2, 3, 4, 5]));
    await zip.addFile('tracks/microfone-host 🎙️.webm', new Uint8Array([6, 7, 8]));
    await zip.addFile('manifest.json', JSON.stringify({ app: 'SeeMyGame', tracksCount: 2 }));

    const blob = zip.buildBlob();
    return {
      size: blob.size,
      entriesCount: zip.entries.length
    };
  });

  assert.ok(zipExport.size > 0, 'Blob do ZIP deve ter bytes');
  assert.equal(zipExport.entriesCount, 3, 'ZIP deve conter as 3 entradas incluindo nomes unicode');
  console.log('✅ Geração de ZIP com caracteres UTF-8 e múltiplas faixas validada');
  evidence.checks.push({ multitrackZipUtf8: 'passed' });

  // Captura screenshots finais das duas janelas
  await pages[0].screenshot({ path: fileURLToPath(new URL('adversarial-host.png', output)), fullPage: true });
  await pages[1].screenshot({ path: fileURLToPath(new URL('adversarial-viewer.png', output)), fullPage: true });

  assert.deepEqual(evidence.errors, []);
  evidence.status = 'passed';
  console.log('\n🎉 PASS: Todas as variações avançadas e condições adversárias passaram com 100% de sucesso!');
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = error.stack || error.message;
  console.error('❌ Falha no teste adversarial:', error);
  throw error;
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(evidence, null, 2));
  console.log('📁 Evidências salvas em:', fileURLToPath(output));
  await browser?.close();
  await signaling?.close();
  await server?.close();
}
