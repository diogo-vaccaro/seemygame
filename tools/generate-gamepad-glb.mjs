import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

// Polyfill FileReader for Node.js
class NodeFileReader {
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    if (this.onloadend) this.onloadend();
  }
}
globalThis.FileReader = NodeFileReader;

import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createGamepadModel, createXboxGamepadModel, createSwitchGamepadModel } from '../js/gamepad-model-builder.js';

async function exportSingleModel(model, filename) {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      model,
      (gltf) => {
        const outDir = path.resolve('css', 'assets');
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }
        const outFile = path.join(outDir, filename);
        const buffer = Buffer.from(gltf);
        fs.writeFileSync(outFile, buffer);

        const distDir = path.resolve('dist', 'css', 'assets');
        if (!fs.existsSync(distDir)) {
          fs.mkdirSync(distDir, { recursive: true });
        }
        const distFile = path.join(distDir, filename);
        fs.writeFileSync(distFile, buffer);

        console.log(`[GLTFExporter] Sucesso: Gamepad 3D gerado em ${outFile} e ${distFile} (${(buffer.length / 1024).toFixed(1)} KB)`);
        resolve({ outFile, distFile });
      },
      (err) => {
        console.error(`[GLTFExporter] Erro ao exportar GLB (${filename}):`, err);
        reject(err);
      },
      { binary: true }
    );
  });
}

export async function exportAllGamepadGLBs() {
  const models = [
    { model: createGamepadModel('playstation'), filename: 'gamepad.glb' },
    { model: createXboxGamepadModel(), filename: 'gamepad-xbox.glb' },
    { model: createSwitchGamepadModel(), filename: 'gamepad-switch.glb' }
  ];

  const results = [];
  for (const { model, filename } of models) {
    const res = await exportSingleModel(model, filename);
    results.push(res);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('tools/generate-gamepad-glb.mjs')) {
  exportAllGamepadGLBs().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
