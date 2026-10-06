//! pipeline; internal to the native media subsystem.
use super::*;

pub(crate) fn validate_source(source: &ValidatedSource) -> Result<(), String> {
    match source.source_type.as_str() {
        "window" if source.hwnd.is_some() => Ok(()),
        "monitor" if source.monitor_handle.is_some() => Ok(()),
        "window" => Err("Fonte de janela sem HWND validado".to_string()),
        "monitor" => Err("Fonte de monitor sem HMONITOR validado".to_string()),
        _ => Err("Tipo de fonte nativo inválido".to_string()),
    }
}

pub(crate) fn build_pipeline(
    source: &ValidatedSource,
    config: &MediaWorkerConfig,
    video_rtp_port: u16,
    audio_rtp_port: Option<u16>,
) -> Result<Vec<String>, String> {
    let d3d12 = config.capture_backend == CaptureBackend::D3d12;
    if d3d12 && (config.codec != VideoCodec::H264 || config.h264_encoder != H264EncoderBackend::Nvenc) {
        return Err("Captura D3D12 experimental requer H.264/NVENC; não há fallback silencioso".into());
    }
    let memory = if d3d12 { "D3D12Memory" } else { "D3D11Memory" };
    let capture_api = capture_api_for_source(source, config.capture_api.as_deref())?;
    let gop_size = config
        .gop_size
        .unwrap_or_else(|| (config.fps / 2).clamp(15, 30));

    let mut args = vec![
        if d3d12 { "d3d12screencapturesrc" } else { "d3d11screencapturesrc" }.to_string(),
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

    let convert_format =
        if config.codec == VideoCodec::Av1 || config.h264_encoder == H264EncoderBackend::Cpu {
            "I420"
        } else {
            "NV12"
        };

    args.extend([
        cursor_arg.to_string(),
        "!".to_string(),
        format!("video/x-raw(memory:{memory}),format=BGRA"),
        "!".to_string(),
        "queue".to_string(),
    ]);
    args.extend(config.raw_video_queue.properties().iter().map(|arg| (*arg).to_string()));
    args.extend([
        "!".to_string(),
        "videorate".to_string(),
        "drop-only=true".to_string(),
        "skip-to-first=true".to_string(),
        "!".to_string(),
        format!(
            "video/x-raw(memory:{memory}),framerate={}/1",
            config.fps
        ),
        "!".to_string(),
        if d3d12 { "d3d12convert" } else { "d3d11convert" }.to_string(),
        "!".to_string(),
        format!(
            "video/x-raw(memory:{memory}),format={convert_format},framerate={}/1{resolution_caps}",
            config.fps
        ),
        "!".to_string(),
    ]);
    if d3d12 {
        // Explicit GPU-memory interop into the SAME D3D11 NVENC encoder.
        args.extend([
            "d3d12download".to_string(), "!".to_string(),
            format!("video/x-raw(memory:D3D11Memory),format=NV12,framerate={}/1{resolution_caps}", config.fps),
            "!".to_string(),
        ]);
    }
    args.extend([
        "queue".to_string(),
    ]);
    args.extend(config.raw_video_queue.properties().iter().map(|arg| (*arg).to_string()));
    args.extend([
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
            format!(
                "video/x-raw,format=I420,framerate={}/1{resolution_caps}",
                config.fps
            ),
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
            } else if let Some(exclude_pid) = config.exclude_process_id {
                args.extend([
                    "loopback-mode=exclude-process-tree".to_string(),
                    format!("loopback-target-pid={exclude_pid}"),
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

pub(crate) static CACHED_CAPABILITIES: OnceLock<MediaCapabilities> = OnceLock::new();
