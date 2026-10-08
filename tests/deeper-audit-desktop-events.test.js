import { afterEach, expect, it, vi } from 'vitest';
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../js/desktop/ipc.js', () => ({ isDesktopApp: () => true, invokeDesktopCommand: ipc.invoke }));
import { listenNativeCapture, listenNativeCaptureBridge } from '../js/desktop/capture.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); ipc.invoke.mockReset(); });
it.each([['capture', listenNativeCapture], ['bridge', listenNativeCaptureBridge]])('releases transformed callback when %s cannot subscribe', async (_name, listen) => {
  const unregisterCallback = vi.fn();
  window.__TAURI_INTERNALS__ = { transformCallback: vi.fn(() => 123), unregisterCallback };
  ipc.invoke.mockRejectedValueOnce(new Error('listen unavailable'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await listen(() => {});
  expect(unregisterCallback).toHaveBeenCalledWith(123);
  delete window.__TAURI_INTERNALS__;
});
