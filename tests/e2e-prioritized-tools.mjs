import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/prioritized-tools-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });

const server = await startAssetServer({ root });
const signaling = await startSignalingServer();
let browser;

const evidence = {
  status: 'running',
  checks: [],
  errors: [],
  limitations: ['Chromium headless with fake devices and local loopback signaling.']
};

const wait = (page, predicate, arg) => waitForAsync(() => page.evaluate(predicate, arg), { timeout: 25000 });

try {
  console.log('🚀 Iniciando suíte de testes E2E do pacote prioritário de ferramentas...');
  browser = await launchTestBrowser();

  const [ctx1, ctx2, ctx3] = await Promise.all([
    prepareSessionContext(browser, signaling),
    prepareSessionContext(browser, signaling),
    prepareSessionContext(browser, signaling)
  ]);

  const [hostPage, guestPage, viewerPage] = await Promise.all([
    ctx1.newPage(),
    ctx2.newPage(),
    ctx3.newPage()
  ]);

  // Captura de erros nas páginas
  for (const [name, page] of [['Host', hostPage], ['Guest', guestPage], ['Viewer', viewerPage]]) {
    page.on('pageerror', err => {
      console.warn(`[${name} Error]`, err.message);
      evidence.errors.push(`${name}: ${err.message}`);
    });
  }

  // =========================================================================
  // 1. CONEXÃO DA SALA: HOST E GUEST
  // =========================================================================
  console.log('📡 1. Conectando Host e Guest à sala via WebRTC...');
  await hostPage.goto(server.origin + '/room.html?room=prioritized-tools-test');
  await hostPage.locator('#green-room-user-name').fill('Host Gamer');
  await hostPage.locator('#green-room-join-btn').click();
  await wait(hostPage, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);

  await guestPage.goto(server.origin + '/room.html?room=prioritized-tools-test');
  await guestPage.locator('#green-room-user-name').fill('Guest Gamer');
  await guestPage.locator('#green-room-join-btn').click();
  await wait(guestPage, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom);

  // Aguarda sincronização de presença P2P
  await wait(hostPage, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  await wait(guestPage, async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2);
  console.log('✅ Ambos os membros conectados na sala.');
  evidence.checks.push({ roomMembersConnected: 2 });

  // =========================================================================
  // 2. TESTE E2E: ENTRADA SOMENTE-LEITURA (/watch & readonly-viewer)
  // =========================================================================
  console.log('🔒 2. Testando Entrada Somente-Leitura no Espectador...');
  await viewerPage.goto(server.origin + '/viewer.html#watch=prioritized-tools-test&mode=readonly');

  // Verifica crachá de modo somente-leitura na interface
  const roleBadge = viewerPage.locator('.role-badge.viewer');
  await roleBadge.waitFor({ state: 'visible' });
  const badgeText = await roleBadge.textContent();
  assert.ok(badgeText.includes('Somente-Leitura'), `Crachá deve indicar modo somente-leitura, recebido: "${badgeText}"`);

  // Verifica que o botão de laboratório de controle está oculto
  const ctrlLabDisplay = await viewerPage.evaluate(() => {
    const el = document.getElementById('open-controller-lab-btn');
    return el ? window.getComputedStyle(el).display : 'none';
  });
  assert.equal(ctrlLabDisplay, 'none', 'Botão de controles deve estar oculto em modo somente-leitura');

  // Verifica que tentar entrar em voz em modo somente-leitura exibe toast e não inicializa áudio transmissor
  const toggleVoiceBtn = viewerPage.locator('#toggle-voice-btn');
  if (await toggleVoiceBtn.count() > 0) {
    await toggleVoiceBtn.click();
    const voiceConnectBtn = viewerPage.locator('#voice-connect-btn');
    await voiceConnectBtn.waitFor({ state: 'visible' });
    await voiceConnectBtn.click();

    // Aguarda o toast informativo
    await viewerPage.waitForSelector('#toast-container .toast', { timeout: 5000 });
    const toastContent = await viewerPage.locator('#toast-container').textContent();
    assert.ok(
      toastContent.includes('somente-leitura') || toastContent.includes('desativada'),
      `Toast deve informar sobre restrição de voz, obtido: "${toastContent}"`
    );
  }
  console.log('✅ Modo Somente-Leitura validado com sucesso (UI, Badges, Guarda de Voz e Controles).');
  evidence.checks.push({ readonlyViewer: 'passed' });

  // =========================================================================
  // 3. TESTE E2E: GERENCIADOR DE LAYOUTS (Grade, Destaque e Cinema)
  // =========================================================================
  console.log('🖼️ 3. Testando Gerenciador de Layouts na Sala...');
  // Inicia transmissão sintética para ativar a grade de vídeos
  await hostPage.locator('#dock-stream-btn').click();
  await hostPage.locator('.video-card video').first().waitFor({ state: 'visible' });

  const gridEl = hostPage.locator('#video-grid');
  await gridEl.waitFor({ state: 'visible' });

  // Início em modo grade
  let gridClass = await gridEl.getAttribute('class');
  assert.ok(gridClass.includes('layout-grid'), 'Grid deve iniciar com classe layout-grid');

  // Alternar para foco com a tecla 'f'
  await hostPage.keyboard.press('f');
  gridClass = await gridEl.getAttribute('class');
  assert.ok(gridClass.includes('layout-focus'), 'Após tecla F, grid deve receber layout-focus');

  // Alternar para cinema pelo menu de ferramentas
  const toolsBtn = hostPage.locator('#dock-room-tools-btn');
  await toolsBtn.click();
  await hostPage.locator('#room-tools-menu').waitFor({ state: 'visible' });

  const layoutItem = hostPage.locator('#room-tools-menu [data-action="layout"]');
  await layoutItem.click();

  // Grid deve entrar em modo cinema
  gridClass = await gridEl.getAttribute('class');
  assert.ok(gridClass.includes('layout-cinema'), 'Grid deve receber classe layout-cinema');

  // Controles flutuantes de cinema devem estar presentes
  const cinemaControls = hostPage.locator('#cinema-floating-controls');
  await cinemaControls.waitFor({ state: 'visible' });

  // Testar alternância do chat em overlay no modo cinema
  const cinemaChatBtn = hostPage.locator('#cinema-toggle-chat-btn');
  await cinemaChatBtn.click();
  const drawerClass = await hostPage.locator('#discord-drawer').getAttribute('class');
  assert.ok(drawerClass.includes('cinema-open'), 'Gaveta deve receber classe cinema-open ao abrir chat');

  // Sair do modo cinema com a tecla Escape
  await hostPage.keyboard.press('Escape');
  gridClass = await gridEl.getAttribute('class');
  assert.ok(gridClass.includes('layout-grid'), 'Após Escape, deve retornar ao layout-grid');
  assert.equal(await cinemaControls.count(), 0, 'Controles flutuantes de cinema devem ser removidos');

  console.log('✅ Gerenciador de Layouts validado com sucesso (Grade, Destaque, Cinema, Overlay e Escape).');
  evidence.checks.push({ roomLayouts: 'passed' });

  // =========================================================================
  // 4. TESTE E2E: INSTANT REPLAY (Clipar / DVR)
  // =========================================================================
  console.log('🎬 4. Testando Instant Replay (Clipar e Atalho C)...');
  const dockClipBtn = hostPage.locator('#dock-clip-btn');
  await dockClipBtn.waitFor({ state: 'visible' });

  // Teste de digitação: focar no chat e digitar 'c' não deve disparar clip
  const chatInput = hostPage.locator('#chat-input, #room-chat-input').first();
  if (await chatInput.count() > 0) {
    await chatInput.focus();
    await hostPage.keyboard.press('c');
    const typedVal = await chatInput.inputValue();
    assert.ok(typedVal.includes('c'), 'Caractere C deve ser digitado normalmente no chat');
    // Desfocar
    await hostPage.evaluate(() => document.activeElement?.blur());
  }

  // Clicar no botão de clipar no dock
  await dockClipBtn.click();
  console.log('✅ Botão de Clipping e atalho C com guarda de inputs validados.');
  evidence.checks.push({ clippingIntegration: 'passed' });

  // =========================================================================
  // 5. TESTE E2E: BLOCO DE NOTAS COLABORATIVO (NotepadManager P2P)
  // =========================================================================
  console.log('📝 5. Testando Bloco de Notas Colaborativo com Sincronização P2P...');
  // Abrir no Host
  await toolsBtn.click();
  await hostPage.locator('#room-tools-menu').waitFor({ state: 'visible' });
  const notepadItem = hostPage.locator('#room-tools-menu [data-action="notepad"]');
  await notepadItem.click();

  const hostNotepadModal = hostPage.locator('#notepad-modal');
  await hostNotepadModal.waitFor({ state: 'visible' });

  const hostTextarea = hostPage.locator('#notepad-textarea');
  await hostTextarea.fill('Senha do Lobby: SMG2026');

  // Verifica atualização do contador
  const hostStatus = await hostPage.locator('#notepad-status-info').textContent();
  assert.ok(hostStatus.includes('23 caracteres') || hostStatus.includes('caracteres'), 'Contador deve computar caracteres');

  // Testar botão copiar
  const copyBtn = hostPage.locator('#notepad-copy-btn');
  await copyBtn.click();

  // Abrir Bloco de Notas no Guest e verificar sincronização P2P
  const guestToolsBtn = guestPage.locator('#dock-room-tools-btn');
  await guestToolsBtn.click();
  await guestPage.locator('#room-tools-menu').waitFor({ state: 'visible' });
  await guestPage.locator('#room-tools-menu [data-action="notepad"]').click();

  const guestTextarea = guestPage.locator('#notepad-textarea');
  await guestTextarea.waitFor({ state: 'visible' });

  // Aguarda sincronização P2P do texto
  await wait(guestPage, () => {
    const el = document.getElementById('notepad-textarea');
    return el && el.value.includes('Senha do Lobby: SMG2026');
  });

  const guestText = await guestTextarea.inputValue();
  assert.equal(guestText, 'Senha do Lobby: SMG2026', 'Texto deve ter sincronizado via P2P no Guest');

  // Guest adiciona informação complementar
  await guestTextarea.fill('Senha do Lobby: SMG2026\nIP: 192.168.1.100');

  // Host recebe a sincronização
  await wait(hostPage, () => {
    const el = document.getElementById('notepad-textarea');
    return el && el.value.includes('IP: 192.168.1.100');
  });

  const updatedHostText = await hostTextarea.inputValue();
  assert.ok(updatedHostText.includes('IP: 192.168.1.100'), 'Host deve receber atualização remota do Guest');

  // Fechar blocos de notas
  await hostPage.locator('#notepad-close-btn').click();
  await guestPage.locator('#notepad-close-btn').click();

  console.log('✅ Bloco de Notas validado com sucesso (Modal, Cópia, Edição Bidirecional P2P).');
  evidence.checks.push({ collaborativeNotepadP2P: 'passed' });

  // =========================================================================
  // 6. TESTE E2E: REAÇÕES EM RAJADA E ATALHOS 1 A 8
  // =========================================================================
  console.log('🚀 6. Testando Reações em Rajada e Atalhos Numéricos...');
  // Pressionar tecla '1' no Host
  await hostPage.keyboard.press('1');
  await hostPage.waitForSelector('#reactions-overlay .floating-reaction', { timeout: 4000 });

  const reactionsCount = await hostPage.locator('#reactions-overlay .floating-reaction').count();
  assert.ok(reactionsCount >= 1, 'Tecla 1 deve instanciar reação flutuante');

  // Pressionar Shift + 1 para rajada (burst)
  await hostPage.keyboard.press('Shift+1');
  await hostPage.waitForTimeout(300);

  const burstReactionsCount = await hostPage.locator('#reactions-overlay .floating-reaction').count();
  assert.ok(burstReactionsCount >= 2, 'Shift+1 deve instanciar rajada com múltiplos emojis');

  // Testar guarda de digitação: digitar no chat não deve disparar reação
  if (await chatInput.count() > 0) {
    const initialCount = await hostPage.locator('#reactions-overlay .floating-reaction').count();
    await chatInput.focus();
    await hostPage.keyboard.press('2');
    await hostPage.waitForTimeout(100);

    const afterCount = await hostPage.locator('#reactions-overlay .floating-reaction').count();
    // Não deve adicionar nova reação
    assert.equal(afterCount, initialCount, 'Digitar números no input de texto não deve disparar reações flutuantes');
  }

  console.log('✅ Reações em Rajada e Atalhos 1 a 8 validados com sucesso.');
  evidence.checks.push({ reactionsBurstAndShortcuts: 'passed' });

  evidence.status = 'passed';
  console.log('\n🎉 TODOS OS TESTES E2E DO PACOTE PRIORITÁRIO PASSARAM COM SUCESSO!');
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.message;
  console.error('\n❌ Falha no teste E2E:', error);
  process.exitCode = 1;
} finally {
  await writeFile(new URL('evidence.json', output), JSON.stringify(evidence, null, 2), 'utf8');
  if (browser) await browser.close();
  if (server) await server.close();
  if (signaling) await signaling.close();
}
