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
    pub video_rtp_port: Option<u16>,
    pub audio_rtp_port: Option<u16>,
    pub error: Option<String>,
}

#[cfg(not(test))]
struct ViewerBridgeEntry {
    bridge: NativeWebRtcBridge,
    video_port: u16,
    audio_port: Option<u16>,
}

#[cfg(not(test))]
#[derive(Debug)]
struct RtpFanout {
    running: Arc<AtomicBool>,
    video_targets: Arc<Mutex<HashSet<u16>>>,
    audio_targets: Arc<Mutex<HashSet<u16>>>,
    video_thread: Option<JoinHandle<()>>,
    audio_thread: Option<JoinHandle<()>>,
}

#[cfg(not(test))]
impl RtpFanout {
    fn start(video_src_port: u16, audio_src_port: Option<u16>) -> Result<Self, String> {
        let running = Arc::new(AtomicBool::new(true));
        let video_targets = Arc::new(Mutex::new(HashSet::new()));
        let audio_targets = Arc::new(Mutex::new(HashSet::new()));

        let video_socket = UdpSocket::bind(("127.0.0.1", video_src_port))
            .map_err(|e| format!("Falha ao conectar socket fan-out de vídeo na porta {video_src_port}: {e}"))?;
        let video_thread = spawn_fanout_thread("vídeo", video_socket, Arc::clone(&video_targets), Arc::clone(&running))?;

        let audio_thread = if let Some(audio_port) = audio_src_port {
            let audio_socket = UdpSocket::bind(("127.0.0.1", audio_port))
                .map_err(|e| format!("Falha ao conectar socket fan-out de áudio na porta {audio_port}: {e}"))?;
            Some(spawn_fanout_thread("áudio", audio_socket, Arc::clone(&audio_targets), Arc::clone(&running))?)
        } else {
            None
        };

        Ok(Self {
            running,
            video_targets,
            audio_targets,
            video_thread: Some(video_thread),
            audio_thread,
        })
    }

    fn add_video_target(&self, port: u16) {
        if let Ok(mut targets) = self.video_targets.lock() {
            targets.insert(port);
        }
    }

    fn remove_video_target(&self, port: u16) {
        if let Ok(mut targets) = self.video_targets.lock() {
            targets.remove(&port);
        }
    }

    fn add_audio_target(&self, port: u16) {
        if let Ok(mut targets) = self.audio_targets.lock() {
            targets.insert(port);
        }
    }

    fn remove_audio_target(&self, port: u16) {
        if let Ok(mut targets) = self.audio_targets.lock() {
            targets.remove(&port);
        }
    }
}

#[cfg(not(test))]
impl Drop for RtpFanout {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(vt) = self.video_thread.take() {
            let _ = vt.join();
        }
        if let Some(at) = self.audio_thread.take() {
            let _ = at.join();
        }
    }
}

#[cfg(windows)]
fn set_socket_buffer_size(socket: &UdpSocket, size_bytes: i32) {
    use std::os::windows::io::AsRawSocket;
    unsafe extern "system" {
        fn setsockopt(
            s: usize,
            level: i32,
            optname: i32,
            optval: *const i8,
            optlen: i32,
        ) -> i32;
    }
    const SOL_SOCKET: i32 = 0xffff;
    const SO_RCVBUF: i32 = 0x1002;
    const SO_SNDBUF: i32 = 0x1001;
    let size = size_bytes;
    unsafe {
        let _ = setsockopt(
            socket.as_raw_socket() as usize,
            SOL_SOCKET,
            SO_RCVBUF,
            &size as *const _ as *const i8,
            std::mem::size_of::<i32>() as i32,
        );
        let _ = setsockopt(
            socket.as_raw_socket() as usize,
            SOL_SOCKET,
            SO_SNDBUF,
            &size as *const _ as *const i8,
            std::mem::size_of::<i32>() as i32,
        );
    }
}

