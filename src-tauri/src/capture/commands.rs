//! commands; internal to the native capture subsystem.
use super::*;

#[cfg(not(test))]
// Plugin discovery can initialize COM/D3D and scan the registry. Keep it off
// the WebView UI thread, including on the first launch with an empty registry.
#[tauri::command(async)]
pub fn get_native_capture_capabilities() -> CaptureCapabilities {
    capabilities()
}

#[cfg(not(test))]
#[tauri::command]
pub fn list_audio_exclusion_candidates() -> Vec<crate::windows_list::AudioExclusionCandidate> {
    crate::windows_list::get_audio_exclusion_candidates()
}

#[cfg(not(test))]
#[tauri::command]
pub fn get_native_capture_state() -> Result<NativeCaptureState, String> {
    let guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    Ok(guard
        .as_ref()
        .map(|session| session.state.clone())
        .unwrap_or_else(|| NativeCaptureState {
            state: "idle".to_string(),
            session_id: None,
            source_id: None,
            source_type: None,
            audio_mode: None,
            width: None,
            height: None,
            dpi: None,
            video_codec: None,
            h264_encoder: None,
            capture_backend: None,
            capture_api: None,
            capture_fallback_reason: None,
            video_rtp_port: None,
            audio_rtp_port: None,
            exclude_app: None,
            exclude_pid: None,
            error: None,
        }))
}

#[cfg(not(test))]
#[tauri::command(async)]
pub fn get_native_stream_stats(session_id: String, viewer_id: String) -> Result<Vec<serde_json::Value>, String> {
    let (webrtc, produced, bridge_stats) = {
        let guard = active_session().lock().map_err(|_| "Estado de captura indisponível")?;
        let session = guard.as_ref().ok_or("Captura encerrada")?;
        if session.state.session_id.as_deref() != Some(session_id.as_str()) { return Err("Sessão inválida".into()); }
        let bridge = &session.viewer_bridges.get(&viewer_id).ok_or("Espectador desconectado")?.bridge;
        (bridge.webrtc.clone(), session.fanout.as_ref().map(|fanout| fanout.counters.snapshot()), bridge.transport_stats())
    };
    let mut reports = crate::webrtc_bridge::stats::collect(&webrtc)?;
    if let Some(produced) = produced { reports.push(produced); }
    reports.extend(bridge_stats);
    Ok(reports)
}

