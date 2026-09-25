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
import { createGamepadModel } from '../js/gamepad-model-builder.js';


async function exportGamepadGLB() {
  const model = createGamepadModel();
  const exporter = new GLTFExporter();

  return new Promise((resolve, reject) => {
    exporter.parse(
      model,
      (gltf) => {
        const outDir = path.resolve('css', 'assets');
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }
        const outFile = path.join(outDir, 'gamepad.glb');
        const buffer = Buffer.from(gltf);
        fs.writeFileSync(outFile, buffer);
        console.log(`[GLTFExporter] Sucesso: Gamepad 3D gerado em ${outFile} (${(buffer.length / 1024).toFixed(1)} KB)`);
        resolve(outFile);
      },
      (err) => {
        console.error('[GLTFExporter] Erro ao exportar GLB:', err);
        reject(err);
      },
      { binary: true }
    );
  });
}

exportGamepadGLB().catch(err => {
  console.error(err);
  process.exit(1);
});
