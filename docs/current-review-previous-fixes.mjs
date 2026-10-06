import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';

// Run the historical assertions unchanged, adapting only the Streamer/Viewer
// whiteboard launcher selector. Keep the original test file intact for review.
const source = await readFile(new URL('../tests/e2e-third-audit-fixes.mjs', import.meta.url), 'utf8');
const oldSelector = "for (const p of relayPages) await p.locator('#dock-whiteboard-btn').click();";
const needsAdaptation = source.includes(oldSelector);
if (needsAdaptation) assert.equal(source.split(oldSelector).length, 2);
else assert.ok(source.includes("for (const p of relayPages) await p.locator('#toggle-whiteboard-btn').click();"));
const temporary = new URL('../tests/.current-review-third-audit.mjs', import.meta.url);
await writeFile(temporary, source.replace(oldSelector,
  "for (const p of relayPages) await p.locator('#toggle-whiteboard-btn').click();"), { flag: 'wx' });
try {
  console.log(needsAdaptation ? 'Review adaptation: Streamer/Viewer use #toggle-whiteboard-btn; original file preserved.' : 'Current test already uses the correct Streamer/Viewer selector.');
  await import(temporary.href);
} finally {
  await unlink(temporary);
}