#[cfg(not(test))]
#[tauri::command(async)]
pub fn start_native_capture(
    app: AppHandle,
    source_id: String,
    audio_mode: Option<String>,
    video_codec: Option<String>,
    h264_encoder: Option<String>,
    capture_backend: Option<String>,
    capture_api: Option<String>,
    show_cursor: Option<bool>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
    exclude_app: Option<String>,
) -> Result<NativeCaptureState, String> {
    let validated = resolve_capture_source(&source_id)?;
    let audio_mode = audio_mode.unwrap_or_else(|| "none".to_string());
    if !matches!(audio_mode.as_str(), "none" | "system" | "process" | "mic") {
        return Err("Modo de áudio inválido".to_string());
    }

    let (exclude_app_name, exclude_pid) = match exclude_app.as_deref() {
        Some("none") | Some("off") => (Some("none".to_string()), None),
        Some(target) => {
            let pid = crate::windows_list::find_process_id_by_name(target);
            (Some(target.to_string()), pid)
        }
        None => {
            if audio_mode == "system" {
                (
                    Some("seemygame".to_string()),
                    crate::windows_list::find_process_id_by_name("seemygame"),
                )
            } else {
                (None, None)
            }
        }
    };

    let session_id = format!("native_capture_{}", timestamp_ms());
    let target_width = width.unwrap_or(validated.width);
    let target_height = height.unwrap_or(validated.height);

    let starting_state = NativeCaptureState {
        state: "starting".to_string(),
        session_id: Some(session_id.clone()),
        source_id: Some(validated.source_id.clone()),
        source_type: Some(validated.source_type.clone()),
        audio_mode: Some(audio_mode.clone()),
        width: Some(target_width),
        height: Some(target_height),
        dpi: Some(validated.dpi),
        video_codec: None,
        h264_encoder: None,
        capture_backend: None,
        capture_api: None,
        capture_fallback_reason: None,
        video_rtp_port: None,
        audio_rtp_port: None,
        exclude_app: exclude_app_name.clone(),
        exclude_pid,
        error: None,
    };

    {
        let mut guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        // The command runs off the UI thread: check and reserve under one
        // lock so concurrent starts cannot overwrite each other's session.
        if let Some(session) = guard.as_ref() {
            if matches!(session.state.state.as_str(), "starting" | "live") {
                if session.state.source_id.as_deref() == Some(source_id.as_str()) {
                    return Ok(session.state.clone());
                }
                return Err("Já existe uma sessão de captura nativa ativa".to_string());
            }
        }
        *guard = Some(ActiveSession {
            state: starting_state.clone(),
            validated_source: validated.clone(),
            worker: None,
            replay: None,
            fanout: None,
            local_bridge: None,
            local_video_port: None,
            local_audio_port: None,
            pending_local_ice_candidates: Vec::new(),
            viewer_bridges: HashMap::new(),
            viewer_negotiations: ViewerNegotiations::default(),
            pending_viewer_ice_candidates: HashMap::new(),
        });
    }
    emit_state(&app, &starting_state);

    crate::system::write_debug_log(&format!(
        "[Capture] start_native_capture: source_id={}, audio_mode={}, video_codec={:?}, h264_encoder={:?}, width={:?}, height={:?}, fps={:?}, bitrate_kbps={:?}",
        source_id, audio_mode, video_codec, h264_encoder, width, height, fps, bitrate_kbps
    ));
    let mut config =
        match media::MediaWorkerConfig::from_environment(&audio_mode, video_codec.as_deref()) {
            Ok(config) => config,
            Err(error) => return fail_start(&app, &starting_state, &error),
        };
    if let Some(backend) = capture_backend.as_deref() {
        config.capture_backend = match media::CaptureBackend::parse(backend) {
            Ok(value) => value,
            Err(error) => return fail_start(&app, &starting_state, &error),
        };
    }
    if let Some(preference) = capture_api.as_deref() {
        config.capture_api = match media::capture_api_for_source(&validated, Some(preference)) {
            Ok(api) => Some(api.to_string()),
            Err(error) => return fail_start(&app, &starting_state, &error),
        };
    }
    if let Some(enc) = h264_encoder.as_deref() {
        let trimmed = enc.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("auto") {
            config.h264_encoder = match media::H264EncoderBackend::parse(trimmed) {
                Ok(backend) => backend,
                Err(error) => return fail_start(&app, &starting_state, &error),
            };
        }
    }
    if let Some(show) = show_cursor {
        config.show_cursor = show;
    }
    if let Some(w) = width {
        config.width = Some(w.clamp(320, 7680));
    }
    if let Some(h) = height {
        config.height = Some(h.clamp(240, 4320));
    }
    if let Some(f) = fps {
        config.fps = f.clamp(1, 120);
    }
    if let Some(b) = bitrate_kbps {
        config.bitrate_kbps = b.clamp(256, 50_000);
    }
    if audio_mode == "system" {
        config.exclude_process_id = exclude_pid;
    }
    let mut worker = match NativeMediaWorker::start(&validated, config) {
        Ok(worker) => worker,
        Err(error) => return fail_start(&app, &starting_state, &error),
    };
    worker.release_rtp_port_leases();
    crate::media::clear_handoff_leases();
    let fanout = match RtpFanout::start(worker.video_rtp_port, worker.audio_rtp_port) {
        Ok(f) => f,
        Err(error) => {
            crate::system::write_debug_log(&format!("[Capture] RtpFanout::start falhou: {error}"));
            worker.stop();
            return fail_start(&app, &starting_state, &error);
        }
    };
    crate::system::write_debug_log(&format!(
        "[Capture] Worker GStreamer ativo com RtpFanout: video_rtp_port={}, audio_rtp_port={:?}",
        worker.video_rtp_port, worker.audio_rtp_port
    ));
    let live_state = NativeCaptureState {
        state: "live".to_string(),
        video_codec: Some(worker.config.codec.as_str().to_string()),
        h264_encoder: Some(worker.config.h264_encoder.as_str().to_string()),
        capture_backend: Some(worker.active_capture_backend.as_str().to_string()),
        capture_api: Some(media::capture_api_for_source(&validated, worker.config.capture_api.as_deref())?.to_string()),
        capture_fallback_reason: worker.capture_fallback_reason.clone(),
        video_rtp_port: Some(worker.video_rtp_port),
        audio_rtp_port: worker.audio_rtp_port,
        exclude_app: exclude_app_name,
        exclude_pid: worker.config.exclude_process_id,
        ..starting_state
    };
    {
        let mut guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        if let Some(session) = guard.as_mut() {
            if session.state.session_id.as_deref() != Some(session_id.as_str()) {
                drop(guard);
                drop(fanout);
                worker.stop();
                return Err("Captura nativa foi cancelada durante a inicialização".to_string());
            }
            session.state = live_state.clone();
            session.worker = Some(worker);
            session.fanout = Some(fanout);
        } else {
            drop(guard);
            drop(fanout);
            worker.stop();
            return Err("Captura nativa foi cancelada durante a inicialização".to_string());
        }
    }
    emit_state(&app, &live_state);
    spawn_worker_health_monitor(&app, session_id);
    Ok(live_state)
}

