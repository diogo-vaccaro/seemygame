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

#[derive(Debug)]
pub struct NativeWebRtcBridge {
    pipeline: gst::Pipeline,
    webrtc: gst::Element,
    error_state: Arc<Mutex<Option<String>>>,
    shutdown: Arc<AtomicBool>,
    bus_thread: Option<JoinHandle<()>>,
}

impl NativeWebRtcBridge {
    pub fn new(
        app: Option<&BridgeAppHandle>,
        session_id: impl Into<String>,
        peer_id: Option<String>,
        video_rtp_port: u16,
        audio_rtp_port: Option<u16>,
        codec: VideoCodec,
        offer_sdp: Option<&str>,
        ice_servers: Option<&[String]>,
    ) -> Result<Self, String> {
        let session_id = session_id.into();
        #[cfg(test)]
        let _ = (&app, &session_id, &peer_id);
        let runtime = GStreamerRuntime::discover().ok_or_else(|| {
            "Runtime GStreamer empacotado não encontrado para a ponte WebRTC".to_string()
        })?;
        let capabilities = runtime.probe();
        if !capabilities.webrtc_available {
            return Err("Plugin GStreamer webrtcbin não está disponível".to_string());
        }
        initialize_gstreamer(&runtime)?;

        let pipeline = gst::Pipeline::new();
        let webrtc = gst::ElementFactory::make("webrtcbin")
            .name("seemygame-webrtc")
            .build()
            .map_err(|error| format!("Falha ao criar webrtcbin: {error}"))?;
        webrtc.set_property_from_str("bundle-policy", "max-bundle");
        webrtc.set_property("latency", 10u32);

        let mut stun_set = false;
        if let Some(servers) = ice_servers {
            for server in servers {
                let trimmed = server.trim();
                if trimmed.starts_with("stun:") || trimmed.starts_with("stun://") {
                    let formatted = if trimmed.starts_with("stun://") {
                        trimmed.to_string()
                    } else {
                        format!("stun://{}", &trimmed[5..])
                    };
                    if !stun_set {
                        webrtc.set_property("stun-server", &formatted);
                        stun_set = true;
                    }
                } else if trimmed.starts_with("turn:")
                    || trimmed.starts_with("turns:")
                    || trimmed.starts_with("turn://")
                    || trimmed.starts_with("turns://")
                {
                    let formatted = if trimmed.starts_with("turn://") || trimmed.starts_with("turns://") {
                        trimmed.to_string()
                    } else if let Some(rest) = trimmed.strip_prefix("turns:") {
                        format!("turns://{rest}")
                    } else if let Some(rest) = trimmed.strip_prefix("turn:") {
                        format!("turn://{rest}")
                    } else {
                        trimmed.to_string()
                    };
                    let sanitized = sanitize_turn_uri(&formatted);
                    #[cfg(not(test))]
                    crate::system::write_debug_log(&format!(
                        "[Bridge] webrtcbin adicionando servidor TURN: {sanitized}"
                    ));
                    let added = webrtc.emit_by_name::<bool>("add-turn-server", &[&formatted]);
                    if !added {
                        #[cfg(not(test))]
                        crate::system::write_debug_log(&format!(
                            "[Bridge] AVISO: webrtcbin recusou o servidor TURN: {sanitized}"
                        ));
                    }
                }
            }
        }
        if !stun_set {
            webrtc.set_property_from_str("stun-server", "stun://stun.l.google.com:19302");
        }
        pipeline
            .add(&webrtc)
            .map_err(|error| format!("Falha ao adicionar webrtcbin: {error}"))?;

        let video_worker_payload = default_video_payload(codec);
        let video_payload = offer_sdp
            .and_then(|offer| negotiated_payload_type(offer, "video", codec.encoding_name()))
            .unwrap_or(video_worker_payload);
        let video_caps = rtp_caps(codec, video_worker_payload);
        let video_src = make_udp_source("seemygame-video", video_rtp_port, &video_caps)?;
        let video_depay = make_rtp_element(codec.depayloader(), "seemygame-video-depay")?;
        let video_pay = make_rtp_element(codec.payloader(), "seemygame-video-pay")?;
        video_pay.set_property("pt", video_payload as u32);
        // H.264/H.265 payloaders periodically repeat codec headers. The AV1
        // payloader has no config-interval property; AV1 sequence headers are
        // carried by av1parse/rtpav1pay according to the negotiated stream.
        if matches!(codec, VideoCodec::H264 | VideoCodec::Hevc) {
            video_pay.set_property("perfect-rtptime", true);
            video_pay.set_property("config-interval", -1i32);
            if codec == VideoCodec::H264 {
                video_pay.set_property_from_str("aggregate-mode", "zero-latency");
            }
        }
        let video_capsfilter =
            make_caps_filter("seemygame-video-caps", &rtp_caps(codec, video_payload))?;
        let video_queue = make_element("queue", "seemygame-video-queue")?;
        video_queue.set_property("max-size-buffers", 0u32);
        video_queue.set_property("max-size-time", 120_000_000u64);
        video_queue.set_property("max-size-bytes", 0u32);
        pipeline
            .add_many([&video_src, &video_depay, &video_pay, &video_capsfilter, &video_queue])
            .map_err(|error| format!("Falha ao adicionar entrada de vídeo: {error}"))?;
        video_src
            .link(&video_depay)
            .map_err(|error| format!("Falha ao ligar depayloader de vídeo: {error}"))?;
        video_depay
            .link(&video_pay)
            .map_err(|error| format!("Falha ao ligar payloader de vídeo: {error}"))?;
        video_pay
            .link(&video_capsfilter)
            .map_err(|error| format!("Falha ao aplicar caps RTP de vídeo: {error}"))?;
        video_capsfilter
            .link(&video_queue)
            .map_err(|error| format!("Falha ao ligar fila de vídeo: {error}"))?;
        link_rtp_output(&video_queue, &webrtc, "sink_0", "vídeo")?;

        if let Some(audio_rtp_port) = audio_rtp_port {
            let audio_worker_payload = 111;
            let audio_payload = offer_sdp
                .and_then(|offer| negotiated_payload_type(offer, "audio", "OPUS"))
                .unwrap_or(audio_worker_payload);
            let audio_caps = audio_rtp_caps(audio_worker_payload);
            let audio_src = make_udp_source("seemygame-audio", audio_rtp_port, &audio_caps)?;
            let audio_jitter = make_element("rtpjitterbuffer", "seemygame-audio-jitter")?;
            audio_jitter.set_property("latency", 5u32);
            audio_jitter.set_property("do-lost", true);
            audio_jitter.set_property("drop-on-latency", true);
            let audio_depay = make_element("rtpopusdepay", "seemygame-audio-depay")?;
            let audio_pay = make_element("rtpopuspay", "seemygame-audio-pay")?;
            audio_pay.set_property("pt", audio_payload as u32);
            audio_pay.set_property("perfect-rtptime", true);
            let audio_capsfilter =
                make_caps_filter("seemygame-audio-caps", &audio_rtp_caps(audio_payload))?;
            let audio_queue = make_element("queue", "seemygame-audio-queue")?;
            audio_queue.set_property("max-size-buffers", 0u32);
            audio_queue.set_property("max-size-time", 120_000_000u64);
            audio_queue.set_property("max-size-bytes", 0u32);
            pipeline
                .add_many([
                    &audio_src,
                    &audio_jitter,
                    &audio_depay,
                    &audio_pay,
                    &audio_capsfilter,
                    &audio_queue,
                ])
                .map_err(|error| format!("Falha ao adicionar entrada de áudio: {error}"))?;
            audio_src
                .link(&audio_jitter)
                .map_err(|error| format!("Falha ao ligar jitter buffer de áudio: {error}"))?;
            audio_jitter
                .link(&audio_depay)
                .map_err(|error| format!("Falha ao ligar depayloader de áudio: {error}"))?;
            audio_depay
                .link(&audio_pay)
                .map_err(|error| format!("Falha ao ligar payloader de áudio: {error}"))?;
            audio_pay
                .link(&audio_capsfilter)
                .map_err(|error| format!("Falha ao aplicar caps RTP de áudio: {error}"))?;
            audio_capsfilter
                .link(&audio_queue)
                .map_err(|error| format!("Falha ao ligar fila de áudio: {error}"))?;
            link_rtp_output(&audio_queue, &webrtc, "sink_1", "áudio")?;
        }

        let error_state = Arc::new(Mutex::new(None));
        let shutdown = Arc::new(AtomicBool::new(false));
        let bus = pipeline
            .bus()
            .ok_or_else(|| "Pipeline WebRTC sem bus de mensagens".to_string())?;
        let bus_error_state = Arc::clone(&error_state);
        let bus_shutdown = Arc::clone(&shutdown);
        let bus_thread = thread::spawn(move || loop {
            if bus_shutdown.load(Ordering::Relaxed) {
                break;
            }
            let Some(message) = bus.timed_pop(Some(gst::ClockTime::from_mseconds(250))) else {
                continue;
            };
            match message.view() {
                gst::MessageView::Error(error) => {
                    let detail = error
                        .debug()
                        .map(|debug| format!("{} ({debug})", error.error()))
                        .unwrap_or_else(|| error.error().to_string());
                    #[cfg(not(test))]
                    crate::system::write_debug_log(&format!("[Bridge Pipeline ERROR] {detail}"));
                    if let Ok(mut state) = bus_error_state.lock() {
                        *state = Some(detail);
                    }
                    break;
                }
                gst::MessageView::Warning(warning) => {
                    let detail = warning
                        .debug()
                        .map(|debug| format!("{} ({debug})", warning.error()))
                        .unwrap_or_else(|| warning.error().to_string());
                    #[cfg(not(test))]
                    crate::system::write_debug_log(&format!("[Bridge Pipeline WARNING] {detail}"));
                }
                gst::MessageView::Eos(..) => break,
                _ => {}
            }
        });

        #[cfg(not(test))]
        if let Some(event_app) = app.cloned() {
            let event_session_id = session_id.clone();
            let event_peer_id = peer_id.clone();
            webrtc.connect("on-ice-candidate", false, move |values| {
                let mline_index = values.get(1).and_then(|value| value.get::<u32>().ok());
                let candidate = values.get(2).and_then(|value| value.get::<String>().ok());
                if let Some(cand_str) = candidate {
                    for cand in expand_local_candidates(&cand_str) {
                        crate::system::write_debug_log(&format!(
                            "[Bridge] webrtcbin emitiu candidato ICE (peer={:?}) mline={:?}: {:?}",
                            event_peer_id, mline_index, cand
                        ));
                        let event = NativeCaptureBridgeEvent {
                            session_id: event_session_id.clone(),
                            peer_id: event_peer_id.clone(),
                            event: "ice-candidate".to_string(),
                            mline_index,
                            candidate: Some(cand),
                            message: None,
                        };
                        if let Err(error) = event_app.emit(BRIDGE_EVENT, event) {
                            log::debug!("[Capture] Falha ao emitir candidato ICE nativo: {error}");
                        }
                    }
                }
                None
            });

            webrtc.connect_notify(Some("ice-connection-state"), |webrtc, _| {
                let state =
                    webrtc.property::<gst_webrtc::WebRTCICEConnectionState>("ice-connection-state");
                crate::system::write_debug_log(&format!(
                    "[Bridge] webrtcbin ice-connection-state mudou para: {:?}",
                    state
                ));
            });
            webrtc.connect_notify(Some("connection-state"), |webrtc, _| {
                let state =
                    webrtc.property::<gst_webrtc::WebRTCPeerConnectionState>("connection-state");
                crate::system::write_debug_log(&format!(
                    "[Bridge] webrtcbin connection-state mudou para: {:?}",
                    state
                ));
            });
            webrtc.connect_notify(Some("ice-gathering-state"), |webrtc, _| {
                let state =
                    webrtc.property::<gst_webrtc::WebRTCICEGatheringState>("ice-gathering-state");
                crate::system::write_debug_log(&format!(
                    "[Bridge] webrtcbin ice-gathering-state mudou para: {:?}",
                    state
                ));
            });
        }

        // Mantenha as fontes RTP em PAUSED durante a negociação. Em NULL o
        // webrtcbin ainda não prepara todos os pads; em PLAYING o worker pode
        // entregar Opus cedo demais e causar `not-negotiated` antes do SDP.
        pipeline
            .set_state(gst::State::Paused)
            .map_err(|error| format!("Falha ao preparar pipeline WebRTC: {error}"))?;

        Ok(Self {
            pipeline,
            webrtc,
            error_state,
            shutdown,
            bus_thread: Some(bus_thread),
        })
    }

