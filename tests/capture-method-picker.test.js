import { afterEach, expect, it, vi } from 'vitest';
import { SessionContext } from '../js/core/session-context.js';
import { bindSourcePicker } from '../js/capture/source-picker.js';

afterEach(() => { delete window.__TAURI_INTERNALS__; vi.restoreAllMocks(); });

it('DXGI bloqueia janelas, permite o monitor e reabilita janelas ao escolher WGC', async () => {
  window.__TAURI_INTERNALS__ = { invoke: vi.fn(async command => command === 'list_capture_sources' ? [
    { source_id: 'window-id', source_type: 'window', title: 'Jogo' },
    { source_id: 'monitor-id', source_type: 'monitor', title: 'Monitor' }
  ] : []) };
  document.body.innerHTML = '<select id="capture-method-select"><option value="dxgi">DXGI</option><option value="wgc">WGC</option></select><div id="desktop-picker-modal"><div id="desktop-windows-list"></div></div>';
  const session = new SessionContext(), start = vi.fn().mockResolvedValue({});
  try {
    const picker = bindSourcePicker(session, { start, stop: vi.fn(), isStreaming: () => false, showToast: vi.fn() });
    await picker.refresh();
    const [windowButton, monitorButton] = document.querySelectorAll('.window-item');
    expect(windowButton.disabled).toBe(true);
    windowButton.click(); expect(start).not.toHaveBeenCalled();
    monitorButton.click();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'monitor-id', sourceType: 'monitor', captureApi: 'dxgi' }));
    const method = document.getElementById('capture-method-select');
    method.value = 'wgc'; method.dispatchEvent(new Event('change'));
    expect(windowButton.disabled).toBe(false);
    windowButton.click();
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ sourceId: 'window-id', sourceType: 'window', captureApi: 'wgc' }));
  } finally { await session.dispose(); }
});
