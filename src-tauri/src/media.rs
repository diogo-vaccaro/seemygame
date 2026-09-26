//! Native media worker backed by the bundled GStreamer command line runtime.
//!
//! The worker deliberately communicates with GStreamer through process
//! arguments, never through a shell. Video stays in the native pipeline:
//! Windows Graphics Capture -> D3D11 -> Media Foundation H.264/H.265 -> RTP.
//! Optional loopback audio follows WASAPI -> Opus -> RTP. The RTP sockets are
//! bound to loopback and are an internal hand-off point for the future native
//! WebRTC bridge; no media bytes cross the Tauri JSON IPC boundary.

use std::env;
use std::io::{BufRead, BufReader};
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const HIGH_PRIORITY_CLASS: u32 = 0x00000080;

use crate::windows_list::ValidatedSource;

const DEFAULT_FPS: u32 = 60;
const DEFAULT_BITRATE_KBPS: u32 = 8_000;
const MIN_BITRATE_KBPS: u32 = 256;
const MAX_BITRATE_KBPS: u32 = 50_000;

const REQUIRED_ELEMENTS: [&str; 9] = [
    "d3d11screencapturesrc",
    "d3d11convert",
    "videorate",
    "wasapi2src",
    "opusenc",
    "rtpjitterbuffer",
    "webrtcbin",
    "mfh264enc",
    "mfh265enc",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Hevc,
    Av1,
}

impl VideoCodec {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "h264" | "avc" => Ok(Self::H264),
            "hevc" | "h265" => Ok(Self::Hevc),
            "av1" => Ok(Self::Av1),
            _ => Err(format!(
                "Codec nativo inválido: {value}; use h264, hevc ou av1"
            )),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
        }
    }

    pub const fn encoding_name(self) -> &'static str {
        match self {
            Self::H264 => "H264",
            Self::Hevc => "H265",
            Self::Av1 => "AV1",
        }
    }

    pub const fn depayloader(self) -> &'static str {
        match self {
            Self::H264 => "rtph264depay",
            Self::Hevc => "rtph265depay",
            Self::Av1 => "rtpav1depay",
        }
    }

    pub const fn payloader(self) -> &'static str {
        match self {
            Self::H264 => "rtph264pay",
            Self::Hevc => "rtph265pay",
            Self::Av1 => "rtpav1pay",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum H264EncoderBackend {
    #[default]
    Auto,
    Nvenc,
    MediaFoundation,
    Cpu,
}

impl H264EncoderBackend {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "nvenc" | "nvd3d11" | "nvd3d11h264enc" | "nvidia" => Ok(Self::Nvenc),
            "mf" | "mediafoundation" | "mfh264enc" => Ok(Self::MediaFoundation),
            "cpu" | "x264" | "x264enc" | "software" => Ok(Self::Cpu),
            _ => Err(format!(
                "Backend de encoder H.264 inválido: {value}; use auto, nvenc, mf ou cpu"
            )),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Nvenc => "nvenc",
            Self::MediaFoundation => "mf",
            Self::Cpu => "cpu",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioMode {
    None,
    System,
    Process,
}

impl AudioMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::System => "system",
            Self::Process => "process",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "none" | "mic" => Ok(Self::None),
            "system" => Ok(Self::System),
            "process" => Ok(Self::Process),
            _ => Err(format!("Modo de áudio nativo inválido: {value}")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MediaWorkerConfig {
    pub codec: VideoCodec,
    pub h264_encoder: H264EncoderBackend,
    pub audio_mode: AudioMode,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub show_cursor: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub gop_size: Option<u32>,
    pub capture_api: Option<String>,
}

impl Default for MediaWorkerConfig {
    fn default() -> Self {
        Self {
            codec: VideoCodec::H264,
            h264_encoder: H264EncoderBackend::Auto,
            audio_mode: AudioMode::None,
            fps: DEFAULT_FPS,
            bitrate_kbps: DEFAULT_BITRATE_KBPS,
            show_cursor: true,
            width: None,
            height: None,
            gop_size: None,
            capture_api: None,
        }
    }
}

impl MediaWorkerConfig {
    pub fn from_environment(
        audio_mode: &str,
        codec_override: Option<&str>,
    ) -> Result<Self, String> {
        let codec = match codec_override {
            Some(value) => VideoCodec::parse(value)?,
            None => match env::var("SEEMYGAME_NATIVE_CODEC") {
                Ok(value) => VideoCodec::parse(&value)?,
                Err(_) => VideoCodec::H264,
            },
        };
        let mut config = Self {
            codec,
            h264_encoder: H264EncoderBackend::Auto,
            audio_mode: AudioMode::parse(audio_mode)?,
            ..Self::default()
        };

        if let Ok(value) = env::var("SEEMYGAME_NATIVE_H264_ENCODER") {
            config.h264_encoder = H264EncoderBackend::parse(&value)?;
        }

        if let Ok(value) = env::var("SEEMYGAME_NATIVE_SHOW_CURSOR") {
            config.show_cursor = !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "false" | "0" | "no" | "off"
            );
        }
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_FPS") {
            config.fps = value
                .parse::<u32>()
                .map_err(|_| "SEEMYGAME_NATIVE_FPS deve ser um inteiro".to_string())?
                .clamp(1, 120);
        }
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_BITRATE_KBPS") {
            config.bitrate_kbps = value
                .parse::<u32>()
                .map_err(|_| "SEEMYGAME_NATIVE_BITRATE_KBPS deve ser um inteiro".to_string())?
                .clamp(MIN_BITRATE_KBPS, MAX_BITRATE_KBPS);
        }
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_WIDTH") {
            if let Ok(w) = value.parse::<u32>() {
                config.width = Some(w.clamp(320, 7680));
            }
        }
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_HEIGHT") {
            if let Ok(h) = value.parse::<u32>() {
                config.height = Some(h.clamp(240, 4320));
            }
        }
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_GOP_SIZE") {
            if let Ok(gop) = value.trim().parse::<u32>() {
                config.gop_size = Some(gop.clamp(10, 240));
            }
        }
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_CAPTURE_API") {
            let api = value.trim().to_ascii_lowercase();
            if api == "dxgi" || api == "wgc" {
                config.capture_api = Some(api);
            }
        }
        Ok(config)
    }
}

#[derive(Debug, Clone)]
pub struct MediaCapabilities {
    pub runtime_available: bool,
    pub video_available: bool,
    pub system_audio_available: bool,
    pub process_audio_available: bool,
    pub h264_available: bool,
    pub nvenc_h264_available: bool,
    pub x264_available: bool,
    pub hevc_available: bool,
    pub av1_available: bool,
    pub webrtc_available: bool,
    pub missing_elements: Vec<String>,
    pub reason: Option<String>,
}

