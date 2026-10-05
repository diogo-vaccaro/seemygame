/** Bind tactical tools to a session's manager and transport. */
export function bindTacticalPingInput(canvas, {
  manager,
  signal,
  broadcast = () => {},
  getPeerId = () => 'local',
  getDisplayName = () => 'Jogador',
  getRole = () => 'viewer',
  canDraw = () => true
}) {
  manager.setCanvas(canvas);
  const resize = () => {
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth || 1280;
    const height = parent.clientHeight || 720;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  };
  resize();
  window.addEventListener('resize', resize, { signal });
  if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement);
    signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  }

  let mode = 'ping';
  let pointerId = null;
  let drawingLaser = false;
  const buttons = {
    ping: document.getElementById('ping-mode-btn'),
    danger: document.getElementById('danger-mode-btn'),
    laser: document.getElementById('laser-mode-btn')
  };
  const updateMode = nextMode => {
    mode = nextMode;
    for (const [name, button] of Object.entries(buttons)) {
      button?.classList.toggle('active', name === mode);
      button?.setAttribute('aria-pressed', String(name === mode));
    }
    canvas.style.cursor = 'crosshair';
  };
  for (const [name, button] of Object.entries(buttons)) {
    button?.addEventListener('click', () => updateMode(name), { signal });
  }
  updateMode(mode);

  const coordinates = event => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / (rect.height || 1)))
    };
  };
  const addLaserPoint = event => {
    const point = { ...coordinates(event), color: getRole() === 'host' ? '#10b981' : '#00ffff' };
    manager.addLaserPoint(point);
    broadcast({ type: 'TACTICAL_LASER', senderId: getPeerId() || 'local', point });
  };
  const stopDrawing = event => {
    if (pointerId === null || (event?.pointerId != null && event.pointerId !== pointerId)) return;
    const capturedPointer = pointerId;
    pointerId = null;
    if (drawingLaser) {
      drawingLaser = false;
      manager.stopLaserTrail('local');
      broadcast({ type: 'TACTICAL_LASER', action: 'stop', senderId: getPeerId() || 'local' });
    }
    if (canvas.hasPointerCapture?.(capturedPointer)) canvas.releasePointerCapture(capturedPointer);
  };
  canvas.addEventListener('pointerdown', event => {
    if (!canDraw() || pointerId !== null || (event.button !== 0 && event.button !== 2)) return;
    const hit = document.elementFromPoint?.(event.clientX, event.clientY);
    if (hit?.closest('.video-card-header, .card-controls, .card-btn, .reactions-dock, .bottom-control-dock, .facecam-overlay, .audio-unmute-overlay, button, header, nav, aside, input, select, textarea')) return;
    pointerId = event.pointerId ?? 0;
    canvas.setPointerCapture?.(pointerId);
    drawingLaser = mode === 'laser' || event.shiftKey || event.button === 2;
    if (drawingLaser) {
      event.preventDefault();
      manager.startLaserTrail({ color: getRole() === 'host' ? '#10b981' : '#00ffff' });
      addLaserPoint(event);
    } else {
      const ping = { ...coordinates(event), type: mode, senderName: getDisplayName() || 'Jogador' };
      manager.addPing(ping);
      broadcast({ type: 'TACTICAL_PING', ping });
    }
  }, { signal });
  canvas.addEventListener('pointermove', event => {
    if (!drawingLaser || pointerId === null || (event.pointerId != null && event.pointerId !== pointerId)) return;
    if (!canDraw()) { stopDrawing(); return; }
    addLaserPoint(event);
  }, { signal });
  // Window listeners also cover environments without pointer capture.
  window.addEventListener('pointerup', stopDrawing, { signal });
  window.addEventListener('pointercancel', stopDrawing, { signal });
  window.addEventListener('blur', () => stopDrawing(), { signal });
  canvas.addEventListener('lostpointercapture', stopDrawing, { signal });
  canvas.addEventListener('contextmenu', event => event.preventDefault(), { signal });
  signal.addEventListener('abort', () => stopDrawing(), { once: true });
}
