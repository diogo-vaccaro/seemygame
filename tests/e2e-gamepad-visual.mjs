import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { launchTestBrowser } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';

const captureOnly = process.argv.includes('--capture-only');
const label = captureOnly ? 'before' : 'after';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/gamepad-model/', import.meta.url));
await fs.mkdir(output, { recursive: true });
const fixture = `<!doctype html><html lang="pt-BR"><head><base href="/"><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/js/vendor/three.module.js","three/addons/":"/js/vendor/"}}</script>
<style>body{margin:0;padding:24px;background:#0c1020;color:#e7edf9;font:16px system-ui}h1{font-size:22px;margin:0 0 20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}article{background:#171d30;border:1px solid #38445b;border-radius:12px;min-width:0}h2{font-size:14px;margin:16px 20px}.model{height:370px;width:100%}canvas{width:100%;height:100%;display:block}</style></head><body>
<h1>Controle 3D · geometria e resposta aos inputs</h1><div class="grid">
${['playstation','xbox','nintendo'].flatMap(type=>['Procedural · repouso','GLB · repouso','Procedural · inputs ativos','GLB · inputs ativos'].map(title=>type+' · '+title)).map((title,i)=>`<article><h2>${title}</h2><div class="model"><canvas id="model-${i}"></canvas></div></article>`).join('')}
</div><script type="module">
import * as THREE from 'three';
import { Gamepad3DViewer } from '/js/gamepad-3d-viewer.js';
window.__viewers = Array.from({length:12},(_,i)=>{
  const canvas=document.getElementById('model-'+i);
  const viewer=new Gamepad3DViewer({gamepadType:['playstation','xbox','nintendo'][Math.floor(i/4)],container:canvas.parentElement,canvas,enableMouseTracking:false,fitToContainer:true,...(i%2===0?{modelUrl:null}:{})});
  if(i%2===0) viewer.modelUrl=null;
  viewer.init(); viewer.start(); return viewer;
});
window.__applyInputs=()=>window.__viewers.forEach((viewer,i)=>viewer.updateInputs({connected:true,axes:i%4>=2?[.7,-.5,-.6,.6]:[0,0,0,0],buttons:Array.from({length:17},()=>i%4>=2?1:0)}));
window.__verifySurfaces=()=>window.__viewers.map(viewer=>{
  viewer.controllerGroup.updateMatrixWorld(true);
  const root=viewer.controllerGroup.children[0];
  const shell=root.getObjectByName('Body_Shell');
  const hidden=[];
  const cameraOccluded=[];
  for(const name of ['Button_A','Button_B','Button_X','Button_Y','Button_Back','Button_Start','Button_Guide','Dpad_Up','Dpad_Down','Dpad_Left','Dpad_Right']){
    const part=root.getObjectByName(name); const world=part.getWorldPosition(new THREE.Vector3());
    const direction=new THREE.Vector3(0,-1,0).transformDirection(root.matrixWorld);
    const ray=new THREE.Raycaster(world.clone().addScaledVector(direction,-3),direction);
    const hits=ray.intersectObjects([shell,part],true);
    if(!hits.length || hits[0].object===shell) hidden.push(name);
    const inverse=part.matrixWorld.clone().invert(); const box=new THREE.Box3();
    part.traverse(mesh=>{
      if(!mesh.geometry) return; mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox.clone().applyMatrix4(inverse.clone().multiply(mesh.matrixWorld)));
    });
    const top=box.getCenter(new THREE.Vector3()); top.y=box.max.y;
    top.applyMatrix4(part.matrixWorld);
    const origin=viewer.camera.getWorldPosition(new THREE.Vector3());
    const cameraRay=new THREE.Raycaster(origin,top.clone().sub(origin).normalize());
    const cameraHit=cameraRay.intersectObject(root,true)[0];
    let hitPart=cameraHit?.object;
    while(hitPart && hitPart!==part) hitPart=hitPart.parent;
    if(!hitPart) cameraOccluded.push(name);
  }
  return {type:viewer.gamepadType,source:viewer.modelSource,hidden,cameraOccluded};
});
</script></body></html>`;
const server = await startAssetServer({ root, fixtures: { '/fixtures/controller-model.html': fixture } });
let browser;
const errors=[];
try {
  browser=await launchTestBrowser(); const page=await browser.newPage({viewport:{width:1260,height:2800}});
  page.on('pageerror', error=>errors.push(error.message));
  await page.goto(server.origin+'/fixtures/controller-model.html');
  await waitForAsync(()=>page.evaluate(()=>window.__viewers?.every(viewer=>viewer.isInitialized)));
  await waitForAsync(()=>page.evaluate(()=>window.__viewers.every((v,i)=>i%2===0 || v.modelSource==='glb')));
  await page.evaluate(()=>window.__applyInputs());
  await page.screenshot({path:output+'/'+label+'.png'});
  if (!captureOnly) {
    const surfaces=await page.evaluate(()=>window.__verifySurfaces());
    assert.deepEqual(surfaces.map(state=>state.source),Array.from({length:12},(_,i)=>i%2?'glb':'procedural')); await fs.writeFile(output+'/surfaces.json',JSON.stringify(surfaces,null,2)); console.log(JSON.stringify(surfaces));
    surfaces.forEach(state=>assert.deepEqual(state.hidden,[],`Peças encobertas em ${state.source}`));
    surfaces.forEach(state=>assert.deepEqual(state.cameraOccluded,[],`Peças obstruídas na câmera em ${state.source}`));
    await page.evaluate(()=>window.__viewers.forEach(viewer=>viewer.updateInputs({connected:true,axes:[0,0,0,0],buttons:Array(17).fill(0)})));
    await page.screenshot({path:output+'/released.png'});
    assert.deepEqual(errors,[]);
    await fs.writeFile(output+'/report.json',JSON.stringify({surfaces,pageErrors:errors,timestamp:new Date().toISOString()},null,2));
    console.log('PASS GLB e procedural: botões/direcional visíveis em repouso e pressionados; inputs e renderização reais');
  }
} finally { await browser?.close(); await server.close(); }
