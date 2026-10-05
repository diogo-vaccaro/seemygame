// Content diagnostic only. Readbacks/PNG deliberately perturb the pipeline;
// timings from this tool are never used as performance measurements.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from './harness/server.mjs';
import { createMotionFixture } from './fixtures/motion.mjs';
import { ensureDefaultDesktop } from './desktop-affinity.mjs';
import { launchSourceWindow } from './harness/source-window.mjs';
ensureDefaultDesktop();
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=path.join(root,'output/playwright','capture-content-'+new Date().toISOString().replace(/[:.]/g,'-'));
const gstRoot=path.join(root,'native-media/gstreamer');
const exe=path.join(gstRoot,'bin/gst-launch-1.0.exe');
const id=path.basename(output),report={id,status:'running',scope:'Content smoke, CLI capture and local readback; no network or performance conclusions',runs:[]};
let browser,server;
async function command(args) {
  const child=spawn(exe,['-e',...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PATH:path.join(gstRoot,'bin')+';'+process.env.PATH,GST_DEBUG:'*:2'}});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const timeout=setTimeout(()=>child.kill(),20000);
  try { const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});return {code,stdout,stderr}; }
  finally { clearTimeout(timeout); }
}
try {
  await mkdir(output,{recursive:true});
  server=await startAssetServer({root,fixtures:{'/fixtures/content.html':createMotionFixture('SMG Content '+id,431,60,{width:1920,height:1080}),'/fixtures/optical.mjs':await readFile(path.join(root,'tools/e2e/optical.mjs'),'utf8')}});
  const source=await launchSourceWindow(chromium,{profile:path.join(output,'source-profile'),url:server.origin+'/fixtures/content.html',args:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
  browser=source.browser;const page=source.page;report.windowEvidence=source.windowEvidence;
  await page.bringToFront();await page.waitForFunction(()=>window.__smgSourceStats.framesProduced>60);
  report.geometry=await page.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio}));
  await page.screenshot({path:path.join(output,'source.png')});
  const cases=['wgc','dxgi'].flatMap(api=>['capture','convert','roundtrip'].map(stage=>({api,stage,backend:'d3d11'})));
  cases.push({api:'dxgi',stage:'system-memory',backend:'d3d11'},{api:'dxgi',stage:'capture',backend:'d3d12'},{api:'wgc',stage:'capture',backend:'d3d12'},{api:'gdi',stage:'capture',backend:'gdi'});
  for(const {api,stage,backend} of cases) {
    const run={api,stage,backend};report.runs.push(run);
    const folder=path.join(output,backend+'-'+api+'-'+stage);await mkdir(folder,{recursive:true});
    const system=stage==='system-memory'||backend==='gdi';
    const args=backend==='gdi'?['gdiscreencapsrc','num-buffers=30','!','queue']:[backend+'screencapturesrc',`capture-api=${api}`,'monitor-index=0','num-buffers=30','show-cursor=false','!',system?'video/x-raw,format=BGRA':`video/x-raw(memory:${backend==='d3d12'?'D3D12':'D3D11'}Memory),format=BGRA`,'!','queue'];
    if(stage==='convert'||stage==='roundtrip')args.push('!','d3d11convert','!','video/x-raw(memory:D3D11Memory),format=NV12,width=1280,height=720');
    if(stage==='roundtrip')args.push('!','nvd3d11h264enc','tune=ultra-low-latency','zerolatency=true','bframes=0','!','h264parse','!','d3d11h264dec');
    if(!system)args.push('!',backend+'download');
    args.push('!','videoconvert','!','video/x-raw,format=RGB','!','pngenc','!','multifilesink',`location=${path.join(folder,'frame-%03d.png').replaceAll('\\','/')}`,'max-files=1');
    run.command=args;const result=await command(args);run.exitCode=result.code;
    await writeFile(path.join(folder,'gst.log'),result.stdout+'\n'+result.stderr);
    run.images=(await readdir(folder)).filter(file=>file.endsWith('.png')).map(file=>path.join(folder,file));
    if(run.images.length) {
      const bytes=(await readFile(run.images.at(-1))).toString('base64');
      run.content=await page.evaluate(async base64=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/png'}));const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let sum=0,nonBlack=0,n=0;for(let i=0;i<data.length;i+=256){sum+=(data[i]+data[i+1]+data[i+2])/3;if(Math.max(data[i],data[i+1],data[i+2])>3)nonBlack++;n++;}const {decodeOpticalMarker,MARKER_CONFIG}=await import('/fixtures/optical.mjs');const marker=decodeOpticalMarker(data,canvas.width,canvas.height,MARKER_CONFIG,[8,8*canvas.width/1920],431);const provenanceValid=!!marker&&window.__smgSourceStats.frameLog.some(frame=>frame.seq===marker.frameSeq&&(frame.timeMs>>>0)===marker.sourceTimeMs);return {width:canvas.width,height:canvas.height,meanLuminance:sum/n,nonBlackPercent:nonBlack/n*100,black:nonBlack===0,marker,provenanceValid};},bytes);
    }
    run.status=result.code===0&&run.images.length?(run.content.black?'black-content':run.content.provenanceValid?'captured':'wrong-or-missing-source-content'):'failed';console.log(JSON.stringify({api,stage,backend,status:run.status,content:run.content,images:run.images}));
  }
  report.status=report.runs.every(run=>run.status==='captured')?'completed-content-review-required':'completed-with-failures';
  if(report.status==='completed-with-failures')process.exitCode=1;
} catch(error) { report.status='failed';report.error=error.message;process.exitCode=1; }
finally { await browser?.close();await server?.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(output); }
