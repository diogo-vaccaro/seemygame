//! Count encoded video access units at the worker handoff, without decoding or GPU readback.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use std::collections::VecDeque;

/// Video RTP clock at 90 kHz. Arrival timing and media timing are different observations.
#[derive(Debug, Default)]
struct RtpFrameClock {
    previous: Option<(u32, u32, u64)>,
    samples: VecDeque<(f64, f64)>,
    resets: u64,
    non_forward: u64,
}
impl RtpFrameClock {
    fn observe(&mut self, ssrc: u32, timestamp: u32, arrival_us: u64) {
        if let Some((old_ssrc, old_timestamp, old_arrival)) = self.previous {
            if old_ssrc != ssrc {
                self.resets += 1;
                self.samples.clear();
            } else {
                let ticks = timestamp.wrapping_sub(old_timestamp) as i32;
                if ticks <= 0 || arrival_us < old_arrival {
                    self.non_forward += 1;
                    return;
                }
                self.samples.push_back((ticks as f64 / 90.0, (arrival_us - old_arrival) as f64 / 1000.0));
                if self.samples.len() > 256 { self.samples.pop_front(); }
            }
        }
        self.previous = Some((ssrc, timestamp, arrival_us));
    }
    fn report(&self) -> serde_json::Value {
        let distribution = |mut values: Vec<f64>| {
            values.sort_by(f64::total_cmp);
            let percentile = |q: f64| if values.is_empty() { None } else { Some(values[(values.len() as f64 * q).ceil() as usize - 1]) };
            serde_json::json!({"p50":percentile(0.5),"p95":percentile(0.95),"p99":percentile(0.99),"min":values.first(),"max":values.last(),"samplesCount":values.len()})
        };
        serde_json::json!({"clockRateHz":90000,"windowSize":256,"ssrcResets":self.resets,"nonForwardMarkers":self.non_forward,
            "timestampDeltaMs":distribution(self.samples.iter().map(|s|s.0).collect()),
            "arrivalDeltaMs":distribution(self.samples.iter().map(|s|s.1).collect()),
            "arrivalMinusTimestampMs":distribution(self.samples.iter().map(|s|s.1-s.0).collect()),
            "scope":"Recent forward video RTP marker pairs in one SSRC; 90 kHz media clock versus local arrival clock; not capture time, NIC departure or display time"})
    }
}

