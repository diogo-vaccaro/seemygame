import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

export async function startDisplayAwakeLease() {
  if(process.platform!=='win32')return {evidence:{applied:false,reason:'not-windows'},stop:async()=>({restored:true})};
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../keep-display-awake.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{}); // A helper exit must not turn cleanup into EPIPE.
  const lines=createInterface({input:child.stdout});let restored=false,errorText='';
  child.stderr.on('data',data=>errorText+=data);
  const completed=new Promise(resolve=>{child.once('error',()=>resolve(false));child.once('exit',code=>resolve(code===0));});
  let timer;
  const ready=new Promise((resolve,reject)=>{
    lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}if('restored'in value)restored=value.restored;if('applied'in value)resolve(value);});
    child.once('error',reject);child.once('exit',()=>reject(Error('Display request exited before readiness: '+errorText.slice(-300))));
    timer=setTimeout(()=>reject(Error('Display request readiness timeout')),15000);
  });
  let evidence;
  try {evidence=await ready;}catch(error){child.stdin.end();child.kill();throw error;}finally{clearTimeout(timer);}
  const stop=async()=>{
    if(child.exitCode===null)child.stdin.end('\n');
    let deadline;const exited=await Promise.race([completed,new Promise(resolve=>{deadline=setTimeout(()=>resolve(false),3000);})]);clearTimeout(deadline);
    if(child.exitCode===null)child.kill();lines.close();return {restored,exited};
  };
  if(!evidence.applied){await stop();throw Error('Temporary display/system request was rejected');}
  return {evidence:{...evidence,pid:child.pid,scope:'Temporary idle prevention; does not certify physical monitor power'},stop};
}
