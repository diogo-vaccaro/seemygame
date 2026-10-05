/** Test-only controls. The source cadence and dimensions never follow an override
 * of the transmitted profile, so a smaller stream does not reduce game workload. */
export function resolveTestProfiles(base,{streamFps,sourceFps,sourceSize}={}) {
  const fps=value=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>120)throw Error('Test FPS must be an integer in 1..120');return n;};
  const size=sourceSize===undefined?[base.width,base.height]:String(sourceSize).split(',').map(Number);
  if(size.length!==2||size.some(n=>!Number.isInteger(n)||n<240||n>3840))throw Error('Invalid source size (width,height; 240..3840)');
  return {stream:{...base,fps:fps(streamFps??base.fps)},source:{width:size[0],height:size[1],fps:fps(sourceFps??base.fps)},override:streamFps!==undefined||sourceSize!==undefined};
}

export function isSevereCadenceDrop(decodedFps,targetFps) {
  return Number.isFinite(decodedFps)&&decodedFps<targetFps*0.5;
}

export function resolveWebCaptureStages(stream,source,{captureFps=stream.fps,scaleInEncoder=false}={}) {
  if(!Number.isInteger(captureFps)||captureFps<1||captureFps>120)throw Error('Invalid web capture FPS');
  const capture={width:scaleInEncoder?source.width:stream.width,height:scaleInEncoder?source.height:stream.height,fps:captureFps};
  const senderScale=capture.width/stream.width;
  if(senderScale<1||Math.abs(capture.height/stream.height-senderScale)>0.0001)throw Error('Encoder scaling must preserve source aspect ratio');
  return {capture,senderScale,resolutionStage:scaleInEncoder?'sender':'capture'};
}

/** Runs only in the isolated sender after joining, before capture starts. */
export async function installTestStreamProfile({preset,profile,web,captureProfile=profile,senderScale=1}) {
  const {QUALITY_PROFILES}=await import('/js/config.js');
  if(!QUALITY_PROFILES[preset])throw Error('Unknown diagnostic preset');
  Object.assign(QUALITY_PROFILES[preset],{fps:profile.fps});
  window.__smgTestStreamProfile={preset,requested:{width:profile.width,height:profile.height,fps:profile.fps},captureProfile,senderScale,web,requests:[]};
  if(!web)return window.__smgTestStreamProfile;
  if(window.__smgOriginalDisplayMedia)throw Error('Capture override already installed');
  const original=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  window.__smgOriginalDisplayMedia=original;
  if(senderScale!==1){
    const setParameters=RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters=function(parameters){
      if(this.track?.kind==='video')for(const encoding of parameters.encodings??[])encoding.scaleResolutionDownBy=senderScale;
      return setParameters.call(this,parameters);
    };
  }
  navigator.mediaDevices.getDisplayMedia=async function(options) {
    const constraints={width:{ideal:captureProfile.width,max:captureProfile.width},height:{ideal:captureProfile.height,max:captureProfile.height},frameRate:{ideal:captureProfile.fps,max:captureProfile.fps}};
    const requested={...options,video:{...(options?.video===true?{}:options?.video),...constraints}};
    window.__smgTestStreamProfile.requests.push({original:structuredClone(options),effective:structuredClone(requested)});
    const stream=await original(requested);
    const track=stream.getVideoTracks()[0];
    if(!track)throw Error('No real video track returned by getDisplayMedia');
    await track.applyConstraints(constraints);
    window.__smgTestStreamProfile.captureSettings=track.getSettings();
    return stream;
  };
  return window.__smgTestStreamProfile;
}
