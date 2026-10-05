import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiscordUIController } from '../js/discord-ui.js';
import { voiceManager } from '../js/voice.js';

describe('DiscordUIController: Controles de Volume Individual e de Si Mesmo', () => {
  let controller;

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch (_) {}

    document.body.innerHTML = `
      <div id="discord-drawer"></div>
      <div id="voice-participants-list"></div>
      <div id="voice-status-bar"></div>
      <button id="voice-mute-btn"></button>
      <button id="voice-deaf-btn"></button>
      <button id="voice-mode-btn"></button>
      <button id="voice-connect-btn"></button>

      <!-- Controles de Volume Pessoal -->
      <div class="voice-self-settings" id="voice-self-settings">
        <button type="button" id="voice-self-reset-btn">Restaurar 100%</button>
        <span id="voice-self-mic-val">100%</span>
        <input type="range" id="voice-self-mic-slider" min="0" max="200" step="1" value="100">
        <span id="voice-self-output-val">100%</span>
        <input type="range" id="voice-self-output-slider" min="0" max="200" step="1" value="100">
      </div>
    `;

    voiceManager.setInputVolume(100);
    voiceManager.setOutputVolume(100);

    controller = new DiscordUIController();
    controller.init();
  });

  afterEach(() => {
    controller.destroy();
    voiceManager.participants.clear();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('releases obsolete controls across repeated renders and preserves personal settings', () => {
    const peerId = 'render-regression-peer';
    voiceManager.participants.set(peerId, { peerId, name: 'Friend', isLocal: false });
    controller.renderVoiceParticipants(voiceManager.getParticipantsList());
    const cleanupCount = controller._cleanupFns.length;
    const obsoleteSlider = document.querySelector('.voice-user-volume-slider');
    voiceManager.setUserVolume(peerId, 75); voiceManager.setUserMuted(peerId, true);
    for (let i = 0; i < 200; i++) voiceManager.updateParticipantState(peerId, { isSpeaking: i % 2 === 0 });
    expect(controller._cleanupFns.length).toBe(cleanupCount);
    expect(document.querySelector('.voice-user-volume-slider').value).toBe('75');
    expect(document.querySelector('.voice-user-mute-btn').classList.contains('muted')).toBe(true);
    obsoleteSlider.value = '180'; obsoleteSlider.dispatchEvent(new Event('input'));
    expect(voiceManager.getUserVolume(peerId)).toBe(75);
    const currentSlider = document.querySelector('.voice-user-volume-slider');
    controller.destroy(); currentSlider.value = '160'; currentSlider.dispatchEvent(new Event('input'));
    expect(voiceManager.getUserVolume(peerId)).toBe(75);
    voiceManager.removeRemoteParticipant(peerId);
  });

  it('deve inicializar e vincular os sliders de áudio pessoal (mic e saída)', () => {
    const micSlider = document.getElementById('voice-self-mic-slider');
    const micVal = document.getElementById('voice-self-mic-val');
    const outSlider = document.getElementById('voice-self-output-slider');
    const outVal = document.getElementById('voice-self-output-val');

    expect(micSlider.value).toBe('100');
    expect(micVal.textContent).toBe('100%');
    expect(outSlider.value).toBe('100');
    expect(outVal.textContent).toBe('100%');

    // Altera mic para 150%
    micSlider.value = '150';
    micSlider.dispatchEvent(new Event('input'));
    expect(voiceManager.inputVolume).toBe(150);
    expect(micVal.textContent).toBe('150%');

    // Altera saída para 60%
    outSlider.value = '60';
    outSlider.dispatchEvent(new Event('input'));
    expect(voiceManager.outputVolume).toBe(60);
    expect(outVal.textContent).toBe('60%');
  });

  it('botão de restaurar deve resetar mic e saída para 100%', () => {
    const micSlider = document.getElementById('voice-self-mic-slider');
    const outSlider = document.getElementById('voice-self-output-slider');
    const resetBtn = document.getElementById('voice-self-reset-btn');
    const micVal = document.getElementById('voice-self-mic-val');
    const outVal = document.getElementById('voice-self-output-val');

    voiceManager.setInputVolume(180);
    voiceManager.setOutputVolume(40);
    micSlider.value = '180';
    outSlider.value = '40';

    resetBtn.click();

    expect(voiceManager.inputVolume).toBe(100);
    expect(voiceManager.outputVolume).toBe(100);
    expect(micSlider.value).toBe('100');
    expect(micVal.textContent).toBe('100%');
    expect(outSlider.value).toBe('100');
    expect(outVal.textContent).toBe('100%');
  });

  it('renderVoiceParticipants deve renderizar controles de volume individual para amigos remotos', () => {
    const participants = [
      {
        peerId: 'local-peer',
        name: 'Eu Mesmo',
        role: 'host',
        isLocal: true,
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
      },
      {
        peerId: 'friend-peer-1',
        name: 'Amigo Pro Player',
        role: 'member',
        isLocal: false,
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        userVolume: 120,
        isLocallyMuted: false,
      }
    ];

    for (const participant of participants) voiceManager.participants.set(participant.peerId, participant);
    voiceManager.userVolumes.set('friend-peer-1', 120);
    controller.renderVoiceParticipants(participants);

    const list = document.getElementById('voice-participants-list');
    expect(list.children.length).toBe(2);

    // Card local deve ter badge (Você) e indicador de ganho
    const localCard = list.children[0];
    expect(localCard.textContent).toContain('(Você)');
    expect(localCard.textContent).toContain('Ganho Mic');

    // Card remoto deve ter slider de volume individual e botão de mute local
    const remoteCard = list.children[1];
    expect(remoteCard.textContent).toContain('Amigo Pro Player');

    const slider = remoteCard.querySelector('.voice-user-volume-slider');
    let muteBtn = remoteCard.querySelector('.voice-user-mute-btn');
    const valBadge = remoteCard.querySelector('.voice-user-volume-val');

    expect(slider).not.toBeNull();
    expect(slider.value).toBe('120');
    expect(valBadge.textContent).toBe('120%');
    expect(muteBtn.textContent).toBe('🔊');

    // Interação com o slider individual
    slider.value = '80';
    slider.dispatchEvent(new Event('input'));
    expect(voiceManager.getUserVolume('friend-peer-1')).toBe(80);
    expect(valBadge.textContent).toBe('80%');

    // Interação com o mute local
    muteBtn = list.querySelector('.voice-user-mute-btn');
    muteBtn.click();
    expect(voiceManager.isUserLocallyMuted('friend-peer-1')).toBe(true);
    expect(muteBtn.textContent).toBe('🔇');

    // Desmuta
    muteBtn = list.querySelector('.voice-user-mute-btn');
    muteBtn.click();
    expect(voiceManager.isUserLocallyMuted('friend-peer-1')).toBe(false);
    expect(muteBtn.textContent).toBe('🔊');
  });
});
