import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionContext } from '../js/core/session-context.js';
import { registerSessionFeatures } from '../js/plugins/session-composition.js';
import { tacticalPingManager } from '../js/ping.js';

describe('Tactical tools in current sessions', () => {
  let session, features, canvas, broadcast, role;
  const pointer = (target, type, options = {}) => target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, clientX: 600, clientY: 300, button: 0, ...options
  }));
  beforeEach(() => {
    document.body.innerHTML = `<main><canvas id="ping-canvas"></canvas></main>
      <button id="ping-mode-btn"></button><button id="danger-mode-btn"></button><button id="laser-mode-btn"></button>`;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(),
      arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(), fillText: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn()
    });
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(123);
    session = createSessionContext({ role: 'room' });
    broadcast = vi.fn(); role = 'viewer';
    features = registerSessionFeatures(session, {
      role: 'room', broadcastDataMessage: broadcast, getPeerId: () => 'alice',
      getDisplayName: () => 'Ana', getRole: () => role
    });
    canvas = document.getElementById('ping-canvas');
    canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 1000, height: 500 });
  });
  afterEach(async () => {
    await session.dispose(); vi.restoreAllMocks(); document.body.innerHTML = '';
  });

  it('clicks add and send ping/alert using the session manager and identity', () => {
    const legacy = vi.spyOn(tacticalPingManager, 'addPing');
    pointer(canvas, 'pointerdown'); pointer(window, 'pointerup');
    document.getElementById('danger-mode-btn').click();
    pointer(canvas, 'pointerdown'); pointer(window, 'pointerup');
    expect(features.ping.manager.pings.map(p => p.type)).toEqual(['ping', 'danger']);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'TACTICAL_PING', ping: { x: .5, y: .5, type: 'danger', senderName: 'Ana' } });
    expect(legacy).not.toHaveBeenCalled();
    expect(document.getElementById('danger-mode-btn').getAttribute('aria-pressed')).toBe('true');
  });

  it.each(['button', 'shift', 'right'])('starts, sends and stops a laser via %s', trigger => {
    if (trigger === 'button') document.getElementById('laser-mode-btn').click();
    pointer(canvas, 'pointerdown', { shiftKey: trigger === 'shift', button: trigger === 'right' ? 2 : 0 });
    pointer(canvas, 'pointermove', { clientX: 800 });
    expect(features.ping.manager.currentLaserTrail.points).toHaveLength(2);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'TACTICAL_LASER', senderId: 'alice', point: { x: .7, y: .5, color: '#00ffff' } });
    pointer(window, 'pointerup');
    expect(features.ping.manager.isDrawingLaser).toBe(false);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'TACTICAL_LASER', action: 'stop', senderId: 'alice' });
  });

  it('renders inbound ping and laser on the same canvas as local tools', () => {
    session.dispatcher.dispatch({ type: 'TACTICAL_PING', ping: { x: .2, y: .3 } }, { peer: 'bob' });
    session.dispatcher.dispatch({ type: 'TACTICAL_LASER', point: { x: .4, y: .5 } }, { peer: 'bob' });
    expect(features.ping.manager.canvas).toBe(canvas);
    expect(features.ping.manager.pings).toHaveLength(1);
    expect(features.ping.manager.activeLaserTrails.get('bob').points).toHaveLength(1);
  });

  it('rebinds without duplicate input listeners and cancels drawing on blur', () => {
    features.ping.bindCanvas(canvas);
    document.getElementById('laser-mode-btn').click();
    pointer(canvas, 'pointerdown');
    expect(broadcast).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('blur'));
    pointer(canvas, 'pointermove');
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(features.ping.manager.isDrawingLaser).toBe(false);
  });

  it('does not draw for a remote player whose mouse is routed to the game', () => {
    session.services = { coopController: { getCoopState: () => ({ isPlayer2: true }) } };
    pointer(canvas, 'pointerdown');
    expect(broadcast).not.toHaveBeenCalled();
    expect(features.ping.manager.pings).toHaveLength(0);
  });

  it('disposing stops the laser and removes local and network handlers', async () => {
    document.getElementById('laser-mode-btn').click(); pointer(canvas, 'pointerdown');
    await session.dispose();
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'stop' }));
    broadcast.mockClear();
    pointer(window, 'pointerup'); pointer(canvas, 'pointerdown'); pointer(canvas, 'pointermove');
    expect(broadcast).not.toHaveBeenCalled();
    expect(features.ping.manager.canvas).toBeNull();
  });
});
