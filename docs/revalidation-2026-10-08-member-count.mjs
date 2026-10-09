import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../tools/e2e/harness/server.mjs';
import { startSignalingServer } from '../tools/e2e/harness/signaling.mjs';
import { launchTestBrowser, prepareSessionContext } from '../tools/e2e/harness/browser.mjs';
import { waitForAsync } from '../tools/e2e/wait.mjs';
const server = await startAssetServer({ root: fileURLToPath(new URL('../', import.meta.url)) });
const signaling = await startSignalingServer();
let browser;
const report = {};
try {
  browser = await launchTestBrowser();
  const hostContext = await prepareSessionContext(browser, signaling);
  await hostContext.addInitScript(() => localStorage.setItem('seemygame_dir_publish_audit-member-count', 'true'));
  const host = await hostContext.newPage();
  const guest = await (await prepareSessionContext(browser, signaling)).newPage();
  for (const [page, name] of [[host, 'Host'], [guest, 'Guest']]) {
    await page.goto(server.origin + '/room.html?room=audit-member-count');
    await page.locator('#green-room-user-name').fill(name);
    await page.locator('#green-room-join-btn').click();
    await waitForAsync(() => page.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.roomManager?.isInRoom), { timeout: 25000 });
  }
  await waitForAsync(() => host.evaluate(async () => (await import('/js/entries/room-entry.js')).roomState.roomManager.members.size === 2), { timeout: 25000 });
  report.state = await host.evaluate(async () => {
    const r = (await import('/js/entries/room-entry.js')).roomState;
    await r.publisher.sendHeartbeat();
    return { actualMembers: r.roomManager.members.size, publisherMembers: r.publisher.roomInfo.memberCount };
  });
  report.directory = await (await fetch(server.origin + '/api/rooms')).json();
  assert.equal(report.state.actualMembers, 2);
  assert.equal(report.state.publisherMembers, 2);
  assert.equal(report.directory.rooms.find(r => r.id === 'audit-member-count').memberCount, 2);
  report.status = 'member-count-fixed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  await writeFile(new URL('../output/revalidation-2026-10-08-member-count.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser?.close(); await signaling.close(); await server.close();
}
