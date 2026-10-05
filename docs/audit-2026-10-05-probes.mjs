import { mkdir, writeFile } from 'node:fs/promises';
import { WhiteboardManager } from '../js/whiteboard.js';

// Execute production functions; delay only the browser image decoder callback.
const report = { checks: [], limitations: ['Controlled canvas context and Image.onload; no real image decoding in these two probes.'] };
const manager = new WhiteboardManager();
manager.zoom = 2; manager.panX = 100; manager.panY = 50;
manager.remoteCursors.set('remote', { x: .25, y: .25, time: Date.now(), userName: 'Remote', color: '#06b6d4' });
const positions = [];
const context = new Proxy({ moveTo: (x, y) => positions.push({ x, y }), measureText: () => ({ width: 45 }) }, {
  get: (target, key) => key in target ? target[key] : () => {}, set: (target, key, value) => { target[key] = value; return true; }
});
manager.drawRemoteCursors(context, 1000, 800);
report.checks.push({ name: 'Remote cursor follows receiving board zoom and pan', passed: positions[0].x === 600 && positions[0].y === 450,
  expected: { x: 600, y: 450 }, observed: positions[0] });

const originalImage = globalThis.Image;
const images = [];
globalThis.Image = class { constructor() { this.naturalWidth = 120; this.naturalHeight = 80; images.push(this); } };
try {
  const m = new WhiteboardManager();
  const created = [];
  m.onElementCreated = e => created.push(e.type);
  m.addElement({ id: 'before', type: 'rectangle', startX: 1, startY: 1, endX: 20, endY: 20 });
  const pending = m.addImageFromDataUrl('data:image/png;base64,test-decoder-is-controlled');
  m.clear();
  const afterClear = m.elements.length;
  images[0].onload();
  await pending;
  report.checks.push({ name: 'Clear invalidates a pending image insertion', passed: m.elements.length === 0,
    afterClear, afterDecoderFinishes: m.elements.map(e => e.type), createdEvents: created });
  m.dispose();
} finally { globalThis.Image = originalImage; manager.dispose(); }

await mkdir(new URL('../output/', import.meta.url), { recursive: true });
report.status = report.checks.some(c => !c.passed) ? 'bugs-reproduced' : 'passed';
await writeFile(new URL('../output/audit-2026-10-05-probes.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
