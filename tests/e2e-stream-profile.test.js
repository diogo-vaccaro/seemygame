import {describe,it,expect} from 'vitest';
import {resolveTestProfiles,installTestStreamProfile,isSevereCadenceDrop,resolveWebCaptureStages} from '../tools/e2e/harness/stream-profile.mjs';
import {createMotionFixture} from '../tools/e2e/fixtures/motion.mjs';
describe('Independent E2E source and streaming profiles',()=>{
  const base={width:1280,height:720,fps:60,bitrate:7500000};
  it('keeps a 1080p60 source when transmission changes to 720p30',()=>{
    const profiles=resolveTestProfiles(base,{streamFps:'30',sourceFps:'60',sourceSize:'1920,1080'});
    expect(profiles.stream).toEqual({...base,fps:30});
    expect(profiles.source).toEqual({width:1920,height:1080,fps:60});
    expect(base.fps).toBe(60);
    const fixture=createMotionFixture('isolated',1,profiles.source.fps,profiles.source);
    expect(fixture).toContain('width="1920" height="1080"');
    expect(fixture).toContain('fps: 60');
  });
  it('preserves legacy defaults without opting into overrides',()=>{
    expect(resolveTestProfiles(base)).toEqual({stream:base,source:{width:1280,height:720,fps:60},override:false});
  });
  it('rejects invalid controls before launching a workload',()=>{
    for(const options of [{streamFps:0},{streamFps:121},{streamFps:'bad'},{sourceFps:NaN},{sourceSize:'0,1080'},{sourceSize:'1920,1080,60'}])expect(()=>resolveTestProfiles(base,options)).toThrow();
  });
  it('serializes the diagnostic adapter without a module closure',()=>{
    expect(()=>new Function(`return (${installTestStreamProfile.toString()})`)).not.toThrow();
  });
  it('does not classify healthy 30 FPS cadence as a severe 60 FPS drop',()=>{
    expect(isSevereCadenceDrop(29.6,30)).toBe(false);
    expect(isSevereCadenceDrop(29.6,60)).toBe(true);
    expect(isSevereCadenceDrop(14,30)).toBe(true);
    expect(isSevereCadenceDrop(null,30)).toBe(false);
  });
  it('can isolate sender FPS and sender scaling from browser capture',()=>{
    const source={width:1920,height:1080,fps:60},stream={width:1280,height:720,fps:30};
    expect(resolveWebCaptureStages(stream,source,{captureFps:60,scaleInEncoder:true})).toEqual({capture:source,senderScale:1.5,resolutionStage:'sender'});
    expect(resolveWebCaptureStages(stream,source)).toEqual({capture:{width:1280,height:720,fps:30},senderScale:1,resolutionStage:'capture'});
    expect(()=>resolveWebCaptureStages(stream,{width:1920,height:1200},{scaleInEncoder:true})).toThrow('aspect ratio');
  });
});
