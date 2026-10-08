//! Safe scalar statistics only. Never serialize ICE candidates, addresses or SDP.
use super::*;

const FIELDS: &[&str] = &[
    "codec-id", "transport-id", "local-id", "remote-id", "selected-candidate-pair-id",
    "mime-type", "sdp-fmtp-line", "kind", "ssrc", "state", "nominated",
    "bytes-sent", "bytes-received", "packets-sent", "packets-received", "packets-lost",
    "frames-encoded", "frames-decoded", "frames-per-second", "frame-width", "frame-height",
    "total-encode-time", "total-decode-time", "jitter", "jitter-buffer-delay",
    "jitter-buffer-emitted-count", "current-round-trip-time", "round-trip-time",
    "fraction-lost", "available-outgoing-bitrate", "nack-count", "pli-count",
];

/// Header-only observation: neither decode nor GPU readback. Payload data is never exported.
pub(crate) fn attach_rtp_probe(element: &gst::Element, pad_name: &str, counters: Arc<crate::media::RtpCounters>) -> Result<(), String> {
    let pad = element.static_pad(pad_name).ok_or("RTP probe pad missing")?;
    pad.add_probe(gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST, move |_, info| {
        match info.data.as_ref() {
            Some(gst::PadProbeData::Buffer(buffer)) => {
                if let Ok(map) = buffer.map_readable() { counters.observe(map.as_slice()); }
            }
            Some(gst::PadProbeData::BufferList(list)) => {
                for buffer in list.iter() { if let Ok(map) = buffer.map_readable() { counters.observe(map.as_slice()); } }
            }
            _ => {}
        }
        gst::PadProbeReturn::Ok
    }).ok_or("RTP probe installation failed")?;
    Ok(())
}

fn camel(key: &str) -> String {
    let mut upper = false;
    key.chars().filter_map(|c| {
        if c == '-' { upper = true; None } else if upper { upper = false; Some(c.to_ascii_uppercase()) } else { Some(c) }
    }).collect()
}

pub(crate) fn normalize(report: &gst::StructureRef) -> serde_json::Value {
    let mut result = serde_json::Map::new();
    if let Ok(id) = report.get::<String>("id") { result.insert("id".into(), id.into()); }
    if let Ok(kind) = report.get::<gst_webrtc::WebRTCStatsType>("type") {
        let name = match kind {
            gst_webrtc::WebRTCStatsType::Codec => "codec",
            gst_webrtc::WebRTCStatsType::InboundRtp => "inbound-rtp",
            gst_webrtc::WebRTCStatsType::OutboundRtp => "outbound-rtp",
            gst_webrtc::WebRTCStatsType::RemoteInboundRtp => "remote-inbound-rtp",
            gst_webrtc::WebRTCStatsType::CandidatePair => "candidate-pair",
            gst_webrtc::WebRTCStatsType::Transport => "transport",
            _ => "other",
        };
        result.insert("type".into(), name.into());
    }
    for &key in FIELDS {
        let value = if let Ok(v) = report.get::<f64>(key) { serde_json::Number::from_f64(v).map(serde_json::Value::Number) }
        else if let Ok(v) = report.get::<u64>(key) { Some(v.into()) }
        else if let Ok(v) = report.get::<u32>(key) { Some(v.into()) }
        else if let Ok(v) = report.get::<i64>(key) { Some(v.into()) }
        else if let Ok(v) = report.get::<i32>(key) { Some(v.into()) }
        else if let Ok(v) = report.get::<bool>(key) { Some(v.into()) }
        else if let Ok(v) = report.get::<String>(key) { Some(v.into()) }
        else { None };
        if let Some(value) = value { result.insert(camel(key), value); }
    }
    result.into()
}

