#[test]
fn capture_method_defaults_to_wgc_and_strictly_validates_preferences() {
    for kind in ["window", "monitor"] {
        for preference in [None, Some("auto"), Some(" WGC ")] {
            assert_eq!(capture_api_for_source(&source(kind), preference).unwrap(), "wgc");
        }
    }
    for invalid in ["", "d3d12", "dxgi ! fakesink", "automatic"] {
        assert!(capture_api_for_source(&source("monitor"), Some(invalid)).is_err());
    }
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
    let config = MediaWorkerConfig::default();
    let mut dxgi = config.clone(); dxgi.capture_api = Some("dxgi".into());
    let before = build_pipeline(&source("monitor"), &config, 5000, None).unwrap();
    let mut after = build_pipeline(&source("monitor"), &dxgi.clone(), 5000, None).unwrap();
    for arg in &mut after { if arg == "capture-api=dxgi" { *arg = "capture-api=wgc".into(); } }
    assert_eq!(before, after);
}
