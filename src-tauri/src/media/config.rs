//! config; internal to the native media subsystem.
use super::*;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaptureBackend {
    #[default]
    Auto,
    D3d11,
    D3d12,
}

impl CaptureBackend {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "d3d11" => Ok(Self::D3d11),
            "d3d12" => Ok(Self::D3d12),
            _ => Err(format!("Backend de captura inválido: {value}; use auto, d3d11 ou d3d12")),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::D3d11 => "d3d11",
            Self::D3d12 => "d3d12",
        }
    }

    /// Called after resolving the encoder. Explicit selections stay strict.
    pub fn resolve(self, codec: VideoCodec, encoder: H264EncoderBackend, d3d12_available: bool) -> Result<Self, String> {
        let compatible = codec == VideoCodec::H264 && encoder == H264EncoderBackend::Nvenc;
        match self {
            Self::Auto if compatible && d3d12_available => Ok(Self::D3d12),
            Self::Auto => Ok(Self::D3d11),
            Self::D3d12 if !compatible => Err("Captura D3D12 requer H.264/NVENC; seleção explícita não admite fallback".into()),
            Self::D3d12 if !d3d12_available => Err("Captura D3D12 indisponível: plugins de captura/conversão/interop ausentes".into()),
            backend => Ok(backend),
        }
    }
}

/// Capture acquisition is independent of the D3D processing backend and encoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureApi {
    Auto,
    Wgc,
    Dxgi,
}

impl CaptureApi {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "wgc" => Ok(Self::Wgc),
            "dxgi" => Ok(Self::Dxgi),
            _ => Err("Método de captura inválido; use auto, wgc ou dxgi".into()),
        }
    }

    /// Auto deliberately keeps WGC until monitor DXGI completes E2E validation.
    pub fn resolve(self, source: &ValidatedSource) -> Result<&'static str, String> {
        if self == Self::Dxgi && (source.source_type != "monitor" || source.monitor_handle.is_none() || source.hwnd.is_some()) {
            return Err("DXGI captura somente o monitor inteiro. Para compartilhar uma janela, escolha WGC ou Automático.".into());
        }
        Ok(if self == Self::Dxgi { "dxgi" } else { "wgc" })
    }
}

pub(crate) fn capture_api_for_source(source: &ValidatedSource, preference: Option<&str>) -> Result<&'static str, String> {
    CaptureApi::parse(preference.unwrap_or("auto"))?.resolve(source)
}

/// Applies only to uncompressed video before the encoder. Audio and encoded RTP
/// must not inherit this dropping policy. Keep the established default until E2E
/// validation of audio, recovery and replay completes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RawVideoQueuePolicy {
    #[default]
    Bounded,
    Latest,
}

impl RawVideoQueuePolicy {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "bounded" => Ok(Self::Bounded),
            "latest" => Ok(Self::Latest),
            _ => Err("Política de fila de vídeo inválida; use bounded ou latest".into()),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self { Self::Bounded => "bounded", Self::Latest => "latest" }
    }

    pub const fn properties(self) -> &'static [&'static str] {
        match self {
            Self::Bounded => &["max-size-buffers=3", "max-size-time=50000000", "max-size-bytes=0"],
            Self::Latest => &["max-size-buffers=1", "max-size-time=0", "max-size-bytes=0", "leaky=downstream"],
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
    pub capture_backend: CaptureBackend,
    pub raw_video_queue: RawVideoQueuePolicy,
    pub exclude_process_id: Option<u32>,
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
            capture_backend: CaptureBackend::Auto,
            raw_video_queue: RawVideoQueuePolicy::default(),
            exclude_process_id: None,
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
        // Auto prefers D3D12 for H.264/NVENC; explicit values are diagnostic overrides.
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_CAPTURE_BACKEND") {
            config.capture_backend = CaptureBackend::parse(&value)?;
        }
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_RAW_QUEUE") {
            config.raw_video_queue = RawVideoQueuePolicy::parse(&value)?;
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
        if let Ok(value) = env::var("SEEMYGAME_NATIVE_EXCLUDE_PID") {
            if let Ok(pid) = value.trim().parse::<u32>() {
                config.exclude_process_id = Some(pid);
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
    pub d3d12_available: bool,
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
            d3d12_available: false,
            x264_available: false,
            hevc_available: false,
            av1_available: false,
            webrtc_available: false,
            missing_elements: Vec::new(),
            reason: Some(reason.into()),
        }
    }
}
