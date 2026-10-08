/** Preserve the distinction between missing evidence and invalid optical calibration. */
export function describeBenchmarkOutcome({raw,phase,run,matrix,exitCode=0}={}) {
 const verdict=raw?.verdict;
 const clock=raw?.clockCalibrations?.[raw?.web?'web':'native']?.validation??null;
 const explicitError=raw?.error??run?.error??matrix?.error??null;
 let error=explicitError;
 if(!error&&verdict?.functionalPassed===true&&verdict.measurementRequested&&verdict.measurementValid!==true){
  error='measurement-inconclusive: '+(clock?.reason??'optical measurement not qualified');
 }else if(!error&&exitCode!==0){
  error=phase?`Runner exit ${exitCode}; phase evidence preserved`:'Runner failed without phase evidence';
 }
 return {overallStatus:verdict?.overallStatus??null,measurementRequested:verdict?.measurementRequested??null,
  measurementValid:verdict?.measurementValid??null,clockValidation:clock,error};
}