#[cfg(windows)]
fn disable_connection_reset(socket: &UdpSocket) {
    use std::os::windows::io::AsRawSocket;
    unsafe extern "system" {
        fn WSAIoctl(
            s: usize,
            dwIoControlCode: u32,
            lpvInBuffer: *const std::ffi::c_void,
            cbInBuffer: u32,
            lpvOutBuffer: *mut std::ffi::c_void,
            cbOutBuffer: u32,
            lpcbBytesReturned: *mut u32,
            lpOverlapped: *mut std::ffi::c_void,
            lpCompletionRoutine: *mut std::ffi::c_void,
        ) -> i32;
    }
    const SIO_UDP_CONNRESET: u32 = 0x9800000C;
    let mut bytes_returned: u32 = 0;
    let flag: u32 = 0;
    unsafe {
        let _ = WSAIoctl(
            socket.as_raw_socket() as usize,
            SIO_UDP_CONNRESET,
            &flag as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
    }
}

#[cfg(not(test))]
fn spawn_fanout_thread(
    label: &'static str,
    socket: UdpSocket,
    targets: Arc<Mutex<HashSet<u16>>>,
    running: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    #[cfg(windows)]
    set_socket_buffer_size(&socket, 2 * 1024 * 1024);
    #[cfg(windows)]
    disable_connection_reset(&socket);
    socket
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|e| format!("Falha ao configurar timeout no socket fan-out de {label}: {e}"))?;
    let sender = UdpSocket::bind("127.0.0.1:0")
        .map_err(|e| format!("Falha ao criar socket transmissor fan-out de {label}: {e}"))?;
    #[cfg(windows)]
    set_socket_buffer_size(&sender, 2 * 1024 * 1024);
    #[cfg(windows)]
    disable_connection_reset(&sender);

    let handle = thread::spawn(move || {
        let mut buf = [0u8; 65535];
        let mut first_packet_logged = false;
        while running.load(Ordering::Relaxed) {
            match socket.recv_from(&mut buf) {
                Ok((len, src_addr)) => {
                    if !first_packet_logged {
                        first_packet_logged = true;
                        crate::system::write_debug_log(&format!(
                            "[Capture] Fanout {label} primeiro pacote RTP recebido de {src_addr} (tamanho: {len} bytes)"
                        ));
                    }
                    let ports: Vec<u16> = {
                        let Ok(guard) = targets.lock() else { continue };
                        guard.iter().copied().collect()
                    };
                    for port in ports {
                        let _ = sender.send_to(&buf[..len], ("127.0.0.1", port));
                    }
                }
                Err(ref e)
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::ConnectionReset =>
                {
                    continue;
                }
                Err(ref e) => {
                    crate::system::write_debug_log(&format!("[Capture] Fanout {label} erro de recepção ignorado: {e}"));
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
            }
        }
    });
    Ok(handle)
}

#[cfg(not(test))]
fn allocate_ephemeral_port() -> Result<u16, String> {
    let socket = UdpSocket::bind("127.0.0.1:0")
        .map_err(|e| format!("Falha ao alocar porta RTP efêmera: {e}"))?;
    let port = socket
        .local_addr()
        .map_err(|e| format!("Falha ao ler porta RTP efêmera: {e}"))?
        .port();
    drop(socket);
    Ok(port)
}

#[cfg(not(test))]
struct ActiveSession {
    state: NativeCaptureState,
    validated_source: ValidatedSource,
    worker: Option<NativeMediaWorker>,
    fanout: Option<RtpFanout>,
    local_bridge: Option<NativeWebRtcBridge>,
    local_video_port: Option<u16>,
    local_audio_port: Option<u16>,
    pending_local_ice_candidates: Vec<(u32, String)>,
    viewer_bridges: HashMap<String, ViewerBridgeEntry>,
    pending_viewer_ice_candidates: HashMap<String, Vec<(u32, String)>>,
}

#[cfg(not(test))]
static ACTIVE_SESSION: OnceLock<Mutex<Option<ActiveSession>>> = OnceLock::new();

#[cfg(not(test))]
fn active_session() -> &'static Mutex<Option<ActiveSession>> {
    ACTIVE_SESSION.get_or_init(|| Mutex::new(None))
}