impl MediaCapabilities {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            runtime_available: false,
            video_available: false,
            system_audio_available: false,
            process_audio_available: false,
            h264_available: false,
            nvenc_h264_available: false,
            x264_available: false,
            hevc_available: false,
            av1_available: false,
            webrtc_available: false,
            missing_elements: Vec::new(),
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GStreamerRuntime {
    pub root: PathBuf,
    launch: PathBuf,
    inspect: PathBuf,
}

impl GStreamerRuntime {
    pub fn discover() -> Option<Self> {
        let mut candidates = Vec::new();
        if let Some(value) = env::var_os("SEEMYGAME_GSTREAMER_ROOT") {
            candidates.push(PathBuf::from(value));
        }
        if let Some(value) = env::var_os("GSTREAMER_ROOT_X86_64") {
            candidates.push(PathBuf::from(value));
        }
        if let Ok(exe) = env::current_exe() {
            if let Some(parent) = exe.parent() {
                for ancestor in parent.ancestors().take(7) {
                    candidates.push(ancestor.join("native-media").join("gstreamer"));
                    candidates.push(
                        ancestor
                            .join("resources")
                            .join("native-media")
                            .join("gstreamer"),
                    );
                    candidates.push(
                        ancestor
                            .join("resources")
                            .join("_up_")
                            .join("native-media")
                            .join("gstreamer"),
                    );
                    candidates.push(ancestor.join("_up_").join("native-media").join("gstreamer"));
                    candidates.push(ancestor.join("resources").join("gstreamer"));
                    candidates.push(ancestor.join("gstreamer"));
                }
            }
        }
        candidates.push(PathBuf::from("native-media/gstreamer"));

        candidates.into_iter().find_map(|root| {
            let launch = root.join("bin").join(executable_name("gst-launch-1.0"));
            let inspect = root.join("bin").join(executable_name("gst-inspect-1.0"));
            (launch.is_file() && inspect.is_file()).then_some(Self {
                root,
                launch,
                inspect,
            })
        })
    }

    pub fn probe(&self) -> MediaCapabilities {
        let mut available = Vec::new();
        let mut missing = Vec::new();
        for element in REQUIRED_ELEMENTS {
            if self.inspect_element(element) {
                available.push(element);
            } else {
                missing.push(element.to_string());
            }
        }

        let has = |element: &str| available.contains(&element);
        let h264_available = has("mfh264enc");
        let nvenc_h264_available = self.inspect_element("nvd3d11h264enc");
        let x264_available = self.inspect_element("x264enc");
        let hevc_available = has("mfh265enc");
        let av1_available = self.inspect_element("svtav1enc")
            && self.inspect_element("av1parse")
            && self.inspect_element("rtpav1pay");
        let video_available = has("d3d11screencapturesrc")
            && has("d3d11convert")
            && (h264_available || nvenc_h264_available || x264_available || hevc_available || av1_available);
        let system_audio_available = has("wasapi2src") && has("opusenc");
        let process_audio_available = system_audio_available && process_loopback_supported();
        let webrtc_available = has("webrtcbin");
        let reason = if missing.is_empty() {
            None
        } else {
            Some(format!(
                "Plugins GStreamer ausentes: {}",
                missing.join(", ")
            ))
        };

        MediaCapabilities {
            runtime_available: true,
            video_available,
            system_audio_available,
            process_audio_available,
            h264_available,
            nvenc_h264_available,
            x264_available,
            hevc_available,
            av1_available,
            webrtc_available,
            missing_elements: missing,
            reason,
        }
    }

    /// Makes the packaged runtime visible to in-process GStreamer bindings.
    /// The worker subprocess receives the same variables through
    /// `configure_environment`; the WebRTC bridge needs them in this process.
    pub fn prepare_process_environment(&self) {
        static PREPARED: OnceLock<()> = OnceLock::new();
        PREPARED.get_or_init(|| {
            let bin = self.root.join("bin");
            let lib = self.root.join("lib");
            let plugins = lib.join("gstreamer-1.0");
            std::env::set_var("GST_PLUGIN_PATH_1_0", &plugins);
            std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &plugins);
            let mut path_entries = vec![bin, lib];
            if let Some(existing) = env::var_os("PATH") {
                for p in env::split_paths(&existing) {
                    if !path_entries.contains(&p) {
                        path_entries.push(p);
                    }
                }
            }
            if let Ok(path) = env::join_paths(path_entries) {
                std::env::set_var("PATH", path);
            }
        });
    }

    fn inspect_element(&self, element: &str) -> bool {
        self.prepare_process_environment();
        if gstreamer::init().is_ok() && gstreamer::ElementFactory::find(element).is_some() {
            return true;
        }
        let mut command = Command::new(&self.inspect);
        command
            .arg(element)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_environment(&mut command, &self.root);
        command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.launch);
        configure_environment(&mut command, &self.root);
        command
    }
}

#[derive(Debug)]
pub struct NativeMediaWorker {
    runtime: GStreamerRuntime,
    child: Option<Child>,
    // Mantém as portas escolhidas ocupadas até a ponte `udpsrc` ser criada.
    // Isso reduz a janela em que outro processo poderia tomar a porta entre
    // a alocação e a abertura do receptor RTP.
    rtp_port_leases: Vec<UdpSocket>,
    pub config: MediaWorkerConfig,
    pub video_rtp_port: u16,
    pub audio_rtp_port: Option<u16>,
}

