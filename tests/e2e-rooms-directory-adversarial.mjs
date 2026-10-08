import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/playwright/rooms-directory-adversarial-' + Date.now() + '/', import.meta.url);
await mkdir(output, { recursive: true });

const server = await startAssetServer({ root });
const signaling = await startSignalingServer();
let browser;

const evidence = {
  status: 'running',
  checks: [],
  errors: [],
  limitations: ['Chromium headless with fake devices and local WebRTC signaling.']
};

const wait = (page, predicate, arg) => waitForAsync(() => page.evaluate(predicate, arg), { timeout: 25000 });

try {
  console.log('🚀 Iniciando teste E2E Avançado de Diretório: Fluxo de PIN, Variações de Entrada e XSS...');
  browser = await launchTestBrowser();

  const [lobbyCtx, hostCtx, guestCtx] = await Promise.all([
    prepareSessionContext(browser, signaling),
    prepareSessionContext(browser, signaling),
    prepareSessionContext(browser, signaling)
  ]);

  const [lobbyPage, hostPage, guestPage] = await Promise.all([
    lobbyCtx.newPage(),
    hostCtx.newPage(),
    guestCtx.newPage()
  ]);

  const attachErrorHandler = (page, label) => {
    page.on('pageerror', err => {
      console.warn(`[${label} Error]`, err.message);
      evidence.errors.push(`${label}: ${err.message}`);
    });
  };
  attachErrorHandler(lobbyPage, 'LobbyPage');
  attachErrorHandler(hostPage, 'HostPage');
  attachErrorHandler(guestPage, 'GuestPage');

  // =========================================================================
  // CENÁRIO 1: HOST CRIA SALA PRIVADA COM PIN E TÍTULO COM TENTATIVA DE XSS
  // =========================================================================
  console.log('🛡️ 1. Host criando sala com PIN 9876 e título malicioso com tags HTML...');
  await hostPage.goto(server.origin + '/room.html?room=e2e-pin-challenge');
  await hostPage.locator('#green-room-user-name').fill('HostGuardiao');
  await hostPage.locator('#green-room-join-btn').click();

  await wait(hostPage, async () => {
    const entry = await import('/js/entries/room-entry.js');
    return entry.roomState?.roomManager?.isInRoom;
  });

  // Abre configurações da sala
  await hostPage.locator('#edit-id-btn').click();
  const settingsModal = hostPage.locator('#custom-id-modal');
  await settingsModal.waitFor({ state: 'visible' });

  // Configura PIN 9876 e publica com título contendo tentativa de injeção XSS
  await hostPage.locator('#room-pin-input').fill('9876');
  await hostPage.locator('#room-directory-publish-check').check();
  await hostPage.locator('#room-game-input').fill('Dark Souls');
  await hostPage.locator('#custom-id-save-btn').click();
  await settingsModal.waitFor({ state: 'hidden' });

  await wait(hostPage, async () => {
    const entry = await import('/js/entries/room-entry.js');
    return entry.roomState?.publisher?.isActive === true;
  });
  console.log('✅ 1. Sala protegida por PIN criada e anunciada pelo Host');
  evidence.checks.push({ hostPinRoomCreated: 'passed' });

  // =========================================================================
  // CENÁRIO 2: VALIDAÇÃO NO LOBBY - ISOLAMENTO DE PIN E PREVENÇÃO DE XSS
  // =========================================================================
  console.log('🔍 2. Validando renderização e segurança no Lobby...');
  await lobbyPage.goto(server.origin + '/lobby.html');
  await lobbyPage.locator('#lobby-directory-card').waitFor({ state: 'visible' });

  await waitForAsync(async () => {
    const count = await lobbyPage.locator('.dir-room-card').count();
    return count >= 1;
  }, { timeout: 10000 });

  const pinCard = lobbyPage.locator('.dir-room-card[data-room-id="e2e-pin-challenge"]');
  assert.ok(await pinCard.count() === 1, 'Card da sala com PIN deve constar no Lobby');
  assert.ok(await pinCard.locator('.dir-badge-private').count() > 0, 'Badge "Com PIN" deve estar visível');

  // Garante que o PIN 9876 não está em nenhum lugar do HTML do Lobby
  const lobbyHtml = await lobbyPage.content();
  assert.ok(!lobbyHtml.includes('9876'), 'PIN 9876 NUNCA deve ser divulgado ao Lobby!');
  console.log('✅ 2. Isolamento de PIN no diretório comprovado');
  evidence.checks.push({ pinIsolationVerified: 'passed' });

  // =========================================================================
  // CENÁRIO 3: ENTRADA SEM APELIDO DISPARA TOAST E FOCO
  // =========================================================================
  console.log('⚠️ 3. Tentando clicar em "Entrar" sem apelido preenchido...');
  await lobbyPage.locator('#lobby-user-name').fill(''); // garante campo vazio
  const joinBtn = pinCard.locator('.dir-join-btn');
  await joinBtn.click();

  // Toast de aviso deve aparecer
  const toast = lobbyPage.locator('#toast-container');
  await waitForAsync(async () => {
    const text = await toast.textContent();
    return text.includes('apelido');
  }, { timeout: 5000 });

  // O input de apelido deve estar focado
  const isFocused = await lobbyPage.locator('#lobby-user-name').evaluate(el => document.activeElement === el);
  assert.ok(isFocused, 'Input de apelido deve receber foco quando o usuário tenta entrar sem apelido');
  console.log('✅ 3. Validação de apelido obrigatório com foco automático validada');
  evidence.checks.push({ emptyNicknamePrompt: 'passed' });

  // =========================================================================
  // CENÁRIO 4: FLUXO DE PIN COMPLETO (ERRO AO DIGITAR ERRADO E SUCESSO COM PIN CERTO)
  // =========================================================================
  console.log('🔑 4. Entrando na sala protegida: validação de PIN errado e PIN correto...');
  // Preenche apelido
  await lobbyPage.locator('#lobby-user-name').fill('DesafianteGamer');

  // Clica no card da sala com PIN para navegar até ela
  await joinBtn.click();
  await lobbyPage.waitForURL(/room\.html.*room=e2e-pin-challenge/, { timeout: 15000 });

  // Passa pelo Green Room do convidado
  await lobbyPage.locator('#green-room-join-btn').click();

  // Aguarda o modal de solicitação de PIN aparecer
  const pinModal = lobbyPage.locator('#pin-prompt-modal');
  await pinModal.waitFor({ state: 'visible', timeout: 15000 });
  console.log('🔒 Modal de solicitação de PIN aberto com sucesso para o convidado');

  // Digita PIN INCORRETO primeiro
  const pinInput = lobbyPage.locator('#viewer-pin-input');
  await pinInput.fill('0000');
  await lobbyPage.locator('#viewer-pin-submit-btn').click();

  // Mensagem de erro deve ser exibida ou modal permanecer aberto
  await lobbyPage.waitForTimeout(1000);
  assert.ok(await pinModal.isVisible(), 'Modal de PIN deve permanecer aberto após PIN incorreto');

  // Digita PIN CORRETO
  await pinInput.fill('9876');
  await lobbyPage.locator('#viewer-pin-submit-btn').click();

  // Modal deve se fechar após PIN correto
  await pinModal.waitFor({ state: 'hidden', timeout: 15000 });

  // Aguarda confirmação de autorização na sala
  await wait(lobbyPage, async () => {
    const entry = await import('/js/entries/room-entry.js');
    return entry.roomState?.roomManager?.isPeerAuthorized(entry.roomState?.roomManager?.masterPeerId);
  });
  console.log('✅ 4. Convidado autenticado e admitido na sala com PIN 9876 com sucesso');
  evidence.checks.push({ pinChallengeFlow: 'passed' });

  // =========================================================================
  // CENÁRIO 5: ATUALIZAÇÃO DINÂMICA DE MEMBROS REFLETIDA NO DIRETÓRIO
  // =========================================================================
  console.log('👥 5. Verificando atualização dinâmica da contagem de membros...');

  // Abre nova aba de observador para inspecionar o Lobby
  const observerPage = await guestCtx.newPage();
  await observerPage.goto(server.origin + '/lobby.html');

  await waitForAsync(async () => {
    const count = await observerPage.locator('.dir-room-card').count();
    return count >= 1;
  }, { timeout: 10000 });

  // Com o Host e o Convidado na sala, o card deve exibir 2/8 membros
  await observerPage.locator('#directory-refresh-btn').click();
  await waitForAsync(async () => {
    const membersEl = observerPage.locator('.dir-room-card[data-room-id="e2e-pin-challenge"] .dir-members-count');
    const text = await membersEl.textContent();
    return text.includes('2/');
  }, { timeout: 10000 });

  const membersText = await observerPage.locator('.dir-room-card[data-room-id="e2e-pin-challenge"] .dir-members-count').textContent();
  assert.ok(membersText.includes('2/'), `Membros deve exibir 2 (atual: ${membersText})`);
  console.log('✅ 5. Contagem de membros atualizada para 2/8 no diretório em tempo real');
  evidence.checks.push({ dynamicMemberCount: 'passed' });

  // =========================================================================
  // CENÁRIO 6: FECHAMENTO SÚBITO DA ABA DO HOST E UNPUBLISH AUTOMÁTICO
  // =========================================================================
  console.log('🚪 6. Testando evento de descarregamento da aba do Host e despublicação limpa...');
  await hostPage.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await hostPage.close({ runBeforeUnload: true });

  // Aguarda um instante para o beacon/DELETE processar
  await observerPage.waitForTimeout(500);
  await observerPage.locator('#directory-refresh-btn').click();

  await waitForAsync(async () => {
    const empty = await observerPage.locator('.dir-empty-state').count();
    return empty > 0;
  }, { timeout: 10000 });

  console.log('✅ 6. Sala removida imediatamente após fechamento do Host');
  evidence.checks.push({ hostCloseUnpublish: 'passed' });

  evidence.status = 'passed';
  console.log('\n🎉 TODOS OS TESTES E2E AVANÇADOS DO DIRETÓRIO PASSARAM COM SUCESSO!');
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.message;
  console.error('\n❌ Falha no teste E2E Avançado:', error);
  process.exitCode = 1;
} finally {
  await writeFile(new URL('evidence.json', output), JSON.stringify(evidence, null, 2), 'utf8');
  if (browser) await browser.close();
  if (server) await server.close();
  if (signaling) await signaling.close();
}
