#[test]
fn capture_method_defaults_by_source_and_strictly_validates_preferences() {
    for preference in [None, Some("auto"), Some(" WGC ")] {
        assert_eq!(capture_api_for_source(&source("window"), preference).unwrap(), "wgc");
    }
    assert_eq!(capture_api_for_source(&source("monitor"), None).unwrap(), "dxgi");
    assert_eq!(capture_api_for_source(&source("monitor"), Some("auto")).unwrap(), "dxgi");
    assert_eq!(capture_api_for_source(&source("monitor"), Some(" WGC ")).unwrap(), "wgc");
    assert_eq!(capture_api_for_source(&source("monitor"), Some(" DXGI ")).unwrap(), "dxgi");
    for invalid in ["", "d3d12", "dxgi ! fakesink", "automatic"] {
        assert!(capture_api_for_source(&source("monitor"), Some(invalid)).is_err());
    }
}

fn failed_capture_worker(backend: CaptureBackend, preference: Option<&str>) -> NativeMediaWorker {
    let missing = std::env::temp_dir().join("seemygame-no-runtime-for-recovery-test");
    NativeMediaWorker {
        runtime: GStreamerRuntime { root: missing.clone(), launch: missing.join("missing.exe"), inspect: missing.join("missing-inspect.exe") },
        child: None, rtp_port_leases: Vec::new(),
        config: MediaWorkerConfig { capture_backend: backend, capture_api: preference.map(String::from),
            h264_encoder: H264EncoderBackend::Nvenc, width: Some(1280), height: Some(720),
            audio_mode: AudioMode::System, ..Default::default() },
        active_capture_backend: if backend == CaptureBackend::Auto { CaptureBackend::D3d12 } else { backend },
        active_capture_api: "dxgi", capture_fallback_reason: None,
        video_rtp_port: 5555, audio_rtp_port: Some(5556),
    }
}

#[test]
fn automatic_dxgi_recovery_is_once_only_and_preserves_monitor_settings_and_ports() {
    let mut worker = failed_capture_worker(CaptureBackend::D3d11, None);
    let error = worker.fallback_to_wgc(&source("monitor"), "DXGI unavailable").unwrap_err();
    assert!(error.contains("fallback WGC falhou"));
    assert_eq!(worker.active_capture_api, "wgc");
    assert_eq!(worker.config.capture_api, None);
    assert_eq!(worker.active_capture_backend, CaptureBackend::D3d11);
    assert_eq!((worker.video_rtp_port, worker.audio_rtp_port), (5555, Some(5556)));
    assert_eq!((worker.config.width, worker.config.height), (Some(1280), Some(720)));
    assert_eq!(worker.config.audio_mode, AudioMode::System);
    assert!(worker.child.is_none());
    assert_eq!(worker.fallback_to_wgc(&source("monitor"), "second failure").unwrap_err(), "second failure");
    let mut pipeline_config = worker.config.clone();
    pipeline_config.capture_api = Some(worker.active_capture_api.into());
    let args = build_pipeline(&source("monitor"), &pipeline_config, 5555, Some(5556)).unwrap();
    assert!(args.iter().any(|a| a == "capture-api=wgc"));
    assert!(!args.iter().any(|a| a.starts_with("window-handle=")));
}

#[test]
fn explicit_dxgi_and_window_capture_never_silently_change_acquisition_method() {
    for (preference, target) in [(Some("dxgi"), "monitor"), (Some("wgc"), "monitor"), (None, "window")] {
        let mut worker = failed_capture_worker(CaptureBackend::D3d11, preference);
        assert_eq!(worker.fallback_to_wgc(&source(target), "failure").unwrap_err(), "failure");
        assert_eq!(worker.active_capture_api, "dxgi");
        assert!(worker.capture_fallback_reason.is_none());
    }
}

#[test]
fn automatic_backend_failure_can_recover_method_without_restarting_forever() {
    let mut worker = failed_capture_worker(CaptureBackend::Auto, Some("auto"));
    let error = worker.health_error(&source("monitor")).unwrap_err();
    assert!(error.contains("fallback WGC falhou"));
    assert_eq!(worker.active_capture_backend, CaptureBackend::D3d11);
    assert_eq!(worker.active_capture_api, "wgc");
    assert_eq!(worker.config.capture_backend, CaptureBackend::Auto);
    assert_eq!(worker.config.capture_api.as_deref(), Some("auto"));
    let reason = worker.capture_fallback_reason.clone();
    assert!(reason.as_deref().unwrap().contains("D3D11"));
    assert!(reason.as_deref().unwrap().contains("WGC"));
    assert!(worker.health_error(&source("monitor")).is_err());
    assert_eq!(worker.capture_fallback_reason, reason);
}

#[test]
fn explicit_graphics_backend_can_still_recover_automatic_monitor_method() {
    let mut worker = failed_capture_worker(CaptureBackend::D3d12, Some("auto"));
    assert!(worker.health_error(&source("monitor")).is_err());
    assert_eq!(worker.active_capture_backend, CaptureBackend::D3d12);
    assert_eq!(worker.active_capture_api, "wgc");
}

#[test]
fn dxgi_monitor_is_independent_of_graphics_api_and_never_captures_a_window() {
    for backend in [CaptureBackend::D3d11, CaptureBackend::D3d12] {
        let config = MediaWorkerConfig { capture_api: Some("dxgi".into()), capture_backend: backend,
            h264_encoder: H264EncoderBackend::Nvenc, ..Default::default() };
        assert!(build_pipeline(&source("window"), &config, 5000, None).unwrap_err().contains("monitor inteiro"));
        let args = build_pipeline(&source("monitor"), &config, 5000, None).unwrap();
        assert!(args.iter().any(|arg| arg == "capture-api=dxgi"));
        assert!(args.iter().any(|arg| arg.starts_with("monitor-handle=")));
        assert!(!args.iter().any(|arg| arg.starts_with("window-handle=")));
        assert_eq!(args[0], if backend == CaptureBackend::D3d11 { "d3d11screencapturesrc" } else { "d3d12screencapturesrc" });
    }
}

#[test]
fn capture_method_changes_only_the_source_api_and_survives_config_clone() {
    let mut config = MediaWorkerConfig::default();
    config.capture_api = Some("wgc".into());
    let mut dxgi = config.clone(); dxgi.capture_api = Some("dxgi".into());
    let before = build_pipeline(&source("monitor"), &config, 5000, None).unwrap();
    let mut after = build_pipeline(&source("monitor"), &dxgi.clone(), 5000, None).unwrap();
    for arg in &mut after { if arg == "capture-api=dxgi" { *arg = "capture-api=wgc".into(); } }
    assert_eq!(before, after);
}
