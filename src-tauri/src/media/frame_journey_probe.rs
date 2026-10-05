// Test-only per-frame evidence. PTS is normalized per pad; pad arrival does not
// prove GPU texture completion or physical presentation.
#[derive(Default)]
struct ProbeFrameJourney {
    start: Option<std::time::Instant>,
    pending: std::collections::BTreeMap<u64, serde_json::Map<String, serde_json::Value>>,
    rows: Vec<serde_json::Value>,
    evicted: u64,
    duplicate_arrivals: u64,
}

impl ProbeFrameJourney {
    fn arrival(&mut self, key: u64, stage: &str, at_ms: f64, pts_age_ms: Option<f64>) {
        let row = self.pending.entry(key).or_default();
        // Keep the first arrival. A repeated PTS must not replace the start time.
        if row.contains_key(stage) { self.duplicate_arrivals += 1; return; }
        row.insert(stage.into(), serde_json::json!(at_ms));
        row.insert(format!("{stage}PtsAgeMs"), serde_json::json!(pts_age_ms));
        if stage == "encoded" {
            let mut row = self.pending.remove(&key).unwrap();
            row.insert("runningTimeNs".into(), serde_json::json!(key));
            for (metric, from, to) in [
                ("captureToEncoderInputMs", "capture", "encoderInput"),
                ("captureToEncodedMs", "capture", "encoded"),
                ("encodeMs", "encoderInput", "encoded"),
                ("captureQueueMs", "captureQueueIn", "captureQueueOut"),
                ("encoderQueueMs", "encoderQueueIn", "encoderQueueOut"),
                ("convertMs", "convertIn", "convert"),
                ("interopMs", "interopIn", "interopOut"),
            ] {
                let value = row.get(from).and_then(|v|v.as_f64()).zip(row.get(to).and_then(|v|v.as_f64()))
                    .and_then(|(a,b)|if b >= a {Some(b-a)} else {None});
                row.insert(metric.into(), serde_json::json!(value));
            }
            if self.rows.len() < 8192 { self.rows.push(serde_json::Value::Object(row)); }
        }
        while self.pending.len() > 8192 { self.pending.pop_first(); self.evicted += 1; }
    }

    fn report(&self) -> serde_json::Value {
        let mut summaries = serde_json::Map::new();
        for metric in ["captureToEncoderInputMs", "captureToEncodedMs", "encodeMs", "captureQueueMs", "encoderQueueMs", "convertMs", "interopMs", "capturePtsAgeMs", "encoderInputPtsAgeMs", "encodedPtsAgeMs"] {
            let mut values = self.rows.iter().filter_map(|r|r[metric].as_f64()).collect::<Vec<_>>();
            values.sort_by(f64::total_cmp);
            let percentile = |q:f64| if values.is_empty(){None}else{Some(values[(values.len() as f64*q).ceil() as usize-1])};
            summaries.insert(metric.into(), serde_json::json!({"samples":values.len(),"p50":percentile(0.5),"p95":percentile(0.95),"p99":percentile(0.99),"max":values.last()}));
        }
        serde_json::json!({"metrics":summaries,"frames":self.rows,"pendingUnmatched":self.pending.len(),"evicted":self.evicted,"duplicateArrivals":self.duplicate_arrivals,"scope":"Matched running-time per frame; wall times include scheduling/backpressure; PTS age uses the pipeline clock, not optical source timestamps or GPU completion"})
    }
}

fn attach_probe_frame_journey(pipeline:&gstreamer::Pipeline) -> std::sync::Arc<std::sync::Mutex<ProbeFrameJourney>> {
    use gstreamer::prelude::*;
    use std::sync::{Arc,Mutex};
    let journey = Arc::new(Mutex::new(ProbeFrameJourney::default()));
    for (name,pad,stage) in [
        ("stage-capture","src","capture"),
        ("stage-capture-queue","sink","captureQueueIn"), ("stage-capture-queue","src","captureQueueOut"),
        ("stage-rate","src","rate"),
        ("stage-convert","sink","convertIn"), ("stage-convert","src","convert"),
        ("stage-interop","sink","interopIn"), ("stage-interop","src","interopOut"),
        ("stage-encoder-queue","sink","encoderQueueIn"), ("stage-encoder-queue","src","encoderQueueOut"),
        ("stage-encoder","sink","encoderInput"), ("stage-encoder","src","encoded"),
    ] {
        let Some(element)=pipeline.by_name(name) else {continue};
        let segment=Mutex::new(None::<gstreamer::FormattedSegment<gstreamer::ClockTime>>);
        let state=journey.clone();let pipeline=pipeline.downgrade();
        element.static_pad(pad).unwrap().add_probe(gstreamer::PadProbeType::BUFFER|gstreamer::PadProbeType::EVENT_DOWNSTREAM,move|_,info|{
            if let Some(event)=info.event(){if let gstreamer::EventView::Segment(event)=event.view(){*segment.lock().unwrap()=event.segment().downcast_ref::<gstreamer::ClockTime>().cloned();}}
            if let Some(buffer)=info.buffer(){
                let key=segment.lock().unwrap().as_ref().and_then(|s|s.to_running_time(buffer.pts()));
                if let Some(key)=key {
                    let now=std::time::Instant::now();
                    let age=pipeline.upgrade().and_then(|p|p.current_running_time()).and_then(|t|t.checked_sub(key)).map(|t|t.nseconds() as f64/1e6);
                    let mut state=state.lock().unwrap();
                    if let Some(start)=state.start {state.arrival(key.nseconds(),stage,now.duration_since(start).as_secs_f64()*1000.0,age);}
                }
            }
            gstreamer::PadProbeReturn::Ok
        });
    }
    journey
}

#[test]
fn frame_journey_matches_frames_and_preserves_missing_evidence() {
    let mut p=ProbeFrameJourney::default();
    p.arrival(1,"capture",10.,Some(2.));p.arrival(2,"capture",11.,Some(3.));
    p.arrival(1,"encoderInput",14.,Some(6.));p.arrival(1,"encoded",20.,Some(12.));
    p.arrival(3,"encoderInput",21.,None);p.arrival(3,"encoded",25.,None);
    assert_eq!(p.rows[0]["captureToEncoderInputMs"],4.);
    assert_eq!(p.rows[0]["encodeMs"],6.);
    assert!(p.rows[1]["captureToEncodedMs"].is_null());
    assert_eq!(p.report()["metrics"]["captureToEncodedMs"]["samples"],1);
    assert_eq!(p.report()["pendingUnmatched"],1);
}

#[test]
fn frame_journey_bounds_unmatched_frames_and_rejects_negative_intervals() {
    let mut p=ProbeFrameJourney::default();
    p.arrival(1,"capture",10.,None);p.arrival(1,"capture",12.,None);
    p.arrival(1,"encoded",9.,None);
    assert_eq!(p.duplicate_arrivals,1);assert!(p.rows[0]["captureToEncodedMs"].is_null());
    for key in 2..=8200 {p.arrival(key,"capture",0.,None);}
    assert_eq!(p.pending.len(),8192);assert_eq!(p.evicted,7);
}
