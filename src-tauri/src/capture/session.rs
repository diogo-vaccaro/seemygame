//! session; internal to the native capture subsystem.
use super::*;

#[cfg(not(test))]
pub(crate) struct ActiveSession {
    pub(crate) state: NativeCaptureState,
    pub(crate) validated_source: ValidatedSource,
    pub(crate) worker: Option<NativeMediaWorker>,
    pub(crate) replay: Option<crate::replay::NativeReplay>,
    pub(crate) fanout: Option<RtpFanout>,
    pub(crate) local_bridge: Option<NativeWebRtcBridge>,
    pub(crate) local_video_port: Option<u16>,
    pub(crate) local_audio_port: Option<u16>,
    pub(crate) pending_local_ice_candidates: Vec<(u32, String)>,
    pub(crate) viewer_bridges: HashMap<String, ViewerBridgeEntry>,
    pub(crate) viewer_negotiations: ViewerNegotiations,
    pub(crate) pending_viewer_ice_candidates: HashMap<(String, Option<String>), Vec<(u32, String)>>,
}

#[cfg(not(test))]
pub(crate) static ACTIVE_SESSION: OnceLock<Mutex<Option<ActiveSession>>> = OnceLock::new();

#[cfg(not(test))]
pub(crate) fn active_session() -> &'static Mutex<Option<ActiveSession>> {
    ACTIVE_SESSION.get_or_init(|| Mutex::new(None))
}

#[cfg(not(test))]
pub(crate) fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(not(test))]
pub(crate) fn emit_state(app: &AppHandle, state: &NativeCaptureState) {
    if let Err(error) = app.emit(STATE_EVENT, state.clone()) {
        log::debug!("[Capture] Falha ao emitir estado: {error}");
    }
}
