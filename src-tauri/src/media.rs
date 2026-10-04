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

mod config;
pub(crate) use config::*;

mod runtime;
pub(crate) use runtime::*;

mod worker;
pub(crate) use worker::*;

mod environment;
pub(crate) use environment::*;

mod transport;
pub(crate) use transport::*;
mod rtp_stats;
pub(crate) use rtp_stats::*;

mod platform;
pub(crate) use platform::*;

mod pipeline;
pub(crate) use pipeline::*;

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
    fn d3d12_capture_is_preferred_automatically_and_rejects_invalid_backends() {
        assert_eq!(MediaWorkerConfig::default().capture_backend, CaptureBackend::Auto);
        assert_eq!(CaptureBackend::parse("auto").unwrap(), CaptureBackend::Auto);
        assert_eq!(CaptureBackend::parse(" D3D12 ").unwrap(), CaptureBackend::D3d12);
        assert!(CaptureBackend::parse("automatic").is_err());
        for encoder in [H264EncoderBackend::Auto, H264EncoderBackend::MediaFoundation, H264EncoderBackend::Cpu] {
            let config = MediaWorkerConfig {capture_backend:CaptureBackend::D3d12,h264_encoder:encoder,..Default::default()};
            assert!(build_pipeline(&source("window"), &config, 5000, None).is_err());
        }
        for codec in [VideoCodec::Av1, VideoCodec::Hevc] {
            let config = MediaWorkerConfig {capture_backend:CaptureBackend::D3d12,h264_encoder:H264EncoderBackend::Nvenc,codec,..Default::default()};
            assert!(build_pipeline(&source("window"), &config, 5000, None).is_err());
        }
    }
    #[test]
    fn d3d12_pipeline_keeps_gpu_memory_until_nvenc_at_both_resolutions() {
        for (width,height) in [(1280,720),(1920,1080)] {
            let config = MediaWorkerConfig {capture_backend:CaptureBackend::D3d12,h264_encoder:H264EncoderBackend::Nvenc,width:Some(width),height:Some(height),..Default::default()};
            let mut src=source("window");src.width=1920;src.height=1080;
            let args=build_pipeline(&src,&config,5000,None).unwrap();
            assert_eq!(args[0], "d3d12screencapturesrc");
            let interop=args.iter().position(|s|s=="d3d12download").unwrap();
            assert_eq!(args[interop+2],format!("video/x-raw(memory:D3D11Memory),format=NV12,framerate=60/1,width={width},height={height}"));
            assert!(args.iter().any(|s|s=="nvd3d11h264enc"));
            assert!(!args.iter().any(|s|s=="d3d11screencapturesrc"||s.starts_with("video/x-raw,format=")));
        }
        assert_eq!(build_pipeline(&source("window"),&MediaWorkerConfig::default(),5000,None).unwrap()[0],"d3d11screencapturesrc");
    }

    #[test]
    fn automatic_capture_preserves_other_encoders_codecs_and_explicit_overrides() {
        for codec in [VideoCodec::H264, VideoCodec::Hevc, VideoCodec::Av1] {
            for encoder in [H264EncoderBackend::Auto, H264EncoderBackend::Nvenc,
                H264EncoderBackend::MediaFoundation, H264EncoderBackend::Cpu] {
                for available in [false, true] {
                    let expected = if available && codec == VideoCodec::H264 && encoder == H264EncoderBackend::Nvenc {
                        CaptureBackend::D3d12
                    } else { CaptureBackend::D3d11 };
                    assert_eq!(CaptureBackend::Auto.resolve(codec, encoder, available).unwrap(), expected);
                    assert_eq!(CaptureBackend::D3d11.resolve(codec, encoder, available).unwrap(), CaptureBackend::D3d11);
                    assert_eq!(CaptureBackend::D3d12.resolve(codec, encoder, available).is_ok(), expected == CaptureBackend::D3d12);
                }
            }
        }
    }

    #[test]
    fn automatic_fallback_is_once_only_and_preserves_requested_settings_and_ports() {
        let mut worker = NativeMediaWorker {
            runtime: GStreamerRuntime::discover().unwrap(), child: None,
            rtp_port_leases: Vec::new(),
            config: MediaWorkerConfig {h264_encoder:H264EncoderBackend::Nvenc,
                width:Some(1920),height:Some(1080),audio_mode:AudioMode::System,
                bitrate_kbps:4500,..Default::default()},
            active_capture_backend:CaptureBackend::D3d12, capture_fallback_reason:None,
            video_rtp_port:5555,audio_rtp_port:Some(6666),
        };
        // Reject the replacement before spawning any process, to exercise a failed fallback.
        let mut invalid = source("window"); invalid.hwnd = None;
        let error = worker.fallback_to_d3d11(&invalid,"device initialization failed").unwrap_err();
        assert!(error.contains("fallback D3D11 falhou"));
        assert_eq!(worker.active_capture_backend,CaptureBackend::D3d11);
        assert_eq!(worker.config.capture_backend,CaptureBackend::Auto);
        assert_eq!(worker.capture_fallback_reason.as_deref(),Some("device initialization failed"));
        assert_eq!(worker.fallback_to_d3d11(&invalid,"second failure").unwrap_err(),"second failure");
        let mut pipeline_config=worker.config.clone();pipeline_config.capture_backend=worker.active_capture_backend;
        let args=build_pipeline(&source("window"),&pipeline_config,worker.video_rtp_port,worker.audio_rtp_port).unwrap();
        assert_eq!(args[0],"d3d11screencapturesrc");
        assert!(args.iter().any(|s|s=="port=5555"));
        assert!(args.iter().any(|s|s=="port=6666"));
        assert!(args.iter().any(|s|s=="bitrate=4500"));
        worker.config.capture_backend=CaptureBackend::D3d12;
        worker.active_capture_backend=CaptureBackend::D3d12;
        assert_eq!(worker.fallback_to_d3d11(&invalid,"forced failure").unwrap_err(),"forced failure");
        assert_eq!(worker.active_capture_backend,CaptureBackend::D3d12);
    }
    include!("media/cadence_probe.rs");
    include!("media/capture_stage_probe.rs");
    include!("media/queue_policy_tests.rs");

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
            runtime: GStreamerRuntime::discover().unwrap(),
            child: None,
            rtp_port_leases: vec![lease],
            config: MediaWorkerConfig::default(),
            active_capture_backend: CaptureBackend::D3d11,
            capture_fallback_reason: None,
            video_rtp_port: port,
            audio_rtp_port: None,
        };
        // Exercise the exact hand-off currently called by capture.rs before
        // bridge construction; a competing binder must never get ownership.
        worker.release_rtp_port_leases();
        assert!(
            UdpSocket::bind(("127.0.0.1", port)).is_err(),
            "R04: porta desprotegida durante handoff"
        );
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
        let (_runtime, resolved) =
            NativeMediaWorker::resolve_and_validate_config(config, &test_src).unwrap();
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
        let (_runtime, resolved_none) =
            NativeMediaWorker::resolve_and_validate_config(config_none, &test_src).unwrap();
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
        let config = MediaWorkerConfig {
            codec: VideoCodec::Av1,
            ..Default::default()
        };
        let args = build_pipeline(&source("window"), &config, 5000, None).unwrap();
        // Preserve the production conversion/encoder chain, replacing only
        // screen input and UDP output with finite synthetic input/fakesink.
        let begin = args
            .iter()
            .position(|s| s.starts_with("video/x-raw("))
            .unwrap();
        let end = args.iter().position(|s| s == "udpsink").unwrap() - 1;
        let description = format!("videotestsrc num-buffers=4 ! video/x-raw,format=BGRA,width=320,height=240,framerate=60/1 ! d3d11upload ! {} ! fakesink sync=false", args[begin..end].join(" "));
        let pipeline =
            gstreamer::parse::launch(&description).expect("AV1 deve negociar formatos reais");
        let result = (|| {
            pipeline
                .set_state(gstreamer::State::Playing)
                .map_err(|e| format!("{e:?}"))?;
            let bus = pipeline.bus().unwrap();
            let message = bus
                .timed_pop_filtered(
                    gstreamer::ClockTime::from_seconds(15),
                    &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error],
                )
                .ok_or("timeout AV1")?;
            match message.view() {
                gstreamer::MessageView::Eos(..) => Ok(()),
                other => Err(format!("{other:?}")),
            }
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
        let config = MediaWorkerConfig {
            codec: VideoCodec::H264,
            ..Default::default()
        };
        let args = build_pipeline(&source("window"), &config, 5000, None).unwrap();
        let begin = args
            .iter()
            .position(|s| s.starts_with("video/x-raw("))
            .unwrap();
        let end = args.iter().position(|s| s == "udpsink").unwrap() - 1;
        let description = format!("videotestsrc num-buffers=4 ! video/x-raw,format=BGRA,width=320,height=240,framerate=60/1 ! d3d11upload ! {} ! fakesink sync=false", args[begin..end].join(" "));
        let pipeline =
            gstreamer::parse::launch(&description).expect("H264 deve negociar formatos reais");
        let result = (|| {
            pipeline
                .set_state(gstreamer::State::Playing)
                .map_err(|e| format!("{e:?}"))?;
            let bus = pipeline.bus().unwrap();
            let message = bus
                .timed_pop_filtered(
                    gstreamer::ClockTime::from_seconds(15),
                    &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error],
                )
                .ok_or("timeout H264")?;
            match message.view() {
                gstreamer::MessageView::Eos(..) => Ok(()),
                other => Err(format!("{other:?}")),
            }
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
        let begin = args
            .iter()
            .position(|s| s.starts_with("video/x-raw("))
            .unwrap();
        let end = args.iter().position(|s| s == "udpsink").unwrap() - 1;
        let description = format!("videotestsrc num-buffers=4 ! video/x-raw,format=BGRA,width=320,height=240,framerate=60/1 ! d3d11upload ! {} ! fakesink sync=false", args[begin..end].join(" "));
        let pipeline = gstreamer::parse::launch(&description)
            .expect("NVENC H264 deve negociar formatos reais");
        let result = (|| {
            pipeline
                .set_state(gstreamer::State::Playing)
                .map_err(|e| format!("{e:?}"))?;
            let bus = pipeline.bus().unwrap();
            let message = bus
                .timed_pop_filtered(
                    gstreamer::ClockTime::from_seconds(15),
                    &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error],
                )
                .ok_or("timeout NVENC")?;
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
                other => Err(format!("{other:?}")),
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
        assert!(args
            .iter()
            .any(|arg| arg == "video/x-h264,profile=constrained-baseline"));
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
        assert!(args
            .iter()
            .any(|arg| arg == "audio-type=restricted-lowdelay"));
        assert!(args.iter().any(|arg| arg == "perfect-timestamp=true"));
        assert!(args.iter().all(|arg| arg != "hard-resync=true"));
        assert!(args.iter().any(|arg| arg == "rtph265pay"));
    }

    #[test]
    fn builds_system_audio_pipeline_with_process_exclusion() {
        let args = build_pipeline(
            &source("monitor"),
            &MediaWorkerConfig {
                codec: VideoCodec::H264,
                audio_mode: AudioMode::System,
                exclude_process_id: Some(1337),
                ..MediaWorkerConfig::default()
            },
            5000,
            Some(5001),
        )
        .unwrap();
        assert!(args.iter().any(|arg| arg == "wasapi2src"));
        assert!(args
            .iter()
            .any(|arg| arg == "loopback-mode=exclude-process-tree"));
        assert!(args.iter().any(|arg| arg == "loopback-target-pid=1337"));
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
        assert!(args
            .iter()
            .any(|arg| arg == "video/x-h264,profile=constrained-baseline"));
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
