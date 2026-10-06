import { it, expect } from 'vitest';
import { assessResolutionRun } from '../tools/e2e/resolution-assessment.mjs';
const profile = { targetWidth: 1280, targetHeight: 720, fps: 60, degradationPreference: 'maintain-resolution' };
const result = { appliedDegradation: 'maintain-resolution', finalDegradation: 'maintain-resolution', samples: [2, 3, 4].map(second => ({ second, phase: 'initial', inboundFrameWidth: 1280, inboundFrameHeight: 720, rxFps: 60, presentedFps: 60, codec: 'video/H264' })) };
it('aprova somente amostras estáveis com dimensões, codec, preferência e cadência corretas', () => {
 expect(assessResolutionRun(result, profile).passed).toBe(true);
});
it.each([{ inboundFrameWidth: 1920 }, { inboundFrameHeight: 1080 }, { codec: 'video/VP8' }, { rxFps: 20 }, { presentedFps: 20 }])('rejeita uma amostra divergente mesmo se a altura mínima for correta: %j', mismatch => {
 const data = structuredClone(result); Object.assign(data.samples[1], mismatch);
 expect(assessResolutionRun(data, profile).passed).toBe(false);
});
it('exige evidência estável dos dois lados da troca dinâmica', () => {
 const dynamic = { ...profile, dynamicSwitch: { targetWidth: 640, targetHeight: 360, degradationPreference: 'balanced' } };
 const data = { ...structuredClone(result), finalDegradation: 'balanced' };
 expect(assessResolutionRun(data, dynamic).reasons).toContain('final-insufficient-samples');
 data.samples.push(...[5, 6].map(second => ({ ...data.samples[0], second, phase: 'final', inboundFrameWidth: 640, inboundFrameHeight: 360 })));
 expect(assessResolutionRun(data, dynamic).passed).toBe(true);
});
it('não aprova fallback de preferência nem falta de evidência', () => {
 expect(assessResolutionRun({ ...result, appliedDegradation: undefined }, profile).passed).toBe(false);
 expect(assessResolutionRun({ ...result, samples: [] }, profile).passed).toBe(false);
});