#[cfg(not(test))]
pub(crate) fn spawn_worker_health_monitor(app: &AppHandle, session_id: String) {
    let monitor_app = app.clone();
    thread::spawn(move || loop {
        thread::sleep(std::time::Duration::from_millis(750));
        let mut cleanup = None;
        let mut state_event = None;
        let should_exit = {
            let Ok(mut guard) = active_session().lock() else {
                return;
            };
            match guard.as_mut() {
                None => true,
                Some(session) => {
                    if session.state.session_id.as_deref() != Some(session_id.as_str())
                        || session.state.state != "live"
                    {
                        true
                    } else if let Some(worker) = session.worker.as_mut() {
                        match worker.health_error(&session.validated_source) {
                            Ok(()) => {
                                let backend = Some(worker.active_capture_backend.as_str().to_string());
                                if session.state.capture_backend != backend {
                                    session.state.capture_backend = backend;
                                    session.state.capture_fallback_reason = worker.capture_fallback_reason.clone();
                                    state_event = Some(session.state.clone());
                                }
                                false
                            },
                            Err(error) => {
                                log::error!("[Capture] Worker GStreamer falhou: {error}");
                                session.state.state = "error".to_string();
                                session.state.error = Some(error);
                                cleanup = Some((
                                    session.replay.take(),
                                    session.viewer_bridges.drain().collect::<Vec<_>>(),
                                    session.local_bridge.take(),
                                    session.fanout.take(),
                                    session.worker.take(),
                                ));
                                state_event = Some(session.state.clone());
                                true
                            }
                        }
                    } else {
                        log::error!("[Capture] Sessão ativa sem worker GStreamer");
                        session.state.state = "error".to_string();
                        session.state.error =
                            Some("Worker GStreamer ausente em sessão ativa".to_string());
                        cleanup = Some((
                            session.replay.take(),
                            session.viewer_bridges.drain().collect::<Vec<_>>(),
                            session.local_bridge.take(),
                            session.fanout.take(),
                            session.worker.take(),
                        ));
                        state_event = Some(session.state.clone());
                        true
                    }
                }
            }
        };
        drop(cleanup);
        if let Some(state) = state_event {
            emit_state(&monitor_app, &state);
        }
        if should_exit {
            break;
        }
    });
}

#[cfg(not(test))]
pub(crate) fn fail_start(
    app: &AppHandle,
    starting_state: &NativeCaptureState,
    error: &str,
) -> Result<NativeCaptureState, String> {
    crate::system::write_debug_log(&format!("[Capture] fail_start: {error}"));
    let error = error.to_string();
    let error_state = NativeCaptureState {
        state: "error".to_string(),
        error: Some(error.clone()),
        ..starting_state.clone()
    };
    {
        let mut guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        if let Some(session) = guard.as_mut() {
            if session.state.session_id.as_deref() != starting_state.session_id.as_deref() {
                return Err(error);
            }
            session.state = error_state.clone();
        } else {
            return Err(error);
        }
    }
    emit_state(app, &error_state);
    Err(error)
}

