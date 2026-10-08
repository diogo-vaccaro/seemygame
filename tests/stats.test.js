import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startStatsMonitor,
  stopStatsMonitor
} from '../js/stats.js';
import { MockRTCPeerConnection } from './mocks/webrtc.mock.js';

describe('Módulo: stats.js', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function setupStatsDom(peerId) {
    document.body.innerHTML = `
      <div id="stat-rtt-${peerId}">-- ms</div>
      <div id="stat-fps-${peerId}">-- FPS</div>
      <div id="stat-bitrate-${peerId}">-- Mbps</div>
      <div id="stat-res-${peerId}">--</div>
    `;
  }

  describe('startStatsMonitor', () => {
    it('deve registrar um intervalo periódico e atualizar RTT a partir de candidate-pair', async () => {
      const peerId = 'peer-stats-1';
      setupStatsDom(peerId);

      const pc = new MockRTCPeerConnection();
      pc.getStats = vi.fn().mockResolvedValue([
        {
          type: 'candidate-pair',
          state: 'succeeded',
          currentRoundTripTime: 0.018 // 18 ms
        }
      ]);

      startStatsMonitor(peerId, pc);

      await vi.advanceTimersByTimeAsync(1000);

      const rttElem = document.getElementById(`stat-rtt-${peerId}`);
      expect(rttElem.innerText).toBe('18 ms');

      stopStatsMonitor(peerId);
    });

    it('deve atualizar FPS, resolução e bitrate em stream inbound (espectador)', async () => {
      const peerId = 'peer-stats-inbound';
      setupStatsDom(peerId);

      const pc = new MockRTCPeerConnection();
      let bytes = 1000000;

      pc.getStats = vi.fn().mockImplementation(async () => [
        {
          type: 'inbound-rtp',
          kind: 'video',
          framesPerSecond: 60,
          bytesReceived: bytes,
          frameWidth: 1920,
          frameHeight: 1080
        }
      ]);

      startStatsMonitor(peerId, pc);

      // Primeiro tick (estabelece lastBytes)
      await vi.advanceTimersByTimeAsync(1000);

      // Segundo tick com mais bytes para calcular bitrate
      bytes += 1000000; // +1 MB ~ 8 Mbps
      await vi.advanceTimersByTimeAsync(1000);

      const fpsElem = document.getElementById(`stat-fps-${peerId}`);
      const resElem = document.getElementById(`stat-res-${peerId}`);
      const bitElem = document.getElementById(`stat-bitrate-${peerId}`);

      expect(fpsElem.innerText).toBe('60 FPS');
      expect(resElem.innerText).toBe('1920x1080');
      expect(parseFloat(bitElem.innerText)).toBeGreaterThan(0);

      stopStatsMonitor(peerId);
    });

    it('deve atualizar FPS, resolução e bytes em stream outbound (transmissor)', async () => {
      const peerId = 'peer-stats-outbound';
      setupStatsDom(peerId);

      const pc = new MockRTCPeerConnection();
      let bytes = 500000;

      pc.getStats = vi.fn().mockImplementation(async () => [
        {
          type: 'outbound-rtp',
          kind: 'video',
          framesPerSecond: 59.8,
          bytesSent: bytes,
          frameWidth: 1280,
          frameHeight: 720
        }
      ]);

      startStatsMonitor(peerId, pc, true);

      // Primeiro tick
      await vi.advanceTimersByTimeAsync(1000);
      // Segundo tick
      bytes += 700000;
      await vi.advanceTimersByTimeAsync(1000);

      const fpsElem = document.getElementById(`stat-fps-${peerId}`);
      const resElem = document.getElementById(`stat-res-${peerId}`);

      expect(fpsElem.innerText).toBe('60 FPS'); // Math.round(59.8)
      expect(resElem.innerText).toBe('1280x720');

      stopStatsMonitor(peerId);
    });

    it('deve ler dimensões de resolução a partir do relatório do tipo track', async () => {
      const peerId = 'peer-stats-track';
      setupStatsDom(peerId);

      const pc = new MockRTCPeerConnection();
      pc.getStats = vi.fn().mockResolvedValue([
        {
          type: 'track',
          kind: 'video',
          frameWidth: 2560,
          frameHeight: 1440
        }
      ]);

      startStatsMonitor(peerId, pc);
      await vi.advanceTimersByTimeAsync(1000);

      const resElem = document.getElementById(`stat-res-${peerId}`);
      expect(resElem.innerText).toBe('2560x1440');

      stopStatsMonitor(peerId);
    });

    it('deve encerrar a monitoria se a conexão estiver fechada (closed)', async () => {
      const peerId = 'peer-stats-closed';
      setupStatsDom(peerId);

      const pc = new MockRTCPeerConnection();
      pc.connectionState = 'closed';
      const getStatsSpy = vi.spyOn(pc, 'getStats');

      startStatsMonitor(peerId, pc);
      await vi.advanceTimersByTimeAsync(1000);

      expect(getStatsSpy).not.toHaveBeenCalled();
    });

    it('não deve quebrar se os elementos do DOM não existirem', async () => {
      const peerId = 'peer-no-dom';
      const pc = new MockRTCPeerConnection();
      pc.getStats = vi.fn().mockResolvedValue([
        {
          type: 'candidate-pair',
          state: 'succeeded',
          currentRoundTripTime: 0.010
        }
      ]);

      expect(() => {
        startStatsMonitor(peerId, pc);
      }).not.toThrow();

      await vi.advanceTimersByTimeAsync(1000);
      stopStatsMonitor(peerId);
    });

    it('deve priorizar candidate-pair ativo (nominated/selected) sobre outros pares bem-sucedidos', async () => {
      const peerId = 'peer-stats-nominated';
      setupStatsDom(peerId);

      const pc = new MockRTCPeerConnection();
      pc.getStats = vi.fn().mockResolvedValue([
        {
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: false,
          currentRoundTripTime: 0.050 // 50 ms (não nomeado)
        },
        {
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.012 // 12 ms (nomeado / ativo)
        }
      ]);

      startStatsMonitor(peerId, pc);
      await vi.advanceTimersByTimeAsync(1000);

      const rttElem = document.getElementById(`stat-rtt-${peerId}`);
      expect(rttElem.innerText).toBe('12 ms');

      stopStatsMonitor(peerId);
    });

    it('deve atualizar elementos de perda de pacotes e limitação de qualidade quando presentes', async () => {
      const peerId = 'peer-stats-adv';
      document.body.innerHTML = `
        <div id="stat-rtt-${peerId}">-- ms</div>
        <div id="stat-fps-${peerId}">-- FPS</div>
        <div id="stat-bitrate-${peerId}">-- Mbps</div>
        <div id="stat-res-${peerId}">--</div>
        <div id="stat-loss-${peerId}">--</div>
        <div id="stat-quality-${peerId}">--</div>
      `;

      const pc = new MockRTCPeerConnection();
      pc.getStats = vi.fn().mockResolvedValue([
        {
          type: 'inbound-rtp',
          kind: 'video',
          framesPerSecond: 60,
          bytesReceived: 2000000,
          packetsLost: 5
        }
      ]);

      startStatsMonitor(peerId, pc, false);
      await vi.advanceTimersByTimeAsync(1000);

      const lossElem = document.getElementById(`stat-loss-${peerId}`);
      expect(lossElem.innerText).toBe('5 perdidos');

      stopStatsMonitor(peerId);
    });
  });

  describe('stopStatsMonitor', () => {
    it('deve interromper o intervalo e não atualizar mais o DOM', async () => {
      const peerId = 'peer-stop-stats';
      setupStatsDom(peerId);

      const pc = new MockRTCPeerConnection();
      pc.getStats = vi.fn().mockResolvedValue([
        {
          type: 'candidate-pair',
          state: 'succeeded',
          currentRoundTripTime: 0.020
        }
      ]);

      startStatsMonitor(peerId, pc);
      await vi.advanceTimersByTimeAsync(1000);

      const rttElem = document.getElementById(`stat-rtt-${peerId}`);
      expect(rttElem.innerText).toBe('20 ms');

      stopStatsMonitor(peerId);

      // Altera o mock para confirmar que não haverá novas atualizações
      pc.getStats = vi.fn().mockResolvedValue([
        {
          type: 'candidate-pair',
          state: 'succeeded',
          currentRoundTripTime: 0.080
        }
      ]);

      await vi.advanceTimersByTimeAsync(2000);
      expect(rttElem.innerText).toBe('20 ms');
    });

    it('pode ser chamado de forma segura para peer inexistente', () => {
      expect(() => stopStatsMonitor('unknown-peer')).not.toThrow();
    });

    it('deve identificar conexão LAN a partir de candidatos host e RTT baixo', async () => {
      const peerId = 'peer-stats-lan';
      setupStatsDom(peerId);

      const pc = new MockRTCPeerConnection();
      pc.getStats = vi.fn().mockResolvedValue([
        {
          type: 'candidate-pair',
          state: 'succeeded',
          localCandidateId: 'cand-local',
          remoteCandidateId: 'cand-remote',
          currentRoundTripTime: 0.002 // 2 ms
        },
        {
          id: 'cand-local',
          type: 'local-candidate',
          candidateType: 'host',
          address: '192.168.1.50'
        },
        {
          id: 'cand-remote',
          type: 'remote-candidate',
          candidateType: 'host',
          address: '192.168.1.60'
        }
      ]);

      startStatsMonitor(peerId, pc);
      await vi.advanceTimersByTimeAsync(1000);

      const rttElem = document.getElementById(`stat-rtt-${peerId}`);
      expect(rttElem.innerText).toContain('2 ms (LAN)');

      stopStatsMonitor(peerId);
    });
  });
});
