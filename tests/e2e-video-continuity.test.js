import { it, expect } from 'vitest';
import { assessVideoContinuity } from '../tools/e2e/harness/verdict.mjs';
const rows = frames => frames.map((count, index) => ({ receiverSamplePerf: index * 1000, presentation: { presentedFrames: count } }));
it('requires continued video presentation, independently of advancing audio/currentTime', () => {
  expect(assessVideoContinuity(rows([20, 80, 140, 200, 260])).passed).toBe(true);
  expect(assessVideoContinuity(rows([20, 80, 80, 80, 80, 140]))).toMatchObject({ passed: false, reason: 'video-stalled', maxObservedStallMs: 3000 });
});
it('does not certify a receiver with no presentation evidence', () => {
  expect(assessVideoContinuity([])).toMatchObject({ passed: false, reason: 'insufficient-frame-evidence' });
  expect(assessVideoContinuity(rows([20])).passed).toBe(false);
});
it('does not certify an empty or stationary counter even in a short window', () => {
  expect(assessVideoContinuity(rows([0, 0]))).toMatchObject({ passed: false, reason: 'no-advancing-frames' });
  expect(assessVideoContinuity(rows([20, 20]))).toMatchObject({ passed: false, reason: 'no-advancing-frames' });
});
it('rejects counter replacement and permits brief startup gaps', () => {
  expect(assessVideoContinuity(rows([20, 80, 0, 60]))).toMatchObject({ passed: false, reason: 'frame-counter-reset' });
  expect(assessVideoContinuity(rows([20, 20, 20, 80, 140])).passed).toBe(true);
});