#[cfg(not(test))]
#[tauri::command]
pub fn reconfigure_native_capture(
    app: AppHandle,
    session_id: String,
    audio_mode: Option<String>,
    video_codec: Option<String>,
    h264_encoder: Option<String>,
    capture_backend: Option<String>,
    capture_api: Option<String>,
    show_cursor: Option<bool>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
    bitrate_kbps: Option<u32>,
    exclude_app: Option<String>,
) -> Result<NativeCaptureState, String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Err("Nenhuma captura nativa ativa".to_string());
    };
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if session.state.state != "live" || session.worker.is_none() {
        return Err("A captura nativa ainda não está ativa".to_string());
    }
    // Validate before taking ownership of the live worker; changing the API is a next-start setting.
    if let Some(value) = capture_backend.as_deref() {
        let requested = media::CaptureBackend::parse(value)?;
        if session.worker.as_ref().is_some_and(|worker| worker.config.capture_backend != requested) {
            return Err("A troca de API gráfica requer reiniciar a transmissão.".to_string());
        }
    }

    if let Some(preference) = capture_api.as_deref() {
        let requested = media::capture_api_for_source(&session.validated_source, Some(preference))?;
        let active = media::capture_api_for_source(&session.validated_source, session.worker.as_ref().unwrap().config.capture_api.as_deref())?;
        if requested != active {
            return Err("A troca de método de captura requer reiniciar a transmissão.".into());
        }
    }

    let current_worker = session.worker.take().expect("worker present");
    let video_rtp_port = current_worker.video_rtp_port;
    let audio_rtp_port = current_worker.audio_rtp_port;
    let mut new_config = current_worker.config.clone();
    let mut next_exclude_app = session.state.exclude_app.clone();

    if let Some(target) = exclude_app.as_deref() {
        if target.eq_ignore_ascii_case("none") || target.eq_ignore_ascii_case("off") {
            new_config.exclude_process_id = None;
            next_exclude_app = Some("none".to_string());
        } else {
            let pid = crate::windows_list::find_process_id_by_name(target);
            new_config.exclude_process_id = pid;
            next_exclude_app = Some(target.to_string());
        }
    }

    if let Some(mode) = audio_mode.as_deref() {
        if matches!(mode, "none" | "system" | "process" | "mic") {
            let parsed_mode = AudioMode::parse(mode)?;
            if parsed_mode != current_worker.config.audio_mode {
                if audio_rtp_port.is_none() && parsed_mode != AudioMode::None {
                    session.worker = Some(current_worker);
                    return Err(
                        "Ativar áudio nativo durante uma transmissão iniciada sem áudio requer reiniciar a transmissão para negociar as faixas com os espectadores."
                            .to_string(),
                    );
                }
                new_config.audio_mode = parsed_mode;
            }
        }
    }
    if let Some(codec_str) = video_codec.as_deref() {
        if let Ok(c) = media::VideoCodec::parse(codec_str) {
            if c != current_worker.config.codec {
                session.worker = Some(current_worker);
                return Err(
                    "A troca de codec de vídeo durante a transmissão requer reiniciar a transmissão para renegociar com os espectadores."
                        .to_string(),
                );
            }
            new_config.codec = c;
        }
    }
    if let Some(enc_str) = h264_encoder.as_deref() {
        let trimmed = enc_str.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("auto") {
            if let Ok(backend) = media::H264EncoderBackend::parse(trimmed) {
                new_config.h264_encoder = backend;
            }
        } else {
            new_config.h264_encoder = media::H264EncoderBackend::Auto;
        }
    }
    if let Some(cursor) = show_cursor {
        new_config.show_cursor = cursor;
    }
    if let Some(w) = width {
        new_config.width = Some(w.clamp(320, 7680));
    }
    if let Some(h) = height {
        new_config.height = Some(h.clamp(240, 4320));
    }
    if let Some(f) = fps {
        new_config.fps = f.clamp(1, 120);
    }
    if let Some(b) = bitrate_kbps {
        new_config.bitrate_kbps = b.clamp(256, 50_000);
    }

    crate::system::write_debug_log(&format!(
        "[Capture] Reconfigurando worker GStreamer: codec={:?}, encoder={:?}, show_cursor={}, width={:?}, height={:?}, fps={}, bitrate_kbps={}",
        new_config.codec, new_config.h264_encoder, new_config.show_cursor, new_config.width, new_config.height, new_config.fps, new_config.bitrate_kbps
    ));

    let previous_config = current_worker.config.clone();
    current_worker.stop();

    let target_audio_rtp_port = if new_config.audio_mode == AudioMode::None {
        None
    } else {
        audio_rtp_port
    };

    let new_worker = match NativeMediaWorker::start_with_ports(
        &session.validated_source,
        new_config,
        video_rtp_port,
        target_audio_rtp_port,
    ) {
        Ok(w) => w,
        Err(err) => {
            crate::system::write_debug_log(&format!(
                "[Capture] Falha ao reconfigurar worker GStreamer: {err}. Tentando rollback para configuração anterior..."
            ));
            match NativeMediaWorker::start_with_ports(
                &session.validated_source,
                previous_config,
                video_rtp_port,
                audio_rtp_port,
            ) {
                Ok(restored_worker) => {
                    crate::system::write_debug_log(
                        "[Capture] Rollback concluído com sucesso; worker anterior restaurado.",
                    );
                    session.worker = Some(restored_worker);
                    return Err(format!("Falha na reconfiguração ({err}). Configuração anterior restaurada com sucesso."));
                }
                Err(rollback_err) => {
                    crate::system::write_debug_log(&format!(
                        "[Capture] Falha crítica no rollback: {rollback_err}"
                    ));
                    session.state.state = "error".to_string();
                    session.state.error = Some(format!("Falha ao reconfigurar captura nativa: {err}; falha no rollback: {rollback_err}"));
                    let cleanup = (
                        session.replay.take(),
                        session.viewer_bridges.drain().collect::<Vec<_>>(),
                        session.local_bridge.take(),
                        session.fanout.take(),
                        session.worker.take(),
                    );
                    drop(cleanup);
                    let state_to_emit = session.state.clone();
                    emit_state(&app, &state_to_emit);
                    return Err(err);
                }
            }
        }
    };

    let updated_state = NativeCaptureState {
        state: "live".to_string(),
        session_id: Some(session_id),
        source_id: session.state.source_id.clone(),
        source_type: session.state.source_type.clone(),
        audio_mode: Some(new_worker.config.audio_mode.as_str().to_string()),
        width: new_worker.config.width.or(session.state.width),
        height: new_worker.config.height.or(session.state.height),
        dpi: session.state.dpi,
        video_codec: Some(new_worker.config.codec.as_str().to_string()),
        h264_encoder: Some(new_worker.config.h264_encoder.as_str().to_string()),
        capture_backend: Some(new_worker.active_capture_backend.as_str().to_string()),
        capture_api: Some(media::capture_api_for_source(&session.validated_source, new_worker.config.capture_api.as_deref())?.to_string()),
        capture_fallback_reason: new_worker.capture_fallback_reason.clone(),
        video_rtp_port: Some(video_rtp_port),
        audio_rtp_port: target_audio_rtp_port,
        exclude_app: next_exclude_app,
        exclude_pid: new_worker.config.exclude_process_id,
        error: None,
    };

    session.worker = Some(new_worker);
    session.state = updated_state.clone();
    emit_state(&app, &updated_state);
    Ok(updated_state)
}