#[cfg(not(test))]
fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(not(test))]
fn emit_state(app: &AppHandle, state: &NativeCaptureState) {
    if let Err(error) = app.emit(STATE_EVENT, state.clone()) {
        log::debug!("[Capture] Falha ao emitir estado: {error}");
    }
}

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
#[tauri::command]
pub fn get_native_capture_capabilities() -> CaptureCapabilities {
    capabilities()
}

#[cfg(not(test))]
#[tauri::command]
pub fn get_native_capture_state() -> Result<NativeCaptureState, String> {
    let guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    Ok(guard
        .as_ref()
        .map(|session| session.state.clone())
        .unwrap_or_else(|| NativeCaptureState {
            state: "idle".to_string(),
            session_id: None,
            source_id: None,
            source_type: None,
            audio_mode: None,
            width: None,
            height: None,
            dpi: None,
            video_codec: None,
            h264_encoder: None,
            video_rtp_port: None,
            audio_rtp_port: None,
            error: None,
        }))
}

#[cfg(not(test))]
#[tauri::command]
pub fn start_native_capture(
    app: AppHandle,
    source_id: String,
    audio_mode: Option<String>,
    video_codec: Option<String>,
    h264_encoder: Option<String>,
    show_cursor: Option<bool>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
) -> Result<NativeCaptureState, String> {
    let validated = resolve_capture_source(&source_id)?;
    let audio_mode = audio_mode.unwrap_or_else(|| "none".to_string());
    if !matches!(audio_mode.as_str(), "none" | "system" | "process" | "mic") {
        return Err("Modo de áudio inválido".to_string());
    }

    {
        let guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        if let Some(session) = guard.as_ref() {
            if matches!(session.state.state.as_str(), "starting" | "live") {
                if session.state.source_id.as_deref() == Some(source_id.as_str()) {
                    return Ok(session.state.clone());
                }
                return Err("Já existe uma sessão de captura nativa ativa".to_string());
            }
        }
    }

    let session_id = format!("native_capture_{}", timestamp_ms());
    let target_width = width.unwrap_or(validated.width);
    let target_height = height.unwrap_or(validated.height);

    let starting_state = NativeCaptureState {
        state: "starting".to_string(),
        session_id: Some(session_id.clone()),
        source_id: Some(validated.source_id.clone()),
        source_type: Some(validated.source_type.clone()),
        audio_mode: Some(audio_mode.clone()),
        width: Some(target_width),
        height: Some(target_height),
        dpi: Some(validated.dpi),
        video_codec: None,
        h264_encoder: None,
        video_rtp_port: None,
        audio_rtp_port: None,
        error: None,
    };

    {
        let mut guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        *guard = Some(ActiveSession {
            state: starting_state.clone(),
            validated_source: validated.clone(),
            worker: None,
            fanout: None,
            local_bridge: None,
            local_video_port: None,
            local_audio_port: None,
            pending_local_ice_candidates: Vec::new(),
            viewer_bridges: HashMap::new(),
            pending_viewer_ice_candidates: HashMap::new(),
        });
    }
    emit_state(&app, &starting_state);

    crate::system::write_debug_log(&format!(
        "[Capture] start_native_capture: source_id={}, audio_mode={}, video_codec={:?}, h264_encoder={:?}, width={:?}, height={:?}, fps={:?}, bitrate_kbps={:?}",
        source_id, audio_mode, video_codec, h264_encoder, width, height, fps, bitrate_kbps
    ));
    let mut config =
        match media::MediaWorkerConfig::from_environment(&audio_mode, video_codec.as_deref()) {
            Ok(config) => config,
            Err(error) => return fail_start(&app, &starting_state, &error),
        };
    if let Some(enc) = h264_encoder.as_deref() {
        let trimmed = enc.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("auto") {
            config.h264_encoder = match media::H264EncoderBackend::parse(trimmed) {
                Ok(backend) => backend,
                Err(error) => return fail_start(&app, &starting_state, &error),
            };
        }
    }
    if let Some(show) = show_cursor {
        config.show_cursor = show;
    }
    if let Some(w) = width {
        config.width = Some(w.clamp(320, 7680));
    }
    if let Some(h) = height {
        config.height = Some(h.clamp(240, 4320));
    }
    if let Some(f) = fps {
        config.fps = f.clamp(1, 120);
    }
    if let Some(b) = bitrate_kbps {
        config.bitrate_kbps = b.clamp(256, 50_000);
    }
    let mut worker = match NativeMediaWorker::start(&validated, config) {
        Ok(worker) => worker,
        Err(error) => return fail_start(&app, &starting_state, &error),
    };
    worker.release_rtp_port_leases();
    crate::media::clear_handoff_leases();
    let fanout = match RtpFanout::start(worker.video_rtp_port, worker.audio_rtp_port) {
        Ok(f) => f,
        Err(error) => {
            crate::system::write_debug_log(&format!("[Capture] RtpFanout::start falhou: {error}"));
            worker.stop();
            return fail_start(&app, &starting_state, &error);
        }
    };
    crate::system::write_debug_log(&format!(
        "[Capture] Worker GStreamer ativo com RtpFanout: video_rtp_port={}, audio_rtp_port={:?}",
        worker.video_rtp_port, worker.audio_rtp_port
    ));
    let live_state = NativeCaptureState {
        state: "live".to_string(),
        video_codec: Some(worker.config.codec.as_str().to_string()),
        h264_encoder: Some(worker.config.h264_encoder.as_str().to_string()),
        video_rtp_port: Some(worker.video_rtp_port),
        audio_rtp_port: worker.audio_rtp_port,
        ..starting_state
    };
    {
        let mut guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        if let Some(session) = guard.as_mut() {
            if session.state.session_id.as_deref() != Some(session_id.as_str()) {
                drop(guard);
                drop(fanout);
                worker.stop();
                return Err("Captura nativa foi cancelada durante a inicialização".to_string());
            }
            session.state = live_state.clone();
            session.worker = Some(worker);
            session.fanout = Some(fanout);
        } else {
            drop(guard);
            drop(fanout);
            worker.stop();
            return Err("Captura nativa foi cancelada durante a inicialização".to_string());
        }
    }
    emit_state(&app, &live_state);
    spawn_worker_health_monitor(&app, session_id);
    Ok(live_state)
}

