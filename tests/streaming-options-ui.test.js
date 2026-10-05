import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionContext } from '../js/core/session-context.js';
import { bindStreamingOptions, syncStreamingOptions } from '../js/streaming/options-ui.js';
import { bindCaptureSettings, readCaptureSettings } from '../js/capture/settings.js';
const template = readFileSync('templates/streaming-options/default.html', 'utf8');
const caps = { supports_h264: true, supports_hevc: true, supports_av1: true, supports_cpu_h264: true, supports_nvenc_h264: true, supports_mf_h264: true, supports_d3d12: true };
let session;
const select = id => document.getElementById(id);
const change = (id, value) => { select(id).value = value; select(id).dispatchEvent(new Event('change', { bubbles: true })); };
beforeEach(() => { document.body.innerHTML = template; localStorage.clear(); session = new SessionContext(); });
afterEach(async () => { await session.dispose(); vi.unstubAllGlobals(); localStorage.clear(); });

it('mantém as quatro categorias visíveis na web e explica os campos controlados pelo browser', () => {
  syncStreamingOptions({ desktop: false });
  expect(select('h264-encoder-select').disabled).toBe(true);
  expect(select('capture-backend-select').disabled).toBe(true);
  expect(select('capture-method-select').disabled).toBe(true);
  expect(select('h264-encoder-note').textContent).toContain('não permite forçar');
  expect(select('capture-backend-note').textContent).toContain('getDisplayMedia');
  expect(select('capture-method-note').textContent).toContain('getDisplayMedia');
});
it('bloqueia D3D12 com MF/CPU e HEVC/AV1, sem oferecer combinações ainda não integradas', () => {
  for (const [codec, encoder] of [['h264', 'mf'], ['h264', 'cpu'], ['hevc', 'mf'], ['av1', 'cpu']]) {
    select('video-codec-select').value = codec; select('h264-encoder-select').value = encoder; select('capture-backend-select').value = 'd3d12';
    syncStreamingOptions({ desktop: true, capabilities: caps });
    expect(select('capture-backend-select').querySelector('[value=d3d12]').disabled).toBe(true);
    expect(select('capture-backend-select').value).toBe('auto');
  }
  select('video-codec-select').value = 'h264'; select('h264-encoder-select').value = 'nvenc';
  syncStreamingOptions({ desktop: true, capabilities: caps });
  expect(select('capture-backend-select').querySelector('[value=d3d12]').disabled).toBe(false);
});
it('usa capacidades reais para impedir NVENC/D3D12 ausentes, mantendo Media Foundation disponível', () => {
  select('video-codec-select').value = 'h264';
  syncStreamingOptions({ desktop: true, capabilities: { ...caps, supports_nvenc_h264: false, supports_d3d12: false } });
  expect(select('h264-encoder-select').querySelector('[value=nvenc]').disabled).toBe(true);
  expect(select('h264-encoder-select').querySelector('[value=mf]').disabled).toBe(false);
  expect(select('capture-backend-select').querySelector('[value=d3d12]').disabled).toBe(true);
});
it('identifica MF para HEVC e SVT por CPU para AV1, e não oferece VP8/VP9 na captura nativa', () => {
  select('video-codec-select').value = 'hevc'; syncStreamingOptions({ desktop: true, capabilities: caps });
  expect(select('h264-encoder-note').textContent).toContain('Media Foundation');
  expect(select('h264-encoder-select').querySelector('[value=nvenc]').disabled).toBe(true);
  expect(select('h264-encoder-select').querySelector('[value=cpu]').disabled).toBe(true);
  expect(select('video-codec-select').querySelector('[value=vp8]').disabled).toBe(true);
  select('video-codec-select').value = 'av1'; syncStreamingOptions({ desktop: true, capabilities: caps });
  expect(select('h264-encoder-note').textContent).toContain('SVT-AV1');
  expect(select('h264-encoder-select').querySelector('[value=cpu]').disabled).toBe(false);
});
it('restaura e persiste codec/encoder/API separados e os envia nas configurações de captura', async () => {
  localStorage.setItem('seemygame_video_codec', 'h264'); localStorage.setItem('seemygame_h264_encoder', 'nvenc'); localStorage.setItem('seemygame_capture_backend', 'd3d12');
  bindStreamingOptions(session, { desktop: true, loadCapabilities: async () => caps });
  await vi.waitFor(() => expect(select('capture-backend-select').value).toBe('d3d12'));
  expect(readCaptureSettings()).toMatchObject({ videoCodec: 'h264', h264Encoder: 'nvenc', captureBackend: 'd3d12' });
  change('capture-backend-select', 'd3d11');
  expect(localStorage.getItem('seemygame_capture_backend')).toBe('d3d11');
});
it('troca pendente de encoder/API não reconfigura o worker e não vaza para uma alteração de bitrate', async () => {
  document.body.insertAdjacentHTML('beforeend', '<input id="bitrate-slider" value="4500">');
  const provider = { session: { sessionId: 'live', videoCodec: 'h264', h264Encoder: 'nvenc', captureBackend: 'd3d12' }, requestedSettings: { h264Encoder: 'auto', captureBackend: 'auto' }, reconfigure: vi.fn().mockResolvedValue({}) };
  const toast = vi.fn(); bindCaptureSettings(session, () => provider, toast);
  change('h264-encoder-select', 'cpu'); change('capture-backend-select', 'd3d11'); change('capture-method-select', 'dxgi');
  expect(provider.reconfigure).not.toHaveBeenCalled(); expect(toast).toHaveBeenCalledTimes(3);
  change('bitrate-slider', '5000');
  await vi.waitFor(() => expect(provider.reconfigure).toHaveBeenCalledWith(expect.objectContaining({ bitrateKbps: 5000, h264Encoder: 'auto', captureBackend: 'auto', captureApi: null })));
});
it('persiste DXGI independentemente da API gráfica e esclarece o compartilhamento do monitor', async () => {
  localStorage.setItem('seemygame_capture_method', 'dxgi');
  localStorage.setItem('seemygame_capture_backend', 'd3d11');
  bindStreamingOptions(session, { desktop: true, loadCapabilities: async () => caps });
  await vi.waitFor(() => expect(select('capture-method-select').value).toBe('dxgi'));
  expect(readCaptureSettings()).toMatchObject({ captureApi: 'dxgi', captureBackend: 'd3d11' });
  expect(select('capture-method-note').textContent).toContain('tudo que aparecer');
  change('capture-backend-select', 'd3d12');
  expect(select('capture-method-select').value).toBe('dxgi');
  change('capture-method-select', 'wgc');
  expect(localStorage.getItem('seemygame_capture_method')).toBe('wgc');
  expect(select('capture-backend-select').value).toBe('d3d12');
});
it('preserva o método ativo ao reconfigurar bitrate com uma preferência diferente pendente', async () => {
  document.body.insertAdjacentHTML('beforeend', '<input id="bitrate-slider" value="4500">');
  const provider = { session: { sessionId: 'live', captureApi: 'dxgi' }, requestedSettings: { captureApi: 'dxgi' }, reconfigure: vi.fn().mockResolvedValue({}) };
  bindCaptureSettings(session, () => provider, vi.fn());
  change('capture-method-select', 'auto');
  change('bitrate-slider', '5000');
  await vi.waitFor(() => expect(provider.reconfigure).toHaveBeenCalledWith(expect.objectContaining({ captureApi: 'dxgi', bitrateKbps: 5000 })));
});
it('ajuda abre com foco, fecha com Escape e remove listeners ao encerrar a sessão', async () => {
  bindStreamingOptions(session, { desktop: false });
  const button = document.querySelector('[data-streaming-help="encoder-help"]');
  button.focus(); expect(select('encoder-help').hidden).toBe(false); expect(button.getAttribute('aria-expanded')).toBe('true');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(select('encoder-help').hidden).toBe(true);
  await session.dispose(); button.blur(); button.focus(); expect(select('encoder-help').hidden).toBe(true);
});