#[cfg(not(test))]
#[tauri::command]
pub fn set_native_capture_audio_mode(
    app: AppHandle,
    session_id: String,
    audio_mode: String,
) -> Result<NativeCaptureState, String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Err("Nenhuma captura nativa ativa".to_string());
    };
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if session.state.state != "live" || session.worker.is_none() {
        return Err("A captura nativa ainda não está ativa".to_string());
    }
    let parsed_mode = AudioMode::parse(&audio_mode)?;
    if session
        .worker
        .as_ref()
        .is_some_and(|worker| worker.config.audio_mode != parsed_mode)
        && (session.local_bridge.is_some() || !session.viewer_bridges.is_empty())
    {
        return Err(
            "Altere o modo de áudio reiniciando a captura nativa para preservar a ponte WebRTC"
                .to_string(),
        );
    }
    if let Some(worker) = session.worker.as_mut() {
        if worker.config.audio_mode != parsed_mode {
            worker.restart_audio_mode(&session.validated_source, parsed_mode)?;
            session.state.audio_rtp_port = worker.audio_rtp_port;
            session.state.capture_backend = Some(worker.active_capture_backend.as_str().to_string());
            session.state.capture_fallback_reason = worker.capture_fallback_reason.clone();
        }
    }
    session.state.audio_mode = Some(audio_mode);
    let state = session.state.clone();
    emit_state(&app, &state);
    Ok(state)
}

