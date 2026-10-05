// Diagnostic tests only. Capture the uniquely named E2E window, never arbitrary user windows.
#[derive(Default)]
struct ProbeEncoderTiming {
    pending: std::collections::HashMap<u64, std::time::Instant>,
    samples_ms: Vec<f64>,
}

fn attach_probe_encoder_timing(pipeline: &gstreamer::Pipeline, name: &str) -> std::sync::Arc<std::sync::Mutex<ProbeEncoderTiming>> {
    use gstreamer::prelude::*;
    use std::sync::{Arc, Mutex};
    let timing = Arc::new(Mutex::new(ProbeEncoderTiming::default()));
    for pad_name in ["sink", "src"] {
        let timing = timing.clone();
        let segment = Mutex::new(None::<gstreamer::FormattedSegment<gstreamer::ClockTime>>);
        pipeline.by_name(name).unwrap().static_pad(pad_name).unwrap().add_probe(
            gstreamer::PadProbeType::BUFFER | gstreamer::PadProbeType::EVENT_DOWNSTREAM,
            move |_, info| {
                if let Some(event) = info.event() {
                    if let gstreamer::EventView::Segment(event) = event.view() {
                        *segment.lock().unwrap() = event.segment().downcast_ref::<gstreamer::ClockTime>().cloned();
                    }
                }
                if let Some(buffer) = info.buffer() {
                    // Some encoders shift the PTS origin. Compare running-time in each pad's segment.
                    let key = segment.lock().unwrap().as_ref().and_then(|s| s.to_running_time(buffer.pts())).map(|t|t.nseconds());
                    if let Some(key) = key {
                        let mut timing = timing.lock().unwrap();
                        if pad_name == "sink" {
                            if timing.pending.len() < 8192 { timing.pending.insert(key, std::time::Instant::now()); }
                        } else if let Some(start) = timing.pending.remove(&key) {
                            if timing.samples_ms.len() < 8192 { timing.samples_ms.push(start.elapsed().as_secs_f64()*1000.0); }
                        }
                    }
                }
                gstreamer::PadProbeReturn::Ok
            });
    }
    timing
}

#[test]
fn encoder_probe_normalizes_shifted_pts_origins() {
    let _gpu_lock = TEST_GPU_MUTEX.lock().unwrap();
    if let Some(runtime)=GStreamerRuntime::discover(){runtime.prepare_process_environment();}
    gstreamer::init().unwrap();
    let input = gstreamer::FormattedSegment::<gstreamer::ClockTime>::new();
    let mut output = input.clone();
    let origin = gstreamer::ClockTime::from_seconds(3_600_000);
    output.set_start(origin);
    let frame = gstreamer::ClockTime::from_mseconds(17);
    assert_eq!(input.to_running_time(frame), output.to_running_time(origin + frame));
}

