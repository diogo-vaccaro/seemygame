import { getButtonDisplayLabel } from '../coop/input.js';
import { controllerDeviceType, controllerChecksComplete } from './state.js';

const emptyHints = ['Seu controle', 'Convide o primeiro amigo', 'Convide mais um amigo', 'O grupo fica completo aqui'];

export function createControllerLabView({ onClose, onInvite, onReady, onDevice, onGrantAccess, onRevokeAccess, onAccept, onDismiss } = {}) {
  const screen = document.createElement('section');
  screen.className = 'controller-lab'; screen.hidden = true;
  screen.setAttribute('role', 'dialog'); screen.setAttribute('aria-modal', 'true'); screen.setAttribute('aria-labelledby', 'controller-lab-title');
  screen.innerHTML = `<div class="controller-lab-shell">
    <div class="controller-lab-heading">
      <div><p class="controller-lab-eyebrow">SeeMyGame · Antes da partida</p><h2 id="controller-lab-title">Sala de controles<span>Todo mundo pronto?</span></h2>
      <p class="controller-lab-intro">Aperte os quatro botões principais, mova os dois analógicos e pressione os dois gatilhos.</p></div>
      <button type="button" class="controller-lab-close" aria-label="Voltar à sala">Voltar à sala <span aria-hidden="true">↗</span></button>
    </div>
    <div class="controller-lab-toolbar"><span class="controller-lab-count" role="status" aria-live="polite">0 controles prontos</span>
      <button type="button" class="controller-lab-invite">Convidar amigos para testar</button></div>
    <div class="controller-lab-grid">${Array.from({ length: 4 }, (_, slot) => `
      <article class="controller-lab-player" data-lab-slot="${slot}" aria-label="Controle do jogador ${slot + 1}">
        <div class="controller-lab-player-top"><span class="controller-lab-number">0${slot + 1}</span><span class="controller-lab-status">Lugar disponível</span></div>
        <h3 class="controller-lab-name">${emptyHints[slot]}</h3><p class="controller-lab-role">${slot === 0 ? 'Organizador' : `Convidado ${slot}`}</p>
        <div class="controller-lab-model"><canvas width="420" height="330" aria-label="Controle 3D do jogador ${slot + 1}"></canvas><span class="controller-lab-fallback" hidden>Visualização 3D indisponível.<br>Veja os inputs abaixo.</span></div>
        <p class="controller-lab-device-name">Aguardando um controle</p>
        <div class="controller-lab-selector" hidden><label>Seu controle físico<select aria-label="Escolher seu controle físico"></select></label></div>
        <div class="controller-lab-inputs"><div class="controller-lab-sticks">
          <div><span>Analógico L</span><div class="controller-lab-stick" data-stick="0"><i></i></div><output data-axes="0">0.00 / 0.00</output></div>
          <div><span>Analógico R</span><div class="controller-lab-stick" data-stick="1"><i></i></div><output data-axes="1">0.00 / 0.00</output></div>
        </div><div class="controller-lab-triggers"><label>LT <meter min="0" max="1" value="0" data-trigger="6"></meter><output data-trigger-value="6">0%</output></label>
          <label>RT <meter min="0" max="1" value="0" data-trigger="7"></meter><output data-trigger-value="7">0%</output></label></div>
        <div class="controller-lab-buttons" aria-label="Botões pressionados">${Array.from({ length: 17 }, (_, i) => `<span data-lab-button="${i}" title="Botão ${i}">${i < 4 ? ['A', 'B', 'X', 'Y'][i] : i}</span>`).join('')}</div></div>
        <div class="controller-lab-checks"><span data-check="face">Botões</span><span data-check="sticks">Analógicos</span><span data-check="triggers">Gatilhos</span></div>
        <p class="controller-lab-player-hint">${slot ? 'Entre no convite para aparecer aqui.' : 'Conecte o controle e pressione um botão.'}</p>
        <div class="controller-lab-access" hidden><p class="controller-lab-access-status">Sem acesso ao Co-op</p><button type="button" class="controller-lab-access-toggle"></button></div>
        <div class="controller-lab-card-action"><button type="button" class="controller-lab-ready" hidden disabled>Marcar como pronto</button></div>
      </article>`).join('')}</div>
    <div class="controller-lab-footer"><span class="controller-lab-safe">Teste visual · Inputs do Co-op pausados nesta tela</span><p>“Pronto” confirma o teste. Libere o acesso ao Co-op para o jogador controlar a partida.</p></div>
  </div>`;
  const invitation = document.createElement('aside');
  invitation.className = 'controller-lab-invitation'; invitation.hidden = true;
  invitation.setAttribute('role', 'status');
  invitation.innerHTML = '<div><strong>Vamos testar os controles?</strong><p></p></div><button type="button" data-accept>Entrar no teste</button><button type="button" data-dismiss aria-label="Dispensar convite">✕</button>';
  document.body.append(screen, invitation);
  const abort = new AbortController(); const options = { signal: abort.signal };
  screen.querySelector('.controller-lab-close').addEventListener('click', onClose, options);
  screen.querySelector('.controller-lab-invite').addEventListener('click', onInvite, options);
  invitation.querySelector('[data-accept]').addEventListener('click', onAccept, options);
  invitation.querySelector('[data-dismiss]').addEventListener('click', onDismiss, options);
  const cards = [...screen.querySelectorAll('[data-lab-slot]')];
  for (const card of cards) {
    card.querySelector('.controller-lab-ready').addEventListener('click', () => onReady(card.dataset.ready !== 'true'), options);
    card.querySelector('.controller-lab-access-toggle').addEventListener('click', () => {
      const peerId = card.dataset.peerId;
      if (!peerId) return;
      if (card.dataset.coopAuthorized === 'true') onRevokeAccess?.(peerId);
      else onGrantAccess?.(peerId);
    }, options);
    card.querySelector('select').addEventListener('change', event => onDevice(Number(event.target.value)), options);
  }
  let viewers = []; let generation = 0; let previousFocus = null; let previousInert = [];
  let lastPlayers = []; let localPeerId = null;
  let lastAccessState = { canManage: false, byPeer: new Map() };
  document.addEventListener('keydown', event => {
    if (screen.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const focusable = [...screen.querySelectorAll('button:not(:disabled),select')].filter(el => !el.closest('[hidden]'));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !screen.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }, { signal: abort.signal, capture: true });

  function render(players, myPeerId, accessState = { canManage: false, byPeer: new Map() }) {
    lastPlayers = players; localPeerId = myPeerId; lastAccessState = accessState;
    const ready = players.filter(player => player.ready).length;
    const inviteButton = screen.querySelector('.controller-lab-invite');
    inviteButton.disabled = players.length >= 4;
    inviteButton.textContent = players.length >= 4 ? 'Grupo completo' : 'Convidar amigos para testar';
    screen.querySelector('.controller-lab-count').textContent = `${ready} de ${players.length} ${players.length === 1 ? 'controle pronto' : 'controles prontos'}`;
    for (const [slot, card] of cards.entries()) {
      const player = players.find(item => item.slot === slot); const state = player?.state;
      const local = player?.peerId === myPeerId;
      card.dataset.peerId = player?.peerId || '';
      card.dataset.connected = String(Boolean(state?.connected)); card.dataset.ready = String(Boolean(player?.ready));
      card.querySelector('.controller-lab-name').textContent = player ? player.name + (local ? ' · você' : '') : emptyHints[slot];
      card.querySelector('.controller-lab-role').textContent = slot === 0 ? 'Organizador' : `Convidado ${slot}`;
      card.querySelector('.controller-lab-status').textContent = player?.ready ? 'Pronto para jogar' : state?.connected ? 'Testando' : player ? 'Sem controle' : 'Lugar disponível';
      card.querySelector('.controller-lab-device-name').textContent = state?.device || (player ? 'Conecte o controle e pressione um botão' : 'Aguardando um amigo');
      card.querySelector('.controller-lab-selector').hidden = !local;
      const readyButton = card.querySelector('.controller-lab-ready'); readyButton.hidden = !local;
      readyButton.disabled = !state?.connected || !controllerChecksComplete(player?.checks);
      readyButton.textContent = player?.ready ? '✓ Pronto · revisar' : 'Marcar como pronto';
      readyButton.setAttribute('aria-pressed', String(Boolean(player?.ready)));
      const accessCard = card.querySelector('.controller-lab-access');
      const access = player ? accessState.byPeer?.get(player.peerId) : null;
      accessCard.hidden = !accessState.canManage || !player || local;
      card.dataset.coopAuthorized = String(access?.slot !== null && access?.slot !== undefined);
      if (!accessCard.hidden) {
        const accessStatus = accessCard.querySelector('.controller-lab-access-status');
        const accessButton = accessCard.querySelector('.controller-lab-access-toggle');
        if (access?.slot !== null && access?.slot !== undefined) {
          accessStatus.textContent = `Acesso liberado · Player ${access.slot + 1}`;
          accessButton.textContent = `Revogar acesso · P${access.slot + 1}`;
          accessButton.disabled = false; accessButton.dataset.action = 'revoke';
          accessButton.setAttribute('aria-label', `Revogar acesso de ${player.name} ao Player ${access.slot + 1}`);
        } else if (access?.availableSlot !== null && access?.availableSlot !== undefined) {
          accessStatus.textContent = 'Sem acesso ao Co-op';
          accessButton.textContent = `Liberar como P${access.availableSlot + 1}`;
          accessButton.disabled = false; accessButton.dataset.action = 'grant';
          accessButton.setAttribute('aria-label', `Liberar acesso de ${player.name} como Player ${access.availableSlot + 1}`);
        } else {
          accessStatus.textContent = 'Sem slot de Co-op disponível';
          accessButton.textContent = 'Sem slot disponível';
          accessButton.disabled = true; accessButton.dataset.action = 'grant';
          accessButton.setAttribute('aria-label', `Sem slot de Co-op disponível para ${player.name}`);
        }
      }
      for (const key of ['face', 'sticks', 'triggers']) {
        const passed = player?.checks?.[key] === (key === 'face' ? 15 : 3);
        const indicator = card.querySelector(`[data-check="${key}"]`);
        indicator.dataset.passed = String(passed);
        indicator.textContent = `${passed ? '✓ ' : '○ '}${{ face: 'Botões', sticks: 'Analógicos', triggers: 'Gatilhos' }[key]}`;
      }
      card.querySelector('.controller-lab-player-hint').textContent = !player ? 'O convite aparece na tela do seu amigo.'
        : !state?.connected ? 'Conecte o controle e pressione um botão.'
        : state.mapping !== 'standard' ? 'Os botões podem ter outra ordem neste controle.'
        : controllerChecksComplete(player.checks) ? 'Inputs conferidos. Você já pode confirmar.' : 'Teste os três grupos de inputs acima.';
      for (let stick = 0; stick < 2; stick++) {
        const x = state?.axes?.[stick * 2] || 0, y = state?.axes?.[stick * 2 + 1] || 0;
        card.querySelector(`[data-stick="${stick}"] i`).style.transform = `translate(${x * 17}px, ${y * 17}px)`;
        card.querySelector(`[data-axes="${stick}"]`).textContent = `${x.toFixed(2)} / ${y.toFixed(2)}`;
      }
      for (const trigger of [6, 7]) {
        const value = state?.buttons?.[trigger] || 0;
        card.querySelector(`[data-trigger="${trigger}"]`).value = value;
        card.querySelector(`[data-trigger-value="${trigger}"]`).textContent = `${Math.round(value * 100)}%`;
      }
      const type = controllerDeviceType(state);
      for (const button of card.querySelectorAll('[data-lab-button]')) {
        const index = Number(button.dataset.labButton);
        const name = state?.mapping === 'standard' ? getButtonDisplayLabel(index, 'auto', type) : `B${index}`;
        button.textContent = index < 4 ? name.split(' ')[0] : ['LB', 'RB', 'LT', 'RT', '↶', '☰', 'L3', 'R3', '↑', '↓', '←', '→', '⌂'][index - 4];
        button.title = name; button.dataset.pressed = String((state?.buttons?.[index] || 0) > .1);
        button.setAttribute('aria-label', `${name}${(state?.buttons?.[index] || 0) > .1 ? ' pressionado' : ''}`);
      }
      if (viewers[slot]) {
        if (type && type !== 'generic' && viewers[slot].gamepadType !== type) {
          viewers[slot].setGamepadType?.(type);
        }
        viewers[slot].updateInputs(state || { connected: false, axes: [0, 0, 0, 0], buttons: [] });
      }
    }
  }
  function updateDevices(pads, selectedIndex) {
    const card = cards.find(item => !item.querySelector('.controller-lab-selector').hidden);
    if (!card) return;
    const select = card.querySelector('select');
    const signature = `${selectedIndex}:` + pads.map(pad => `${pad.index}:${pad.id}`).join('|');
    if (select.dataset.devices === signature) return;
    select.dataset.devices = signature; select.replaceChildren();
    if (!pads.length) select.add(new Option('Nenhum controle detectado', '-1'));
    for (const pad of pads) select.add(new Option(`#${pad.index + 1} · ${pad.id || 'Controle'}`, String(pad.index)));
    if (selectedIndex !== null && selectedIndex >= 0 && !pads.some(pad => pad.index === selectedIndex)) {
      select.add(new Option(`#${selectedIndex + 1} · Desconectado (aguardando reconexão)`, String(selectedIndex)));
    }
    select.value = String(selectedIndex);
  }
  async function open(canInvite, canManageAccess = false) {
    if (!screen.hidden) return;
    const current = ++generation;
    previousFocus = document.activeElement; screen.hidden = false; invitation.hidden = true;
    previousInert = [...document.body.children].filter(el => el !== screen && el !== invitation).map(el => [el, el.inert]);
    previousInert.forEach(([el]) => { el.inert = true; });
    screen.querySelector('.controller-lab-invite').hidden = !canInvite;
    screen.dataset.canManageAccess = String(canManageAccess);
    screen.querySelector('.controller-lab-close').focus();
    try {
      const { Gamepad3DViewer } = await import('../gamepad-3d-viewer.js');
      if (current !== generation || screen.hidden) return;
      viewers = cards.map(card => {
        const container = card.querySelector('.controller-lab-model');
        let viewer;
        try {
          viewer = new Gamepad3DViewer({ container, canvas: container.querySelector('canvas'), enableMouseTracking: false, fitToContainer: true });
          if (!viewer.init()) throw new Error('3D renderer unavailable');
          viewer.start(); return viewer;
        } catch (_) {
          viewer?.destroy(); card.querySelector('.controller-lab-fallback').hidden = false; return null;
        }
      });
      render(lastPlayers, localPeerId, lastAccessState);
    } catch (_) { cards.forEach(card => { card.querySelector('.controller-lab-fallback').hidden = false; }); }
  }
  function close() {
    ++generation; screen.hidden = true;
    viewers.forEach(viewer => viewer?.destroy()); viewers = [];
    cards.forEach(card => { card.querySelector('.controller-lab-fallback').hidden = true; });
    previousInert.forEach(([el, inert]) => { el.inert = inert; }); previousInert = [];
    previousFocus?.focus?.(); previousFocus = null;
  }
  return {
    screen, open, close, render, updateDevices,
    invitation: pending => {
      invitation.hidden = !pending;
      invitation.querySelector('p').textContent = pending ? `${pending.name} convidou você para preparar o controle antes da partida.` : '';
    },
    pause: hidden => viewers.forEach(viewer => hidden ? viewer?.stop() : viewer?.start()),
    destroy: () => { close(); abort.abort(); screen.remove(); invitation.remove(); }
  };
}