#[cfg(not(test))]
#[tauri::command]
pub fn stop_native_capture(
    app: AppHandle,
    session_id: Option<String>,
) -> Result<NativeCaptureState, String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;

    if let Some(expected_id) = session_id.as_deref() {
        if let Some(session) = guard.as_ref() {
            if session.state.session_id.as_deref() != Some(expected_id) {
                return Err("Sessão de captura nativa inválida".to_string());
            }
        }
    }

    let previous = guard.take();
    let stopped = NativeCaptureState {
        state: "idle".to_string(),
        session_id: previous.as_ref().and_then(|s| s.state.session_id.clone()),
        source_id: previous.as_ref().and_then(|s| s.state.source_id.clone()),
        source_type: previous.as_ref().and_then(|s| s.state.source_type.clone()),
        audio_mode: previous.as_ref().and_then(|s| s.state.audio_mode.clone()),
        width: previous.as_ref().and_then(|s| s.state.width),
        height: previous.as_ref().and_then(|s| s.state.height),
        dpi: previous.as_ref().and_then(|s| s.state.dpi),
        video_codec: previous.as_ref().and_then(|s| s.state.video_codec.clone()),
        h264_encoder: previous.as_ref().and_then(|s| s.state.h264_encoder.clone()),
        capture_backend: previous.as_ref().and_then(|s| s.state.capture_backend.clone()),
        capture_api: previous.as_ref().and_then(|s| s.state.capture_api.clone()),
        capture_fallback_reason: previous.as_ref().and_then(|s| s.state.capture_fallback_reason.clone()),
        video_rtp_port: previous.as_ref().and_then(|s| s.state.video_rtp_port),
        audio_rtp_port: previous.as_ref().and_then(|s| s.state.audio_rtp_port),
        exclude_app: previous.as_ref().and_then(|s| s.state.exclude_app.clone()),
        exclude_pid: previous.as_ref().and_then(|s| s.state.exclude_pid),
        error: None,
    };
    drop(guard);
    if let Some(mut session) = previous {
        drop(session.replay.take());
        session.viewer_bridges.clear();
        drop(session.local_bridge.take());
        drop(session.fanout.take());
        if let Some(worker) = session.worker.take() {
            worker.stop();
        }
    }
    emit_state(&app, &stopped);
    Ok(stopped)
}

#[cfg(not(test))]
#[tauri::command]
pub fn create_native_capture_peer(
    app: AppHandle,
    session_id: String,
    offer_sdp: String,
) -> Result<NativeCaptureSdp, String> {
    if offer_sdp.len() > 256 * 1024 {
        return Err("Oferta SDP excede o limite permitido".to_string());
    }
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if session.state.state != "live" {
        return Err("A captura nativa ainda não está ativa".to_string());
    }
    crate::system::write_debug_log(&format!(
        "[Capture] create_native_capture_peer: session_id={}, offer_sdp_len={}, pending_candidates_count={}",
        session_id,
        offer_sdp.len(),
        session.pending_local_ice_candidates.len()
    ));

    if session.local_bridge.is_none() {
        let fanout = session
            .fanout
            .as_ref()
            .ok_or_else(|| "Fanout RTP não está ativo".to_string())?;
        let worker = session
            .worker
            .as_ref()
            .ok_or_else(|| "Worker nativo não está ativo".to_string())?;

        let local_video_port = allocate_ephemeral_port()?;
        let local_audio_port = worker
            .audio_rtp_port
            .is_some()
            .then(allocate_ephemeral_port)
            .transpose()?;

        fanout.add_video_target(local_video_port);
        if let Some(ap) = local_audio_port {
            fanout.add_audio_target(ap);
        }

        let bridge = NativeWebRtcBridge::new(
            Some(&app),
            session_id.clone(),
            None,
            local_video_port,
            local_audio_port,
            worker.config.codec,
            Some(&offer_sdp),
            None,
        )?;

        session.local_video_port = Some(local_video_port);
        session.local_audio_port = local_audio_port;
        session.local_bridge = Some(bridge);
    }
    let answer = session
        .local_bridge
        .as_ref()
        .expect("local_bridge initialized")
        .create_answer(&offer_sdp)?;

    crate::system::write_debug_log(&format!(
        "[Capture] create_answer local gerou SDP de resposta ({} bytes). Drenando {} candidatos ICE pendentes...",
        answer.sdp.len(),
        session.pending_local_ice_candidates.len()
    ));

    for (mline_index, candidate) in session.pending_local_ice_candidates.drain(..) {
        if let Err(err) = session
            .local_bridge
            .as_ref()
            .unwrap()
            .add_ice_candidate(mline_index, &candidate)
        {
            crate::system::write_debug_log(&format!(
                "[Capture] Falha ao adicionar candidato ICE retido do preview local: {err}"
            ));
        }
    }

    Ok(answer)
}

#[cfg(not(test))]
#[tauri::command]
pub fn add_native_capture_ice_candidate(
    session_id: String,
    mline_index: u32,
    candidate: String,
) -> Result<(), String> {
    if candidate.len() > 16 * 1024 {
        return Err("Candidato ICE excede o limite permitido".to_string());
    }
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    let expanded = crate::webrtc_bridge::expand_local_candidates(&candidate);
    for cand in expanded {
        crate::system::write_debug_log(&format!(
            "[Capture] add_native_capture_ice_candidate local: mline={}, cand={}",
            mline_index, cand
        ));
        if let Some(bridge) = session.local_bridge.as_ref() {
            let _ = bridge.add_ice_candidate(mline_index, &cand);
        } else {
            session
                .pending_local_ice_candidates
                .push((mline_index, cand));
        }
    }
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub fn close_native_capture_peer(session_id: String) -> Result<(), String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    if let Some(fanout) = session.fanout.as_ref() {
        if let Some(vp) = session.local_video_port.take() {
            fanout.remove_video_target(vp);
        }
        if let Some(ap) = session.local_audio_port.take() {
            fanout.remove_audio_target(ap);
        }
    }
    let bridge = session.local_bridge.take();
    drop(guard);
    drop(bridge);
    Ok(())
}

