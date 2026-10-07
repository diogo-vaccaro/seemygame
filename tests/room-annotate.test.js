import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnnotateManager } from '../js/room/annotate.js';

describe('AnnotateManager (Telestrator)', () => {
  let manager;
  let container;
  let video;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    video = document.createElement('video');
    container.appendChild(video);
    document.body.appendChild(container);

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      strokeRect: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      scale: vi.fn(),
    });

    manager = new AnnotateManager();
  });

  afterEach(() => {
    manager.detach();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches canvas overlay correctly to container', () => {
    manager.attach(container, video);
    expect(manager.canvas).not.toBeNull();
    expect(container.querySelector('.annotate-overlay-canvas')).toBe(manager.canvas);
    expect(manager.isActive).toBe(true);
  });

  it('records pen stroke on pointer events and calls broadcast', () => {
    const broadcast = vi.fn();
    manager.setBroadcast(broadcast);
    manager.attach(container, video);

    const canvas = manager.canvas;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });

    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200 }));
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 200, clientY: 200 }));

    expect(manager.strokes.length).toBe(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ANNOTATE_DRAW',
        stroke: expect.objectContaining({
          tool: 'pen',
          points: expect.any(Array)
        })
      })
    );
  });

  it('receives remote drawing message and updates strokes', () => {
    manager.attach(container, video);
    const mockStroke = {
      id: 'remote-1',
      tool: 'arrow',
      color: '#ff4757',
      width: 4,
      shapeStart: { x: 0.1, y: 0.1 },
      shapeEnd: { x: 0.5, y: 0.5 }
    };

    manager.handleRemoteMessage({
      type: 'ANNOTATE_DRAW',
      stroke: mockStroke
    });

    expect(manager.strokes).toContain(mockStroke);
  });

  it('clears strokes on clear() and broadcasts ANNOTATE_CLEAR', () => {
    const broadcast = vi.fn();
    manager.setBroadcast(broadcast);
    manager.attach(container, video);

    manager.strokes.push({ id: 's1' });
    manager.clear(true);

    expect(manager.strokes.length).toBe(0);
    expect(broadcast).toHaveBeenCalledWith({ type: 'ANNOTATE_CLEAR' });
  });

  it('creates toolbar and updates active tool/color on click', () => {
    manager.attach(container, video);
    const toolbar = manager.createToolbar(container);

    const arrowBtn = toolbar.querySelector('[data-tool="arrow"]');
    arrowBtn.click();
    expect(manager.tool).toBe('arrow');

    const colorBtn = toolbar.querySelector('[data-color="#2ed573"]');
    colorBtn.click();
    expect(manager.color).toBe('#2ed573');
  });

  it('auto-clears strokes after specified timeout when autoClear is enabled', () => {
    manager.setAutoClear(true, 3000);
    manager.attach(container, video);

    const canvas = manager.canvas;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });

    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50, button: 0 }));
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 50, clientY: 50 }));

    expect(manager.strokes.length).toBe(1);
    vi.advanceTimersByTime(3001);
    expect(manager.strokes.length).toBe(0);
  });
});
