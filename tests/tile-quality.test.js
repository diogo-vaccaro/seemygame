import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TileQualityController } from '../js/streaming/tile-quality.js';

describe('TileQualityController - Qualidade Automática por Tamanho de Tile', () => {
  let controller;
  let emittedDemands;

  beforeEach(() => {
    emittedDemands = [];
    controller = new TileQualityController({
      downscaleDelayMs: 50, // reduzido para o teste
      resizeDebounceMs: 10,
      onDemandChange: (profile, config) => emittedDemands.push({ profile, config })
    });
  });

  afterEach(() => {
    controller.dispose();
  });

  it('classifica dimensões de tile corretamente nos perfis discretos', () => {
    // Tile pequeno (ex: 400x300 = 120.000px <= 250.000px)
    controller.tileArea = 120000;
    expect(controller.evaluateLocalProfile()).toBe('small');

    // Tile médio (ex: 800x600 = 480.000px <= 950.000px)
    controller.tileArea = 480000;
    expect(controller.evaluateLocalProfile()).toBe('medium');

    // Tile grande / foco (ex: 1920x1080 = 2.073.600px > 950.000px)
    controller.tileArea = 2073600;
    expect(controller.evaluateLocalProfile()).toBe('focus');

    // Tile com foco explícito vai para focus
    controller.isTileFocused = true;
    controller.tileArea = 10000;
    expect(controller.evaluateLocalProfile()).toBe('focus');

    // Oculto se fora da tela ou página oculta
    controller.isTileFocused = false;
    controller.isPageVisible = false;
    expect(controller.evaluateLocalProfile()).toBe('hidden');
  });

  it('aplica subida de qualidade imediatamente em foco', () => {
    controller.currentProfile = 'small';
    controller.setFocused(true);

    expect(controller.currentProfile).toBe('focus');
    expect(emittedDemands).toHaveLength(1);
    expect(emittedDemands[0].profile).toBe('focus');
  });

  it('aplica histerese com atraso na redução de qualidade', async () => {
    vi.useFakeTimers();

    controller.currentProfile = 'focus';
    controller.tileArea = 100000; // Demanda 'small'
    controller.isTileFocused = false;
    controller.isPageVisible = true;

    controller._updateProfileWithHysteresis();

    // Ainda não mudou imediatamente
    expect(controller.currentProfile).toBe('focus');

    // Avança o tempo da histerese
    vi.advanceTimersByTime(60);

    expect(controller.currentProfile).toBe('small');
    vi.useRealTimers();
  });

  it('agrega a maior demanda entre consumo local e downstream relay', () => {
    controller.currentProfile = 'small';

    // Downstream peer precisa de 'focus'
    controller.setDownstreamDemand('downstream-peer-1', 'focus');

    expect(controller.getEffectiveDemandedProfile()).toBe('focus');

    // Remove demanda do downstream peer
    controller.removeDownstreamDemand('downstream-peer-1');
    expect(controller.getEffectiveDemandedProfile()).toBe('small');
  });
});