#[cfg(not(test))]
#[tauri::command(async)]
pub fn create_native_viewer_peer(
    app: AppHandle,
    session_id: String,
    viewer_id: String,
    offer_sdp: String,
    ice_servers: Option<Vec<String>>,
    negotiation_id: Option<String>,
) -> Result<NativeCaptureSdp, String> {
    if offer_sdp.len() > 256 * 1024 {
        return Err("Oferta SDP excede o limite permitido".to_string());
    }
    if viewer_id.is_empty() || viewer_id.len() > 128 {
        return Err("Identificador de espectador inválido".to_string());
    }
    if negotiation_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 128) {
        return Err("Identificador de negociação inválido".to_string());
    }
    let (codec, audio_rtp_port_exists, ticket) = {
        let mut guard = active_session()
            .lock()
            .map_err(|_| "Estado de captura indisponível".to_string())?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
        if session.state.session_id.as_deref() != Some(session_id.as_str()) {
            return Err("Sessão de captura nativa inválida".to_string());
        }
        if session.state.state != "live" {
            return Err("A captura nativa ainda não está ativa".to_string());
        }

        let ticket = session.viewer_negotiations.begin(&viewer_id, negotiation_id.clone())?;
        session.pending_viewer_ice_candidates.retain(|(peer, id), _| peer != &viewer_id || id == &negotiation_id);
        let fanout = session
            .fanout
            .as_ref()
            .ok_or_else(|| "Fanout RTP não está ativo".to_string())?;
        let worker = session
            .worker
            .as_ref()
            .ok_or_else(|| "Worker nativo não está ativo".to_string())?;

        // Se já existia uma ponte antiga para este espectador, encerre-a
        if let Some(old) = session.viewer_bridges.remove(&viewer_id) {
            fanout.remove_video_target(old.video_port);
            if let Some(ap) = old.audio_port {
                fanout.remove_audio_target(ap);
            }
            drop(old.bridge);
        }

        (worker.config.codec, worker.audio_rtp_port.is_some(), ticket)
    };

    let viewer_video_port = allocate_ephemeral_port()?;
    let viewer_audio_port = audio_rtp_port_exists
        .then(allocate_ephemeral_port)
        .transpose()?;

    crate::system::write_debug_log(&format!(
        "[Capture] Criando ponte direta webrtcbin para espectador {viewer_id} (video_port={viewer_video_port}, audio_port={viewer_audio_port:?})"
    ));

    let bridge = NativeWebRtcBridge::new_with_negotiation(
        Some(&app),
        session_id.clone(),
        Some(viewer_id.clone()),
        viewer_video_port,
        viewer_audio_port,
        codec,
        Some(&offer_sdp),
        ice_servers.as_deref(),
        negotiation_id.clone(),
    )?;

    let answer = bridge.create_answer(&offer_sdp)?;

    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;

    if !session.viewer_negotiations.can_commit(&viewer_id, &ticket, &session_id,
        session.state.session_id.as_deref(), session.state.state == "live") {
        return Err("Negociação nativa substituída ou cancelada".to_string());
    }
    if let Some(fanout) = session.fanout.as_ref() {
        fanout.add_video_target(viewer_video_port);
        if let Some(ap) = viewer_audio_port {
            fanout.add_audio_target(ap);
        }
    }

    if let Some(pending) = session.pending_viewer_ice_candidates.remove(&(viewer_id.clone(), negotiation_id.clone())) {
        for (mline_index, cand) in pending {
            let _ = bridge.add_ice_candidate(mline_index, &cand);
        }
    }

    session.viewer_bridges.insert(
        viewer_id,
        ViewerBridgeEntry {
            bridge,
            video_port: viewer_video_port,
            audio_port: viewer_audio_port,
        },
    );

    Ok(answer)
}

