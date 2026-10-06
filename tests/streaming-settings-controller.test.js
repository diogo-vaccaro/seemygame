import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { SessionContext } from '../js/core/session-context.js';
import { bindStreamingQuality } from '../js/streaming/settings-controller.js';
import { bindCaptureSettings } from '../js/capture/settings.js';
import { BrowserCaptureProvider } from '../js/capture.js';
import { videoScaleForProfile } from '../js/streaming/quality.js';
import { mutateVideoSender, getSenderParameterStatus } from '../js/streaming/sender-parameters.js';
import { safeSample } from '../js/stats/diagnostic.js';
import { createStatsHud, renderStatsHud } from '../js/stats/hud.js';

let session, state, track, sender, stream, provider, onSettings, showToast;
const change = (id, value) => { const element = document.getElementById(id); element.value = value; element.dispatchEvent(new Event('change')); };
beforeEach(() => {
 document.body.innerHTML = '<select id="quality-preset"><option value="balanced">1080p</option><option value="ultra">720p</option></select><input id="bitrate-slider" value="7500">' + readFileSync('templates/streaming-options/default.html', 'utf8');
 session = new SessionContext();
 state = { encodings: [{ scaleResolutionDownBy: 1.5 }] };
 track = { kind: 'video', getSettings: () => ({ width: 1920, height: 1080 }), applyConstraints: vi.fn().mockRejectedValue(new Error('constraints refused')) };
 sender = { track, getParameters: () => structuredClone(state), setParameters: vi.fn(async p => { state = structuredClone(p); }) };
 stream = { getVideoTracks: () => [track] }; provider = null;
 onSettings = vi.fn(); showToast = vi.fn();
 bindStreamingQuality(session, { getStream: () => stream, getCalls: () => [{ peerConnection: { getSenders: () => [sender] } }], getProvider: () => provider, onSettings, showToast });
});
afterEach(async () => { await session.dispose(); document.body.innerHTML = ''; });