pub(crate) fn collect(webrtc: &gst::Element) -> Result<Vec<serde_json::Value>, String> {
    let promise = gst::Promise::new();
    webrtc.emit_by_name::<()>("get-stats", &[&None::<gst::Pad>, &promise]);
    wait_promise(&promise, "telemetria WebRTC")?;
    let reply = promise.get_reply().ok_or("Telemetria nativa sem resposta")?;
    let mut reports: Vec<serde_json::Value> = reply.iter().filter_map(|(_, value)| value.get::<gst::Structure>().ok()).map(|s| normalize(&s)).collect();
    reports.push(serde_json::json!({
        "id": "native-connection", "type": "native-connection",
        "iceConnectionState": format!("{:?}", webrtc.property::<gst_webrtc::WebRTCICEConnectionState>("ice-connection-state")).to_ascii_lowercase(),
        "connectionState": format!("{:?}", webrtc.property::<gst_webrtc::WebRTCPeerConnectionState>("connection-state")).to_ascii_lowercase(),
    }));
    Ok(reports)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn depay_repay_video_clock_can_reconstruct_original_rtp_ticks() {
        let runtime=GStreamerRuntime::discover().expect("runtime empacotado de teste");
        initialize_gstreamer(&runtime).unwrap();
        // Generate a valid encoded fixture including SPS/PPS; an arbitrary IDR-like
        // byte string is not a valid depay/pay integration test.
        let fixture=gst::parse::launch("videotestsrc num-buffers=6 ! video/x-raw,width=32,height=32,framerate=60/1 ! x264enc tune=zerolatency speed-preset=ultrafast key-int-max=1 bframes=0 ! rtph264pay pt=96 aggregate-mode=zero-latency ! appsink name=encoded sync=false").unwrap().downcast::<gst::Pipeline>().unwrap();
        let sink=fixture.by_name("encoded").unwrap();
        fixture.set_state(gst::State::Playing).unwrap();
        let mut packets=Vec::new();let mut frame_index=0usize;
        while frame_index<6 {
            let sample=sink.emit_by_name::<Option<gst::Sample>>("try-pull-sample", &[&gst::ClockTime::from_seconds(2)]).expect("encoded RTP fixture");
            let map=sample.buffer().unwrap().map_readable().unwrap();
            let packet=map.as_slice().to_vec();let marker=packet[1]&0x80!=0;
            packets.push((packet,frame_index));if marker {frame_index+=1;}
        }
        fixture.set_state(gst::State::Null).unwrap();
        for reconstruct in [false,true] {
        let clock=if reconstruct {"rtpjitterbuffer latency=0 mode=none ! "}else{""};
        let pipeline=gst::parse::launch(&format!("appsrc name=input is-live=true format=time caps=\"application/x-rtp,media=video,encoding-name=H264,clock-rate=90000,payload=96\" ! identity name=before ! {clock}rtph264depay ! rtph264pay pt=96 perfect-rtptime=true config-interval=-1 aggregate-mode=zero-latency ! identity name=after ! fakesink sync=false async=false")).unwrap().downcast::<gst::Pipeline>().unwrap();
        let before=Arc::new(crate::media::RtpCounters::default());
        let after=Arc::new(crate::media::RtpCounters::default());
        attach_rtp_probe(&pipeline.by_name("before").unwrap(),"src",Arc::clone(&before)).unwrap();
        attach_rtp_probe(&pipeline.by_name("after").unwrap(),"src",Arc::clone(&after)).unwrap();
        pipeline.set_state(gst::State::Playing).unwrap();
        for (sequence,(fixture_packet,index)) in packets.iter().enumerate() {
            let pts_ms=[0u64,1,33,34,66,67][*index];
            let mut packet=fixture_packet.clone();
            packet[2..4].copy_from_slice(&(sequence as u16).to_be_bytes());
            packet[4..8].copy_from_slice(&(*index as u32*1500).to_be_bytes());
            packet[8..12].copy_from_slice(&1u32.to_be_bytes());
            let mut buffer=gst::Buffer::from_mut_slice(packet);
            buffer.get_mut().unwrap().set_pts(gst::ClockTime::from_mseconds(pts_ms));
            assert_eq!(pipeline.by_name("input").unwrap().emit_by_name::<gst::FlowReturn>("push-buffer", &[&buffer]),gst::FlowReturn::Ok);
        }
        assert_eq!(pipeline.by_name("input").unwrap().emit_by_name::<gst::FlowReturn>("end-of-stream", &[]),gst::FlowReturn::Ok);
        let deadline=Instant::now()+Duration::from_secs(2);
        while after.snapshot()["framesProduced"]!=6&&Instant::now()<deadline {thread::sleep(Duration::from_millis(5));}
        pipeline.set_state(gst::State::Null).unwrap();
        let incoming=before.snapshot();let outgoing=after.snapshot();
        assert_eq!(incoming["framesProduced"],6);
        assert_eq!(outgoing["framesProduced"],6,"{outgoing}");
        assert_eq!(incoming["rtpFrameClock"]["timestampDeltaMs"]["max"],1500.0/90.0);
        if reconstruct {
            for bound in ["min","max"] {assert!((outgoing["rtpFrameClock"]["timestampDeltaMs"][bound].as_f64().unwrap()-1500.0/90.0).abs()<0.03,"{outgoing}");}
        } else {
            assert_eq!(outgoing["rtpFrameClock"]["timestampDeltaMs"]["min"],1.0);
            assert_eq!(outgoing["rtpFrameClock"]["timestampDeltaMs"]["max"],32.0);
        }
        }
    }
    #[test]
    fn rtp_pad_probe_counts_fragmented_buffer_lists_without_decoding() {
        let runtime = GStreamerRuntime::discover().expect("runtime empacotado de teste");
        initialize_gstreamer(&runtime).unwrap();
        let pipeline = gst::parse::launch("appsrc name=input is-live=true format=time caps=\"application/x-rtp,media=video,encoding-name=H264,clock-rate=90000,payload=96\" ! identity name=stage ! fakesink sync=false async=false").unwrap().downcast::<gst::Pipeline>().unwrap();
        let counters = Arc::new(crate::media::RtpCounters::default());
        attach_rtp_probe(&pipeline.by_name("stage").unwrap(), "src", Arc::clone(&counters)).unwrap();
        let mut list = gst::BufferList::new();
        for (seq, marker) in [(0u16, false), (1, true)] {
            let mut bytes=vec![0u8;13];bytes[0]=0x80;bytes[1]=96 | if marker { 0x80 } else { 0 };bytes[2..4].copy_from_slice(&seq.to_be_bytes());
            list.get_mut().unwrap().add(gst::Buffer::from_mut_slice(bytes));
        }
        pipeline.set_state(gst::State::Playing).unwrap();
        let flow=pipeline.by_name("input").unwrap().emit_by_name::<gst::FlowReturn>("push-buffer-list", &[&list]);
        assert_eq!(flow, gst::FlowReturn::Ok);
        let deadline=Instant::now()+Duration::from_secs(2);
        while counters.snapshot()["packetsProduced"]!=2 && Instant::now()<deadline { thread::sleep(Duration::from_millis(5)); }
        pipeline.set_state(gst::State::Null).unwrap();
        let report=counters.snapshot();assert_eq!(report["packetsProduced"],2);assert_eq!(report["framesProduced"],1);assert_eq!(report["sequenceGapPackets"],0);
    }
    #[test]
    fn stats_export_is_allowlisted_and_preserves_units() {
        let runtime = GStreamerRuntime::discover().expect("runtime empacotado de teste");
        initialize_gstreamer(&runtime).unwrap();
        let report = gst::Structure::builder("outbound")
            .field("id", "rtp-1").field("type", gst_webrtc::WebRTCStatsType::OutboundRtp)
            .field("bytes-sent", 4000u64).field("round-trip-time", 0.025f64)
            .field("ip", "secret").field("candidate", "secret").build();
        let output = normalize(&report);
        assert_eq!(output["type"], "outbound-rtp");
        assert_eq!(output["bytesSent"], 4000);
        assert_eq!(output["roundTripTime"], 0.025);
        assert!(output.get("ip").is_none());
        assert!(output.get("candidate").is_none());
    }
}
