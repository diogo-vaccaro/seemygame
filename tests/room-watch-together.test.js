import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedToolsService } from '../js/room/tools/shared-tools-service.js';
import { WatchTogetherController } from '../js/room/tools/watch-together.js';

describe('WatchTogetherController - Co-visualização Sincronizada', () => {
  let hostService;
  let watch;

  beforeEach(() => {
    hostService = new SharedToolsService({
      isHost: () => true,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      getCoordinatorPeerId: () => 'host-peer',
      roomEpoch: 'epoch-1'
    });

    watch = new WatchTogetherController({
      service: hostService,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      getCoordinatorPeerId: () => 'host-peer',
      isHost: () => true,
      getIsReadonly: () => false
    });
  });

  afterEach(() => {
    watch.destroy();
    hostService.dispose();
  });

  it('analisa URLs válidas de YouTube e MP4 HTTPS', () => {
    const yt1 = WatchTogetherController.parseMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(yt1).toEqual({ provider: 'youtube', resource: 'dQw4w9WgXcQ' });

    const yt2 = WatchTogetherController.parseMediaUrl('https://youtu.be/dQw4w9WgXcQ?t=10');
    expect(yt2).toEqual({ provider: 'youtube', resource: 'dQw4w9WgXcQ' });

    const mp4 = WatchTogetherController.parseMediaUrl('https://cdn.example.com/video/gameplay.mp4');
    expect(mp4).toEqual({ provider: 'mp4', resource: 'https://cdn.example.com/video/gameplay.mp4' });

    const invalid = WatchTogetherController.parseMediaUrl('http://inseguro.com/video.exe');
    expect(invalid).toBeNull();
  });

  it('carrega mídia, gera mediaId e ancora o relógio da sala', async () => {
    const res = await watch.loadMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(res.success).toBe(true);
    expect(watch.mediaId).not.toBeNull();
    expect(watch.provider).toBe('youtube');
    expect(watch.resource).toBe('dQw4w9WgXcQ');
    expect(watch.positionSeconds).toBe(0);
    expect(watch.paused).toBe(true);
    expect(watch.roomClockAnchor).toBeGreaterThan(0);
  });

  it('coordena comandos de play, pause e seek incrementando revisões', async () => {
    await watch.loadMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(watch.revision).toBe(1);

    await watch.play();
    expect(watch.paused).toBe(false);
    expect(watch.revision).toBe(2);

    await watch.seek(45.5);
    expect(watch.positionSeconds).toBe(45.5);
    expect(watch.revision).toBe(3);

    await watch.pause();
    expect(watch.paused).toBe(true);
    expect(watch.revision).toBe(4);
  });

  it('permite que o host delegue o controle a outro participante', async () => {
    await watch.loadMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const delegateRes = await watch.delegateController('player-friend');
    expect(delegateRes.success).toBe(true);
    expect(watch.controllerPeerId).toBe('player-friend');

    // Agora player-friend possui autorização de comando
    expect(watch._canControl('player-friend')).toBe(true);
    expect(watch._canControl('stranger-guest')).toBe(false);
  });

  it('rejeita comandos de reprodução vindos de participante não autorizado', async () => {
    await watch.loadMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const unauthorizedPlay = await watch._applyProposalOnHost(
      { action: 'play' },
      { authorPeerId: 'unauthorized-guest' }
    );
    expect(unauthorizedPlay.success).toBe(false);
    expect(unauthorizedPlay.reason).toBe('unauthorized_controller');
  });

  it('calcula posição estimada corretamente baseada no tempo decorrido desde a ancoragem', () => {
    watch.mediaId = 'm1';
    watch.positionSeconds = 10;
    watch.paused = false;
    watch.roomClockAnchor = Date.now() - 5000; // 5 segundos atrás

    const est = watch.calculateEstimatedPosition();
    expect(est).toBeGreaterThanOrEqual(14.8);
    expect(est).toBeLessThanOrEqual(15.5);
  });
});
