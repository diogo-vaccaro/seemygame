//! In-process GStreamer/WebRTC bridge for the desktop capture provider.
//!
//! The capture worker produces RTP on loopback. This bridge consumes those
//! packets with `udpsrc`, feeds them to `webrtcbin`, and exchanges SDP with a
//! browser `RTCPeerConnection`. The browser therefore receives a normal
//! `MediaStream`; no encoded frame or HWND crosses Tauri JSON IPC.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_webrtc as gst_webrtc;
use serde::Serialize;
#[cfg(not(test))]
use tauri::{AppHandle, Emitter};

use crate::media::{GStreamerRuntime, VideoCodec};
use crate::webrtc_common::wait_promise;

#[cfg(not(test))]
type BridgeAppHandle = AppHandle;
#[cfg(test)]
type BridgeAppHandle = ();

pub const BRIDGE_EVENT: &str = "native-capture-bridge";

#[derive(Debug, Serialize, Clone)]
pub struct NativeCaptureBridgeEvent {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub negotiation_id: Option<String>,
    pub event: String,
    pub mline_index: Option<u32>,
    pub candidate: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct NativeCaptureSdp {
    #[serde(rename = "type")]
    pub sdp_type: String,
    pub sdp: String,
}

static GSTREAMER_INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();

fn initialize_gstreamer(runtime: &GStreamerRuntime) -> Result<(), String> {
    runtime.prepare_process_environment();
    GSTREAMER_INITIALIZED
        .get_or_init(|| {
            gst::init().map_err(|error| format!("Falha ao inicializar GStreamer: {error}"))
        })
        .clone()
}

mod pipeline;
pub(crate) use pipeline::*;

mod negotiation;
pub(crate) use negotiation::*;
pub(crate) mod stats;

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::UdpSocket;

    #[test]
    fn review_r04_receiver_binds_only_loopback() {
        let runtime = GStreamerRuntime::discover().unwrap();
        initialize_gstreamer(&runtime).unwrap();
        let src = make_udp_source("review-loopback", 0, &audio_rtp_caps(111)).unwrap();
        assert_eq!(src.property::<String>("address"), "127.0.0.1");
    }

    #[test]
    fn review_r09_unanswered_promise_has_bounded_wait() {
        let runtime = GStreamerRuntime::discover().unwrap();
        initialize_gstreamer(&runtime).unwrap();
        let start = Instant::now();
        let promise = gst::Promise::new();
        assert!(wait_promise(&promise, "teste sem resposta").is_err());
        assert!(start.elapsed() < Duration::from_secs(7));
    }

    #[test]
    fn selects_payload_types_from_browser_offer() {
        let offer = "m=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:63 red/48000/2\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 127 125 99\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:127 H264/90000\r\na=rtpmap:125 H264/90000\r\na=rtpmap:99 AV1/90000\r\n";
        assert_eq!(negotiated_payload_type(offer, "audio", "OPUS"), Some(111));
        assert_eq!(negotiated_payload_type(offer, "video", "H264"), Some(127));
        assert_eq!(negotiated_payload_type(offer, "video", "AV1"), Some(99));
        assert_eq!(negotiated_payload_type(offer, "video", "H265"), None);
    }

    #[test]
    fn rejects_native_codec_missing_from_remote_offer_before_starting_pipeline() {
        let offer = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n";
        let error = NativeWebRtcBridge::new(None, "unsupported", None, 1, None, VideoCodec::Hevc, Some(offer), None).unwrap_err();
        assert!(error.contains("H265"));
        assert!(error.contains("H.264"));
    }

    #[test]
    fn creates_in_process_bridge_from_loopback_rtp() {
        let Some(_runtime) = GStreamerRuntime::discover() else {
            panic!("Runtime GStreamer não preparado para o teste da ponte");
        };
        let port = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let bridge = NativeWebRtcBridge::new(
            None,
            "bridge-test",
            None,
            port,
            None,
            VideoCodec::H264,
            None,
            None,
        )
        .expect("pipeline WebRTC deveria iniciar com entrada RTP local");
        bridge.ensure_healthy().unwrap();
    }

    #[test]
    fn negotiates_realistic_offer() {
        let Some(_runtime) = GStreamerRuntime::discover() else {
            panic!("Runtime GStreamer não preparado");
        };
        let port = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let offer = "v=0\r\no=- 123456789 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:testufrag\r\na=ice-pwd:testpassword12345678901234\r\na=ice-options:trickle\r\na=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\na=setup:actpass\r\na=mid:0\r\na=recvonly\r\na=rtcp-mux\r\na=rtcp-rsize\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42c028\r\n";
        let bridge = NativeWebRtcBridge::new(
            None,
            "bridge-test",
            None,
            port,
            None,
            VideoCodec::H264,
            Some(offer),
            None,
        )
        .expect("pipeline WebRTC deveria iniciar");
        let answer = bridge
            .create_answer(offer)
            .expect("create_answer deveria funcionar");
        assert_eq!(answer.sdp_type, "answer");
        assert!(answer.sdp.contains("m=video"));
        assert!(answer.sdp.contains("a=sendonly"));
    }

