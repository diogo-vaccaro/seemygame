//! pipeline; internal to the native webrtc_bridge subsystem.
use super::*;

#[derive(Debug)]
pub struct NativeWebRtcBridge {
    pub(crate) pipeline: gst::Pipeline,
    pub(crate) webrtc: gst::Element,
    pub(crate) error_state: Arc<Mutex<Option<String>>>,
    pub(crate) shutdown: Arc<AtomicBool>,
    pub(crate) bus_thread: Option<JoinHandle<()>>,
    pub(crate) video_input: Arc<crate::media::RtpCounters>,
    pub(crate) video_output: Arc<crate::media::RtpCounters>,
    pub(crate) video_queue: gst::Element,
    pub(crate) video_clock_mode: VideoRtpClockMode,
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
        Self::new_with_negotiation(app, session_id, peer_id, video_rtp_port,
            audio_rtp_port, codec, offer_sdp, ice_servers, None)
    }

    pub fn new_with_negotiation(
        app: Option<&BridgeAppHandle>,
        session_id: impl Into<String>,
        peer_id: Option<String>,
        video_rtp_port: u16,
        audio_rtp_port: Option<u16>,
        codec: VideoCodec,
        offer_sdp: Option<&str>,
        ice_servers: Option<&[String]>,
        negotiation_id: Option<String>,
    ) -> Result<Self, String> {
        if let Some(offer) = offer_sdp {
            if negotiated_payload_type(offer, "video", codec.encoding_name()).is_none() {
                return Err(format!("Espectador não oferece {}; reinicie em H.264 ou selecione um codec comum antes de transmitir.", codec.encoding_name()));
            }
        }
        let session_id = session_id.into();
        #[cfg(test)]
        let _ = (&app, &session_id, &peer_id, &negotiation_id);
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
                    let formatted =
                        if trimmed.starts_with("turn://") || trimmed.starts_with("turns://") {
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
        // Explicit diagnostic opt-in. Keep the established default while testing
        // frame pacing, latency and A/V synchronization end to end.
        let video_clock_mode=VideoRtpClockMode::parse(&std::env::var("SEEMYGAME_NATIVE_VIDEO_RTP_CLOCK").unwrap_or_else(|_|"arrival".into()))?;
        let video_clock=if video_clock_mode==VideoRtpClockMode::Rtp {
            let clock=make_element("rtpjitterbuffer","seemygame-video-clock")?;
            clock.set_property("latency",0u32);
            clock.set_property_from_str("mode","none");
            clock.set_property("do-lost",true);
            Some(clock)
        }else{None};
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
        let video_input = Arc::new(crate::media::RtpCounters::default());
        let video_output = Arc::new(crate::media::RtpCounters::default());
        stats::attach_rtp_probe(&video_src, "src", Arc::clone(&video_input))?;
        stats::attach_rtp_probe(&video_queue, "src", Arc::clone(&video_output))?;
        pipeline
            .add_many([
                &video_src,
                &video_depay,
                &video_pay,
                &video_capsfilter,
                &video_queue,
            ])
            .map_err(|error| format!("Falha ao adicionar entrada de vídeo: {error}"))?;
        if let Some(clock)=video_clock.as_ref() {
            pipeline.add(clock).map_err(|error|format!("Falha ao adicionar relógio RTP de vídeo: {error}"))?;
            video_src.link(clock).map_err(|error|format!("Falha ao ligar relógio RTP de vídeo: {error}"))?;
        }
        video_clock.as_ref().unwrap_or(&video_src)
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
                            negotiation_id: negotiation_id.clone(),
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
            video_input, video_output, video_queue, video_clock_mode,
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

    pub(crate) fn ensure_healthy(&self) -> Result<(), String> {
        let state = self
            .error_state
            .lock()
            .map_err(|_| "Estado da ponte WebRTC indisponível".to_string())?;
        if let Some(error) = state.as_ref() {
            return Err(format!("Pipeline WebRTC nativo falhou: {error}"));
        }
        Ok(())
    }

    pub(crate) fn transport_stats(&self) -> Vec<serde_json::Value> {
        [("bridge-input", &self.video_input), ("bridge-output", &self.video_output)].into_iter().map(|(stage, counters)| {
            let mut row = counters.snapshot();
            row["id"] = stage.into(); row["type"] = "native-rtp-stage".into(); row["stage"] = stage.into();
            row["scope"] = "Local RTP pad; bridge-output is before webrtcbin, not NIC departure or remote delivery".into();
            row["videoRtpClockMode"]=self.video_clock_mode.name().into();
            if stage == "bridge-output" {
                row["queueLevelTimeMs"] = (self.video_queue.property::<u64>("current-level-time") as f64 / 1_000_000.0).into();
                row["queueLevelBuffers"] = self.video_queue.property::<u32>("current-level-buffers").into();
                row["queueLevelBytes"] = self.video_queue.property::<u32>("current-level-bytes").into();
            }
            row
        }).collect()
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