#[cfg(not(test))]
fn spawn_worker_health_monitor(app: &AppHandle, session_id: String) {
    let monitor_app = app.clone();
    thread::spawn(move || loop {
        thread::sleep(std::time::Duration::from_millis(750));
        let mut cleanup = None;
        let mut state_event = None;
        let should_exit = {
            let Ok(mut guard) = active_session().lock() else {
                return;
            };
            match guard.as_mut() {
                None => true,
                Some(session) => {
                    if session.state.session_id.as_deref() != Some(session_id.as_str())
                        || session.state.state != "live"
                    {
                        true
                    } else if let Some(worker) = session.worker.as_mut() {
                        match worker.health_error() {
                            Ok(()) => false,
                            Err(error) => {
                                log::error!("[Capture] Worker GStreamer falhou: {error}");
                                session.state.state = "error".to_string();
                                session.state.error = Some(error);
                                cleanup = Some((
                                    session.viewer_bridges.drain().collect::<Vec<_>>(),
                                    session.local_bridge.take(),
                                    session.fanout.take(),
                                    session.worker.take(),
                                ));
                                state_event = Some(session.state.clone());
                                true
                            }
                        }
                    } else {
                        log::error!("[Capture] Sessão ativa sem worker GStreamer");
                        session.state.state = "error".to_string();
                        session.state.error = Some("Worker GStreamer ausente em sessão ativa".to_string());
                        cleanup = Some((
                            session.viewer_bridges.drain().collect::<Vec<_>>(),
                            session.local_bridge.take(),
                            session.fanout.take(),
                            session.worker.take(),
                        ));
                        state_event = Some(session.state.clone());
                        true
                    }
                }
            }
        };
        drop(cleanup);
        if let Some(state) = state_event {
            emit_state(&monitor_app, &state);
        }
        if should_exit {
            break;
        }
    });
}