    #[test]
    fn negotiates_realistic_offer_with_audio_and_rtp_packet() {
        let Some(_runtime) = GStreamerRuntime::discover() else {
            panic!("Runtime GStreamer não preparado");
        };
        let video_port = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let audio_port = {
            let s = UdpSocket::bind("127.0.0.1:0").unwrap();
            s.local_addr().unwrap().port()
        };
        let offer = "v=0\r\no=- 123456789 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\na=msid-semantic: WMS\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:testufrag\r\na=ice-pwd:testpassword12345678901234\r\na=ice-options:trickle\r\na=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\na=setup:actpass\r\na=mid:0\r\na=recvonly\r\na=rtcp-mux\r\na=rtcp-rsize\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42c028\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:testufrag\r\na=ice-pwd:testpassword12345678901234\r\na=ice-options:trickle\r\na=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\na=setup:actpass\r\na=mid:1\r\na=recvonly\r\na=rtcp-mux\r\na=rtcp-rsize\r\na=rtpmap:111 opus/48000/2\r\n";
        let bridge = NativeWebRtcBridge::new(
            None,
            "bridge-test-audio",
            None,
            video_port,
            Some(audio_port),
            VideoCodec::H264,
            Some(offer),
            None,
        )
        .expect("pipeline WebRTC deveria iniciar com áudio e vídeo");
        let answer = bridge
            .create_answer(offer)
            .expect("create_answer deveria funcionar");
        assert_eq!(answer.sdp_type, "answer");
        assert!(answer.sdp.contains("m=video"));
        assert!(answer.sdp.contains("m=audio"));

        let mut rtp_packet = vec![
            0x80, 0x6f, 0x00, 0x01, 0x00, 0x00, 0x03, 0xc0, 0x12, 0x34, 0x56, 0x78,
        ];
        rtp_packet.extend_from_slice(&[0xf8, 0xff, 0xfe]);
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let _ = sender.send_to(&rtp_packet, format!("127.0.0.1:{audio_port}"));
        thread::sleep(Duration::from_millis(50));
        bridge
            .ensure_healthy()
            .expect("pipeline de áudio deve processar buffer sem not-negotiated");
    }

    #[test]
    fn creates_av1_bridge_without_h264_only_payloader_properties() {
        let Some(runtime) = GStreamerRuntime::discover() else {
            panic!("Runtime GStreamer não preparado");
        };
        if !runtime.probe().av1_available {
            return;
        }
        let port = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let offer = "v=0\r\no=- 123456789 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:testufrag\r\na=ice-pwd:testpassword12345678901234\r\na=ice-options:trickle\r\na=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\na=setup:actpass\r\na=mid:0\r\na=recvonly\r\na=rtcp-mux\r\na=rtcp-rsize\r\na=rtpmap:99 AV1/90000\r\n";
        let bridge = NativeWebRtcBridge::new(
            None,
            "bridge-test-av1",
            None,
            port,
            None,
            VideoCodec::Av1,
            Some(offer),
            None,
        )
        .expect("pipeline AV1 deveria iniciar sem config-interval");
        let answer = bridge
            .create_answer(offer)
            .expect("negociação AV1 deveria funcionar");
        assert!(answer.sdp.contains("m=video"));
    }

    #[test]
    fn expands_mdns_and_lan_candidates_to_loopback() {
        let mdns = "candidate:1 1 UDP 2122260223 abcdef-1234.local 54321 typ host";
        let expanded_mdns = expand_local_candidates(mdns);
        assert_eq!(expanded_mdns.len(), 2);
        assert_eq!(expanded_mdns[0], mdns);
        assert_eq!(
            expanded_mdns[1],
            "candidate:1 1 UDP 2122260223 127.0.0.1 54321 typ host"
        );

        let lan = "candidate:2 1 UDP 2122260223 192.168.15.4 60000 typ host generation 0";
        let expanded_lan = expand_local_candidates(lan);
        assert_eq!(expanded_lan.len(), 2);
        assert_eq!(expanded_lan[0], lan);
        assert_eq!(
            expanded_lan[1],
            "candidate:2 1 UDP 2122260223 127.0.0.1 60000 typ host generation 0"
        );

        let loopback = "candidate:3 1 UDP 2122260223 127.0.0.1 60000 typ host";
        let expanded_loopback = expand_local_candidates(loopback);
        assert_eq!(expanded_loopback.len(), 1);
        assert_eq!(expanded_loopback[0], loopback);
    }

    #[test]
    fn sanitizes_turn_credentials_from_uri() {
        let raw = "turn://myuser:supersecretpassword@turn.example.com:3478";
        let sanitized = sanitize_turn_uri(raw);
        assert_eq!(sanitized, "turn://***:***@turn.example.com:3478");
        assert!(!sanitized.contains("supersecretpassword"));
        assert!(!sanitized.contains("myuser"));

        let raw_turns = "turns://admin:pass123@turn.example.com:5349?transport=tcp";
        let sanitized_turns = sanitize_turn_uri(raw_turns);
        assert_eq!(
            sanitized_turns,
            "turns://***:***@turn.example.com:5349?transport=tcp"
        );
        assert!(!sanitized_turns.contains("pass123"));

        let raw_single_colon = "turn:sentinel_user:sentinel_pass@turn.example.com:3478";
        let sanitized_single = sanitize_turn_uri(raw_single_colon);
        assert_eq!(sanitized_single, "turn:***:***@turn.example.com:3478");
        assert!(!sanitized_single.contains("sentinel_pass"));

        let no_auth = "turn://turn.example.com:3478";
        assert_eq!(sanitize_turn_uri(no_auth), no_auth);

        let stun = "stun:stun.l.google.com:19302";
        assert_eq!(sanitize_turn_uri(stun), stun);
    }
}