    pub fn create_answer(&self, offer_sdp: &str) -> Result<NativeCaptureSdp, String> {
        self.ensure_healthy()?;
        let sdp = gst_webrtc::gst_sdp::SDPMessage::parse_buffer(offer_sdp.as_bytes())
            .map_err(|error| format!("Oferta SDP inválida: {error}"))?;
        let offer =
            gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Offer, sdp);

        let set_remote_promise = gst::Promise::new();
        self.webrtc
            .emit_by_name::<()>("set-remote-description", &[&offer, &set_remote_promise]);
        wait_promise(&set_remote_promise, "aplicar oferta SDP")?;

        let answer_promise = gst::Promise::new();
        self.webrtc
            .emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &answer_promise]);
        let answer_reply = wait_promise(&answer_promise, "criar resposta SDP")?
            .ok_or_else(|| "webrtcbin não retornou uma resposta SDP".to_string())?;
        let answer = answer_reply
            .get::<gst_webrtc::WebRTCSessionDescription>("answer")
            .map_err(|error| format!("Resposta SDP ausente no retorno do webrtcbin: {error}"))?;

        let set_local_promise = gst::Promise::new();
        self.webrtc
            .emit_by_name::<()>("set-local-description", &[&answer, &set_local_promise]);
        wait_promise(&set_local_promise, "aplicar resposta SDP")?;

        // O worker nativo começa a emitir RTP assim que a sessão é criada.
        // Só deixe as fontes UDP entrarem em PLAYING depois que o offer remoto
        // e a resposta local já definiram os caps dos pads do webrtcbin.
        // Caso contrário, a primeira rajada de Opus pode chegar enquanto
        // sink_1 ainda não está negociado e derrubar toda a pipeline com
        // `udpsrc ... reason not-negotiated`.
        self.pipeline
            .set_state(gst::State::Playing)
            .map_err(|error| format!("Falha ao iniciar pipeline WebRTC: {error}"))?;

        // Host ICE candidates are gathered asynchronously. Waiting briefly
        // lets the returned SDP be usable without requiring a second browser
        // round trip; trickled candidates are still emitted above.
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            if self
                .webrtc
                .property::<gst_webrtc::WebRTCICEGatheringState>("ice-gathering-state")
                == gst_webrtc::WebRTCICEGatheringState::Complete
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        self.ensure_healthy()?;

        let local_description = self
            .webrtc
            .property::<gst_webrtc::WebRTCSessionDescription>("local-description");
        let sdp = local_description
            .sdp()
            .as_text()
            .map_err(|error| format!("Falha ao serializar resposta SDP: {error}"))?;
        Ok(NativeCaptureSdp {
            sdp_type: "answer".to_string(),
            sdp,
        })
    }

    pub fn add_ice_candidate(&self, mline_index: u32, candidate: &str) -> Result<(), String> {
        self.ensure_healthy()?;
        self.webrtc
            .emit_by_name::<()>("add-ice-candidate", &[&mline_index, &candidate]);
        Ok(())
    }

    fn ensure_healthy(&self) -> Result<(), String> {
        let state = self
            .error_state
            .lock()
            .map_err(|_| "Estado da ponte WebRTC indisponível".to_string())?;
        if let Some(error) = state.as_ref() {
            return Err(format!("Pipeline WebRTC nativo falhou: {error}"));
        }
        Ok(())
    }
}

