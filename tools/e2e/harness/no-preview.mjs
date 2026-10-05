/** Isolated diagnostic adapter. Remote media still comes from the real native worker.
 * The local canvas supplies only the UI's required stream/track lifecycle, never outbound RTP.
 * Apply identically to all compared codecs; this is not the production preview path.
 */
export async function installNativeWithoutPreview() {
 const {NativeCaptureProvider}=await import('/js/capture.js');
 const {startNativeCapture,stopNativeCapture}=await import('/js/desktop.js');
 NativeCaptureProvider.prototype.start=async function(options={}) {
  const operationId=++this._operationId;
  this.requestedSettings={...options};
  if(window.__smgTestStreamProfile)window.__smgTestStreamProfile.nativeRequested={...options};
  const state=await startNativeCapture(options);
  if(operationId!==this._operationId){await stopNativeCapture(state.sessionId);throw new Error('Diagnostic capture cancelled');}
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
  const context=canvas.getContext('2d');context.fillStyle='#172236';context.fillRect(0,0,320,180);
  context.fillStyle='#eff4fb';context.font='15px sans-serif';context.fillText('Diagnóstico: prévia local desativada',12,92);
  const stream=canvas.captureStream(0);stream.getVideoTracks()[0].requestFrame?.();
  this.stream=stream;
  this.session={...state,provider:'native',sourceId:options.sourceId,sourceType:options.sourceType};
  return {stream,session:this.session,operationId};
 };
}