impl NativeMediaWorker {
    pub fn resolve_and_validate_config(
        config: MediaWorkerConfig,
        source: &ValidatedSource,
    ) -> Result<(GStreamerRuntime, MediaWorkerConfig), String> {
        validate_source(source)?;
        let runtime = GStreamerRuntime::discover().ok_or_else(|| {
            "Runtime GStreamer empacotado não encontrado; execute tools/prepare-native-media.ps1"
                .to_string()
        })?;
        let capabilities = runtime.probe();
        if !capabilities.video_available {
            return Err(capabilities.reason.unwrap_or_else(|| {
                "GStreamer não possui captura WGC e encoder H.264/H.265/AV1 disponíveis".to_string()
            }));
        }
        let mut resolved_config = config;
        if resolved_config.codec == VideoCodec::H264 {
            resolved_config.h264_encoder = match resolved_config.h264_encoder {
                H264EncoderBackend::Auto => {
                    if capabilities.nvenc_h264_available {
                        log::info!("[Capture] Encoder H.264 selecionado: NVCODEC (nvd3d11h264enc)");
                        #[cfg(not(test))]
                        crate::system::write_debug_log("[Capture] Encoder H.264 selecionado: NVCODEC (nvd3d11h264enc)");
                        H264EncoderBackend::Nvenc
                    } else if capabilities.h264_available {
                        log::info!("[Capture] Encoder H.264 selecionado: Media Foundation (mfh264enc)");
                        #[cfg(not(test))]
                        crate::system::write_debug_log("[Capture] Encoder H.264 selecionado: Media Foundation (mfh264enc)");
                        H264EncoderBackend::MediaFoundation
                    } else if capabilities.x264_available {
                        log::info!("[Capture] Encoder H.264 selecionado: CPU (x264enc)");
                        #[cfg(not(test))]
                        crate::system::write_debug_log("[Capture] Encoder H.264 selecionado: CPU (x264enc)");
                        H264EncoderBackend::Cpu
                    } else {
                        return Err("Nenhum encoder H.264 (nvd3d11h264enc, mfh264enc ou x264enc) disponível".to_string());
                    }
                }
                H264EncoderBackend::Nvenc => {
                    if !capabilities.nvenc_h264_available {
                        return Err("Encoder NVENC (nvd3d11h264enc) foi requisitado mas não está disponível".to_string());
                    }
                    #[cfg(not(test))]
                    crate::system::write_debug_log("[Capture] Encoder H.264 forçado: NVCODEC (nvd3d11h264enc)");
                    H264EncoderBackend::Nvenc
                }
                H264EncoderBackend::MediaFoundation => {
                    if !capabilities.h264_available {
                        return Err("Encoder Media Foundation (mfh264enc) foi requisitado mas não está disponível".to_string());
                    }
                    #[cfg(not(test))]
                    crate::system::write_debug_log("[Capture] Encoder H.264 forçado: Media Foundation (mfh264enc)");
                    H264EncoderBackend::MediaFoundation
                }
                H264EncoderBackend::Cpu => {
                    if !capabilities.x264_available {
                        return Err("Encoder CPU (x264enc) foi requisitado mas não está disponível".to_string());
                    }
                    #[cfg(not(test))]
                    crate::system::write_debug_log("[Capture] Encoder H.264 forçado: CPU (x264enc)");
                    H264EncoderBackend::Cpu
                }
            };
        } else if resolved_config.codec == VideoCodec::Hevc && !capabilities.hevc_available {
            return Err("O encoder HEVC/H.265 (mfh265enc) não está disponível".to_string());
        } else if resolved_config.codec == VideoCodec::Av1 && !capabilities.av1_available {
            return Err("O encoder AV1 (svtav1enc) não está disponível".to_string());
        }
        #[cfg(not(test))]
        if resolved_config.codec == VideoCodec::H264 {
            crate::system::write_debug_log(&format!("[Capture] Encoder H.264 ativo: {}", resolved_config.h264_encoder.as_str()));
        }
        if resolved_config.audio_mode != AudioMode::None && !capabilities.system_audio_available {
            return Err("O áudio loopback WASAPI/Opus não está disponível".to_string());
        }
        if resolved_config.audio_mode == AudioMode::Process && !capabilities.process_audio_available {
            if capabilities.system_audio_available {
                log::warn!("[Capture] Áudio por processo não suportado neste Windows build. Fazendo fallback para áudio do sistema (WASAPI loopback).");
                #[cfg(not(test))]
                crate::system::write_debug_log("[Capture] Áudio por processo não suportado (build < 20348). Fallback para áudio do sistema.");
                resolved_config.audio_mode = AudioMode::System;
            } else {
                return Err(
                    "Áudio por processo exige Windows build 20348+ e loopback WASAPI disponível"
                        .to_string(),
                );
            }
        }
        if resolved_config.audio_mode == AudioMode::Process && source.process_id.is_none() {
            if capabilities.system_audio_available {
                log::warn!("[Capture] Janela sem PID validado. Fazendo fallback para áudio do sistema.");
                #[cfg(not(test))]
                crate::system::write_debug_log("[Capture] Janela sem PID. Fallback para áudio do sistema.");
                resolved_config.audio_mode = AudioMode::System;
            } else {
                return Err("Áudio do processo exige uma fonte de janela com PID validado".to_string());
            }
        }
        Ok((runtime, resolved_config))
    }

