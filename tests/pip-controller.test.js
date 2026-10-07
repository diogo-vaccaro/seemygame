import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PipController } from '../js/room/pip-controller.js';

describe('PipController', () => {
  let controller;

  beforeEach(() => {
    controller = new PipController();
    document.pictureInPictureEnabled = true;
  });

  it('detects picture-in-picture support', () => {
    expect(controller.isSupported()).toBe(true);
  });

  it('enters standard video picture-in-picture when available', async () => {
    const video = document.createElement('video');
    video.requestPictureInPicture = vi.fn().mockResolvedValue({});

    let entered = false;
    controller.onPipChange((event, data) => {
      if (event === 'enter') entered = true;
    });

    const res = await controller.enterPip(video);
    expect(res).toBe(true);
    expect(video.requestPictureInPicture).toHaveBeenCalled();
    expect(entered).toBe(true);
  });

  it('exits picture-in-picture gracefully', async () => {
    document.exitPictureInPicture = vi.fn().mockResolvedValue({});
    const res = await controller.exitPip();
    expect(res).toBe(true);
    expect(document.exitPictureInPicture).toHaveBeenCalled();
  });
});
