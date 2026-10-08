import {describe,it,expect} from 'vitest';
import {describeBenchmarkOutcome} from '../tools/e2e/harness/benchmark-outcome.mjs';
describe('benchmark exit diagnostics',()=>{
 it('retains successful delivery and clock rejection rather than reporting missing phase evidence',()=>{
  const raw={native:{timeline:[{}]},verdict:{functionalPassed:true,measurementRequested:true,measurementValid:false,overallStatus:'inconclusive'},clockCalibrations:{native:{validation:{status:'invalid',reason:'uncertainty exceeds bound',uncertaintyMs:10.1,maxErrorMs:10}}}};
  const result=describeBenchmarkOutcome({raw,phase:raw.native,exitCode:1});
  expect(result.error).toBe('measurement-inconclusive: uncertainty exceeds bound');
  expect(result.overallStatus).toBe('inconclusive');expect(result.measurementValid).toBe(false);
  expect(result.clockValidation.uncertaintyMs).toBe(10.1);
 });
 it('preserves explicit failures and distinguishes present phase evidence',()=>{
  expect(describeBenchmarkOutcome({raw:{error:'wrong geometry'},phase:{},exitCode:1}).error).toBe('wrong geometry');
  expect(describeBenchmarkOutcome({phase:{},exitCode:1}).error).toContain('phase evidence preserved');
  expect(describeBenchmarkOutcome({exitCode:1}).error).toBe('Runner failed without phase evidence');
  expect(describeBenchmarkOutcome({exitCode:0}).error).toBeNull();
 });
});