#[cfg(not(test))]
fn fail_start(
    app: &AppHandle,
    starting_state: &NativeCaptureState,
    error: &str,
) -> Result<NativeCaptureState, String> {
    crate::system::write_debug_log(&format!("[Capture] fail_start: {error}"));
    let error = error.to_string();
    let error_state = NativeCaptureState {
        state: "error".to_string(),
        error: Some(error.clone()),
        ..starting_state.clone()
    };
    {
        let mut guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        if let Some(session) = guard.as_mut() {
            if session.state.session_id.as_deref() != starting_state.session_id.as_deref() {
                return Err(error);
            }
            session.state = error_state.clone();
        } else {
            return Err(error);
        }
    }
    emit_state(app, &error_state);
    Err(error)
}

#[cfg(not(test))]
#[tauri::command]
pub fn reconfigure_native_capture(
    app: AppHandle,
    session_id: String,
    audio_mode: Option<String>,
    video_codec: Option<String>,
    h264_encoder: Option<String>,
    show_cursor: Option<bool>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
) -> Result<NativeCaptureState, String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Err("Nenhuma captura nativa ativa".to_string());
    };
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if session.state.state != "live" || session.worker.is_none() {
        return Err("A captura nativa ainda não está ativa".to_string());
    }

    let current_worker = session.worker.take().expect("worker present");
    let video_rtp_port = current_worker.video_rtp_port;
    let audio_rtp_port = current_worker.audio_rtp_port;
    let mut new_config = current_worker.config.clone();

    if let Some(mode) = audio_mode.as_deref() {
        if matches!(mode, "none" | "system" | "process" | "mic") {
            let parsed_mode = AudioMode::parse(mode)?;
            if parsed_mode != current_worker.config.audio_mode {
                if audio_rtp_port.is_none() && parsed_mode != AudioMode::None {
                    session.worker = Some(current_worker);
                    return Err(
                        "Ativar áudio nativo durante uma transmissão iniciada sem áudio requer reiniciar a transmissão para negociar as faixas com os espectadores."
                            .to_string(),
                    );
                }
                new_config.audio_mode = parsed_mode;
            }
        }
    }
    if let Some(codec_str) = video_codec.as_deref() {
        if let Ok(c) = media::VideoCodec::parse(codec_str) {
            if c != current_worker.config.codec {
                session.worker = Some(current_worker);
                return Err(
                    "A troca de codec de vídeo durante a transmissão requer reiniciar a transmissão para renegociar com os espectadores."
                        .to_string(),
                );
            }
            new_config.codec = c;
        }
    }
    if let Some(enc_str) = h264_encoder.as_deref() {
        let trimmed = enc_str.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("auto") {
            if let Ok(backend) = media::H264EncoderBackend::parse(trimmed) {
                new_config.h264_encoder = backend;
            }
        } else {
            new_config.h264_encoder = media::H264EncoderBackend::Auto;
        }
    }
    if let Some(cursor) = show_cursor {
        new_config.show_cursor = cursor;
    }
    if let Some(w) = width {
        new_config.width = Some(w.clamp(320, 7680));
    }
    if let Some(h) = height {
        new_config.height = Some(h.clamp(240, 4320));
    }
    if let Some(f) = fps {
        new_config.fps = f.clamp(1, 120);
    }
    if let Some(b) = bitrate_kbps {
        new_config.bitrate_kbps = b.clamp(256, 50_000);
    }

    crate::system::write_debug_log(&format!(
        "[Capture] Reconfigurando worker GStreamer: codec={:?}, encoder={:?}, show_cursor={}, width={:?}, height={:?}, fps={}, bitrate_kbps={}",
        new_config.codec, new_config.h264_encoder, new_config.show_cursor, new_config.width, new_config.height, new_config.fps, new_config.bitrate_kbps
    ));

    current_worker.stop();

    let target_audio_rtp_port = if new_config.audio_mode == AudioMode::None {
        None
    } else {
        audio_rtp_port
    };

    let new_worker = match NativeMediaWorker::start_with_ports(
        &session.validated_source,
        new_config,
        video_rtp_port,
        target_audio_rtp_port,
    ) {
        Ok(w) => w,
        Err(err) => {
            crate::system::write_debug_log(&format!("[Capture] Falha ao reconfigurar worker GStreamer: {err}"));
            session.state.state = "error".to_string();
            session.state.error = Some(format!("Falha ao reconfigurar captura nativa: {err}"));
            let cleanup = (
                session.viewer_bridges.drain().collect::<Vec<_>>(),
                session.local_bridge.take(),
                session.fanout.take(),
                session.worker.take(),
            );
            drop(cleanup);
            let state_to_emit = session.state.clone();
            emit_state(&app, &state_to_emit);
            return Err(err);
        }
    };

    let updated_state = NativeCaptureState {
        state: "live".to_string(),
        session_id: Some(session_id),
        source_id: session.state.source_id.clone(),
        source_type: session.state.source_type.clone(),
        audio_mode: Some(new_worker.config.audio_mode.as_str().to_string()),
        width: new_worker.config.width.or(session.state.width),
        height: new_worker.config.height.or(session.state.height),
        dpi: session.state.dpi,
        video_codec: Some(new_worker.config.codec.as_str().to_string()),
        h264_encoder: Some(new_worker.config.h264_encoder.as_str().to_string()),
        video_rtp_port: Some(video_rtp_port),
        audio_rtp_port: target_audio_rtp_port,
        error: None,
    };

    session.worker = Some(new_worker);
    session.state = updated_state.clone();
    emit_state(&app, &updated_state);
    Ok(updated_state)
}

