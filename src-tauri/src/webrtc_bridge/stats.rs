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
