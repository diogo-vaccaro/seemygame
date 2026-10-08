import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RelayManager, DEFAULT_MAX_DIRECT_VIEWERS } from '../js/relay.js';
import { MockMediaStream, MockMediaStreamTrack } from './mocks/webrtc.mock.js';

describe('Módulo: relay.js (P2P Tree Mesh)', () => {
  let manager;
  let topologySpy;
  let failoverSpy;

  beforeEach(() => {
    topologySpy = vi.fn();
    failoverSpy = vi.fn();
    manager = new RelayManager({
      originPeerId: 'streamer-host',
      maxDirectViewers: 2,
      onTopologyChange: topologySpy,
      onFailover: failoverSpy
    });
  });

  it('deve usar DEFAULT_MAX_DIRECT_VIEWERS = 3 por padrão', () => {
    expect(DEFAULT_MAX_DIRECT_VIEWERS).toBe(3);
    const defaultManager = new RelayManager({ originPeerId: 'host' });
    expect(defaultManager.maxDirectViewers).toBe(3);
  });

  it('deve inicializar com o nó de origem raiz configurado', () => {
    const topo = manager.getTopology();
    expect(topo.origin).toBe('streamer-host');
    expect(topo.totalViewers).toBe(0);
    expect(topo.directCount).toBe(0);
    expect(topo.relayedCount).toBe(0);
  });

  it('deve alocar os dois primeiros espectadores como diretos (Nível 1)', () => {
    const v1 = manager.registerViewer('viewer-1', { rtt: 30 });
    const v2 = manager.registerViewer('viewer-2', { rtt: 40 });

    expect(v1.role).toBe('direct');
    expect(v1.parentPeerId).toBe('streamer-host');

    expect(v2.role).toBe('direct');
    expect(v2.parentPeerId).toBe('streamer-host');

    const topo = manager.getTopology();
    expect(topo.totalViewers).toBe(2);
    expect(topo.directCount).toBe(2);
    expect(topo.relayedCount).toBe(0);
  });

  it('deve alocar o 3º espectador como relay sob o melhor nó direto (menor RTT)', () => {
    manager.registerViewer('viewer-1', { rtt: 25 }); // menor RTT
    manager.registerViewer('viewer-2', { rtt: 60 });

    const v3 = manager.registerViewer('viewer-3', { rtt: 45 });

    expect(v3.role).toBe('relay');
    expect(v3.parentPeerId).toBe('viewer-1'); // elegeu viewer-1

    const topo = manager.getTopology();
    expect(topo.totalViewers).toBe(3);
    expect(topo.directCount).toBe(2);
    expect(topo.relayedCount).toBe(1);
    expect(topo.relayed[0].childPeerId || topo.relayed[0].peerId).toBe('viewer-3');
    expect(topo.relayed[0].parentPeerId).toBe('viewer-1');
  });

  it('deve balancear o 4º espectador para o outro nó direto', () => {
    manager.registerViewer('viewer-1', { rtt: 30 });
    manager.registerViewer('viewer-2', { rtt: 35 });

    const v3 = manager.registerViewer('viewer-3', { rtt: 40 });
    expect(v3.parentPeerId).toBe('viewer-1');

    const v4 = manager.registerViewer('viewer-4', { rtt: 50 });
    // viewer-1 já tem 1 filho; viewer-2 tem 0 filhos, então viewer-2 deve ser escolhido!
    expect(v4.role).toBe('relay');
    expect(v4.parentPeerId).toBe('viewer-2');
  });

  it('deve calcular corretamente a economia de largura de banda do streamer', () => {
    manager.registerViewer('viewer-1');
    manager.registerViewer('viewer-2');
    manager.registerViewer('viewer-3');
    manager.registerViewer('viewer-4');

    // 4 espectadores a 8 Mbps cada:
    // Full Mesh: 4 * 8 = 32 Mbps
    // Tree Mesh: 2 * 8 = 16 Mbps
    // Economia: 16 Mbps (50%)
    const savings = manager.calculateBandwidthSavings(8000000);
    expect(savings.fullMeshUploadBps).toBe(32000000);
    expect(savings.treeUploadBps).toBe(16000000);
    expect(savings.savingsBps).toBe(16000000);
    expect(savings.percentSaved).toBe(50);
  });

  it('deve executar failover automático quando um nó pai de relay desconectar', () => {
    manager.registerViewer('viewer-1', { rtt: 25 });
    manager.registerViewer('viewer-2', { rtt: 45 });
    manager.registerViewer('viewer-3', { rtt: 30 }); // filho de viewer-1

    // viewer-1 desconecta!
    const failovers = manager.unregisterViewer('viewer-1');

    expect(failovers.length).toBe(1);
    expect(failovers[0].childPeerId).toBe('viewer-3');
    // Como agora há uma vaga direta no streamer (apenas viewer-2 é direto),
    // viewer-3 deve ser promovido para 'direct' com o streamer!
    expect(failovers[0].role).toBe('direct');
    expect(failovers[0].newParentPeerId).toBe('streamer-host');
    expect(failoverSpy).toHaveBeenCalledWith('viewer-3', 'streamer-host', 'direct');
  });

  it('forwardMediaStream deve adicionar trilhas ativas ao novo peer connection', () => {
    const videoTrack = new MockMediaStreamTrack('video');
    const audioTrack = new MockMediaStreamTrack('audio');
    const stream = new MockMediaStream([videoTrack, audioTrack]);

    const mockPc = {
      addTrack: vi.fn()
    };

    const ok = RelayManager.forwardMediaStream(stream, mockPc);
    expect(ok).toBe(true);
    expect(mockPc.addTrack).toHaveBeenCalledTimes(2);
  });

  it('forwardMediaStream deve retornar false se a stream for vazia ou inválida', () => {
    const emptyStream = new MockMediaStream([]);
    const mockPc = { addTrack: vi.fn() };

    expect(RelayManager.forwardMediaStream(null, mockPc)).toBe(false);
    expect(RelayManager.forwardMediaStream(emptyStream, mockPc)).toBe(false);
    expect(mockPc.addTrack).not.toHaveBeenCalled();
  });

  it('deve alocar espectadores em LAN diretamente sem consumir a cota de espectadores WAN', () => {
    // maxDirectViewers é 2. Adiciona 1 espectador LAN e 2 espectadores WAN
    const vLan1 = manager.registerViewer('viewer-lan-1', { rtt: 2, isLan: true });
    expect(vLan1.role).toBe('direct');

    const vWan1 = manager.registerViewer('viewer-wan-1', { rtt: 35 });
    const vWan2 = manager.registerViewer('viewer-wan-2', { rtt: 40 });
    expect(vWan1.role).toBe('direct');
    expect(vWan2.role).toBe('direct');

    // 3º espectador WAN deve virar relay porque a cota WAN (2) foi atingida
    const vWan3 = manager.registerViewer('viewer-wan-3', { rtt: 50 });
    expect(vWan3.role).toBe('relay');

    // Outro espectador LAN ainda consegue entrar como direto
    const vLan2 = manager.registerViewer('viewer-lan-2', { rtt: 3, isLan: true });
    expect(vLan2.role).toBe('direct');
  });
});