#[cfg(not(test))]
#[tauri::command]
pub fn add_native_viewer_ice_candidate(
    session_id: String,
    viewer_id: String,
    mline_index: u32,
    candidate: String,
    negotiation_id: Option<String>,
) -> Result<(), String> {
    if candidate.len() > 16 * 1024 {
        return Err("Candidato ICE excede o limite permitido".to_string());
    }
    if viewer_id.is_empty() || viewer_id.len() > 128 ||
        negotiation_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 128) {
        return Err("Identificador de negociação inválido".to_string());
    }
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    let expanded = crate::webrtc_bridge::expand_local_candidates(&candidate);
    for cand in expanded {
        if let Some(entry) = session.viewer_bridges.get(&viewer_id)
            .filter(|_| session.viewer_negotiations.matches(&viewer_id, &negotiation_id)) {
            let _ = entry.bridge.add_ice_candidate(mline_index, &cand);
        } else {
            let key = (viewer_id.clone(), negotiation_id.clone());
            if session.pending_viewer_ice_candidates.len() >= 128 && !session.pending_viewer_ice_candidates.contains_key(&key) {
                return Err("Limite de negociações ICE pendentes excedido".to_string());
            }
            let pending = session.pending_viewer_ice_candidates.entry(key).or_default();
            if pending.len() < 256 { pending.push((mline_index, cand)); }
        }
    }
    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub fn close_native_viewer_peer(session_id: String, viewer_id: String, negotiation_id: Option<String>) -> Result<(), String> {
    let mut guard = active_session()
        .lock()
        .map_err(|_| "Estado de captura indisponível".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Nenhuma captura nativa ativa".to_string())?;
    if session.state.session_id.as_deref() != Some(session_id.as_str()) {
        return Err("Sessão de captura nativa inválida".to_string());
    }
    session.pending_viewer_ice_candidates.remove(&(viewer_id.clone(), negotiation_id.clone()));
    if !session.viewer_negotiations.cancel(&viewer_id, &negotiation_id) { return Ok(()); }
    if let Some(entry) = session.viewer_bridges.remove(&viewer_id) {
        if let Some(fanout) = session.fanout.as_ref() {
            fanout.remove_video_target(entry.video_port);
            if let Some(ap) = entry.audio_port {
                fanout.remove_audio_target(ap);
            }
        }
        drop(entry.bridge);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn start_native_replay(session_id: String, seconds: u32) -> Result<(), String> {
    let mut guard = active_session().lock().map_err(|_| "Captura indisponível")?;
    let session = guard.as_mut().ok_or("Sem captura ativa")?;
    if session.state.session_id.as_deref() != Some(&session_id) || session.state.state != "live" {
        return Err("Sessão de captura inválida".into());
    }
    if session.state.video_codec.as_deref() != Some("h264") {
        return Err("Replay sem recodificação disponível apenas para H.264".into());
    }
    if let Some(old) = session.replay.take() {
        if let Some(fanout) = &session.fanout {
            fanout.remove_video_target(old.video_port);
            if let Some(port) = old.audio_port { fanout.remove_audio_target(port); }
        }
        drop(old);
    }
    let video_port = allocate_ephemeral_port()?;
    let audio_port = session.state.audio_rtp_port.map(|_| allocate_ephemeral_port()).transpose()?;
    let replay = crate::replay::NativeReplay::start(video_port, audio_port, seconds)?;
    let fanout = session.fanout.as_ref().ok_or("Fanout indisponível")?;
    fanout.add_video_target(video_port);
    if let Some(port) = audio_port { fanout.add_audio_target(port); }
    session.replay = Some(replay);
    Ok(())
}

#[tauri::command(async)]
pub fn stop_native_replay(session_id: String) -> Result<(), String> {
    let mut guard = active_session().lock().map_err(|_| "Captura indisponível")?;
    let Some(session) = guard.as_mut() else { return Ok(()); };
    if session.state.session_id.as_deref() != Some(&session_id) { return Err("Sessão de captura inválida".into()); }
    if let Some(replay) = session.replay.take() {
        if let Some(fanout) = &session.fanout {
            fanout.remove_video_target(replay.video_port);
            if let Some(port) = replay.audio_port { fanout.remove_audio_target(port); }
        }
        drop(replay);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn export_native_replay(session_id: String) -> Result<tauri::ipc::Response, String> {
    let snapshot = {
        let guard = active_session().lock().map_err(|_| "Captura indisponível")?;
        let session = guard.as_ref().ok_or("Sem captura ativa")?;
        if session.state.session_id.as_deref() != Some(&session_id) { return Err("Sessão de captura inválida".into()); }
        session.replay.as_ref().ok_or("Replay desativado")?.snapshot()?
    }; // Mux outside the capture lock: exporting must not block negotiation/stop.
    snapshot.export().map(tauri::ipc::Response::new)
}
