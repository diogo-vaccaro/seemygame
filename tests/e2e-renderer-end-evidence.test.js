import {describe, it, expect} from 'vitest';
import {collectRendererEndEvidence, qualifyWindowOptics} from '../tools/e2e/harness/renderer-end-evidence.mjs';

describe('renderer evidence closure', () => {
  it('copies source log after receiver snapshot, including a frame produced during the RPC', async () => {
    const frameLog = [{seq: 1, timeMs: 1000}];
    const events = [];
    const result = await collectRendererEndEvidence(async () => {
      events.push('receiver');
      await Promise.resolve();
      frameLog.push({seq: 2, timeMs: 1017});
      return {optics: [{seq: 2, sourceTime32: 1017, captureEpoch: 1050}]};
    }, async () => {events.push('source'); return {frameLog: [...frameLog]};});
    expect(events).toEqual(['receiver', 'source']);
    expect(qualifyWindowOptics(result.receiverEvidence.optics, result.sourceAfter.frameLog, {start: 1000, end: 1100, offsetMs: 0}).invalidProvenance).toBe(0);
  });
  it('excludes receiver samples after the measurement boundary without hiding unmatched measured frames', () => {
    const optics = [
      {seq: 1, sourceTime32: 900, captureEpoch: 1100},
      {seq: 2, sourceTime32: 950, captureEpoch: 1150},
      {seq: 3, sourceTime32: 1050, captureEpoch: 1201},
      {seq: 4, sourceTime32: 850, captureEpoch: 1099}
    ];
    const result = qualifyWindowOptics(optics, [{seq: 1, timeMs: 900}], {start: 1000, end: 1100, offsetMs: 100});
    expect(result.samples.map(s => s.seq)).toEqual([1, 2]);
    expect(result.invalidProvenance).toBe(1);
    expect(result.beforeWindow).toBe(1);
    expect(result.afterWindow).toBe(1);
  });
  it('matches sequence AND uint32 timestamp across both rollovers', () => {
    const optics = [{seq: 0xffffff, sourceTime32: 0xfffffff0, captureEpoch: 2000}, {seq: 0, sourceTime32: 0, captureEpoch: 2010}, {seq: 0, sourceTime32: 16, captureEpoch: 2020}];
    const result = qualifyWindowOptics(optics, [{seq: 0xffffff, timeMs: 0xfffffff0}, {seq: 0, timeMs: 0x100000000}], {start: 2000, end: 2020, offsetMs: 0});
    expect(result.samples.map(s => s.provenanceValid)).toEqual([true, true, false]);
  });
  it('retains malformed evidence as a qualification failure', () => {
    const result = qualifyWindowOptics([{seq: 1, sourceTime32: 1, captureEpoch: NaN}], [], {start: 0, end: 10, offsetMs: 0});
    expect(result.malformed).toBe(1);
    expect(() => qualifyWindowOptics([], [], {start: 10, end: 0, offsetMs: 0})).toThrow();
  });
});
