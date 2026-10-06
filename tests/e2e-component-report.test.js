import { it, expect } from 'vitest';
import { captureComponentTable, captureConfigurationMatches } from '../tools/e2e/component-report.mjs';
it('não transforma um label de cenário em evidência de fila ou prioridade aplicada', () => {
 const text = captureComponentTable([{ source: 'report.json', report: { runs: [{
  case: { id: 'DXGI Latest HIGH', rawQueue: 'latest', priority: 'high' }, status: 'resource-pressure-unqualified',
  conditions: { condition: { captureBackend: 'd3d11', captureMode: 'monitor-dxgi', rawQueue: 'bounded', width: 1280, height: 720 }, priority: { effectiveGpuClass: 2 } },
  encodedFps: 60.09, metrics: { captureToEncodedMs: { p50: 1.591 }, captureQueueMs: { p50: .0227 } }
 }] } }]);
 expect(text).toContain('resource-pressure-unqualified | d3d11 | monitor-dxgi | bounded | 2 | 1280×720');
 expect(text).toContain('sem receptor remoto');
});
it('preserva ausência de métricas em rodadas interrompidas', () => {
 expect(captureComponentTable([{ report: { runs: [{ case: { id: 'interrupted' }, status: 'failed' }] } }])).toContain('failed | N/D | N/D');
});
it('não qualifica uma configuração que não aplicou a fila ou prioridade solicitada', () => {
 const run = { case: { backend: 'd3d11', capture: 'monitor-dxgi', rawQueue: 'latest', priority: 'high' },
  conditions: { condition: { captureBackend: 'd3d11', captureMode: 'monitor-dxgi', rawQueue: 'latest' }, priority: { applied: true, cpuHighApplied: true, effectiveGpuClass: 4 } } };
 expect(captureConfigurationMatches(run)).toBe(true);
 run.conditions.condition.rawQueue = 'bounded'; expect(captureConfigurationMatches(run)).toBe(false);
 run.conditions.condition.rawQueue = 'latest'; run.conditions.priority.effectiveGpuClass = 2;
 expect(captureConfigurationMatches(run)).toBe(false);
 expect(captureConfigurationMatches({})).toBe(false);
});