#[cfg(not(test))]
#[tauri::command]
pub fn set_native_capture_audio_mode(
    app: AppHandle,
    session_id: String,
    audio_mode: String,
) -> Result<NativeCaptureState, String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Err("Nenhuma captura nativa ativa".to_string());
    };
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if session.state.state != "live" || session.worker.is_none() {
        return Err("A captura nativa ainda não está ativa".to_string());
    }
    let parsed_mode = AudioMode::parse(&audio_mode)?;
    if session
        .worker
        .as_ref()
        .is_some_and(|worker| worker.config.audio_mode != parsed_mode)
        && (session.local_bridge.is_some() || !session.viewer_bridges.is_empty())
    {
        return Err(
            "Altere o modo de áudio reiniciando a captura nativa para preservar a ponte WebRTC"
                .to_string(),
        );
    }
    if let Some(worker) = session.worker.as_mut() {
        if worker.config.audio_mode != parsed_mode {
            worker.restart_audio_mode(&session.validated_source, parsed_mode)?;
            session.state.audio_rtp_port = worker.audio_rtp_port;
        }
    }
    session.state.audio_mode = Some(audio_mode);
    let state = session.state.clone();
    emit_state(&app, &state);
    Ok(state)
}

#[cfg(not(test))]
#[tauri::command]
pub fn stop_native_capture(
    app: AppHandle,
    session_id: Option<String>,
) -> Result<NativeCaptureState, String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;

    if let Some(expected_id) = session_id.as_deref() {
        if let Some(session) = guard.as_ref() {
            if session.state.session_id.as_deref() != Some(expected_id) {
                return Err("Sessão de captura nativa inválida".to_string());
            }
        }
    }

    let previous = guard.take();
    let stopped = NativeCaptureState {
        state: "idle".to_string(),
        session_id: previous.as_ref().and_then(|s| s.state.session_id.clone()),
        source_id: previous.as_ref().and_then(|s| s.state.source_id.clone()),
        source_type: previous.as_ref().and_then(|s| s.state.source_type.clone()),
        audio_mode: previous.as_ref().and_then(|s| s.state.audio_mode.clone()),
        width: previous.as_ref().and_then(|s| s.state.width),
        height: previous.as_ref().and_then(|s| s.state.height),
        dpi: previous.as_ref().and_then(|s| s.state.dpi),
        video_codec: previous.as_ref().and_then(|s| s.state.video_codec.clone()),
        h264_encoder: previous.as_ref().and_then(|s| s.state.h264_encoder.clone()),
        video_rtp_port: previous.as_ref().and_then(|s| s.state.video_rtp_port),
        audio_rtp_port: previous.as_ref().and_then(|s| s.state.audio_rtp_port),
        error: None,
    };
    drop(guard);
    if let Some(mut session) = previous {
        session.viewer_bridges.clear();
        drop(session.local_bridge.take());
        drop(session.fanout.take());
        if let Some(worker) = session.worker.take() {
            worker.stop();
        }
    }
    emit_state(&app, &stopped);
    Ok(stopped)
}