impl Drop for NativeWebRtcBridge {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let _ = self.pipeline.set_state(gst::State::Null);
        if let Some(thread) = self.bus_thread.take() {
            let _ = thread.join();
        }
    }
}

fn wait_promise(promise: &gst::Promise, operation: &str) -> Result<Option<gst::Structure>, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let promise_for_wait = promise.clone();
    let worker = thread::spawn(move || {
        let result = match promise_for_wait.wait() {
            gst::PromiseResult::Replied => Ok(promise_for_wait.get_reply().map(ToOwned::to_owned)),
            gst::PromiseResult::Interrupted => Err("interrupted".to_string()),
            gst::PromiseResult::Expired => Err("expired".to_string()),
            result => Err(format!("{result:?}")),
        };
        let _ = sender.send(result);
    });

    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(reply)) => {
            let _ = worker.join();
            Ok(reply)
        }
        Ok(Err(reason)) => {
            let _ = worker.join();
            Err(format!("webrtcbin falhou ao {operation}: {reason}"))
        }
        Err(_) => {
            // Expirar a promise acorda o waiter e evita uma thread bloqueada
            // caso o elemento nunca responda.
            promise.expire();
            let _ = worker.join();
            Err(format!(
                "Tempo limite ao {operation} na ponte WebRTC nativa"
            ))
        }
    }
}

