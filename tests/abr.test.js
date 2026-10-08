import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveBitrateController } from '../js/abr.js';

describe('Módulo: abr.js (AdaptiveBitrateController)', () => {
  let controller;
  let bitrateChangeSpy;

  beforeEach(() => {
    bitrateChangeSpy = vi.fn();
    controller = new AdaptiveBitrateController({
      targetBitrateBps: 8000000,
      minBitrateBps: 2000000,
      onBitrateChange: bitrateChangeSpy,
    });
  });

  it('deve inicializar com o bitrate alvo configurado', () => {
    expect(controller.currentBitrateBps).toBe(8000000);
    expect(controller.targetBitrateBps).toBe(8000000);
    expect(controller.minBitrateBps).toBe(2000000);
    expect(controller.isEnabled).toBe(true);
  });

  it('deve reduzir bitrate em 25% quando perda de pacotes for maior que 4%', () => {
    controller.processSample({ packetLossRate: 0.06, rttMs: 50 });

    expect(controller.currentBitrateBps).toBe(6000000); // 8M * 0.75
    expect(bitrateChangeSpy).toHaveBeenCalledWith(6000000);
  });

  it('deve reduzir bitrate quando latência RTT for muito alta (> 220ms)', () => {
    controller.processSample({ packetLossRate: 0.0, rttMs: 300 });

    expect(controller.currentBitrateBps).toBe(6000000);
  });

  it('deve reduzir bitrate quando qualityLimitationReason for cpu', () => {
    controller.processSample({ packetLossRate: 0.0, rttMs: 40, qualityLimitationReason: 'cpu' });

    expect(controller.currentBitrateBps).toBe(6000000);
    expect(bitrateChangeSpy).toHaveBeenCalledWith(6000000);
  });

  it('deve reduzir bitrate quando encodeTimeMs for excessivo (> 20ms)', () => {
    controller.processSample({ packetLossRate: 0.0, rttMs: 35, encodeTimeMs: 25.5 });

    expect(controller.currentBitrateBps).toBe(6000000);
    expect(bitrateChangeSpy).toHaveBeenCalledWith(6000000);
  });

  it('não deve recuperar bitrate se encodeTimeMs permanecer elevado (> 15ms)', () => {
    controller.currentBitrateBps = 4000000;

    for (let i = 0; i < 5; i++) {
      controller.processSample({ packetLossRate: 0.0, rttMs: 30, encodeTimeMs: 18.0 });
    }

    expect(controller.currentBitrateBps).toBe(4000000);
  });

  it('não deve reduzir abaixo do bitrate mínimo', () => {
    controller.currentBitrateBps = 2200000;
    controller.processSample({ packetLossRate: 0.1, rttMs: 500 });

    expect(controller.currentBitrateBps).toBe(2000000); // travou em minBitrateBps
  });

  it('deve recuperar bitrate gradualmente após 4 amostras consecutivas saudáveis', () => {
    controller.currentBitrateBps = 4000000;

    // 3 amostras boas
    controller.processSample({ packetLossRate: 0.002, rttMs: 40 });
    controller.processSample({ packetLossRate: 0.001, rttMs: 42 });
    controller.processSample({ packetLossRate: 0.0, rttMs: 38 });
    expect(controller.currentBitrateBps).toBe(4000000);

    // 4ª amostra boa -> aciona incremento de 15%
    controller.processSample({ packetLossRate: 0.0, rttMs: 35 });
    expect(controller.currentBitrateBps).toBe(4600000); // 4M * 1.15
  });

  it('ao desativar ABR, deve restaurar imediatamente o targetBitrate', () => {
    controller.currentBitrateBps = 3000000;
    controller.setEnabled(false);

    expect(controller.currentBitrateBps).toBe(8000000);
    expect(bitrateChangeSpy).toHaveBeenCalledWith(8000000);
  });

  it('calculateMeshGuardCap deve isentar espectadores em LAN do rateio de upload residencial', () => {
    // 3 espectadores no total, mas 2 são LAN -> apenas 1 WAN, então mantém o bitrate base integral
    const cap = AdaptiveBitrateController.calculateMeshGuardCap(3, 8000000, 2);
    expect(cap).toBe(8000000);
  });

  it('applyMeshGuard não deve limitar pares com isLan ativo', () => {
    controller.setTargetBitrate(30000000, 'peer-lan');
    controller.processSample({ isLan: true, rttMs: 2 }, 'peer-lan');

    controller.setTargetBitrate(8000000, 'peer-wan');
    controller.processSample({ isLan: false, rttMs: 40 }, 'peer-wan');

    // 4 espectadores totais, 1 LAN
    controller.applyMeshGuard(4, 8000000, 1);

    expect(controller.getCurrentBitrate('peer-lan')).toBe(30000000);
    expect(controller.getCurrentBitrate('peer-wan')).toBeLessThanOrEqual(4000000);
  });

  it('em LAN deve recuperar bitrate mais rapidamente (após 1 amostra saudável)', () => {
    controller.currentBitrateBps = 4000000;
    controller.processSample({ packetLossRate: 0.0, rttMs: 2, isLan: true });

    // Com 1 amostra saudável na LAN já deve acionar aumento de bitrate
    expect(controller.currentBitrateBps).toBe(5000000); // 4M * 1.25
  });
});
