import { describe, it, expect, vi } from 'vitest';
import { createParticipantVolumePopover } from '../js/ui/participant-controls.js';

describe('createParticipantVolumePopover', () => {
  it('cria estrutura de controle de volume e responde a interações', () => {
    const mockVoiceManager = {
      getUserVolume: vi.fn().mockReturnValue(100),
      setUserVolume: vi.fn(),
      isUserLocallyMuted: vi.fn().mockReturnValue(false),
      setUserLocallyMuted: vi.fn()
    };

    const wrapper = createParticipantVolumePopover({
      peerId: 'peer-abc',
      name: 'Player 2',
      voiceManager: mockVoiceManager
    });

    expect(wrapper).not.toBeNull();
    const toggleBtn = wrapper.querySelector('.btn-participant-volume-toggle');
    const popover = wrapper.querySelector('.participant-volume-popover');
    const slider = wrapper.querySelector('.participant-volume-slider');
    const muteBtn = wrapper.querySelector('.btn-participant-mute-local');

    expect(popover.style.display).toBe('none');
    toggleBtn.click();
    expect(popover.style.display).toBe('flex');

    // Testar slider
    slider.value = '145';
    slider.dispatchEvent(new Event('input'));
    expect(mockVoiceManager.setUserVolume).toHaveBeenCalledWith('peer-abc', 145);

    // Testar mute
    muteBtn.click();
    expect(mockVoiceManager.setUserLocallyMuted).toHaveBeenCalledWith('peer-abc', true);

    wrapper.cleanup();
  });
});