#[cfg(not(test))]
#[tauri::command]
pub fn create_native_capture_peer(
    app: AppHandle,
    session_id: String,
    offer_sdp: String,
) -> Result<NativeCaptureSdp, String> {
    if offer_sdp.len() > 256 * 1024 {
        return Err("Oferta SDP excede o limite permitido".to_string());
    }
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if session.state.state != "live" {
        return Err("A captura nativa ainda não está ativa".to_string());
    }
    crate::system::write_debug_log(&format!(
        "[Capture] create_native_capture_peer: session_id={}, offer_sdp_len={}, pending_candidates_count={}",
        session_id,
        offer_sdp.len(),
        session.pending_local_ice_candidates.len()
    ));

    if session.local_bridge.is_none() {
        let fanout = session
            .fanout
            .as_ref()
            .ok_or_else(|| "Fanout RTP não está ativo".to_string())?;
        let worker = session
            .worker
            .as_ref()
            .ok_or_else(|| "Worker nativo não está ativo".to_string())?;

        let local_video_port = allocate_ephemeral_port()?;
        let local_audio_port = worker
            .audio_rtp_port
            .is_some()
            .then(allocate_ephemeral_port)
            .transpose()?;

        fanout.add_video_target(local_video_port);
        if let Some(ap) = local_audio_port {
            fanout.add_audio_target(ap);
        }

        let bridge = NativeWebRtcBridge::new(
            Some(&app),
            session_id.clone(),
            None,
            local_video_port,
            local_audio_port,
            worker.config.codec,
            Some(&offer_sdp),
            None,
        )?;

        session.local_video_port = Some(local_video_port);
        session.local_audio_port = local_audio_port;
        session.local_bridge = Some(bridge);
    }
    let answer = session
        .local_bridge
        .as_ref()
        .expect("local_bridge initialized")
        .create_answer(&offer_sdp)?;

    crate::system::write_debug_log(&format!(
        "[Capture] create_answer local gerou SDP de resposta ({} bytes). Drenando {} candidatos ICE pendentes...",
        answer.sdp.len(),
        session.pending_local_ice_candidates.len()
    ));

    for (mline_index, candidate) in session.pending_local_ice_candidates.drain(..) {
        if let Err(err) = session
            .local_bridge
            .as_ref()
            .unwrap()
            .add_ice_candidate(mline_index, &candidate)
        {
            crate::system::write_debug_log(&format!(
                "[Capture] Falha ao adicionar candidato ICE retido do preview local: {err}"
            ));
        }
    }

    Ok(answer)
}