    fn spawn_child(
        runtime: &GStreamerRuntime,
        source: &ValidatedSource,
        config: &MediaWorkerConfig,
        video_rtp_port: u16,
        audio_rtp_port: Option<u16>,
    ) -> Result<std::process::Child, String> {
        let args = build_pipeline(source, config, video_rtp_port, audio_rtp_port)?;
        #[cfg(windows)]
        if let Some(hwnd) = source.hwnd {
            unsafe {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
                let _ = ShowWindow(HWND(hwnd as *mut _), SW_SHOWNOACTIVATE);
            }
        }
        #[cfg(not(test))]
        crate::system::write_debug_log(&format!(
            "[GStreamer Pipeline] gst-launch-1.0 {}",
            args.join(" ")
        ));
        let mut command = runtime.command();
        command
            .arg("-e")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Falha ao iniciar worker GStreamer: {error}"))?;
        #[cfg(windows)]
        assign_child_to_job_object(&child);
        if let Some(stdout) = child.stdout.take() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::new();
                while let Ok(n) = reader.read_until(b'\n', &mut buf) {
                    if n == 0 { break; }
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    buf.clear();
                    log::info!("[GStreamer worker stdout] {line}");
                    #[cfg(not(test))]
                    crate::system::write_debug_log(&format!("[GStreamer worker stdout] {line}"));
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::new();
                while let Ok(n) = reader.read_until(b'\n', &mut buf) {
                    if n == 0 { break; }
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    buf.clear();
                    log::warn!("[GStreamer worker] {line}");
                    #[cfg(not(test))]
                    crate::system::write_debug_log(&format!("[GStreamer worker] {line}"));
                    #[cfg(test)]
                    eprintln!("[GStreamer worker] {line}");
                }
                #[cfg(not(test))]
                crate::system::write_debug_log("[GStreamer worker] stderr stream encerrado (processo fechou stderr)");
            });
        }
        Ok(child)
    }

    pub fn start(source: &ValidatedSource, config: MediaWorkerConfig) -> Result<Self, String> {
        let (runtime, resolved_config) = Self::resolve_and_validate_config(config, source)?;
        let (video_rtp_port, video_lease) = allocate_loopback_port()?;
        let audio_port_and_lease = (resolved_config.audio_mode != AudioMode::None)
            .then(allocate_loopback_port)
            .transpose()?;
        let audio_rtp_port = audio_port_and_lease.as_ref().map(|(port, _)| *port);
        let mut rtp_port_leases = vec![video_lease];
        if let Some((_, lease)) = audio_port_and_lease {
            rtp_port_leases.push(lease);
        }
        let child = Self::spawn_child(&runtime, source, &resolved_config, video_rtp_port, audio_rtp_port)?;
        let mut worker = Self {
            runtime,
            child: Some(child),
            rtp_port_leases,
            config: resolved_config,
            video_rtp_port,
            audio_rtp_port,
        };
        thread::sleep(Duration::from_millis(150));
        if let Some(status) = worker
            .child
            .as_mut()
            .expect("worker child initialized")
            .try_wait()
            .map_err(|error| format!("Falha ao verificar worker GStreamer: {error}"))?
        {
            return Err(format!("Worker GStreamer encerrou ao iniciar: {status}"));
        }
        Ok(worker)
    }

    pub fn start_with_ports(
        source: &ValidatedSource,
        config: MediaWorkerConfig,
        video_rtp_port: u16,
        audio_rtp_port: Option<u16>,
    ) -> Result<Self, String> {
        let (runtime, resolved_config) = Self::resolve_and_validate_config(config, source)?;
        let child = Self::spawn_child(&runtime, source, &resolved_config, video_rtp_port, audio_rtp_port)?;
        let mut worker = Self {
            runtime,
            child: Some(child),
            rtp_port_leases: Vec::new(),
            config: resolved_config,
            video_rtp_port,
            audio_rtp_port,
        };
        thread::sleep(Duration::from_millis(150));
        if let Some(status) = worker
            .child
            .as_mut()
            .expect("worker child initialized")
            .try_wait()
            .map_err(|error| format!("Falha ao verificar worker GStreamer: {error}"))?
        {
            return Err(format!("Worker GStreamer encerrou ao iniciar: {status}"));
        }
        Ok(worker)
    }

    pub fn restart_audio_mode(
        &mut self,
        source: &ValidatedSource,
        audio_mode: AudioMode,
    ) -> Result<(), String> {
        let mut config = self.config.clone();
        config.audio_mode = audio_mode;
        self.stop_process();
        let mut replacement = Self::start_with_ports(source, config, self.video_rtp_port, self.audio_rtp_port)?;
        self.runtime = replacement.runtime.clone();
        self.child = replacement.child.take();
        self.config = replacement.config.clone();
        self.video_rtp_port = replacement.video_rtp_port;
        self.audio_rtp_port = replacement.audio_rtp_port;
        Ok(())
    }

    pub fn stop(mut self) {
        self.stop_process();
    }

    /// Detecta uma saída assíncrona do gst-launch depois que a captura já foi
    /// marcada como live. Isso permite que o comando de estado e a UI
    /// propaguem a falha em vez de manter uma sessão fantasma.
    pub fn health_error(&mut self) -> Result<(), String> {
        let Some(child) = self.child.as_mut() else {
            return Err("Worker GStreamer não está ativo".to_string());
        };
        match child
            .try_wait()
            .map_err(|error| format!("Falha ao verificar worker GStreamer: {error}"))?
        {
            Some(status) => {
                self.child = None;
                Err(format!(
                    "Worker GStreamer encerrou inesperadamente: {status}"
                ))
            }
            None => Ok(()),
        }
    }

    pub fn release_rtp_port_leases(&mut self) {
        if let Ok(mut guard) = HANDOFF_LEASES.lock() {
            guard.extend(self.rtp_port_leases.drain(..));
        } else {
            self.rtp_port_leases.clear();
        }
    }

    fn stop_process(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
        self.child = None;
        thread::sleep(Duration::from_millis(60));
    }
}

static HANDOFF_LEASES: std::sync::Mutex<Vec<UdpSocket>> = std::sync::Mutex::new(Vec::new());

pub fn clear_handoff_leases() {
    if let Ok(mut guard) = HANDOFF_LEASES.lock() {
        guard.clear();
    }
}

