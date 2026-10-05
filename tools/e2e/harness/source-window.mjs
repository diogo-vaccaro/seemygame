// A single owned Chrome window, with an isolated profile. A second/incognito
// window can inherit different bounds and need not become the visible source.
export async function launchSourceWindow(chromium, {profile, url, args = []}) {
  const context = await chromium.launchPersistentContext(profile, {
    channel:'chrome', headless:false, viewport:null, chromiumSandbox:true,
    args:[...args,'--window-position=0,0','--window-size=1920,1080','--start-fullscreen']
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url);
    const cdp = await context.newCDPSession(page);
    const {windowId} = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{left:0,top:0,width:1920,height:1080}});
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'fullscreen'}});
    // DOM focus/visibility must describe the real window, not an emulated focus.
    await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    await page.bringToFront();
    await page.waitForTimeout(5000); // Let Chrome's fullscreen notification clear.
    const evidence = await cdp.send('Browser.getWindowBounds',{windowId});
    await cdp.detach();
    return {context,page,browser:context.browser(),windowEvidence:{windowId,...evidence}};
  } catch(error) {await context.close();throw error;}
}