#[cfg(not(test))]
#[tauri::command]
pub fn add_native_capture_ice_candidate(
    session_id: String,
    mline_index: u32,
    candidate: String,
) -> Result<(), String> {
    if candidate.len() > 16 * 1024 {
        return Err("Candidato ICE excede o limite permitido".to_string());
    }
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    let expanded = crate::webrtc_bridge::expand_local_candidates(&candidate);
    for cand in expanded {
        crate::system::write_debug_log(&format!(
            "[Capture] add_native_capture_ice_candidate local: mline={}, cand={}",
            mline_index, cand
        ));
        if let Some(bridge) = session.local_bridge.as_ref() {
            let _ = bridge.add_ice_candidate(mline_index, &cand);
        } else {
            session.pending_local_ice_candidates.push((mline_index, cand));
        }
    }
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub fn close_native_capture_peer(session_id: String) -> Result<(), String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if let Some(fanout) = session.fanout.as_ref() {
        if let Some(vp) = session.local_video_port.take() {
            fanout.remove_video_target(vp);
        }
        if let Some(ap) = session.local_audio_port.take() {
            fanout.remove_audio_target(ap);
        }
    }
    let bridge = session.local_bridge.take();
    drop(guard);
    drop(bridge);
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub fn create_native_viewer_peer(
    app: AppHandle,
    session_id: String,
    viewer_id: String,
    offer_sdp: String,
    ice_servers: Option<Vec<String>>,
) -> Result<NativeCaptureSdp, String> {
    if offer_sdp.len() > 256 * 1024 {
        return Err("Oferta SDP excede o limite permitido".to_string());
    }
    if viewer_id.is_empty() || viewer_id.len() > 128 {
        return Err("Identificador de espectador inválido".to_string());
    }
    let (codec, audio_rtp_port_exists) = {
        let mut guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
        if session.state.session_id.as_deref() != Some(session_id.as_str()) {
            return Err("Sessão de captura nativa inválida".to_string());
        }
        if session.state.state != "live" {
            return Err("A captura nativa ainda não está ativa".to_string());
        }

        let fanout = session
            .fanout
            .as_ref()
            .ok_or_else(|| "Fanout RTP não está ativo".to_string())?;
        let worker = session
            .worker
            .as_ref()
            .ok_or_else(|| "Worker nativo não está ativo".to_string())?;

        // Se já existia uma ponte antiga para este espectador, encerre-a
        if let Some(old) = session.viewer_bridges.remove(&viewer_id) {
            fanout.remove_video_target(old.video_port);
            if let Some(ap) = old.audio_port {
                fanout.remove_audio_target(ap);
            }
            drop(old.bridge);
        }

        (worker.config.codec, worker.audio_rtp_port.is_some())
    };

    let viewer_video_port = allocate_ephemeral_port()?;
    let viewer_audio_port = audio_rtp_port_exists
        .then(allocate_ephemeral_port)
        .transpose()?;

    crate::system::write_debug_log(&format!(
        "[Capture] Criando ponte direta webrtcbin para espectador {viewer_id} (video_port={viewer_video_port}, audio_port={viewer_audio_port:?})"
    ));

    let bridge = NativeWebRtcBridge::new(
        Some(&app),
        session_id.clone(),
        Some(viewer_id.clone()),
        viewer_video_port,
        viewer_audio_port,
        codec,
        Some(&offer_sdp),
        ice_servers.as_deref(),
    )?;

    let answer = bridge.create_answer(&offer_sdp)?;

    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;

    if let Some(fanout) = session.fanout.as_ref() {
        fanout.add_video_target(viewer_video_port);
        if let Some(ap) = viewer_audio_port {
            fanout.add_audio_target(ap);
        }
    }

    if let Some(pending) = session.pending_viewer_ice_candidates.remove(&viewer_id) {
        for (mline_index, cand) in pending {
            let _ = bridge.add_ice_candidate(mline_index, &cand);
        }
    }

    session.viewer_bridges.insert(
        viewer_id,
        ViewerBridgeEntry {
            bridge,
            video_port: viewer_video_port,
            audio_port: viewer_audio_port,
        },
    );

    Ok(answer)
}

#[cfg(not(test))]
#[tauri::command]
pub fn add_native_viewer_ice_candidate(
    session_id: String,
    viewer_id: String,
    mline_index: u32,
    candidate: String,
) -> Result<(), String> {
    if candidate.len() > 16 * 1024 {
        return Err("Candidato ICE excede o limite permitido".to_string());
    }
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    let expanded = crate::webrtc_bridge::expand_local_candidates(&candidate);
    for cand in expanded {
        if let Some(entry) = session.viewer_bridges.get(&viewer_id) {
            let _ = entry.bridge.add_ice_candidate(mline_index, &cand);
        } else {
            session
                .pending_viewer_ice_candidates
                .entry(viewer_id.clone())
                .or_default()
                .push((mline_index, cand));
        }
    }
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub fn close_native_viewer_peer(session_id: String, viewer_id: String) -> Result<(), String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if let Some(entry) = session.viewer_bridges.remove(&viewer_id) {
        if let Some(fanout) = session.fanout.as_ref() {
            fanout.remove_video_target(entry.video_port);
            if let Some(ap) = entry.audio_port {
                fanout.remove_audio_target(ap);
            }
        }
        drop(entry.bridge);
    }
    session.pending_viewer_ice_candidates.remove(&viewer_id);
    Ok(())
}