impl Drop for NativeMediaWorker {
    fn drop(&mut self) {
        self.stop_process();
        clear_handoff_leases();
    }
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn configure_environment(command: &mut Command, root: &Path) {
    let bin = root.join("bin");
    let lib = root.join("lib");
    let plugins = lib.join("gstreamer-1.0");
    command
        .current_dir(root)
        .env("GST_PLUGIN_PATH_1_0", &plugins)
        .env("GST_PLUGIN_SYSTEM_PATH_1_0", &plugins);
    command.env("GST_DEBUG_NO_COLOR", "1");
    if let Ok(debug) = env::var("GST_DEBUG") {
        command.env("GST_DEBUG", debug);
    } else {
        command.env("GST_DEBUG", "*:2,webrtc*:3");
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW | HIGH_PRIORITY_CLASS);
    let mut path_entries = vec![bin, lib];
    if let Some(existing) = env::var_os("PATH") {
        for p in env::split_paths(&existing) {
            if !path_entries.contains(&p) {
                path_entries.push(p);
            }
        }
    }
    if let Ok(path) = env::join_paths(path_entries) {
        command.env("PATH", path);
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

fn allocate_loopback_port() -> Result<(u16, UdpSocket), String> {
    let socket = UdpSocket::bind("127.0.0.1:0")
        .map_err(|error| format!("Não foi possível reservar porta RTP local: {error}"))?;
    #[cfg(windows)]
    set_socket_buffer_size(&socket, 2 * 1024 * 1024);
    let port = socket
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Não foi possível ler porta RTP local: {error}"))?;
    Ok((port, socket))
}

fn process_loopback_supported() -> bool {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct OsVersionInfo {
            size: u32,
            major: u32,
            minor: u32,
            build: u32,
            platform: u32,
            service_pack: [u16; 128],
        }

        unsafe extern "system" {
            fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
        }

        let mut info = OsVersionInfo {
            size: std::mem::size_of::<OsVersionInfo>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        unsafe { RtlGetVersion(&mut info) == 0 && info.build >= 20_348 }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn assign_child_to_job_object(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB_OBJECT: OnceLock<Option<isize>> = OnceLock::new();
    let job_opt = JOB_OBJECT.get_or_init(|| {
        unsafe {
            let handle = match CreateJobObjectW(None, None) {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("[JobObject] Falha ao criar Job Object: {e:?}");
                    return None;
                }
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let res = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if let Err(e) = res {
                log::warn!("[JobObject] Falha ao configurar SetInformationJobObject: {e:?}");
            }
            Some(handle.0 as isize)
        }
    });

    if let Some(stored) = *job_opt {
        unsafe {
            let job_handle = HANDLE(stored as *mut std::ffi::c_void);
            let proc_handle = HANDLE(child.as_raw_handle());
            let _ = windows::Win32::System::Threading::SetPriorityClass(
                proc_handle,
                windows::Win32::System::Threading::HIGH_PRIORITY_CLASS,
            );
            if let Err(e) = AssignProcessToJobObject(job_handle, proc_handle) {
                log::warn!("[JobObject] Falha ao associar processo ao Job Object: {e:?}");
            } else {
                log::info!("[JobObject] Processo worker GStreamer associado ao Job Object com HIGH_PRIORITY_CLASS");
            }
        }
    }
}

fn validate_source(source: &ValidatedSource) -> Result<(), String> {
    match source.source_type.as_str() {
        "window" if source.hwnd.is_some() => Ok(()),
        "monitor" if source.monitor_handle.is_some() => Ok(()),
        "window" => Err("Fonte de janela sem HWND validado".to_string()),
        "monitor" => Err("Fonte de monitor sem HMONITOR validado".to_string()),
        _ => Err("Tipo de fonte nativo inválido".to_string()),
    }
}

fn build_pipeline(
    source: &ValidatedSource,
    config: &MediaWorkerConfig,
    video_rtp_port: u16,
    audio_rtp_port: Option<u16>,
) -> Result<Vec<String>, String> {
    let capture_api = if source.hwnd.is_some() {
        "wgc"
    } else {
        config.capture_api.as_deref().unwrap_or("wgc")
    };
    let gop_size = config
        .gop_size
        .unwrap_or_else(|| (config.fps / 2).clamp(15, 30));

    let mut args = vec![
        "d3d11screencapturesrc".to_string(),
        format!("capture-api={capture_api}"),
        "do-timestamp=true".to_string(),
    ];
    if let Some(hwnd) = source.hwnd {
        args.push(format!("window-handle={}", hwnd as u64));
        let win_mode = env::var("SEEMYGAME_NATIVE_WINDOW_CAPTURE_MODE")
            .unwrap_or_else(|_| "default".to_string());
        args.push(format!("window-capture-mode={win_mode}"));
        args.push("automatic-eos=false".to_string());
    } else if let Some(monitor) = source.monitor_handle {
        args.push(format!("monitor-handle={}", monitor as u64));
    } else {
        return Err("A fonte não possui um identificador nativo validado".to_string());
    }
    let cursor_arg = if config.show_cursor {
        "show-cursor=true"
    } else {
        "show-cursor=false"
    };

    let (target_w, target_h) = match (config.width, config.height) {
        (Some(w), Some(h)) => {
            // Never upscale a window/monitor capture beyond its native dimensions.
            // When source dimensions are known and smaller than target, preserve native resolution.
            if source.width > 0 && source.height > 0 && (source.width < w || source.height < h) {
                (Some(source.width & !1), Some(source.height & !1))
            } else {
                (Some(w & !1), Some(h & !1))
            }
        }
        (Some(w), None) => (Some(w & !1), None),
        (None, Some(h)) => (None, Some(h & !1)),
        (None, None) => (None, None),
    };

    let resolution_caps = match (target_w, target_h) {
        (Some(w), Some(h)) => format!(",width={w},height={h}"),
        (Some(w), None) => format!(",width={w}"),
        (None, Some(h)) => format!(",height={h}"),
        (None, None) => String::new(),
    };

    let convert_format = if config.codec == VideoCodec::Av1
        || config.h264_encoder == H264EncoderBackend::Cpu
    {
        "I420"
    } else {
        "NV12"
    };

    args.extend([
        cursor_arg.to_string(),
        "!".to_string(),
        "video/x-raw(memory:D3D11Memory),format=BGRA".to_string(),
        "!".to_string(),
        "queue".to_string(),
        "max-size-buffers=3".to_string(),
        "max-size-time=50000000".to_string(),
        "max-size-bytes=0".to_string(),
        "!".to_string(),
        "videorate".to_string(),
        "drop-only=true".to_string(),
        "!".to_string(),
        format!(
            "video/x-raw(memory:D3D11Memory),framerate={}/1",
            config.fps
        ),
        "!".to_string(),
        "d3d11convert".to_string(),
        "!".to_string(),
        format!(
            "video/x-raw(memory:D3D11Memory),format={convert_format},framerate={}/1{resolution_caps}",
            config.fps
        ),
        "!".to_string(),
        "queue".to_string(),
        "max-size-buffers=3".to_string(),
        "max-size-time=50000000".to_string(),
        "max-size-bytes=0".to_string(),
        "!".to_string(),
    ]);

    match config.codec {
        VideoCodec::H264 => {
            if config.h264_encoder == H264EncoderBackend::Cpu {
                args.extend([
                    "d3d11download".to_string(),
                    "!".to_string(),
                    format!(
                        "video/x-raw,format=I420,framerate={}/1{resolution_caps}",
                        config.fps
                    ),
                    "!".to_string(),
                    "x264enc".to_string(),
                    format!("bitrate={}", config.bitrate_kbps),
                    "tune=zerolatency".to_string(),
                    "speed-preset=ultrafast".to_string(),
                    format!("key-int-max={gop_size}"),
                    "bframes=0".to_string(),
                    "ref=1".to_string(),
                    "!".to_string(),
                    "video/x-h264,profile=constrained-baseline".to_string(),
                    "!".to_string(),
                    "h264parse".to_string(),
                    "config-interval=-1".to_string(),
                    "!".to_string(),
                    "rtph264pay".to_string(),
                    "pt=96".to_string(),
                    "config-interval=-1".to_string(),
                    "aggregate-mode=zero-latency".to_string(),
                ]);
            } else if config.h264_encoder == H264EncoderBackend::Nvenc {
                args.extend([
                    "nvd3d11h264enc".to_string(),
                    format!("bitrate={}", config.bitrate_kbps),
                    format!("gop-size={gop_size}"),
                    "rc-mode=cbr".to_string(),
                    "tune=ultra-low-latency".to_string(),
                    "zerolatency=true".to_string(),
                    "repeat-sequence-header=true".to_string(),
                    "preset=p1".to_string(),
                    "bframes=0".to_string(),
                    "strict-gop=false".to_string(),
                    "aud=false".to_string(),
                    "cabac=false".to_string(),
                    "!".to_string(),
                    "video/x-h264,profile=constrained-baseline".to_string(),
                    "!".to_string(),
                    "h264parse".to_string(),
                    "config-interval=-1".to_string(),
                    "!".to_string(),
                    "rtph264pay".to_string(),
                    "pt=96".to_string(),
                    "config-interval=-1".to_string(),
                    "aggregate-mode=zero-latency".to_string(),
                ]);
            } else {
                args.extend([
                    "mfh264enc".to_string(),
                    format!("bitrate={}", config.bitrate_kbps),
                    format!("gop-size={gop_size}"),
                    "low-latency=true".to_string(),
                    "rc-mode=cbr".to_string(),
                    "quality-vs-speed=0".to_string(),
                    "ref=1".to_string(),
                    "!".to_string(),
                    // Keep the stream in the browser-compatible H.264 profile. The
                    // Media Foundation encoder negotiates this through caps (it is
                    // not an encoder property).
                    "video/x-h264,profile=constrained-baseline".to_string(),
                    "!".to_string(),
                    "h264parse".to_string(),
                    "config-interval=-1".to_string(),
                    "!".to_string(),
                    "rtph264pay".to_string(),
                    "pt=96".to_string(),
                    "config-interval=-1".to_string(),
                    "aggregate-mode=zero-latency".to_string(),
                ]);
            }
        }
        VideoCodec::Hevc => args.extend([
            "mfh265enc".to_string(),
            format!("bitrate={}", config.bitrate_kbps),
            format!("gop-size={gop_size}"),
            "low-latency=true".to_string(),
            "rc-mode=cbr".to_string(),
            "quality-vs-speed=0".to_string(),
            "ref=1".to_string(),
            "!".to_string(),
            "h265parse".to_string(),
            "config-interval=-1".to_string(),
            "!".to_string(),
            "rtph265pay".to_string(),
            "pt=98".to_string(),
            "config-interval=-1".to_string(),
        ]),
        VideoCodec::Av1 => args.extend([
            "d3d11download".to_string(),
            "!".to_string(),
            format!("video/x-raw,format=I420,framerate={}/1{resolution_caps}", config.fps),
            "!".to_string(),
            "svtav1enc".to_string(),
            format!("target-bitrate={}", config.bitrate_kbps),
            "parameters-string=rc=2:pred-struct=1".to_string(),
            "preset=11".to_string(),
            format!("intra-period-length={}", (config.fps / 2).clamp(15, 30)),
            "intra-refresh-type=IDR".to_string(),
            "!".to_string(),
            "av1parse".to_string(),
            "!".to_string(),
            "rtpav1pay".to_string(),
            "pt=99".to_string(),
        ]),
    }
    args.extend([
        "!".to_string(),
        "udpsink".to_string(),
        "host=127.0.0.1".to_string(),
        format!("port={video_rtp_port}"),
        "sync=false".to_string(),
        "async=false".to_string(),
        "buffer-size=2097152".to_string(),
    ]);

    if config.audio_mode != AudioMode::None {
        if let Some(audio_rtp_port) = audio_rtp_port {
            args.extend([
                "wasapi2src".to_string(),
            "loopback=true".to_string(),
            "low-latency=true".to_string(),
            "do-timestamp=true".to_string(),
            "loopback-silence-on-device-mute=true".to_string(),
        ]);
        if config.audio_mode == AudioMode::Process {
            let pid = source
                .process_id
                .ok_or_else(|| "Áudio do processo exige PID validado".to_string())?;
            args.extend([
                "loopback-mode=include-process-tree".to_string(),
                format!("loopback-target-pid={pid}"),
            ]);
        }
        args.extend([
            "!".to_string(),
            "queue".to_string(),
            "max-size-buffers=0".to_string(),
            "max-size-time=100000000".to_string(),
            "max-size-bytes=0".to_string(),
            "!".to_string(),
            "audioconvert".to_string(),
            "!".to_string(),
            "audioresample".to_string(),
            "!".to_string(),
            "audio/x-raw,format=S16LE,rate=48000,channels=2".to_string(),
            "!".to_string(),
            "opusenc".to_string(),
            "bitrate=128000".to_string(),
            "audio-type=restricted-lowdelay".to_string(),
            "perfect-timestamp=true".to_string(),
            "inband-fec=true".to_string(),
            "packet-loss-percentage=10".to_string(),
            "!".to_string(),
            "rtpopuspay".to_string(),
            "pt=111".to_string(),
            "!".to_string(),
            "udpsink".to_string(),
            "host=127.0.0.1".to_string(),
            format!("port={audio_rtp_port}"),
            "sync=false".to_string(),
            "async=false".to_string(),
        ]);
        }
    }

    Ok(args)
}

static CACHED_CAPABILITIES: OnceLock<MediaCapabilities> = OnceLock::new();

pub fn probe_capabilities() -> MediaCapabilities {
    CACHED_CAPABILITIES
        .get_or_init(|| {
            GStreamerRuntime::discover()
                .map(|runtime| runtime.probe())
                .unwrap_or_else(|| {
                    MediaCapabilities::unavailable(
                        "Runtime GStreamer empacotado não encontrado; execute tools/prepare-native-media.ps1",
                    )
                })
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_r04_port_lease_excludes_competitor_until_drop() {
        let (video, lease) = allocate_loopback_port().unwrap();
        let (audio, audio_lease) = allocate_loopback_port().unwrap();
        assert_ne!(video, audio);
        assert!(UdpSocket::bind(("127.0.0.1", video)).is_err());
        drop(lease);
        assert!(UdpSocket::bind(("127.0.0.1", video)).is_ok());
        drop(audio_lease);
    }

    #[test]
    fn review_r04_handoff_does_not_expose_port_to_competitor() {
        let (port, lease) = allocate_loopback_port().unwrap();
        let mut worker = NativeMediaWorker {
            runtime: GStreamerRuntime::discover().unwrap(), child: None,
            rtp_port_leases: vec![lease], config: MediaWorkerConfig::default(),
            video_rtp_port: port, audio_rtp_port: None,
        };
        // Exercise the exact hand-off currently called by capture.rs before
        // bridge construction; a competing binder must never get ownership.
        worker.release_rtp_port_leases();
        assert!(UdpSocket::bind(("127.0.0.1", port)).is_err(), "R04: porta desprotegida durante handoff");
    }

    #[test]
    fn test_start_with_ports_preserves_assigned_loopback_endpoints() {
        let test_src = source("window");
        let config = MediaWorkerConfig {
            codec: VideoCodec::H264,
            audio_mode: AudioMode::System,
            bitrate_kbps: 4500,
            width: Some(1280),
            height: Some(720),
            fps: 60,
            ..Default::default()
        };
        let (_runtime, resolved) = NativeMediaWorker::resolve_and_validate_config(config, &test_src).unwrap();
        assert_eq!(resolved.width, Some(1280));
        assert_eq!(resolved.height, Some(720));
        assert_eq!(resolved.bitrate_kbps, 4500);
        let args = build_pipeline(&test_src, &resolved, 5555, Some(6666)).unwrap();
        assert!(args.iter().any(|a| a.contains("port=5555")));
        assert!(args.iter().any(|a| a.contains("port=6666")));

        // R1: Verifica que se audio_mode for None, nenhum branch de áudio é montado
        let config_none = MediaWorkerConfig {
            codec: VideoCodec::H264,
            audio_mode: AudioMode::None,
            ..Default::default()
        };
        let (_runtime, resolved_none) = NativeMediaWorker::resolve_and_validate_config(config_none, &test_src).unwrap();
        let args_none = build_pipeline(&test_src, &resolved_none, 5555, Some(6666)).unwrap();
        assert!(args_none.iter().any(|a| a.contains("port=5555")));
        assert!(!args_none.iter().any(|a| a.contains("port=6666")));
        assert!(!args_none.iter().any(|a| a.contains("wasapi2src")));
    }

    static TEST_GPU_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn review_av1_actual_conversion_pipeline_negotiates() {
        let _gpu_lock = TEST_GPU_MUTEX.lock().unwrap();
        use gstreamer::prelude::*;
        let runtime = GStreamerRuntime::discover().expect("GStreamer requerido pelo teste AV1");
        runtime.prepare_process_environment();
        gstreamer::init().unwrap();
        let config = MediaWorkerConfig { codec: VideoCodec::Av1, ..Default::default() };
        let args = build_pipeline(&source("window"), &config, 5000, None).unwrap();
        // Preserve the production conversion/encoder chain, replacing only
        // screen input and UDP output with finite synthetic input/fakesink.
        let begin = args.iter().position(|s| s.starts_with("video/x-raw(")).unwrap();
        let end = args.iter().position(|s| s == "udpsink").unwrap() - 1;
        let description = format!("videotestsrc num-buffers=4 ! video/x-raw,format=BGRA,width=320,height=240,framerate=60/1 ! d3d11upload ! {} ! fakesink sync=false", args[begin..end].join(" "));
        let pipeline = gstreamer::parse::launch(&description).expect("AV1 deve negociar formatos reais");
        let result = (|| {
            pipeline.set_state(gstreamer::State::Playing).map_err(|e| format!("{e:?}"))?;
            let bus = pipeline.bus().unwrap();
            let message = bus.timed_pop_filtered(gstreamer::ClockTime::from_seconds(15), &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error]).ok_or("timeout AV1")?;
            match message.view() { gstreamer::MessageView::Eos(..) => Ok(()), other => Err(format!("{other:?}")) }
        })();
        let _ = pipeline.set_state(gstreamer::State::Null);
        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn review_h264_actual_conversion_pipeline_negotiates() {
        let _gpu_lock = TEST_GPU_MUTEX.lock().unwrap();
        use gstreamer::prelude::*;
        let runtime = GStreamerRuntime::discover().expect("GStreamer requerido pelo teste H264");
        runtime.prepare_process_environment();
        gstreamer::init().unwrap();
        let config = MediaWorkerConfig { codec: VideoCodec::H264, ..Default::default() };
        let args = build_pipeline(&source("window"), &config, 5000, None).unwrap();
        let begin = args.iter().position(|s| s.starts_with("video/x-raw(")).unwrap();
        let end = args.iter().position(|s| s == "udpsink").unwrap() - 1;
        let description = format!("videotestsrc num-buffers=4 ! video/x-raw,format=BGRA,width=320,height=240,framerate=60/1 ! d3d11upload ! {} ! fakesink sync=false", args[begin..end].join(" "));
        let pipeline = gstreamer::parse::launch(&description).expect("H264 deve negociar formatos reais");
        let result = (|| {
            pipeline.set_state(gstreamer::State::Playing).map_err(|e| format!("{e:?}"))?;
            let bus = pipeline.bus().unwrap();
            let message = bus.timed_pop_filtered(gstreamer::ClockTime::from_seconds(15), &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error]).ok_or("timeout H264")?;
            match message.view() { gstreamer::MessageView::Eos(..) => Ok(()), other => Err(format!("{other:?}")) }
        })();
        let _ = pipeline.set_state(gstreamer::State::Null);
        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn review_nvenc_actual_conversion_pipeline_negotiates() {
        let _gpu_lock = TEST_GPU_MUTEX.lock().unwrap();
        use gstreamer::prelude::*;
        let runtime = match GStreamerRuntime::discover() {
            Some(r) => r,
            None => return,
        };
        runtime.prepare_process_environment();
        gstreamer::init().unwrap();
        if !runtime.probe().nvenc_h264_available {
            return;
        }
        let config = MediaWorkerConfig {
            codec: VideoCodec::H264,
            h264_encoder: H264EncoderBackend::Nvenc,
            ..Default::default()
        };
        let args = build_pipeline(&source("window"), &config, 5000, None).unwrap();
        let begin = args.iter().position(|s| s.starts_with("video/x-raw(")).unwrap();
        let end = args.iter().position(|s| s == "udpsink").unwrap() - 1;
        let description = format!("videotestsrc num-buffers=4 ! video/x-raw,format=BGRA,width=320,height=240,framerate=60/1 ! d3d11upload ! {} ! fakesink sync=false", args[begin..end].join(" "));
        let pipeline = gstreamer::parse::launch(&description).expect("NVENC H264 deve negociar formatos reais");
        let result = (|| {
            pipeline.set_state(gstreamer::State::Playing).map_err(|e| format!("{e:?}"))?;
            let bus = pipeline.bus().unwrap();
            let message = bus.timed_pop_filtered(gstreamer::ClockTime::from_seconds(15), &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error]).ok_or("timeout NVENC")?;
            match message.view() {
                gstreamer::MessageView::Eos(..) => Ok(()),
                gstreamer::MessageView::Error(err) => {
                    let debug = err.debug().map(|d| d.to_string()).unwrap_or_default();
                    if debug.contains("Failed to open session") {
                        eprintln!("[INFO] NVENC hardware session não disponível neste ambiente de teste ({debug})");
                        return Ok(());
                    }
                    Err(format!("{err:?}"))
                }
                other => Err(format!("{other:?}"))
            }
        })();
        let _ = pipeline.set_state(gstreamer::State::Null);
        assert!(result.is_ok(), "{result:?}");
    }

    fn source(source_type: &str) -> ValidatedSource {
        ValidatedSource {
            source_id: "test".to_string(),
            source_type: source_type.to_string(),
            title: "Test".to_string(),
            process_id: Some(42),
            hwnd: (source_type == "window").then_some(1234),
            monitor_id: Some("\\\\.\\DISPLAY1".to_string()),
            monitor_handle: (source_type == "monitor").then_some(5678),
            width: 1280,
            height: 720,
            dpi: 96,
            left: 0,
            top: 0,
        }
    }

    #[test]
    fn builds_h264_window_pipeline_without_shell_quoting() {
        let args =
            build_pipeline(&source("window"), &MediaWorkerConfig::default(), 5000, None).unwrap();
        assert!(args.iter().any(|arg| arg == "mfh264enc"));
        assert!(args.iter().any(|arg| arg == "window-handle=1234"));
        assert!(args.iter().any(|arg| arg == "rtph264pay"));
        assert!(args.iter().all(|arg| !arg.contains('"')));
    }

    #[test]
    fn builds_h264_window_pipeline_with_nvenc() {
        let args = build_pipeline(
            &source("window"),
            &MediaWorkerConfig {
                codec: VideoCodec::H264,
                h264_encoder: H264EncoderBackend::Nvenc,
                ..MediaWorkerConfig::default()
            },
            5000,
            None,
        )
        .unwrap();
        assert!(args.iter().any(|arg| arg == "nvd3d11h264enc"));
        assert!(args.iter().any(|arg| arg == "tune=ultra-low-latency"));
        assert!(args.iter().any(|arg| arg == "zerolatency=true"));
        assert!(args.iter().any(|arg| arg == "repeat-sequence-header=true"));
        assert!(args.iter().any(|arg| arg == "rc-mode=cbr"));
        assert!(args.iter().any(|arg| arg == "window-handle=1234"));
        assert!(args.iter().any(|arg| arg == "video/x-h264,profile=constrained-baseline"));
        assert!(args.iter().any(|arg| arg == "rtph264pay"));
        assert!(args.iter().all(|arg| !arg.contains('"')));
    }

    #[test]
    fn builds_hevc_monitor_process_audio_pipeline() {
        let args = build_pipeline(
            &source("monitor"),
            &MediaWorkerConfig {
                codec: VideoCodec::Hevc,
                audio_mode: AudioMode::Process,
                ..MediaWorkerConfig::default()
            },
            5000,
            Some(5001),
        )
        .unwrap();
        assert!(args.iter().any(|arg| arg == "mfh265enc"));
        assert!(args.iter().any(|arg| arg == "monitor-handle=5678"));
        assert!(args
            .iter()
            .any(|arg| arg == "loopback-mode=include-process-tree"));
        assert!(args.iter().any(|arg| arg == "loopback-target-pid=42"));
        assert!(args.iter().any(|arg| arg == "audio-type=restricted-lowdelay"));
        assert!(args.iter().any(|arg| arg == "perfect-timestamp=true"));
        assert!(args.iter().all(|arg| arg != "hard-resync=true"));
        assert!(args.iter().any(|arg| arg == "rtph265pay"));
    }

    #[test]
    fn builds_h264_window_pipeline_with_cpu_x264() {
        let args = build_pipeline(
            &source("window"),
            &MediaWorkerConfig {
                codec: VideoCodec::H264,
                h264_encoder: H264EncoderBackend::Cpu,
                ..MediaWorkerConfig::default()
            },
            5000,
            None,
        )
        .unwrap();
        assert!(args.iter().any(|arg| arg == "d3d11download"));
        assert!(args.iter().any(|arg| arg == "x264enc"));
        assert!(args.iter().any(|arg| arg == "tune=zerolatency"));
        assert!(args.iter().any(|arg| arg == "speed-preset=ultrafast"));
        assert!(args.iter().any(|arg| arg == "key-int-max=30"));
        assert!(args.iter().any(|arg| arg == "bframes=0"));
        assert!(args.iter().any(|arg| arg == "window-handle=1234"));
        assert!(args.iter().any(|arg| arg == "video/x-h264,profile=constrained-baseline"));
        assert!(args.iter().any(|arg| arg == "rtph264pay"));
        assert!(args.iter().all(|arg| !arg.contains('"')));
    }

    #[test]
    fn respects_custom_gop_size() {
        let args = build_pipeline(
            &source("window"),
            &MediaWorkerConfig {
                gop_size: Some(45),
                ..MediaWorkerConfig::default()
            },
            5000,
            None,
        )
        .unwrap();
        assert!(args.iter().any(|arg| arg == "gop-size=45"));
    }

    #[test]
    fn supports_dxgi_for_monitor_and_falls_back_to_wgc_for_window() {
        let monitor_args = build_pipeline(
            &source("monitor"),
            &MediaWorkerConfig {
                capture_api: Some("dxgi".to_string()),
                ..MediaWorkerConfig::default()
            },
            5000,
            None,
        )
        .unwrap();
        assert!(monitor_args.iter().any(|arg| arg == "capture-api=dxgi"));

        let window_args = build_pipeline(
            &source("window"),
            &MediaWorkerConfig {
                capture_api: Some("dxgi".to_string()),
                ..MediaWorkerConfig::default()
            },
            5000,
            None,
        )
        .unwrap();
        assert!(window_args.iter().any(|arg| arg == "capture-api=wgc"));
    }

    #[test]
    fn builds_av1_window_pipeline_with_svtav1enc() {
        let args = build_pipeline(
            &source("window"),
            &MediaWorkerConfig {
                codec: VideoCodec::Av1,
                show_cursor: false,
                ..MediaWorkerConfig::default()
            },
            5000,
            None,
        )
        .unwrap();
        assert!(args.iter().any(|arg| arg == "svtav1enc"));
        assert!(args.iter().any(|arg| arg == "rtpav1pay"));
        assert!(!args.iter().any(|arg| arg == "config-interval=1"));
        assert!(args.iter().any(|arg| arg == "window-handle=1234"));
        assert!(args.iter().any(|arg| arg == "rtpav1pay"));
        assert!(args.iter().any(|arg| arg == "pt=99"));
        assert!(args.iter().any(|arg| arg == "show-cursor=false"));
        assert!(args.iter().any(|arg| arg == "d3d11download"));
    }

    #[test]
    fn respects_show_cursor_option() {
        let visible = build_pipeline(
            &source("window"),
            &MediaWorkerConfig {
                show_cursor: true,
                ..MediaWorkerConfig::default()
            },
            5000,
            None,
        )
        .unwrap();
        assert!(visible.iter().any(|arg| arg == "show-cursor=true"));

        let hidden = build_pipeline(
            &source("window"),
            &MediaWorkerConfig {
                show_cursor: false,
                ..MediaWorkerConfig::default()
            },
            5000,
            None,
        )
        .unwrap();
        assert!(hidden.iter().any(|arg| arg == "show-cursor=false"));
    }
}
