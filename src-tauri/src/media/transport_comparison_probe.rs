// Test-only controlled sender, native receiver and COMMON window observer.
// Never compiled into the shipping application. Only a uniquely named fixture
// window (or its fully covered monitor) can be captured by this diagnostic.
mod transport_comparison {
    use super::*;
    use gst::prelude::*;
    use gstreamer as gst;
    use gstreamer_video::prelude::*;
    use gstreamer_webrtc as rtc;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn D3DKMTSetProcessSchedulingPriorityClass(
            process: *mut std::ffi::c_void,
            class: u32,
        ) -> i32;
        fn D3DKMTGetProcessSchedulingPriorityClass(
            process: *mut std::ffi::c_void,
            class: *mut u32,
        ) -> i32;
    }
    fn priority(mode: &str) -> Value {
        assert!(matches!(mode, "normal" | "high"));
        unsafe {
            use windows::Win32::System::Threading::{
                GetCurrentProcess, GetPriorityClass, SetPriorityClass, HIGH_PRIORITY_CLASS,
            };
            let handle = GetCurrentProcess();
            let cpu = SetPriorityClass(handle, HIGH_PRIORITY_CLASS).is_ok();
            let mut before = 99;
            let before_status = D3DKMTGetProcessSchedulingPriorityClass(handle.0, &mut before);
            let requested = if mode == "high" { 4 } else { 2 };
            let status = D3DKMTSetProcessSchedulingPriorityClass(handle.0, requested);
            let mut after = 99;
            let read_status = D3DKMTGetProcessSchedulingPriorityClass(handle.0, &mut after);
            json!({"mode":mode,"cpuHighApplied":cpu,"cpuPriorityClass":GetPriorityClass(handle),"beforeClass":before,"beforeStatus":before_status,"requestedGpuClass":requested,"setStatus":status,"readStatus":read_status,"effectiveGpuClass":after,"applied":cpu&&status==0&&read_status==0&&after==requested,"scope":"Process GPU scheduling class; does not establish per-device/per-queue priority or alter the game's context"})
        }
    }
    fn fixture(title: &str) -> ValidatedSource {
        assert!(title.starts_with("SMG E2E Motion ") && title.len() > 30);
        let candidates = crate::windows_list::enumerate_sources()
            .into_iter()
            .filter(|s| {
                s.source_type == "window"
                    && (s.title == title || s.title.starts_with(&format!("{title} - ")))
            })
            .collect::<Vec<_>>();
        assert_eq!(candidates.len(), 1, "Unique fixture window required");
        crate::windows_list::resolve_capture_source(&candidates[0].id).unwrap()
    }
    fn monitor_for(source: &ValidatedSource) -> ValidatedSource {
        let monitors = crate::windows_list::enumerate_sources()
            .into_iter()
            .filter(|s| s.source_type == "monitor" && s.monitor_id == source.monitor_id)
            .collect::<Vec<_>>();
        assert_eq!(monitors.len(), 1, "Fixture monitor must be unambiguous");
        let monitor = crate::windows_list::resolve_capture_source(&monitors[0].id).unwrap();
        assert_eq!(
            (source.left, source.top, source.width, source.height),
            (monitor.left, monitor.top, monitor.width, monitor.height),
            "Monitor experiment requires the fixture to fully cover its monitor"
        );
        monitor
    }
    fn monotonic_epoch(base: f64, start: Instant) -> f64 {
        base + start.elapsed().as_secs_f64() * 1000.
    }
    fn network_stats(peer: &gst::Element) -> Result<Value, String> {
        let promise = gst::Promise::new();
        peer.emit_by_name::<()>("get-stats", &[&None::<gst::Pad>, &promise]);
        let reply = crate::webrtc_common::wait_promise(&promise, "diagnostic network stats")?
            .ok_or("missing stats")?;
        let rows = reply
            .iter()
            .filter_map(|(_, v)| v.get::<gst::Structure>().ok())
            .map(|s| {
                let mut row = crate::webrtc_bridge::stats::normalize(&s);
                for field in [
                    "ip",
                    "address",
                    "protocol",
                    "candidate-type",
                    "local-candidate-id",
                    "remote-candidate-id",
                ] {
                    if let Ok(v) = s.get::<String>(field) {
                        row[field] = json!(v);
                    }
                }
                if let Ok(v) = s.get::<u32>("port") {
                    row["port"] = json!(v);
                }
                row
            })
            .collect::<Vec<_>>();
        Ok(json!(rows))
    }
    #[derive(Default)]
    struct Evidence {
        decoded: u64,
        present_calls: u64,
        render_gaps: Vec<f64>,
        last_render: Option<Instant>,
        optics: Vec<Value>,
        readbacks: Vec<f64>,
        failures: u64,
        candidates: Vec<Value>,
        received_caps: Option<String>,
    }
    fn crc(bytes: &[u8]) -> u16 {
        let mut c = 0xffffu16;
        for b in bytes {
            c ^= (*b as u16) << 8;
            for _ in 0..8 {
                c = if c & 0x8000 != 0 {
                    (c << 1) ^ 0x1021
                } else {
                    c << 1
                };
            }
        }
        c
    }
    fn decode_pixels(
        data: &[u8],
        stride: usize,
        width: usize,
        height: usize,
        magic: u16,
    ) -> Option<(u32, u32)> {
        if width < 4
            || height < 5
            || stride < width.checked_mul(4)?
            || data.len() < stride.checked_mul(height)?
        {
            return None;
        }
        let pre = [1, 0, 1, 0, 1, 1, 0, 0];
        for block in [8.0_f64, 8. * 1280. / 1920., 8. * 640. / 1920.] {
            let span = (96. * block).ceil() as usize;
            if width < span + 4 {
                continue;
            }
            for y in (4..height.min(180)).step_by(3) {
                // Borders and fractional browser scaling can place the only
                // valid sampling phase on an odd pixel. Never skip that phase.
                for x in 0..(width - span).min(120) {
                    let l = |i: usize| {
                        let p = y * stride
                            + ((x as f64 + (i as f64 + 0.5) * block).floor() as usize) * 4;
                        (data[p] as f64 + data[p + 1] as f64 + data[p + 2] as f64) / 3.
                    };
                    let white = (l(0) + l(2) + l(4) + l(5)) / 4.;
                    let black = (l(1) + l(3) + l(6) + l(7)) / 4.;
                    if white - black < 50. || white < 110. || black > 110. {
                        continue;
                    }
                    let t = (white + black) / 2.;
                    let bits = (0..96).map(|i| u32::from(l(i) >= t)).collect::<Vec<_>>();
                    if bits[..8] != pre {
                        continue;
                    }
                    let field =
                        |a: usize, b: usize| bits[a..b].iter().fold(0u32, |v, b| (v << 1) | b);
                    if field(8, 24) != magic as u32 {
                        continue;
                    }
                    let seq = field(24, 48);
                    let time = field(48, 80);
                    let payload = [
                        (magic >> 8) as u8,
                        magic as u8,
                        (seq >> 16) as u8,
                        (seq >> 8) as u8,
                        seq as u8,
                        (time >> 24) as u8,
                        (time >> 16) as u8,
                        (time >> 8) as u8,
                        time as u8,
                    ];
                    if crc(&payload) as u32 == field(80, 96) {
                        return Some((seq, time));
                    }
                }
            }
        }
        None
    }
    fn observer(
        title: &str,
        magic: u16,
        state: Arc<Mutex<Evidence>>,
        base: f64,
        start: Instant,
    ) -> Result<gst::Pipeline, String> {
        let source = fixture(title);
        let observer_fps = env::var("SMG_COMPARE_OBSERVER_FPS")
            .unwrap_or_else(|_| "8".into())
            .parse::<u32>()
            .map_err(|_| "Invalid observer FPS")?;
        if ![8, 30, 60].contains(&observer_fps) {
            return Err("Observer FPS must be 8, 30 or 60".into());
        }
        let pipeline=gst::parse::launch(&format!("d3d11screencapturesrc name=observer-source capture-api=wgc window-handle={} do-timestamp=true show-cursor=false ! video/x-raw(memory:D3D11Memory),format=BGRA,framerate={observer_fps}/1 ! d3d11download ! video/x-raw,format=BGRA ! fakesink name=optics sync=false signal-handoffs=true",source.hwnd.unwrap())).map_err(|e|e.to_string())?.downcast::<gst::Pipeline>().unwrap();
        let epochs = Arc::new(Mutex::new(std::collections::BTreeMap::<u64, f64>::new()));
        let rows = epochs.clone();
        pipeline
            .by_name("observer-source")
            .unwrap()
            .static_pad("src")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |_, info| {
                if let Some(b) = info.buffer() {
                    if let Some(pts) = b.pts() {
                        let mut m = rows.lock().unwrap();
                        m.insert(pts.nseconds(), monotonic_epoch(base, start));
                        while m.len() > 120 {
                            m.pop_first();
                        }
                    }
                }
                gst::PadProbeReturn::Ok
            });
        let debug_optics = env::var("SMG_COMPARE_DEBUG_OPTICS").as_deref() == Ok("1");
        let rejected_debug = std::sync::atomic::AtomicUsize::new(0);
        pipeline.by_name("optics").unwrap().connect("handoff",false,move|v|{
            let began=Instant::now();let buffer=v[1].get::<gst::Buffer>().unwrap();let pad=v[2].get::<gst::Pad>().unwrap();
            let capture_epoch=buffer.pts().and_then(|p|epochs.lock().unwrap().remove(&p.nseconds()));
            let caps=pad.current_caps().unwrap();let info=gstreamer_video::VideoInfo::from_caps(&caps).unwrap();
            let result=gstreamer_video::VideoFrameRef::from_buffer_ref_readable(buffer.as_ref(),&info).ok().and_then(|frame|{
                let pixels=frame.plane_data(0).ok()?;let stride=frame.plane_stride()[0] as usize;
                let decoded=decode_pixels(pixels,stride,info.width() as usize,info.height() as usize,magic);
                if decoded.is_none()&&debug_optics&&rejected_debug.load(std::sync::atomic::Ordering::Relaxed)<3 {
                    let crop_height=(info.height() as usize).min(180);
                    let index=rejected_debug.fetch_add(1,std::sync::atomic::Ordering::Relaxed);let prefix=format!("optical-reject-{index}");
                    let _=std::fs::write(format!("{prefix}.bgra"),&pixels[..(stride*crop_height).min(pixels.len())]);
                    let _=std::fs::write(format!("{prefix}.json"),json!({"width":info.width(),"height":crop_height,"stride":stride,"magic":magic,"captureEpoch":capture_epoch}).to_string());

                }
                decoded
            });
            let mut s=state.lock().unwrap();s.readbacks.push(began.elapsed().as_secs_f64()*1000.);
            if let Some((seq,time))=result {if s.optics.len()<5000 {s.optics.push(json!({"seq":seq,"sourceTime32":time,"captureEpoch":capture_epoch,"readbackEpoch":monotonic_epoch(base,start),"width":info.width(),"height":info.height()}));}}else{s.failures+=1;}
            None
        });
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("{e:?}"))?;
        Ok(pipeline)
    }
    fn make_receiver(state: Arc<Mutex<Evidence>>) -> Result<(gst::Pipeline, gst::Element), String> {
        let p = gst::Pipeline::new();
        let rx = gst::ElementFactory::make("webrtcbin")
            .name("rx")
            .build()
            .map_err(|e| e.to_string())?;
        rx.set_property("latency", 0u32);
        rx.set_property_from_str("bundle-policy", "max-bundle");
        if env::var("SMG_COMPARE_PRIVATE_NETWORK").as_deref() != Ok("1") {
            rx.set_property_from_str("stun-server", "stun://stun.l.google.com:19302");
        }
        p.add(&rx).unwrap();
        let caps = gst::Caps::builder("application/x-rtp")
            .field("media", "video")
            .field("encoding-name", "H264")
            .field("clock-rate", 90000i32)
            .field("payload", 96i32)
            .field("packetization-mode", "1")
            .field("profile-level-id", "42c028")
            .build();
        rx.emit_by_name::<rtc::WebRTCRTPTransceiver>(
            "add-transceiver",
            &[&rtc::WebRTCRTPTransceiverDirection::Recvonly, &caps],
        );
        let bin=gst::parse::bin_from_description("rtph264depay ! h264parse ! d3d11h264dec name=decoder ! video/x-raw(memory:D3D11Memory) ! queue name=render-queue max-size-buffers=1 max-size-time=0 max-size-bytes=0 leaky=downstream ! d3d11videosink name=renderer sync=false emit-present=true processing-deadline=0",true).map_err(|e|e.to_string())?;
        p.add(&bin).unwrap();
        let sink = bin.by_name("renderer").unwrap();
        let rows = state.clone();
        sink.connect("present", false, move |_| {
            let mut s = rows.lock().unwrap();
            s.present_calls += 1;
            let now = Instant::now();
            if let Some(prev) = s.last_render {
                s.render_gaps
                    .push(now.duration_since(prev).as_secs_f64() * 1000.);
            }
            s.last_render = Some(now);
            None
        });
        let rows = state.clone();
        bin.by_name("decoder")
            .unwrap()
            .static_pad("src")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
                if info.buffer().is_some() {
                    let mut s = rows.lock().unwrap();
                    s.decoded += 1;
                    s.received_caps = pad.current_caps().map(|c| c.to_string());
                }
                gst::PadProbeReturn::Ok
            });
        let sink_pad = bin.static_pad("sink").unwrap();
        let errors = state.clone();
        rx.connect_pad_added(move |_, pad| {
            if pad.direction() == gst::PadDirection::Src {
                if pad.link(&sink_pad).is_err() {
                    errors.lock().unwrap().failures += 1;
                }
            }
        });
        let rows = state.clone();
        rx.connect("on-ice-candidate",false,move|v|{rows.lock().unwrap().candidates.push(json!({"sdpMLineIndex":v[1].get::<u32>().unwrap(),"candidate":v[2].get::<String>().unwrap()}));None});
        p.set_state(gst::State::Playing)
            .map_err(|e| format!("{e:?}"))?;
        Ok((p, rx))
    }
    fn description(rx: &gst::Element, offer: bool, sdp: Option<&str>) -> Result<String, String> {
        if let Some(sdp) = sdp {
            let desc = rtc::WebRTCSessionDescription::new(
                rtc::WebRTCSDPType::Answer,
                rtc::gst_sdp::SDPMessage::parse_buffer(sdp.as_bytes())
                    .map_err(|e| e.to_string())?,
            );
            let promise = gst::Promise::new();
            rx.emit_by_name::<()>("set-remote-description", &[&desc, &promise]);
            crate::webrtc_common::wait_promise(&promise, "receiver remote answer")?;
            return Ok("answer-set".into());
        }
        let promise = gst::Promise::new();
        rx.emit_by_name::<()>(
            if offer {
                "create-offer"
            } else {
                "create-answer"
            },
            &[&None::<gst::Structure>, &promise],
        );
        let reply = crate::webrtc_common::wait_promise(&promise, "receiver create offer")?
            .ok_or("empty offer reply")?;
        let desc = reply
            .get::<rtc::WebRTCSessionDescription>(if offer { "offer" } else { "answer" })
            .map_err(|e| e.to_string())?;
        let promise = gst::Promise::new();
        rx.emit_by_name::<()>("set-local-description", &[&desc, &promise]);
        crate::webrtc_common::wait_promise(&promise, "receiver local offer")?;
        desc.sdp().as_text().map_err(|e| e.to_string())
    }
    fn native_window(title: &str) -> Result<(), String> {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::UI::WindowsAndMessaging::{
            AdjustWindowRectEx, GetWindowLongW, SetWindowPos, SetWindowTextW, GWL_EXSTYLE,
            GWL_STYLE, SWP_NOACTIVATE, SWP_SHOWWINDOW, WINDOW_EX_STYLE, WINDOW_STYLE,
        };
        let rows = crate::windows_list::enumerate_sources()
            .into_iter()
            .filter(|s| s.source_type == "window" && s.process_id == Some(std::process::id()))
            .collect::<Vec<_>>();
        if rows.len() != 1 {
            return Err(format!("Native renderer visible windows: {}", rows.len()));
        }
        let source = crate::windows_list::resolve_capture_source(&rows[0].id)?;
        let hwnd = HWND(source.hwnd.unwrap() as *mut _);
        let wide = title.encode_utf16().chain([0]).collect::<Vec<_>>();
        unsafe {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 1280,
                bottom: 720,
            };
            AdjustWindowRectEx(
                &mut rect,
                WINDOW_STYLE(GetWindowLongW(hwnd, GWL_STYLE) as u32),
                false,
                WINDOW_EX_STYLE(GetWindowLongW(hwnd, GWL_EXSTYLE) as u32),
            )
            .map_err(|e| e.to_string())?;
            SetWindowTextW(hwnd, PCWSTR(wide.as_ptr())).map_err(|e| e.to_string())?;
            SetWindowPos(
                hwnd,
                None,
                30,
                30,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn read_request(stream: &mut TcpStream, token: &str) -> Result<Value, String> {
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0; 4096];
        let header_end = loop {
            let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("empty HTTP".into());
            }
            bytes.extend_from_slice(&buf[..n]);
            if bytes.len() > 262144 {
                return Err("request too large".into());
            }
            if let Some(i) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let header = std::str::from_utf8(&bytes[..header_end]).map_err(|e| e.to_string())?;
        if !header.starts_with(&format!("POST /{token} HTTP/1.1\r\n"))
            || header
                .lines()
                .any(|s| s.to_lowercase().starts_with("origin:"))
        {
            return Err("Unauthorized diagnostic request".into());
        }
        let len = header
            .lines()
            .find_map(|s| {
                s.to_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|v| v.trim().parse::<usize>().ok())
            })
            .ok_or("length required")?;
        if len > 250000 {
            return Err("body too large".into());
        }
        while bytes.len() < header_end + len {
            let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("truncated body".into());
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        serde_json::from_slice(&bytes[header_end..header_end + len]).map_err(|e| e.to_string())
    }
    #[test]
    #[ignore = "Real isolated capture/renderer comparison; requires explicit ephemeral fixture/control capability"]
    fn run_transport_comparison_probe() {
        let role = env::var("SMG_COMPARE_ROLE").unwrap();
        assert!(matches!(role.as_str(), "sender" | "receiver" | "observer"));
        let token = env::var("SMG_COMPARE_TOKEN").unwrap();
        assert!(token.len() == 48 && token.chars().all(|c| c.is_ascii_hexdigit()));
        let port = env::var("SMG_COMPARE_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        let runtime = GStreamerRuntime::discover().expect("GStreamer required");
        runtime.prepare_process_environment();
        gst::init().unwrap();
        unsafe {
            let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
                windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            );
        }
        let start = Instant::now();
        let base = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.;
        let state = Arc::new(Mutex::new(Evidence::default()));
        let mut capture = None;
        let mut bridge = None::<crate::webrtc_bridge::NativeWebRtcBridge>;
        let mut rx = None;
        let mut observer_pipeline = None::<gst::Pipeline>;
        let mut condition = Value::Null;
        let mut journey = None;
        let mut priority_evidence = Value::Null;
        let mut lease = None;
        if role == "sender" {
            let title = env::var("SMG_COMPARE_TITLE").unwrap();
            let window = fixture(&title);
            let mode = env::var("SMG_COMPARE_CAPTURE").unwrap_or_else(|_| "window-wgc".into());
            assert!(matches!(
                mode.as_str(),
                "window-wgc" | "monitor-wgc" | "monitor-dxgi"
            ));
            let source = if mode == "window-wgc" {
                window
            } else {
                monitor_for(&window)
            };
            let gpu = env::var("SMG_COMPARE_GPU_PRIORITY").unwrap_or_else(|_| "normal".into());
            priority_evidence = priority(&gpu);
            let (video_port, port_lease) = allocate_loopback_port().unwrap();
            lease = Some(port_lease);
            let config = MediaWorkerConfig {
                raw_video_queue: RawVideoQueuePolicy::parse(
                    &env::var("SMG_COMPARE_RAW_QUEUE").unwrap_or_else(|_| "bounded".into()),
                ).unwrap(),
                capture_backend: CaptureBackend::parse(
                    &env::var("SMG_COMPARE_BACKEND").unwrap_or_else(|_| "d3d11".into()),
                )
                .unwrap(),
                h264_encoder: H264EncoderBackend::Nvenc,
                capture_api: Some(
                    if mode == "monitor-dxgi" {
                        "dxgi"
                    } else {
                        "wgc"
                    }
                    .into(),
                ),
                fps: 60,
                width: Some(1280),
                height: Some(720),
                bitrate_kbps: 7500,
                ..Default::default()
            };
            let raw_queue = config.raw_video_queue.as_str();
            let args = build_pipeline(&source, &config, video_port, None).unwrap();
            let mut chain = Vec::new();
            let mut queues = 0;
            for arg in &args {
                chain.push(arg.clone());
                let name = match arg.as_str() {
                    "d3d11screencapturesrc" | "d3d12screencapturesrc" => Some("stage-capture"),
                    "videorate" => Some("stage-rate"),
                    "d3d11convert" | "d3d12convert" => Some("stage-convert"),
                    "d3d12download" => Some("stage-interop"),
                    "nvd3d11h264enc" => Some("stage-encoder"),
                    "queue" => {
                        queues += 1;
                        Some(if queues == 1 {
                            "stage-capture-queue"
                        } else {
                            "stage-encoder-queue"
                        })
                    }
                    _ => None,
                };
                if let Some(name) = name {
                    chain.push(format!("name={name}"));
                }
            }
            let p = gst::parse::launch(&chain.join(" "))
                .unwrap()
                .downcast::<gst::Pipeline>()
                .unwrap();
            let j = attach_probe_frame_journey(&p);
            j.lock().unwrap().start = Some(start);
            journey = Some(j);
            drop(lease.take());
            clear_handoff_leases();
            p.set_state(gst::State::Playing).unwrap();
            capture = Some(p);
            condition = json!({"captureMode":mode,"captureBackend":config.capture_backend.as_str(),"rawQueue":raw_queue,"videoPort":video_port,"pipeline":chain.join(" "),"sourceGeometry":{"left":source.left,"top":source.top,"width":source.width,"height":source.height},"codec":"h264","encoder":"nvenc","fps":60,"width":1280,"height":720,"bitrate":7500,"scope":"Real production pipeline builder, in-process diagnostic host; CPU high in both GPU conditions; no preview/audio/replay"});
        } else if role == "receiver" {
            rx = Some(make_receiver(state.clone()).unwrap());
        }
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        listener.set_nonblocking(true).unwrap();
        println!(
            "SMG_COMPARE_READY {}",
            json!({"port":listener.local_addr().unwrap().port(),"pid":std::process::id(),"role":role,"condition":condition,"priority":priority_evidence,"gstreamerVersion":gst::version_string().to_string()})
        );
        let mut running = true;
        while running && start.elapsed() < Duration::from_secs(300) {
            if let Ok((mut stream, _)) = listener.accept() {
                let result=read_request(&mut stream,&token).and_then(|cmd|->Result<Value,String>{
                let receive=monotonic_epoch(base,start);
                match cmd["op"].as_str().unwrap_or("") {
                    "clock"=>Ok(json!({"receive":receive,"send":monotonic_epoch(base,start),"timeOrigin":base})),
                    "answer" if role=="sender"=>{let offer=cmd["sdp"].as_str().ok_or("offer required")?;let b=crate::webrtc_bridge::NativeWebRtcBridge::new(None,"diagnostic",None,condition["videoPort"].as_u64().unwrap() as u16,None,VideoCodec::H264,Some(offer),Some(&[])).map_err(|e|e.to_string())?;if env::var("SMG_COMPARE_PRIVATE_NETWORK").as_deref()==Ok("1"){b.webrtc.set_property("stun-server",None::<String>);}let rows=state.clone();b.webrtc.connect("on-ice-candidate",false,move|v|{rows.lock().unwrap().candidates.push(json!({"sdpMLineIndex":v[1].get::<u32>().unwrap(),"candidate":v[2].get::<String>().unwrap()}));None});let answer=b.create_answer(offer)?;bridge=Some(b);Ok(json!({"sdp":answer.sdp}))},
                    "offer" if role=="receiver"=>Ok(json!({"sdp":description(&rx.as_ref().unwrap().1,true,None)?})),
                    "answer" if role=="receiver"=>Ok(json!({"result":description(&rx.as_ref().unwrap().1,false,cmd["sdp"].as_str())?})),
                    "candidate"=>{let index=cmd["sdpMLineIndex"].as_u64().ok_or("index required")? as u32;let candidate=cmd["candidate"].as_str().ok_or("candidate required")?;if let Some(b)=&bridge{b.add_ice_candidate(index,candidate)?;}else if let Some((_,r))=&rx {r.emit_by_name::<()>("add-ice-candidate",&[&index,&candidate]);}else{return Err("peer not prepared".into());}Ok(json!({"added":true}))},
                    "observe"=>{let title=cmd["title"].as_str().ok_or("title required")?;if let Some(p)=observer_pipeline.take(){let _=p.set_state(gst::State::Null);}if role=="receiver" {native_window(title)?;}observer_pipeline=Some(observer(title,cmd["magic"].as_u64().ok_or("magic required")? as u16,state.clone(),base,start)?);Ok(json!({"observing":true,"scope":"Common WGC readback observer, capture arrival timestamp; includes observer capture latency, not physical panel scanout"}))},
                    "reset"=>{let mut s=state.lock().unwrap();s.decoded=0;s.present_calls=0;s.render_gaps.clear();s.last_render=None;s.optics.clear();s.readbacks.clear();s.failures=0;if let Some(j)=&journey{*j.lock().unwrap()=ProbeFrameJourney{start:Some(start),..Default::default()};}Ok(json!({"reset":true}))},
                    "status"=>{let s=state.lock().unwrap();let mut result=json!({"epoch":receive,"decoded":s.decoded,"presentCalls":s.present_calls,"opticalSamples":s.optics.len(),"rejectedReads":s.failures,"candidates":s.candidates,"decodedCaps":s.received_caps,"priority":priority_evidence});if cmd["full"].as_bool()==Some(true){result["renderGapsMs"]=json!(s.render_gaps);result["optics"]=json!(s.optics);result["readbackCpuMs"]=json!(s.readbacks);result["journey"]=json!(journey.as_ref().map(|j|j.lock().unwrap().report()));}drop(s);if cmd["full"].as_bool()==Some(true){if let Some((_,peer))=&rx{result["networkStats"]=network_stats(peer)?;}else if let Some(b)=&bridge{result["networkStats"]=network_stats(&b.webrtc)?;}}Ok(result)},
                    "stop"=>{running=false;Ok(json!({"stopping":true}))},
                    _=>Err("unsupported diagnostic operation".into())
                }
            });
                let body = serde_json::to_string(&match result {
                    Ok(v) => json!({"ok":true,"data":v}),
                    Err(e) => json!({"ok":false,"error":e}),
                })
                .unwrap();
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                let _ = stream.write_all(response.as_bytes());
            }
            for p in capture
                .iter()
                .chain(rx.iter().map(|v| &v.0))
                .chain(observer_pipeline.iter())
            {
                if let Some(m) = p.bus().unwrap().pop_filtered(&[gst::MessageType::Error]) {
                    panic!("Diagnostic pipeline failed: {:?}", m.view());
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if let Some(p) = observer_pipeline {
            let _ = p.set_state(gst::State::Null);
        }
        drop(bridge);
        if let Some(p) = capture {
            let _ = p.set_state(gst::State::Null);
        }
        if let Some((p, _)) = rx {
            let _ = p.set_state(gst::State::Null);
        }
        drop(lease);
    }
    #[test]
    fn optical_reader_recovers_real_browser_marker_at_odd_pixel_origin() {
        // One row of a rejected synthetic-browser sample, repeated vertically.
        // The previous x.step_by(2) could not validate its otherwise intact CRC.
        let row = include_bytes!("../../../tests/fixtures/e2e-optical-odd-origin-row.bgra");
        assert_eq!(row.len(), 530 * 4);
        let pixels = row.repeat(20);
        assert_eq!(
            decode_pixels(&pixels, row.len(), 530, 20, 100),
            Some((1615, 140745142))
        );
        assert_eq!(decode_pixels(&pixels, row.len(), 530, 20, 101), None);
    }
    #[test]
    fn optical_reader_rejects_empty_and_wrong_session() {
        assert_eq!(
            decode_pixels(&vec![0; 1280 * 200 * 4], 1280 * 4, 1280, 200, 42),
            None
        );
        assert_eq!(crc(b"123456789"), 0x29b1);
        assert_eq!(decode_pixels(&[0; 8], 5120, 1280, 200, 42), None);
    }
    #[test]
    fn optical_reader_matches_fixture_scaling_session_and_checksum() {
        let magic = 0x12abu16;
        let seq = 0x123456u32;
        let time = 0xffffffa0u32;
        let payload = [
            (magic >> 8) as u8,
            magic as u8,
            (seq >> 16) as u8,
            (seq >> 8) as u8,
            seq as u8,
            (time >> 24) as u8,
            (time >> 16) as u8,
            (time >> 8) as u8,
            time as u8,
        ];
        let checksum = crc(&payload);
        let mut bits = vec![1u8, 0, 1, 0, 1, 1, 0, 0];
        for byte in payload.into_iter().chain(checksum.to_be_bytes()) {
            for bit in (0..8).rev() {
                bits.push((byte >> bit) & 1);
            }
        }
        for width in [1920, 1280, 640] {
            let scale = width as f64 / 1920.;
            let height = 100;
            let stride = width * 4;
            let mut pixels = vec![0u8; stride * height];
            for y in 0..height {
                for x in 0..width {
                    let sx = (x as f64 / scale).floor() as usize;
                    let sy = (y as f64 / scale).floor() as usize;
                    if (2..18).contains(&sy) && sx >= 2 && sx < 770 {
                        let value = bits[(sx - 2) / 8] * 255;
                        pixels[y * stride + x * 4..y * stride + x * 4 + 3].fill(value);
                    }
                }
            }
            assert_eq!(
                decode_pixels(&pixels, stride, width, height, magic),
                Some((seq, time)),
                "width={width}"
            );
            assert_eq!(
                decode_pixels(&pixels, stride, width, height, magic + 1),
                None
            );
            // Corrupt a payload cell at every vertical scan position.
            for y in 0..height {
                for x in 0..width {
                    let sx = (x as f64 / scale).floor() as usize;
                    if (242..250).contains(&sx) {
                        for c in 0..3 {
                            pixels[y * stride + x * 4 + c] ^= 255;
                        }
                    }
                }
            }
            assert_eq!(decode_pixels(&pixels, stride, width, height, magic), None);
        }
    }
}
