#[test]
fn raw_video_queue_policy_is_strict_and_preserves_the_default() {
    assert_eq!(MediaWorkerConfig::default().raw_video_queue, RawVideoQueuePolicy::Bounded);
    assert_eq!(RawVideoQueuePolicy::parse(" bounded ").unwrap(), RawVideoQueuePolicy::Bounded);
    assert_eq!(RawVideoQueuePolicy::parse("LATEST").unwrap(), RawVideoQueuePolicy::Latest);
    for invalid in ["", "auto", "leaky", "latest ! fakesink"] {
        assert!(RawVideoQueuePolicy::parse(invalid).is_err());
    }
}

#[test]
fn latest_policy_only_changes_the_two_pre_encode_video_queues() {
    for backend in [CaptureBackend::D3d11, CaptureBackend::D3d12] {
        for fps in [30, 60, 120] {
            let bounded = MediaWorkerConfig {
                capture_backend: backend, h264_encoder: H264EncoderBackend::Nvenc,
                audio_mode: AudioMode::System, fps, ..Default::default()
            };
            let mut latest = bounded.clone();
            latest.raw_video_queue = RawVideoQueuePolicy::Latest;
            let before = build_pipeline(&source("window"), &bounded, 5000, Some(5002)).unwrap();
            let after = build_pipeline(&source("window"), &latest, 5000, Some(5002)).unwrap();
            let encoder = |args: &[String]| args.iter().position(|a| a == "nvd3d11h264enc").unwrap();
            assert_eq!(&before[encoder(&before)..], &after[encoder(&after)..], "Encoded video/audio/RTP must remain identical");
            assert_eq!(after.iter().filter(|a| a.as_str() == "leaky=downstream").count(), 2);
            let mut stripped = after.clone();
            stripped.retain(|a| a != "leaky=downstream");
            // Only the two raw video queue size limits differ; no source/codec changes.
            for arg in &mut stripped[..encoder(&before)] {
                if arg == "max-size-buffers=1" { *arg = "max-size-buffers=3".into(); }
                if arg == "max-size-time=0" { *arg = "max-size-time=50000000".into(); }
            }
            assert_eq!(before, stripped);
        }
    }
}

#[test]
fn latest_queue_policy_supports_other_codecs_and_cpu_encoder() {
    for (codec, encoder) in [(VideoCodec::H264,H264EncoderBackend::Cpu),
        (VideoCodec::H264,H264EncoderBackend::MediaFoundation),
        (VideoCodec::Hevc,H264EncoderBackend::MediaFoundation),
        (VideoCodec::Av1,H264EncoderBackend::Cpu)] {
        let config = MediaWorkerConfig { codec, h264_encoder: encoder,
            raw_video_queue: RawVideoQueuePolicy::Latest, ..Default::default() };
        let args = build_pipeline(&source("window"), &config, 5000, None).unwrap();
        assert_eq!(args.iter().filter(|a| a.as_str() == "leaky=downstream").count(), 2);
        let pay = args.iter().position(|a| a == codec.payloader()).unwrap();
        assert!(!args[pay..].iter().any(|a| a.starts_with("leaky=")));
    }
}
