import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDisplayMediaOptions, requestBrowserDisplayMedia } from '../js/browser-capture.js';

afterEach(() => vi.restoreAllMocks());

describe('Seletor web: áudio e falhas de captura', () => {
  it.each(['system', 'process'])('solicita áudio em %s sem impor dispositivo ou canais', (audioMode) => {
    const options = buildDisplayMediaOptions({ audioMode });
    expect(options.audio).toEqual({ autoGainControl: false, echoCancellation: false, noiseSuppression: false });
    expect(options.systemAudio).toBe('include');
    expect(options.windowAudio).toBe(audioMode === 'process' ? 'window' : 'system');
  });

  it.each(['none', 'mic'])('não captura áudio do sistema em %s', (audioMode) => {
    expect(buildDisplayMediaOptions({ audioMode })).toMatchObject({
      audio: false, systemAudio: 'exclude', windowAudio: 'exclude'
    });
  });

  it('preserva as opções de vídeo e superfície do E2E', () => {
    expect(buildDisplayMediaOptions({ video: { frameRate: { max: 60 } }, displaySurface: 'monitor', monitorTypeSurfaces: 'include' }))
      .toMatchObject({ video: { frameRate: { max: 60 }, displaySurface: 'monitor' }, monitorTypeSurfaces: 'include' });
  });

  it.each([
    ['TypeError', "Invalid value for windowAudio"],
    ['NotReadableError', 'Audio device unavailable'],
    ['NotAllowedError', 'Permission denied'],
    ['OverconstrainedError', 'Audio constraint failed']
  ])('preserva %s sem abrir outro seletor sem áudio', async (name, message) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = Object.assign(new Error(message), { name });
    const mediaDevices = { getDisplayMedia: vi.fn().mockRejectedValue(error) };
    await expect(requestBrowserDisplayMedia({ audioMode: 'system' }, mediaDevices)).rejects.toBe(error);
    expect(mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(mediaDevices.getDisplayMedia.mock.calls[0][0].audio).not.toBe(false);
  });

  it('aceita resultado sem trilha de áudio sem repetir seletor ou inventar falha de driver', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const stream = { getAudioTracks: () => [] };
    const mediaDevices = { getDisplayMedia: vi.fn().mockResolvedValue(stream) };
    await expect(requestBrowserDisplayMedia({ audioMode: 'system' }, mediaDevices)).resolves.toBe(stream);
    expect(mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
  });
});