fn make_udp_source(name: &str, port: u16, caps: &gst::Caps) -> Result<gst::Element, String> {
    let source = gst::ElementFactory::make("udpsrc")
        .name(name)
        .build()
        .map_err(|error| format!("Falha ao criar udpsrc {name}: {error}"))?;
    // RTP is an internal hand-off between the capture worker and this
    // process. Never expose the unauthenticated socket on a LAN interface.
    source.set_property("address", "127.0.0.1");
    source.set_property("buffer-size", 2097152i32);
    source.set_property("do-timestamp", true);
    crate::media::clear_handoff_leases();
    source.set_property("port", port as i32);
    source.set_property("caps", caps);
    Ok(source)
}

fn make_element(factory: &str, name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .name(name)
        .build()
        .map_err(|error| format!("Falha ao criar elemento {factory}: {error}"))
}

fn make_rtp_element(factory: &str, name: &str) -> Result<gst::Element, String> {
    make_element(factory, name)
}

fn make_caps_filter(name: &str, caps: &gst::Caps) -> Result<gst::Element, String> {
    let filter = make_element("capsfilter", name)?;
    filter.set_property("caps", caps);
    Ok(filter)
}

fn link_rtp_output(
    source: &gst::Element,
    webrtc: &gst::Element,
    pad_name: &str,
    label: &str,
) -> Result<(), String> {
    let source_pad = source
        .static_pad("src")
        .ok_or_else(|| format!("udpsrc sem pad src para {label}"))?;
    let sink_pad = webrtc
        .request_pad_simple(pad_name)
        .ok_or_else(|| format!("webrtcbin sem pad {pad_name} para {label}"))?;
    source_pad
        .link(&sink_pad)
        .map_err(|error| format!("Falha ao ligar RTP de {label} ao webrtcbin: {error}"))?;
    Ok(())
}