#[test]
#[ignore = "real WGC stage benchmark; requires a dedicated visible E2E motion window"]
fn benchmark_native_capture_stages() {
    use gstreamer::prelude::*;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    let _gpu_lock = TEST_GPU_MUTEX.lock().unwrap();
    let title = env::var("SMG_PROBE_WINDOW_TITLE").expect("SMG_PROBE_WINDOW_TITLE required");
    assert!(title.starts_with("SMG E2E Motion ") && title.len()>30, "only a unique synthetic E2E window is allowed");
    let candidates = crate::windows_list::enumerate_sources().into_iter().filter(|s|s.source_type=="window" && (s.title==title || s.title.starts_with(&format!("{title} - ")))).collect::<Vec<_>>();
    assert_eq!(candidates.len(),1,"dedicated E2E window must match exactly once");
    let source = crate::windows_list::resolve_capture_source(&candidates[0].id).unwrap();
    let runtime = GStreamerRuntime::discover().expect("GStreamer required");
    runtime.prepare_process_environment(); gstreamer::init().unwrap();
    let seconds = env::var("SMG_PROBE_SECONDS").ok().and_then(|s|s.parse::<u64>().ok()).unwrap_or(10).clamp(5,60);
    let fps = env::var("SMG_PROBE_FPS").ok().and_then(|s|s.parse::<u32>().ok()).unwrap_or(60).clamp(30,120);
    let backend = H264EncoderBackend::parse(&env::var("SMG_PROBE_BACKEND").unwrap_or_else(|_|"nvenc".into())).unwrap();
    assert!(backend!=H264EncoderBackend::Auto,"explicit encoder required");
    let capture_backend = env::var("SMG_PROBE_CAPTURE").unwrap_or_else(|_| "d3d11".into());
    assert!(matches!(capture_backend.as_str(), "d3d11" | "d3d12"), "unsupported capture probe backend");
    assert!(capture_backend != "d3d12" || backend == H264EncoderBackend::Nvenc, "D3D12 experiment currently isolates capture using the same D3D11 NVENC encoder");
    let width=env::var("SMG_PROBE_WIDTH").ok().and_then(|s|s.parse::<u32>().ok()).unwrap_or(1280).clamp(320,1920);
    let height=env::var("SMG_PROBE_HEIGHT").ok().and_then(|s|s.parse::<u32>().ok()).unwrap_or(720).clamp(240,1080);
    let bitrate=env::var("SMG_PROBE_BITRATE").ok().and_then(|s|s.parse::<u32>().ok()).unwrap_or(4500).clamp(256,50000);
    let config = MediaWorkerConfig { capture_backend:CaptureBackend::parse(&capture_backend).unwrap(),h264_encoder:backend,fps,width:Some(width),height:Some(height),bitrate_kbps:bitrate,..Default::default() };
    let args = build_pipeline(&source,&config,5000,None).unwrap();
    let end = args.iter().position(|s|s=="udpsink").unwrap()-1;
    let mut chain=Vec::new(); let mut queues=0;
    for arg in &args[..end] {
        // Use the same pipeline builder as the real worker, including GPU interop.
        chain.push(arg.clone());
        let name=match arg.as_str() {
            "d3d11screencapturesrc"|"d3d12screencapturesrc"=>Some("stage-capture"), "videorate"=>Some("stage-rate"), "d3d11convert"|"d3d12convert"=>Some("stage-convert"), "d3d12download"=>Some("stage-interop"),
            "nvd3d11h264enc"|"mfh264enc"|"x264enc"=>Some("stage-encoder"),
            "queue"=>{queues+=1;Some(if queues==1{"stage-capture-queue"}else{"stage-encoder-queue"})}, _=>None
        };
        if let Some(name)=name {chain.push(format!("name={name}"));}
    }
    let pipeline=gstreamer::parse::launch(&format!("{} ! fakesink sync=false",chain.join(" "))).unwrap().downcast::<gstreamer::Pipeline>().unwrap();
    #[derive(Default)]
    struct Stage { frames:u64, last:Option<Instant>, gaps:Vec<f64> }
    let stages=Arc::new([Mutex::new(Stage::default()),Mutex::new(Stage::default()),Mutex::new(Stage::default()),Mutex::new(Stage::default()),Mutex::new(Stage::default())]);
    for (index,(name,pad)) in [("stage-capture","src"),("stage-rate","src"),("stage-convert","src"),("stage-encoder","sink"),("stage-encoder","src")].iter().enumerate() {
        let stages=stages.clone();
        pipeline.by_name(name).unwrap().static_pad(pad).unwrap().add_probe(gstreamer::PadProbeType::BUFFER,move|_,info|{
            if info.buffer().is_some_and(|b|b.pts().is_some()) {
                let now=Instant::now();let mut s=stages[index].lock().unwrap(); s.frames+=1;
                if let Some(last)=s.last {if s.gaps.len()<8192 {s.gaps.push(now.duration_since(last).as_secs_f64()*1000.0);}}
                s.last=Some(now);
            } gstreamer::PadProbeReturn::Ok
        });
    }
    let timing=attach_probe_encoder_timing(&pipeline,"stage-encoder");
    let journey=attach_probe_frame_journey(&pipeline);
    let result=(||->Result<serde_json::Value,String>{
        pipeline.set_state(gstreamer::State::Playing).map_err(|e|format!("{e:?}"))?;
        std::thread::sleep(Duration::from_secs(2));
        for s in stages.iter(){*s.lock().unwrap()=Stage::default();}
        *timing.lock().unwrap()=ProbeEncoderTiming::default();
        let rate=pipeline.by_name("stage-rate").unwrap();let baseline_drop=rate.property::<u64>("drop");let baseline_duplicate=rate.property::<u64>("duplicate");
        let started=Instant::now();let epoch=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        *journey.lock().unwrap()=ProbeFrameJourney {start:Some(started),..Default::default()};
        let mut queue_samples=Vec::new();let bus=pipeline.bus().unwrap();
        while started.elapsed()<Duration::from_secs(seconds) {
            if let Some(msg)=bus.timed_pop_filtered(gstreamer::ClockTime::from_mseconds(200),&[gstreamer::MessageType::Error,gstreamer::MessageType::Eos]) {
                return Err(format!("unexpected pipeline message: {:?}",msg.view()));
            }
            queue_samples.push(serde_json::json!({"atMs":started.elapsed().as_millis(),"captureMs":pipeline.by_name("stage-capture-queue").unwrap().property::<u64>("current-level-time") as f64/1e6,"encoderMs":pipeline.by_name("stage-encoder-queue").unwrap().property::<u64>("current-level-time") as f64/1e6}));
        }
        let elapsed=started.elapsed().as_secs_f64();
        let frame_journey={let mut j=journey.lock().unwrap();j.start=None;j.report()};
        let stats=stages.iter().zip(["capture","videorate","convert","encoderInput","encoded"]).map(|(stage,name)|{
            let s=stage.lock().unwrap();let mut gaps=s.gaps.clone();gaps.sort_by(f64::total_cmp);
            (name.to_string(),serde_json::json!({"frames":s.frames,"fps":s.frames as f64/elapsed,"gapP95Ms":if gaps.is_empty(){None}else{Some(gaps[((gaps.len() as f64*0.95).ceil() as usize)-1])},"maxGapMs":gaps.last()}))
        }).collect::<serde_json::Map<String,serde_json::Value>>();
        let mut times=timing.lock().unwrap().samples_ms.clone();times.sort_by(f64::total_cmp);
        if stats["encoded"]["frames"].as_u64().unwrap_or(0)==0 {return Err("no encoded frames".into());}
        let encoder_caps=pipeline.by_name("stage-encoder").unwrap().static_pad("src").unwrap().current_caps().map(|c|c.to_string());
        let encoder_input_caps=pipeline.by_name("stage-encoder").unwrap().static_pad("sink").unwrap().current_caps().map(|c|c.to_string());
        let capture_caps=pipeline.by_name("stage-capture").unwrap().static_pad("src").unwrap().current_caps().map(|c|c.to_string());
        Ok(serde_json::json!({"status":"delivered","backend":backend.as_str(),"captureBackend":capture_backend,"pipeline":chain.join(" "),"gstreamerVersion":gstreamer::version_string().to_string(),"encoderInputCaps":encoder_input_caps,"targetFps":fps,"steadySeconds":elapsed,"steadyStartedAt":epoch,"steadyEndedAt":epoch+(elapsed*1000.0) as u128,"stages":stats,"videorateDrop":rate.property::<u64>("drop")-baseline_drop,"videorateDuplicate":rate.property::<u64>("duplicate")-baseline_duplicate,"frameJourney":frame_journey,"queueSamples":queue_samples,"captureCaps":capture_caps,"sourceGeometry":{"width":source.width,"height":source.height,"dpi":source.dpi,"left":source.left,"top":source.top},"encoderCaps":encoder_caps,"encoderTimingSamples":times.len(),"encoderWallP50Ms":if times.is_empty(){None}else{Some(times[times.len()/2])},"encoderWallP95Ms":if times.is_empty(){None}else{Some(times[((times.len() as f64*0.95).ceil() as usize)-1])},"limitations":["WGC dedicated Chrome window; no network/audio/replay","In-process diagnostic pipeline, normal process priority, not the shipping gst-launch worker","Queue sampled at 5Hz; short peaks may be missed","Encoder segment wall time includes scheduling/internal buffering, not GPU-only execution"]}))
    })();
    let _=pipeline.set_state(gstreamer::State::Null);
    match result {Ok(row)=>println!("SMG_CAPTURE_STAGE {row}"),Err(error)=>panic!("capture stage probe failed: {error}")}
}