#[derive(Debug)]
pub(crate) struct RtpCounters {
    start: Instant,
    packets: AtomicU64,
    bytes: AtomicU64,
    frames: AtomicU64,
    last_frame_us: AtomicU64,
    max_gap_us: AtomicU64,
    sequence: Mutex<Option<(u32, u16)>>,
    sequence_gap_packets: AtomicU64,
    reordered_packets: AtomicU64,
    duplicate_packets: AtomicU64,
    marker: Mutex<Option<(u32, u32)>>,
    frame_clock: Mutex<RtpFrameClock>,
}
impl Default for RtpCounters {
    fn default() -> Self {
        Self { start: Instant::now(), packets: AtomicU64::new(0), bytes: AtomicU64::new(0), frames: AtomicU64::new(0), last_frame_us: AtomicU64::new(0), max_gap_us: AtomicU64::new(0), marker: Mutex::new(None), frame_clock: Mutex::new(RtpFrameClock::default()), sequence: Mutex::new(None), sequence_gap_packets: AtomicU64::new(0), reordered_packets: AtomicU64::new(0), duplicate_packets: AtomicU64::new(0) }
    }
}
impl RtpCounters {
    pub(crate) fn observe(&self, packet: &[u8]) {
        if packet.len() < 12 || packet[0] >> 6 != 2 { return; }
        self.packets.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(packet.len() as u64, Ordering::Relaxed);
        let ssrc = u32::from_be_bytes(packet[8..12].try_into().unwrap());
        let seq = u16::from_be_bytes(packet[2..4].try_into().unwrap());
        if let Ok(mut previous) = self.sequence.lock() {
            match *previous {
                Some((old_ssrc, old_seq)) if old_ssrc == ssrc => {
                    let distance = seq.wrapping_sub(old_seq);
                    if distance == 0 { self.duplicate_packets.fetch_add(1, Ordering::Relaxed); }
                    else if distance < 32768 {
                        self.sequence_gap_packets.fetch_add((distance - 1) as u64, Ordering::Relaxed);
                        *previous = Some((ssrc, seq));
                    } else { self.reordered_packets.fetch_add(1, Ordering::Relaxed); }
                }
                _ => { *previous = Some((ssrc, seq)); }
            }
        }
        if packet[1] & 0x80 == 0 { return; }
        // RTP marker completes an H264/H265/AV1 access unit, not each fragmented packet.
        let timestamp = u32::from_be_bytes(packet[4..8].try_into().unwrap());
        let Ok(mut marker) = self.marker.lock() else { return; };
        if *marker == Some((ssrc, timestamp)) { return; }
        *marker = Some((ssrc, timestamp));
        let now = self.start.elapsed().as_micros().min(u64::MAX as u128) as u64;
        if let Ok(mut clock) = self.frame_clock.lock() { clock.observe(ssrc, timestamp, now); }
        let previous = self.last_frame_us.swap(now, Ordering::Relaxed);
        if self.frames.fetch_add(1, Ordering::Relaxed) > 0 {
            self.max_gap_us.fetch_max(now.saturating_sub(previous), Ordering::Relaxed);
        }
    }
    pub(crate) fn snapshot(&self) -> serde_json::Value {
        let frames = self.frames.load(Ordering::Relaxed);
        serde_json::json!({"id":"capture-worker", "type":"native-pipeline",
            "framesProduced":frames, "packetsProduced":self.packets.load(Ordering::Relaxed), "bytesProduced":self.bytes.load(Ordering::Relaxed),
            "sequenceGapPackets":self.sequence_gap_packets.load(Ordering::Relaxed), "reorderedPackets":self.reordered_packets.load(Ordering::Relaxed), "duplicatePackets":self.duplicate_packets.load(Ordering::Relaxed),
            "sequenceScope":"Forward sequence gaps, not certified loss; late arrivals do not subtract earlier gaps. One active SSRC, modular half-range comparison.",
            "producerFrameAgeMs":if frames>0 { Some(self.start.elapsed().as_micros().saturating_sub(self.last_frame_us.load(Ordering::Relaxed) as u128) as f64/1000.0) } else { None },
            "producerMaxPauseMs":self.max_gap_us.load(Ordering::Relaxed) as f64/1000.0,
            "rtpFrameClock":self.frame_clock.lock().ok().map(|clock|clock.report()) })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_clock_is_distinct_from_bursty_arrival_and_handles_wrap() {
        let mut clock=RtpFrameClock::default();
        clock.observe(1,u32::MAX-1499,0);
        clock.observe(1,0,1000);
        clock.observe(1,1500,33333);
        let report=clock.report();
        assert_eq!(report["timestampDeltaMs"]["samplesCount"],2);
        assert_eq!(report["timestampDeltaMs"]["max"],1500.0/90.0);
        assert_eq!(report["arrivalDeltaMs"]["min"],1.0);
        assert_eq!(report["arrivalDeltaMs"]["max"],32.333);
        assert_eq!(report["nonForwardMarkers"],0);
    }
    #[test]
    fn clock_rejects_late_markers_bounds_history_and_resets_on_ssrc_change() {
        let mut clock=RtpFrameClock::default();
        for i in 0..300 { clock.observe(1,i*1500,i as u64*16667); }
        clock.observe(1,298*1500,5_000_000);
        assert_eq!(clock.report()["nonForwardMarkers"],1);
        assert_eq!(clock.report()["timestampDeltaMs"]["samplesCount"],256);
        clock.observe(2,100,5_000_001);
        assert_eq!(clock.report()["ssrcResets"],1);
        assert_eq!(clock.report()["timestampDeltaMs"]["samplesCount"],0);
    }
    #[test]
    fn fragmented_rtp_and_duplicate_marker_count_only_one_completed_frame() {
        let counter = RtpCounters::default();
        let mut packet = [0u8; 13]; packet[0]=0x80;packet[1]=96;
        counter.observe(&packet);assert_eq!(counter.snapshot()["framesProduced"],0);
        packet[1]|=0x80;counter.observe(&packet);counter.observe(&packet);
        assert_eq!(counter.snapshot()["framesProduced"],1);
        packet[7]=1;counter.observe(&packet);assert_eq!(counter.snapshot()["framesProduced"],2);
        assert_eq!(counter.snapshot()["packetsProduced"],4);
    }
    #[test]
    fn invalid_header_and_incomplete_packets_are_ignored() {
        let counter = RtpCounters::default();counter.observe(&[0;8]);counter.observe(&[0;20]);
        assert_eq!(counter.snapshot()["packetsProduced"],0);
        assert!(counter.snapshot()["producerFrameAgeMs"].is_null());
    }
    #[test]
    fn sequence_wrap_late_packets_and_ssrc_changes_do_not_create_false_huge_gaps() {
        let counter = RtpCounters::default();
        let mut p=[0u8;12];p[0]=0x80;p[1]=96;
        for seq in [65534u16,65535,0,2,1,2,3] { p[2..4].copy_from_slice(&seq.to_be_bytes()); counter.observe(&p); }
        let s=counter.snapshot();assert_eq!(s["sequenceGapPackets"],1);assert_eq!(s["reorderedPackets"],1);assert_eq!(s["duplicatePackets"],1);
        p[11]=1;p[2..4].copy_from_slice(&500u16.to_be_bytes());counter.observe(&p);
        assert_eq!(counter.snapshot()["sequenceGapPackets"],1);
    }
}