fn default_video_payload(codec: VideoCodec) -> i32 {
    match codec {
        VideoCodec::H264 => 96,
        VideoCodec::Hevc => 98,
        VideoCodec::Av1 => 99,
    }
}

fn audio_rtp_caps(payload: i32) -> gst::Caps {
    gst::Caps::builder("application/x-rtp")
        .field("media", "audio")
        .field("encoding-name", "OPUS")
        .field("clock-rate", 48_000i32)
        .field("payload", payload)
        .build()
}

fn rtp_caps(codec: VideoCodec, payload: i32) -> gst::Caps {
    let mut builder = gst::Caps::builder("application/x-rtp")
        .field("media", "video")
        .field("clock-rate", 90_000i32)
        .field("payload", payload)
        .field(
            "encoding-name",
            match codec {
                VideoCodec::H264 => "H264",
                VideoCodec::Hevc => "H265",
                VideoCodec::Av1 => "AV1",
            },
        );

    if matches!(codec, VideoCodec::H264) {
        // rtph264pay always packetizes the negotiated H.264 stream in this
        // mode. Without it, webrtcbin may create an answer without a usable
        // H.264 codec and the browser never receives a video track.
        builder = builder.field("packetization-mode", "1");
    }

    builder.build()
}

pub fn sanitize_turn_uri(uri: &str) -> String {
    let (scheme, rest) = if let Some((s, r)) = uri.split_once("://") {
        (format!("{s}://"), r)
    } else if let Some((s, r)) = uri.split_once(':') {
        (format!("{s}:"), r)
    } else {
        return uri.to_string();
    };

    if let Some((_user_info, host_port)) = rest.split_once('@') {
        format!("{scheme}***:***@{host_port}")
    } else {
        uri.to_string()
    }
}

pub fn expand_local_candidates(candidate: &str) -> Vec<String> {
    let mut candidates = vec![candidate.to_string()];
    let parts: Vec<&str> = candidate.split_whitespace().collect();
    if parts.len() >= 8
        && parts[6].eq_ignore_ascii_case("typ")
        && parts[7].eq_ignore_ascii_case("host")
    {
        let addr = parts[4];
        if addr.ends_with(".local") || (addr != "127.0.0.1" && !addr.contains(':')) {
            let mut loopback_parts = parts.clone();
            loopback_parts[4] = "127.0.0.1";
            candidates.push(loopback_parts.join(" "));
        }
    }
    candidates
}

fn negotiated_payload_type(offer_sdp: &str, media: &str, encoding_name: &str) -> Option<i32> {
    let mut in_media_section = false;
    for raw_line in offer_sdp.lines() {
        let line = raw_line.trim();
        if let Some(media_line) = line.strip_prefix("m=") {
            in_media_section = media_line
                .split_whitespace()
                .next()
                .is_some_and(|value| value.eq_ignore_ascii_case(media));
            continue;
        }
        if !in_media_section || !line.starts_with("a=rtpmap:") {
            continue;
        }
        let Some((payload, codec)) = line[9..].split_once(' ') else {
            continue;
        };
        let Some(payload) = payload.parse::<i32>().ok() else {
            continue;
        };
        let offered_encoding = codec.split('/').next().unwrap_or_default();
        if offered_encoding.eq_ignore_ascii_case(encoding_name) {
            return Some(payload);
        }
    }
    None
}

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
    fn creates_in_process_bridge_from_loopback_rtp() {
        let Some(_runtime) = GStreamerRuntime::discover() else {
            panic!("Runtime GStreamer não preparado para o teste da ponte");
        };
        let port = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let bridge =
            NativeWebRtcBridge::new(None, "bridge-test", None, port, None, VideoCodec::H264, None, None)
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
