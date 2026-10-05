import {describe,it,expect,vi} from 'vitest';
import {retryUncertainCalibration,calibrateLocalSourceClock} from '../tools/e2e/harness/clock-calibration.mjs';
describe('Remote calibration congestion handling',()=>{
 it('retains the uncertain attempt without raising the uncertainty budget',async()=>{
   const collect=vi.fn().mockResolvedValueOnce({status:'too-uncertain',uncertaintyMs:12,maxErrorMs:10}).mockResolvedValue({status:'valid',uncertaintyMs:6,maxErrorMs:10});
   const result=await retryUncertainCalibration(collect);
   expect(result).toMatchObject({status:'valid',maxErrorMs:10,uncertaintyMs:6});expect(result.retryAttempts).toHaveLength(2);
 });
 it('never retries away clock steps or inconsistent bounds',async()=>{
   const collect=vi.fn().mockResolvedValue({status:'unstable'});
   expect((await retryUncertainCalibration(collect)).status).toBe('unstable');expect(collect).toHaveBeenCalledTimes(1);
 });
 it('fails closed when the bounded retry budget is exhausted',async()=>{
   const collect=vi.fn().mockResolvedValue({status:'too-uncertain',uncertaintyMs:20});
   const result=await retryUncertainCalibration(collect);expect(result.status).toBe('too-uncertain');expect(collect).toHaveBeenCalledTimes(3);
 });
 it('seeks a tighter initial bound while retaining valid wider attempts',async()=>{
   const collect=vi.fn().mockResolvedValueOnce({status:'valid',uncertaintyMs:9}).mockResolvedValue({status:'valid',uncertaintyMs:5});
   const result=await retryUncertainCalibration(collect);expect(result.uncertaintyMs).toBe(5);expect(result.retryAttempts).toHaveLength(2);
 });
 it('excludes source-page IPC from each network sample and checks the shared wall clock',async()=>{
   const date=vi.spyOn(Date,'now').mockReturnValue(50000);
   vi.stubGlobal('performance',{timeOrigin:49900,now:()=>100});
   const source={evaluate:vi.fn().mockResolvedValue({epoch:50000,timeOrigin:1})},receiver={evaluate:vi.fn().mockResolvedValue({receive:54000,send:54000,timeOrigin:2})};
   try{
     const result=await calibrateLocalSourceClock(source,receiver,{samples:5});
     expect(result).toMatchObject({status:'valid',offsetMs:4000,uncertaintyMs:2});
     expect(source.evaluate).toHaveBeenCalledTimes(2);expect(receiver.evaluate).toHaveBeenCalledTimes(5);
     expect(result.sourceClockAgreement.observations.every(s=>s.deviationMs===0)).toBe(true);
   }finally{date.mockRestore();vi.unstubAllGlobals();}
 });
 it('rejects a mismatching local source clock before collecting remote data',async()=>{
   const date=vi.spyOn(Date,'now').mockReturnValue(50000),receiver={evaluate:vi.fn()};
   try{await expect(calibrateLocalSourceClock({evaluate:async()=>({epoch:50003,timeOrigin:1})},receiver,{samples:5})).rejects.toThrow('agreement');expect(receiver.evaluate).not.toHaveBeenCalled();}finally{date.mockRestore();}
 });
});