it('usa o SessionContext real para trocar perfil e mantém 720p se a fonte recusar constraints', async () => {
 change('quality-preset', 'ultra');
 await vi.waitFor(() => expect(sender.setParameters).toHaveBeenCalled());
 expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ height: { ideal: 720, max: 720 } }));
 expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ height: 720, bitrateKbps: 4500 }));
 expect(state.encodings[0]).toMatchObject({ scaleResolutionDownBy: 1.5, maxBitrate: 4500000, maxFramerate: 60 });
});
it('calcula escala pela track efetiva depois de constraints aceitas', async () => {
 track.applyConstraints.mockImplementation(async () => { track.getSettings = () => ({ width: 1280, height: 720 }); });
 change('quality-preset', 'ultra');
 await vi.waitFor(() => expect(state.encodings[0].maxBitrate).toBe(4500000));
 expect(state.encodings[0].scaleResolutionDownBy).toBe(1);
});
it('uma sessão real do BrowserCaptureProvider mantém constraints e escala web, sem reconfiguração nativa', async () => {
 provider = new BrowserCaptureProvider({ mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) } });
 await provider.start();
 expect(provider.session.provider).toBe('browser');
 bindCaptureSettings(session, () => provider, showToast);
 change('quality-preset', 'ultra');
 await vi.waitFor(() => expect(state.encodings[0].maxBitrate).toBe(4500000));
 expect(track.applyConstraints).toHaveBeenCalledOnce();
 expect(state.encodings[0].scaleResolutionDownBy).toBe(1.5);
 change('bitrate-slider', '5000');
 await vi.waitFor(() => expect(state.encodings[0].maxBitrate).toBe(5000000));
 expect(state.encodings[0].scaleResolutionDownBy).toBe(1.5);
 expect(showToast.mock.calls.filter(([, type]) => type === 'error')).toEqual([]);
});
it('bitrate e adaptação atualizam o sender sem redimensionar nem reiniciar a captura nativa', async () => {
 provider = { session: { provider: 'native', sessionId: 'live' }, reconfigure: vi.fn() };
 bindCaptureSettings(session, () => provider, showToast);
 change('quality-preset', 'ultra');
 await vi.waitFor(() => expect(onSettings).toHaveBeenCalled());
 provider.reconfigure.mockClear(); sender.setParameters.mockClear();
 change('degradation-preference-select', 'balanced');
 await vi.waitFor(() => expect(state.degradationPreference).toBe('balanced'));
 expect(provider.reconfigure).not.toHaveBeenCalled();
 expect(track.applyConstraints).not.toHaveBeenCalled();
 expect(state.encodings[0].scaleResolutionDownBy).toBe(1);
 provider = null;
 change('bitrate-slider', '5000');
 await vi.waitFor(() => expect(state.encodings[0].maxBitrate).toBe(5000000));
 expect(track.applyConstraints).not.toHaveBeenCalled();
 expect(state.encodings[0].scaleResolutionDownBy).toBe(1.5);
});
it('troca de codec avisa sobre reinício e não altera conexões ativas', () => {
 change('video-codec-select', 'vp8');
 expect(showToast).toHaveBeenCalledWith(expect.stringContaining('reiniciar'), 'info');
 expect(sender.setParameters).not.toHaveBeenCalled();
});
it('não aplica settings a uma sessão encerrada enquanto constraints estão pendentes', async () => {
 let resolve; track.applyConstraints.mockImplementation(() => new Promise(r => { resolve = r; }));
 change('quality-preset', 'ultra');
 await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
 session.dispose(); resolve(); await Promise.resolve(); await Promise.resolve();
 expect(onSettings).not.toHaveBeenCalled(); expect(sender.setParameters).not.toHaveBeenCalled();
});
it.each([
 [{ width: 2560, height: 1440 }, { width: 1920, height: 1080 }, 4 / 3],
 [{ width: 3440, height: 1440 }, { width: 1920, height: 1080 }, 3440 / 1920],
 [{ width: 1080, height: 1920 }, { width: 1280, height: 720 }, 1920 / 720],
 [{ width: 640, height: 360 }, { width: 1280, height: 720 }, 1],
 [{}, { width: 1280, height: 720 }, 1.5]
])('preserva proporção e trata dimensões ausentes: %j', (source, target, expected) => {
 expect(videoScaleForProfile(source, target, 1.5)).toBeCloseTo(expected, 10);
});
it.each(['networkPriority', 'priority'])('preserva preferência quando somente %s não é suportada', async field => {
 sender.setParameters = vi.fn(async p => {
  if (p.encodings[0][field]) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
  state = structuredClone(p);
 });
 await mutateVideoSender(sender, p => { p.degradationPreference = 'maintain-resolution'; Object.assign(p.encodings[0], { priority: 'high', networkPriority: 'high', maxBitrate: 4500000 }); });
 expect(state.degradationPreference).toBe('maintain-resolution');
 expect(getSenderParameterStatus(sender)).toMatchObject({ requestedDegradationPreference: 'maintain-resolution', effectiveDegradationPreference: 'maintain-resolution', senderParameterFallback: 'priority-only' });
});
it('expõe preferência não suportada no diagnóstico sem bloquear bitrate', async () => {
 sender.setParameters = vi.fn(async p => {
  if (p.degradationPreference) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
  state = structuredClone(p);
 });
 await mutateVideoSender(sender, p => { p.degradationPreference = 'maintain-resolution'; p.encodings[0].maxBitrate = 4500000; });
 expect(state.encodings[0].maxBitrate).toBe(4500000);
 expect(safeSample(getSenderParameterStatus(sender))).toMatchObject({ requestedDegradationPreference: 'maintain-resolution', effectiveDegradationPreference: null, senderParameterFallback: 'degradation-unsupported' });
 document.body.append(createStatsHud('audit'));
 renderStatsHud('audit', true, getSenderParameterStatus(sender));
 expect(document.getElementById('stat-adaptation-requested-audit').innerText).toBe('Resolução');
 expect(document.getElementById('stat-adaptation-effective-audit').innerText).toBe('Padrão do navegador');
});
