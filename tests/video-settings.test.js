import {readFileSync} from 'node:fs';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {SessionContext} from '../js/core/session-context.js';
import {bindVideoSettings,readVideoSettings} from '../js/streaming/video-settings.js';
import {bindCaptureSettings} from '../js/capture/settings.js';
import {bindStreamingQuality} from '../js/streaming/settings-controller.js';
import {NativeCaptureProvider} from '../js/capture.js';
import {MockMediaStream,MockMediaStreamTrack} from './mocks/webrtc.mock.js';
const template=readFileSync('templates/video-settings/default.html','utf8');
let session;
const el=id=>document.getElementById(id);
const change=(id,value)=>{el(id).value=String(value);el(id).dispatchEvent(new Event('change'));};
beforeEach(()=>{document.body.innerHTML=template;localStorage.clear();session=new SessionContext();});
afterEach(async()=>{await session.dispose();document.body.innerHTML='';localStorage.clear();delete window.__TAURI_INTERNALS__;});
it('separa resolução, FPS e bitrate sem sobrescrever os outros campos',()=>{
 bindVideoSettings(session,{desktop:true});change('bitrate-slider',5250);change('stream-fps-select',30);change('stream-resolution-select',720);
 expect(readVideoSettings()).toMatchObject({width:1280,height:720,fps:30,bitrateKbps:5250,rawVideoQueue:'bounded'});
 change('stream-resolution-select',1080);expect(readVideoSettings()).toMatchObject({height:1080,fps:30,bitrateKbps:5250});
});
it('restaura as escolhas válidas de uma nova sessão',async()=>{
 bindVideoSettings(session,{desktop:true});change('stream-fps-select',120);change('stream-resolution-select',720);change('bitrate-slider',9000);change('stream-performance-mode','responsive');
 await session.dispose();document.body.innerHTML=template;session=new SessionContext();bindVideoSettings(session,{desktop:true});
 expect(readVideoSettings()).toMatchObject({height:720,fps:120,bitrateKbps:9000,rawVideoQueue:'latest'});
 expect(el('stream-performance-note').textContent).toContain('não é garantida');
});
it('não restaura valores fora do domínio dos controles',()=>{
 localStorage.setItem('seemygame_stream_fps','1000');localStorage.setItem('seemygame_stream_bitrate_kbps','-1');localStorage.setItem('seemygame_stream_resolution','4320');
 bindVideoSettings(session,{desktop:true});expect(readVideoSettings()).toMatchObject({height:1080,fps:60,bitrateKbps:7500});
});
it('explica e desabilita o descarte nativo no navegador',()=>{
 bindVideoSettings(session,{desktop:false});expect(el('stream-performance-mode').disabled).toBe(true);expect(el('stream-performance-note').textContent).toContain('exclusivo do app');
 expect(el('stream-fps-select').disabled).toBe(false);
});
it('a integração antiga ainda atualiza os campos separados',()=>{
 bindVideoSettings(session,{desktop:true});change('quality-preset','hd120');expect(readVideoSettings()).toMatchObject({height:720,fps:120,bitrateKbps:9000});
});
it('aplica FPS e escala ao sender web sem reiniciar a captura',async()=>{
 bindVideoSettings(session,{desktop:false});
 const track={kind:'video',getSettings:()=>({width:1920,height:1080}),applyConstraints:vi.fn().mockResolvedValue()};
 let params={encodings:[{}]};const sender={track,getParameters:()=>structuredClone(params),setParameters:vi.fn(async p=>{params=structuredClone(p);})};
 const stream={getVideoTracks:()=>[track]},onSettings=vi.fn();
 bindStreamingQuality(session,{getStream:()=>stream,getProvider:()=>null,getCalls:()=>[{peerConnection:{getSenders:()=>[sender]}}],onSettings,showToast:vi.fn()});
 change('stream-fps-select',30);change('stream-resolution-select',720);
 await vi.waitFor(()=>expect(params.encodings[0]).toMatchObject({maxFramerate:30,maxBitrate:7500000,scaleResolutionDownBy:1.5}));
 expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({frameRate:{ideal:30,max:30}}));
});
it.each(['bounded','latest'])('preserva a política ativa %s em mudanças ao vivo com outro modo pendente',async policy=>{
 bindVideoSettings(session,{desktop:true});
 const provider={session:{provider:'native',sessionId:'live'},requestedSettings:{rawVideoQueue:policy},reconfigure:vi.fn().mockResolvedValue({})},toast=vi.fn();
 bindCaptureSettings(session,()=>provider,toast);
 change('stream-performance-mode',policy==='bounded'?'responsive':'smooth');expect(provider.reconfigure).not.toHaveBeenCalled();expect(toast).toHaveBeenCalledWith(expect.stringContaining('reiniciar'),'info');
 change('stream-fps-select',30);
 await vi.waitFor(()=>expect(provider.reconfigure).toHaveBeenCalledWith(expect.objectContaining({fps:30,rawVideoQueue:policy})));
});
it('leva resolução/FPS/bitrate e descarte da interface até o IPC nativo',async()=>{
 bindVideoSettings(session,{desktop:true});change('stream-resolution-select',720);change('stream-fps-select',30);change('bitrate-slider',4500);change('stream-performance-mode','responsive');
 const invoke=vi.fn().mockResolvedValue({state:'live',sessionId:'n-1'});window.__TAURI_INTERNALS__={invoke};
 const bridge={createStream:vi.fn().mockResolvedValue(new MockMediaStream([new MockMediaStreamTrack('video')])),closeStream:vi.fn().mockResolvedValue()};
 const provider=new NativeCaptureProvider({mediaBridge:bridge});
 await provider.start({sourceId:'capture_test',...readVideoSettings()});
 expect(invoke).toHaveBeenCalledWith('start_native_capture',expect.objectContaining({width:1280,height:720,fps:30,bitrateKbps:4500,rawVideoQueue:'latest'}));
 expect(provider.requestedSettings.rawVideoQueue).toBe('latest');await provider.stop();
});
