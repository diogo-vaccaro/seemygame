//! negotiation; internal to the native webrtc_bridge subsystem.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum VideoRtpClockMode { Arrival, Rtp }
impl VideoRtpClockMode {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value { "arrival" => Ok(Self::Arrival), "rtp" => Ok(Self::Rtp), _ => Err("SEEMYGAME_NATIVE_VIDEO_RTP_CLOCK: use arrival ou rtp".into()) }
    }
    pub(crate) fn name(self) -> &'static str { match self { Self::Arrival => "arrival", Self::Rtp => "rtp" } }
}

#[cfg(test)]
#[test]
fn video_rtp_clock_mode_rejects_unrecognized_experiments() {
    assert_eq!(VideoRtpClockMode::parse("arrival").unwrap(),VideoRtpClockMode::Arrival);
    assert_eq!(VideoRtpClockMode::parse("rtp").unwrap(),VideoRtpClockMode::Rtp);
    assert!(VideoRtpClockMode::parse("fast").is_err());
}

pub(crate) fn make_udp_source(
    name: &str,
    port: u16,
    caps: &gst::Caps,
) -> Result<gst::Element, String> {
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

pub(crate) fn make_element(factory: &str, name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .name(name)
        .build()
        .map_err(|error| format!("Falha ao criar elemento {factory}: {error}"))
}

pub(crate) fn make_rtp_element(factory: &str, name: &str) -> Result<gst::Element, String> {
    make_element(factory, name)
}

pub(crate) fn make_caps_filter(name: &str, caps: &gst::Caps) -> Result<gst::Element, String> {
    let filter = make_element("capsfilter", name)?;
    filter.set_property("caps", caps);
    Ok(filter)
}

pub(crate) fn link_rtp_output(
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

pub(crate) fn default_video_payload(codec: VideoCodec) -> i32 {
    match codec {
        VideoCodec::H264 => 96,
        VideoCodec::Hevc => 98,
        VideoCodec::Av1 => 99,
    }
}

pub(crate) fn audio_rtp_caps(payload: i32) -> gst::Caps {
    gst::Caps::builder("application/x-rtp")
        .field("media", "audio")
        .field("encoding-name", "OPUS")
        .field("clock-rate", 48_000i32)
        .field("payload", payload)
        .build()
}

pub(crate) fn rtp_caps(codec: VideoCodec, payload: i32) -> gst::Caps {
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

pub(crate) fn negotiated_payload_type(
    offer_sdp: &str,
    media: &str,
    encoding_name: &str,
) -> Option<i32> {
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
