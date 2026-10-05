// Run on the receiving computer. Browser and resource control bind only to loopback.
import {chromium} from 'playwright';
import http from 'node:http';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startResourceSampler} from './harness/resources.mjs';
import {machineFingerprint} from './harness/remote-viewer.mjs';
const require=createRequire(import.meta.url),option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const port=Number(option('--browser-port','9333')),controlPort=Number(option('--control-port','9334')),minutes=Number(option('--max-minutes','30')),headless=process.argv.includes('--headless');
const runtime=option('--runtime','chrome'),root=fileURLToPath(new URL('../../',import.meta.url));
const browserConfig=option('--browser-config','harness');
const diagnosticIce=process.argv.includes('--diagnostic-ice-addresses');
const resourcesOnly=process.argv.includes('--resources-only');
if(resourcesOnly&&runtime!=='chrome')throw new Error('Resource-only helper cannot start a desktop app');
if(!['harness','standard'].includes(browserConfig))throw new Error('Invalid browser config');
if(!['chrome','tauri'].includes(runtime)||runtime==='tauri'&&headless)throw new Error('Use chrome (optionally headless) or tauri in an interactive session');
const readyFile=option('--ready-file',null),readyPath=readyFile?path.resolve(readyFile):null;
if(readyPath&&!readyPath.startsWith(path.join(root,'output')+path.sep))throw new Error('Ready file must be in the project output directory');
if(![port,controlPort].every(p=>Number.isInteger(p)&&p>=1024&&p<=65535)||port===controlPort||!Number.isInteger(minutes)||minutes<1||minutes>180)throw new Error('Invalid ports/lifetime');
let browserServer,desktop,control,resources,timer,stopping=false,ownsReadyFile=false;
const stop=async()=>{if(stopping)return;stopping=true;clearTimeout(timer);await resources?.stop();await browserServer?.close();if(desktop&&desktop.exitCode===null){const exited=new Promise(resolve=>desktop.once('exit',resolve));desktop.kill();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);}if(control){control.closeAllConnections();await new Promise(resolve=>control.close(resolve));}if(ownsReadyFile)await rm(readyPath,{force:true});};
try {
 let session=null;
 if(process.platform==='win32') {
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-Process -Id $pid).SessionId'],{windowsHide:true,stdio:['ignore','pipe','ignore']});let text='';child.stdout.on('data',d=>text+=d.toString());
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  session={processSessionId:code===0&&/^\d+$/.test(text.trim())?Number(text.trim()):null};
  if(!headless&&(session.processSessionId===null||session.processSessionId===0))throw new Error('Headed viewer requires an interactive Windows session. Open this helper in the notebook desktop terminal, or use --headless for decoder/network testing.');
 }
 resources=await startResourceSampler({enabled:!process.argv.includes('--no-system-metrics')});
 const browserArgs=browserConfig==='harness'?['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-features=CalculateNativeWinOcclusion','--autoplay-policy=no-user-gesture-required','--window-position=30,30','--window-size=1280,800']:['--window-position=30,30','--window-size=1280,800'];
 if(diagnosticIce){const at=browserArgs.findIndex(arg=>arg.startsWith('--disable-features='));if(at>=0)browserArgs[at]+=',WebRtcHideLocalIpsWithMdns';else browserArgs.push('--disable-features=WebRtcHideLocalIpsWithMdns');}
 if(resourcesOnly){/* Same resource collector in native receiver cases, no browser. */}
 else if(runtime==='tauri'){
  const exe=path.resolve(option('--exe',path.join(root,'src-tauri/target/release/seemygame.exe')));await stat(exe);
  const profile=path.join(root,'output/playwright',`viewer-profile-${randomUUID()}`);await mkdir(profile,{recursive:true});
  desktop=spawn(exe,[],{cwd:path.dirname(exe),windowsHide:false,stdio:'ignore',env:{...process.env,PATH:[path.join(root,'native-media/gstreamer/bin'),process.env.PATH].filter(Boolean).join(path.delimiter),WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:[...browserArgs,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'].join(' ')}});
  let spawnError;desktop.on('error',e=>{spawnError=e;});
  const deadline=Date.now()+30000;let ready=false;
  while(Date.now()<deadline){if(spawnError)throw spawnError;if(desktop.exitCode!==null)throw new Error('Receiver Tauri exited before CDP readiness: '+desktop.exitCode);try{const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,300));}
  if(!ready)throw new Error('Receiver WebView2 CDP readiness timeout');
 }else if(browserConfig==='standard'){
  if(headless)throw new Error('Standard config requires headed Chrome');
  const candidates=[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA].filter(Boolean).map(p=>path.join(p,'Google/Chrome/Application/chrome.exe'));
  let exe;for(const candidate of candidates){try{await stat(candidate);exe=candidate;break;}catch{}}
  if(!exe)throw new Error('Installed Chrome not found');
  const profile=path.join(root,'output/playwright',`viewer-profile-${randomUUID()}`);await mkdir(profile,{recursive:true});
  desktop=spawn(exe,[...browserArgs,`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
  let spawnError;desktop.on('error',e=>{spawnError=e;});
  const deadline=Date.now()+30000;let ready=false;
  while(Date.now()<deadline){if(spawnError)throw spawnError;if(desktop.exitCode!==null)throw new Error('Standard Chrome exited before CDP');try{const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,300));}
  if(!ready)throw new Error('Standard Chrome CDP readiness timeout');
 }else browserServer=await chromium.launchServer({channel:option('--channel','chrome'),host:'127.0.0.1',port,headless,args:browserArgs});
 const token=randomUUID(),base=`/smg-viewer/${token}`,expiresAt=Date.now()+minutes*60000;
 const metadata={schemaVersion:1,kind:'seemygame-e2e-viewer',runtime,resourcesOnly,browserConfig,browserArgs,connectionType:resourcesOnly?'resources':runtime==='tauri'||browserConfig==='standard'?'cdp':'playwright',machineFingerprint:machineFingerprint(),platform:os.platform(),cpuModel:os.cpus()[0]?.model,logicalProcessors:os.cpus().length,headless,session,...(resourcesOnly?{}:runtime==='tauri'||browserConfig==='standard'?{cdpEndpoint:`http://127.0.0.1:${port}`}:{wsEndpoint:browserServer.wsEndpoint()}),playwrightVersion:require('playwright/package.json').version,expiresAt};
 control=http.createServer((request,response)=>{
  response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type','application/json');
  if(request.method==='POST'&&request.url===base+'/shutdown'&&!request.headers.origin){response.end('{"stopping":true}');setImmediate(()=>void stop());return;}
  if(request.method!=='GET'){response.writeHead(405);response.end('{}');return;}
  if(request.url===base+'/metadata')response.end(JSON.stringify(metadata));
  else if(request.url===base+'/resources')response.end(JSON.stringify(resources.report()));
  else {response.writeHead(404);response.end('{}');}
 });
 await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(controlPort,'127.0.0.1',resolve);});
 timer=setTimeout(()=>void stop(),minutes*60000);timer.unref();
 process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
 browserServer?.on('close',()=>void stop());
 const readyMessage=JSON.stringify({kind:'seemygame-e2e-viewer-ready',controlEndpoint:`http://127.0.0.1:${controlPort}${base}`,browserPort:port,runtime,headless,expiresAt});
 if(readyPath){await mkdir(path.dirname(readyPath),{recursive:true});await writeFile(readyPath,readyMessage,{flag:'wx'});ownsReadyFile=true;}
 console.log(readyMessage);
}catch(error){console.error(error.message);process.exitCode=1;await stop();}
