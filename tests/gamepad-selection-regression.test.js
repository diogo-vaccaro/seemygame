import { it, expect, vi, afterEach } from 'vitest';
import { createSessionContext } from '../js/core/session-context.js';
import { bindControllerLab } from '../js/controller-lab/index.js';
import { createCoopController } from '../js/coop/controller.js';
import { setupGamepadTesterModal } from '../js/coop/tester-controller.js';
import { detectGamepadType, getButtonDisplayLabel, pollGamepads } from '../js/coop/input.js';


const spy = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../js/gamepad-3d-viewer.js', () => ({ Gamepad3DViewer: class {
  init() { return true; } start() {} stop() {} destroy() {} updateInputs(data) { spy.update(data); }
} }));
const pad = (index, id, button) => ({ connected: true, index, id, mapping: 'standard', axes: [0,0,0,0], buttons: Array.from({length:17},(_,i)=>({pressed:i===button,value:i===button?1:0})) });
afterEach(() => { vi.restoreAllMocks(); delete navigator.getGamepads; document.body.innerHTML=''; });

it.each(['Xbox Wireless', 'DualSense', 'Nintendo Switch Pro Controller'])('passes %s device identity to the individual tester', async id => {
  let frame;
  vi.spyOn(globalThis,'requestAnimationFrame').mockImplementation(fn=>{frame=fn;return 1;});
  vi.spyOn(globalThis,'cancelAnimationFrame').mockImplementation(()=>{});
  Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[pad(0,id,0)]});
  document.body.innerHTML='<button id="open-gamepad-tester-btn"></button><div id="gamepad-tester-modal" style="display:none"><div id="gamepad-visual-stage"><canvas id="gamepad-3d-canvas"></canvas></div><select id="gamepad-select"></select></div>';
  const dispose=setupGamepadTesterModal({currentMappingPreset:'xbox',currentGamepadMapping:Array.from({length:17},(_,i)=>i),detectGamepadType,getButtonDisplayLabel,applyButtonMapping:b=>b,isTauriEnvironment:()=>false});
  try {
    await vi.dynamicImportSettled();document.getElementById('open-gamepad-tester-btn').click();frame();
    const sent=spy.update.mock.calls.at(-1)[0];
    expect(sent.connected).toBe(true);expect(sent.device).toBe(id); expect(sent.index).toBe(0);
  } finally { dispose(); }
});

it('handles sparse slots, disconnects and reconnection without switching controllers', () => {
  let pads = [null, pad(1, 'DualSense', 1)];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads });
  vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
  const connection = { send: vi.fn() };
  const ports = {
    isPlayer2: true, activeDataConn: connection, activeHostCapabilities: { gamepad: true },
    myAssignedSlot: 2, lastGamepadState: null, pollGamepads: vi.fn(),
    applyButtonMapping: buttons => buttons, applyRadialDeadzone: (x, y) => ({ x, y })
  };
  pollGamepads(ports, 12345); // The RAF timestamp must never select a device.
  expect(connection.send.mock.calls.at(-1)[0].state.buttons[1]).toBe(true);
  ports.selectedGamepadIndex = 1;
  pads = [pad(0, 'Xbox Wireless', 0), null];
  pollGamepads(ports);
  expect(connection.send.mock.calls.at(-1)[0].state.buttons.every(button => !button)).toBe(true);
  const count = connection.send.mock.calls.length;
  pollGamepads(ports);
  expect(connection.send).toHaveBeenCalledTimes(count);
  pads[1] = pad(1, 'DualSense', 1);
  pollGamepads(ports);
  expect(connection.send.mock.calls.at(-1)[0].state.buttons[1]).toBe(true);
  expect(connection.send.mock.calls.at(-1)[0].state.buttons[0]).toBe(false);
  ports.selectedGamepadIndex = 0;
  pollGamepads(ports);
  expect(connection.send.mock.calls.at(-1)[0].state.buttons[0]).toBe(true);
});

it('keeps polling while awaiting host gamepad capabilities', () => {
  vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(42);
  const callback = vi.fn();
  const ports = { isPlayer2: true, activeDataConn: {}, activeHostCapabilities: { gamepad: false }, pollGamepads: callback };
  pollGamepads(ports);
  expect(requestAnimationFrame).toHaveBeenCalledWith(callback);
  expect(ports.gamepadLoopId).toBe(42);
});

it('keeps the selected physical gamepad after leaving the lab', async () => {
  const frames=new Map();let next=1;
  vi.spyOn(globalThis,'requestAnimationFrame').mockImplementation(fn=>{const id=next++;frames.set(id,fn);return id;});
  vi.spyOn(globalThis,'cancelAnimationFrame').mockImplementation(id=>frames.delete(id));
  Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[pad(0,'Xbox Wireless',0),pad(1,'DualSense',1)]});
  const session=createSessionContext();session.getPeerId=()=> 'guest';
  const controller=createCoopController(),connection={peer:'host',open:true,send:vi.fn()};
  const lab=bindControllerLab(session,{getPeerId:()=> 'guest',getConnections:()=>[],isAuthorizedPeer:()=>true,coopController:controller});
  try {
    lab.open();await vi.dynamicImportSettled();
    const runLab=(time)=>[...frames.values()].at(-1)(time);
    runLab(100);
    const select=document.querySelector('.controller-lab-selector:not([hidden]) select');
    select.value='1';select.dispatchEvent(new Event('change'));runLab(200);
    expect(lab.ownPlayer().state.device).toBe('DualSense');expect(lab.ownPlayer().state.index).toBe(1);
    lab.close();
    const card=document.createElement('div');document.body.append(card);
    controller.requestCoopControl('host',connection);
    controller.handleViewerCoopMessage({type:'COOP_CAPABILITIES',gamepad:true},'host',card);
    controller.handleViewerCoopMessage({type:'COOP_RESPONSE',approved:true,slot:1},'host',card);
    [...frames.values()].at(-1)(300);
    const input=connection.send.mock.calls.map(([data])=>data).findLast(data=>data.type==='INPUT_GAMEPAD');
    expect(input.state.buttons[0]).toBe(false);expect(input.state.buttons[1]).toBe(true);
    lab.open();
    runLab(400);
    expect(lab.ownPlayer().state.index).toBe(1);
    expect(controller.getSelectedGamepadIndex()).toBe(1);
  } finally { controller.dispose();await session.disposeAsync(); }
});
