//! Native capture control plane.
//!
//! This module deliberately contains no video bytes or HWND supplied by the
//! WebView. It validates an opaque source ID through `windows_list`, owns the
//! lifecycle/session state, and is the boundary where the packaged media
//! worker (WGC/WASAPI/GStreamer) will attach.

use serde::Serialize;
#[cfg(not(test))]
use std::collections::{HashMap, HashSet};
use std::net::UdpSocket;
#[cfg(not(test))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(test))]
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(test))]
use std::thread::{self, JoinHandle};
#[cfg(not(test))]
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(not(test))]
use tauri::{AppHandle, Emitter};

use crate::media;
#[cfg(not(test))]
use crate::media::{AudioMode, NativeMediaWorker};
#[cfg(not(test))]
use crate::webrtc_bridge::{NativeCaptureSdp, NativeWebRtcBridge};
#[cfg(not(test))]
use crate::windows_list::{resolve_capture_source, ValidatedSource};

#[cfg(not(test))]
const STATE_EVENT: &str = "native-capture-state";

#[cfg(test)]
mod acceptance_tests {
    #[test]
    fn native_video_backend_is_available_for_window_and_monitor() {
        // Release gate against the REAL backend, not a mocked Tauri response.
        // Availability alone does not replace the manual remote-video/GPU test.
        let caps = super::capabilities();
        assert!(
            caps.worker_available,
            "Native video worker unavailable: {:?}",
            caps.reason
        );
        assert!(caps.supports_window && caps.supports_monitor);
    }

    #[test]
    fn native_backend_supports_required_audio_modes() {
        let caps = super::capabilities();
        assert!(
            caps.supports_system_audio,
            "System loopback unavailable: {:?}",
            caps.reason
        );
        // Process loopback must be tested on a supported Windows build.
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct CaptureCapabilities {
    pub provider: String,
    pub backend: String,
    pub available: bool,
    pub worker_available: bool,
    pub bridge_available: bool,
    pub supports_window: bool,
    pub supports_monitor: bool,
    pub supports_process_audio: bool,
    pub supports_system_audio: bool,
    pub supports_h264: bool,
    pub supports_cpu_h264: bool,
    pub supports_nvenc_h264: bool,
    pub supports_mf_h264: bool,
    pub supports_d3d12: bool,
    pub supports_hevc: bool,
    pub supports_av1: bool,
    pub supports_webrtc: bool,
    pub runtime_available: bool,
    pub missing_elements: Vec<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[cfg(not(test))]
pub struct NativeCaptureState {
    pub state: String,
    pub session_id: Option<String>,
    pub source_id: Option<String>,
    pub source_type: Option<String>,
    pub audio_mode: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi: Option<u32>,
    pub video_codec: Option<String>,
    pub h264_encoder: Option<String>,
    pub capture_backend: Option<String>,
    pub capture_api: Option<String>,
    pub capture_fallback_reason: Option<String>,
    pub video_rtp_port: Option<u16>,
    pub audio_rtp_port: Option<u16>,
    pub exclude_app: Option<String>,
    pub exclude_pid: Option<u32>,
    pub error: Option<String>,
}

#[cfg(not(test))]
pub(crate) struct ViewerBridgeEntry {
    bridge: NativeWebRtcBridge,
    video_port: u16,
    audio_port: Option<u16>,
}

mod fanout;
pub(crate) use fanout::*;

mod session;
pub(crate) use session::*;
mod negotiation;
pub(crate) use negotiation::ViewerNegotiations;

pub fn capabilities() -> CaptureCapabilities {
    let media = media::probe_capabilities();
    let worker_available = media.runtime_available
        && media.video_available
        && (media.h264_available || media.nvenc_h264_available || media.av1_available)
        && media.webrtc_available;
    // The bridge is in-process and consumes the worker's loopback RTP. It is
    // available only when the actual runtime exposes webrtcbin as well.
    let bridge_available = worker_available && media.webrtc_available;
    CaptureCapabilities {
        provider: "native".to_string(),
        backend: "gstreamer-wgc-wasapi".to_string(),
        available: worker_available && bridge_available,
        worker_available,
        bridge_available,
        supports_window: true,
        supports_monitor: true,
        supports_process_audio: media.process_audio_available,
        supports_system_audio: media.system_audio_available,
        supports_h264: media.h264_available || media.nvenc_h264_available || media.x264_available,
        supports_cpu_h264: media.x264_available,
        supports_nvenc_h264: media.nvenc_h264_available,
        supports_mf_h264: media.h264_available,
        supports_d3d12: media.d3d12_available,
        supports_hevc: media.hevc_available,
        supports_av1: media.av1_available,
        supports_webrtc: media.webrtc_available,
        runtime_available: media.runtime_available,
        missing_elements: media.missing_elements,
        reason: if !worker_available {
            Some(media.reason.unwrap_or_else(|| {
                "O worker nativo exige runtime GStreamer, WGC/D3D11, H.264/AV1 e webrtcbin"
                    .to_string()
            }))
        } else if !bridge_available {
            Some("Worker nativo pronto; ponte WebRTC para o WebView indisponível".to_string())
        } else {
            None
        },
    }
}

#[cfg(not(test))]
mod commands;
#[cfg(not(test))]
pub(crate) use commands::*;
