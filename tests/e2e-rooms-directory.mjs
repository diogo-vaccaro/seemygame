import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/rooms-directory-e2e-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });

const server = await startAssetServer({ root });
const signaling = await startSignalingServer();
let browser;

const evidence = {
  status: 'running',
  checks: [],
  errors: [],
  limitations: ['Chromium headless with synthetic audio/video and local WebRTC loopback signaling.']
};

const wait = (page, predicate, arg) => waitForAsync(() => page.evaluate(predicate, arg), { timeout: 25000 });

try {
  console.log('🚀 Iniciando teste E2E do Diretório de Salas e Descoberta ao Vivo...');
  browser = await launchTestBrowser();

  const [lobbyCtx, host1Ctx, host2Ctx] = await Promise.all([
    prepareSessionContext(browser, signaling),
    prepareSessionContext(browser, signaling),
    prepareSessionContext(browser, signaling)
  ]);

  const [lobbyPage, host1Page, host2Page] = await Promise.all([
    lobbyCtx.newPage(),
    host1Ctx.newPage(),
    host2Ctx.newPage()
  ]);

  const attachErrorHandler = (page, label) => {
    page.on('pageerror', err => {
      console.warn(`[${label} Error]`, err.message);
      evidence.errors.push(`${label}: ${err.message}`);
    });
  };
  attachErrorHandler(lobbyPage, 'LobbyPage');
  attachErrorHandler(host1Page, 'Host1Page');
  attachErrorHandler(host2Page, 'Host2Page');

  // =========================================================================
  // FASE 1: LOBBY INICIAL E ESTADO VAZIO DO DIRETÓRIO
  // =========================================================================
  console.log('📋 1. Verificando carregamento e estado inicial do Lobby...');
  await lobbyPage.goto(server.origin + '/lobby.html');

  // Confirma elementos essenciais do painel da comunidade
  await lobbyPage.locator('#lobby-directory-card').waitFor({ state: 'visible' });
  const pulseDot = lobbyPage.locator('.live-pulse-dot');
  assert.ok(await pulseDot.count() > 0, 'Ponto verde pulsante de salas ao vivo deve existir');

  const countBadge = lobbyPage.locator('#directory-room-count');
  await waitForAsync(async () => {
    const text = await countBadge.textContent();
    return text.includes('0');
  }, { timeout: 10000 });

  // Confirma empty state inicial
  const emptyState = lobbyPage.locator('.dir-empty-state');
  assert.ok(await emptyState.count() > 0, 'Estado vazio deve ser exibido quando não há salas');
  console.log('✅ 1. Painel de Diretório carregado com estado vazio');
  evidence.checks.push({ initialLobbyEmpty: 'passed' });

  // =========================================================================
  // FASE 2: HOST 1 CRIA E PUBLICA SALA PÚBLICA COM VAGA PLAYER 2
  // =========================================================================
  console.log('🎮 2. Host 1 criando sala pública com vaga Player 2...');
  await host1Page.goto(server.origin + '/room.html?room=e2e-pub-squad');
  await host1Page.locator('#green-room-user-name').fill('HostAlpha');
  await host1Page.locator('#green-room-join-btn').click();

  await wait(host1Page, async () => {
    const entry = await import('/js/entries/room-entry.js');
    return entry.roomState?.roomManager?.isInRoom;
  });

  // Abre modal de ajustes
  await host1Page.locator('#edit-id-btn').click();
  const settingsModal = host1Page.locator('#custom-id-modal');
  await settingsModal.waitFor({ state: 'visible' });

  // Configura publicação no diretório
  const publishCheck1 = host1Page.locator('#room-directory-publish-check');
  await publishCheck1.check();

  const gameInput1 = host1Page.locator('#room-game-input');
  await gameInput1.fill('Valorant');

  const p2Check1 = host1Page.locator('#room-player2-slot-check');
  await p2Check1.check();

  // Salva ajustes
  await host1Page.locator('#custom-id-save-btn').click();
  await settingsModal.waitFor({ state: 'hidden' });

  // Aguarda publisher ser ativado
  await wait(host1Page, async () => {
    const entry = await import('/js/entries/room-entry.js');
    return entry.roomState?.publisher?.isActive === true;
  });
  console.log('✅ 2. Host 1 publicou e2e-pub-squad (Valorant, Aberta, Player 2)');
  evidence.checks.push({ host1Published: 'passed' });

  // =========================================================================
  // FASE 3: HOST 2 CRIA E PUBLICA SALA PRIVADA COM PIN
  // =========================================================================
  console.log('🔒 3. Host 2 criando sala privada protegida por PIN...');
  await host2Page.goto(server.origin + '/room.html?room=e2e-priv-raid');
  await host2Page.locator('#green-room-user-name').fill('HostBeta');
  await host2Page.locator('#green-room-join-btn').click();

  await wait(host2Page, async () => {
    const entry = await import('/js/entries/room-entry.js');
    return entry.roomState?.roomManager?.isInRoom;
  });

  // Abre modal de ajustes
  await host2Page.locator('#edit-id-btn').click();
  await host2Page.locator('#custom-id-modal').waitFor({ state: 'visible' });

  // Configura PIN e publicação
  await host2Page.locator('#room-pin-input').fill('4321');
  await host2Page.locator('#room-directory-publish-check').check();
  await host2Page.locator('#room-game-input').fill('Elden Ring');
  // Deixa Player 2 desmarcado

  await host2Page.locator('#custom-id-save-btn').click();
  await host2Page.locator('#custom-id-modal').waitFor({ state: 'hidden' });

  await wait(host2Page, async () => {
    const entry = await import('/js/entries/room-entry.js');
    return entry.roomState?.publisher?.isActive === true;
  });
  console.log('✅ 3. Host 2 publicou e2e-priv-raid (Elden Ring, PIN 4321)');
  evidence.checks.push({ host2Published: 'passed' });

  // =========================================================================
  // FASE 4: LOBBY EXIBE AMBAS AS SALAS COM METADADOS E ISOLAMENTO DE PIN
  // =========================================================================
  console.log('🔄 4. Verificando exibição e metadados no Lobby...');
  await lobbyPage.locator('#directory-refresh-btn').click();

  await waitForAsync(async () => {
    const count = await lobbyPage.locator('.dir-room-card').count();
    return count === 2;
  }, { timeout: 10000 });

  const badgeText = await countBadge.textContent();
  assert.ok(badgeText.includes('2 ativas'), `Contador deve exibir 2 ativas (atual: ${badgeText})`);

  // Localiza card da sala pública
  const pubCard = lobbyPage.locator('.dir-room-card[data-room-id="e2e-pub-squad"]');
  assert.ok(await pubCard.count() === 1, 'Card da sala pública deve estar visível');
  assert.ok(await pubCard.locator('.dir-badge-public').count() > 0, 'Badge "Aberta" deve estar presente');
  assert.ok(await pubCard.locator('.dir-badge-p2').count() > 0, 'Badge "Player 2" deve estar presente');
  const pubCardText = await pubCard.textContent();
  assert.ok(pubCardText.includes('Valorant'), 'Jogo Valorant deve constar no card');

  // Localiza card da sala privada
  const privCard = lobbyPage.locator('.dir-room-card[data-room-id="e2e-priv-raid"]');
  assert.ok(await privCard.count() === 1, 'Card da sala privada deve estar visível');
  assert.ok(await privCard.locator('.dir-badge-private').count() > 0, 'Badge "Com PIN" deve estar presente');
  assert.equal(await privCard.locator('.dir-badge-p2').count(), 0, 'Badge Player 2 NÃO deve constar na sala privada');
  const privCardText = await privCard.textContent();
  assert.ok(privCardText.includes('Elden Ring'), 'Jogo Elden Ring deve constar no card');

  // SEGURANÇA: NUNCA expor o PIN no DOM do Lobby
  const wholeLobbyHtml = await lobbyPage.content();
  assert.ok(!wholeLobbyHtml.includes('4321'), 'PIN da sala privada NUNCA deve vazar no DOM ou diretório!');

  console.log('✅ 4. Ambas as salas renderizadas corretamente com isolamento de PIN verificado');
  evidence.checks.push({ lobbyCardsRendered: 'passed', pinNeverExposed: 'passed' });

  // =========================================================================
  // FASE 5: BUSCA E FILTROS EM TEMPO REAL
  // =========================================================================
  console.log('🔍 5. Testando busca textual e filtros em abas...');

  // Busca textual por 'valorant'
  const searchInput = lobbyPage.locator('#directory-search-input');
  await searchInput.fill('valorant');
  await lobbyPage.waitForTimeout(250);

  let visibleCards = await lobbyPage.locator('.dir-room-card').all();
  assert.equal(visibleCards.length, 1, 'Busca por valorant deve exibir apenas 1 sala');
  assert.equal(await visibleCards[0].getAttribute('data-room-id'), 'e2e-pub-squad');

  // Limpa busca
  await searchInput.fill('');
  await lobbyPage.waitForTimeout(250);
  assert.equal(await lobbyPage.locator('.dir-room-card').count(), 2);

  // Filtro: Apenas Abertas
  await lobbyPage.locator('.dir-filter-pill[data-filter="public"]').click();
  await lobbyPage.waitForTimeout(100);
  visibleCards = await lobbyPage.locator('.dir-room-card').all();
  assert.equal(visibleCards.length, 1);
  assert.equal(await visibleCards[0].getAttribute('data-room-id'), 'e2e-pub-squad');

  // Filtro: Apenas Com PIN
  await lobbyPage.locator('.dir-filter-pill[data-filter="private"]').click();
  await lobbyPage.waitForTimeout(100);
  visibleCards = await lobbyPage.locator('.dir-room-card').all();
  assert.equal(visibleCards.length, 1);
  assert.equal(await visibleCards[0].getAttribute('data-room-id'), 'e2e-priv-raid');

  // Filtro: Vaga Player 2
  await lobbyPage.locator('.dir-filter-pill[data-filter="player2"]').click();
  await lobbyPage.waitForTimeout(100);
  visibleCards = await lobbyPage.locator('.dir-room-card').all();
  assert.equal(visibleCards.length, 1);
  assert.equal(await visibleCards[0].getAttribute('data-room-id'), 'e2e-pub-squad');

  // Restaura todas
  await lobbyPage.locator('.dir-filter-pill[data-filter="all"]').click();
  await lobbyPage.waitForTimeout(100);
  assert.equal(await lobbyPage.locator('.dir-room-card').count(), 2);

  console.log('✅ 5. Busca e filtros por tipo e vaga Player 2 validados com sucesso');
  evidence.checks.push({ searchAndFilters: 'passed' });

  // =========================================================================
  // FASE 6: ENTRAR NA SALA CLICANDO NO CARD DO DIRETÓRIO
  // =========================================================================
  console.log('🚀 6. Testando entrada na sala direto pelo card do diretório...');

  // Preenche apelido no lobby
  await lobbyPage.locator('#lobby-user-name').fill('GamerExplorador');

  // Clica no botão Entrar da sala pública
  const joinBtn = pubCard.locator('.dir-join-btn');
  await joinBtn.click();

  // O lobby deve navegar para room.html?room=e2e-pub-squad
  await lobbyPage.waitForURL(/room\.html.*room=e2e-pub-squad/, { timeout: 15000 });
  console.log('✅ 6. Navegação direta para a sala a partir do diretório bem-sucedida');
  evidence.checks.push({ directJoinFromDirectory: 'passed' });

  // =========================================================================
  // FASE 7: CICLO DE VIDA E DESPUBLICAÇÃO AUTOMÁTICA
  // =========================================================================
  console.log('🧹 7. Testando remoção ao sair / despublicar da sala...');

  // Abre nova aba de lobby para testar unpublish
  const observerLobby = await lobbyCtx.newPage();
  await observerLobby.goto(server.origin + '/lobby.html');
  await waitForAsync(async () => await observerLobby.locator('.dir-room-card').count() === 2, { timeout: 10000 });

  // Host 1 desliga a sala
  await host1Page.evaluate(async () => {
    const entry = await import('/js/entries/room-entry.js');
    if (entry.roomState?.publisher) {
      await entry.roomState.publisher.stop();
    }
  });

  // Atualiza observer lobby
  await observerLobby.locator('#directory-refresh-btn').click();
  await waitForAsync(async () => await observerLobby.locator('.dir-room-card').count() === 1, { timeout: 10000 });
  assert.equal(await observerLobby.locator('.dir-room-card').first().getAttribute('data-room-id'), 'e2e-priv-raid');

  // Host 2 desliga a sala
  await host2Page.evaluate(async () => {
    const entry = await import('/js/entries/room-entry.js');
    if (entry.roomState?.publisher) {
      await entry.roomState.publisher.stop();
    }
  });

  await observerLobby.locator('#directory-refresh-btn').click();
  await waitForAsync(async () => await observerLobby.locator('.dir-empty-state').count() > 0, { timeout: 10000 });
  console.log('✅ 7. Despublicação e limpeza de salas confirmadas com sucesso');
  evidence.checks.push({ unpublishCleanup: 'passed' });

  evidence.status = 'passed';
  console.log('\n🎉 TODOS OS TESTES E2E DO DIRETÓRIO DE SALAS PASSARAM COM 100% DE SUCESSO!');
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
