//! worker; internal to the native media subsystem.
use super::*;

#[derive(Debug)]
pub struct NativeMediaWorker {
    pub(crate) runtime: GStreamerRuntime,
    pub(crate) child: Option<Child>,
    // Mantém as portas escolhidas ocupadas até a ponte `udpsrc` ser criada.
    // Isso reduz a janela em que outro processo poderia tomar a porta entre
    // a alocação e a abertura do receptor RTP.
    pub(crate) rtp_port_leases: Vec<UdpSocket>,
    pub config: MediaWorkerConfig,
    // config retains the requested preference across audio/quality restarts.
    pub active_capture_backend: CaptureBackend,
    pub capture_fallback_reason: Option<String>,
    pub video_rtp_port: u16,
    pub audio_rtp_port: Option<u16>,
}

impl NativeMediaWorker {
    pub fn resolve_and_validate_config(
        config: MediaWorkerConfig,
        source: &ValidatedSource,
    ) -> Result<(GStreamerRuntime, MediaWorkerConfig), String> {
        validate_source(source)?;
        let runtime = GStreamerRuntime::discover().ok_or_else(|| {
            "Runtime GStreamer empacotado não encontrado; execute tools/prepare-native-media.ps1"
                .to_string()
        })?;
        let capabilities = runtime.probe();
        if !capabilities.video_available {
            return Err(capabilities.reason.unwrap_or_else(|| {
                "GStreamer não possui captura WGC e encoder H.264/H.265/AV1 disponíveis".to_string()
            }));
        }
        let mut resolved_config = config;
        if resolved_config.codec == VideoCodec::H264 {
            resolved_config.h264_encoder = match resolved_config.h264_encoder {
                H264EncoderBackend::Auto => {
                    if capabilities.nvenc_h264_available {
                        log::info!("[Capture] Encoder H.264 selecionado: NVCODEC (nvd3d11h264enc)");
                        #[cfg(not(test))]
                        crate::system::write_debug_log(
                            "[Capture] Encoder H.264 selecionado: NVCODEC (nvd3d11h264enc)",
                        );
                        H264EncoderBackend::Nvenc
                    } else if capabilities.h264_available {
                        log::info!(
                            "[Capture] Encoder H.264 selecionado: Media Foundation (mfh264enc)"
                        );
                        #[cfg(not(test))]
                        crate::system::write_debug_log(
                            "[Capture] Encoder H.264 selecionado: Media Foundation (mfh264enc)",
                        );
                        H264EncoderBackend::MediaFoundation
                    } else if capabilities.x264_available {
                        log::info!("[Capture] Encoder H.264 selecionado: CPU (x264enc)");
                        #[cfg(not(test))]
                        crate::system::write_debug_log(
                            "[Capture] Encoder H.264 selecionado: CPU (x264enc)",
                        );
                        H264EncoderBackend::Cpu
                    } else {
                        return Err("Nenhum encoder H.264 (nvd3d11h264enc, mfh264enc ou x264enc) disponível".to_string());
                    }
                }
                H264EncoderBackend::Nvenc => {
                    if !capabilities.nvenc_h264_available {
                        return Err("Encoder NVENC (nvd3d11h264enc) foi requisitado mas não está disponível".to_string());
                    }
                    #[cfg(not(test))]
                    crate::system::write_debug_log(
                        "[Capture] Encoder H.264 forçado: NVCODEC (nvd3d11h264enc)",
                    );
                    H264EncoderBackend::Nvenc
                }
                H264EncoderBackend::MediaFoundation => {
                    if !capabilities.h264_available {
                        return Err("Encoder Media Foundation (mfh264enc) foi requisitado mas não está disponível".to_string());
                    }
                    #[cfg(not(test))]
                    crate::system::write_debug_log(
                        "[Capture] Encoder H.264 forçado: Media Foundation (mfh264enc)",
                    );
                    H264EncoderBackend::MediaFoundation
                }
                H264EncoderBackend::Cpu => {
                    if !capabilities.x264_available {
                        return Err(
                            "Encoder CPU (x264enc) foi requisitado mas não está disponível"
                                .to_string(),
                        );
                    }
                    #[cfg(not(test))]
                    crate::system::write_debug_log(
                        "[Capture] Encoder H.264 forçado: CPU (x264enc)",
                    );
                    H264EncoderBackend::Cpu
                }
            };
        } else if resolved_config.codec == VideoCodec::Hevc && !capabilities.hevc_available {
            return Err("O encoder HEVC/H.265 (mfh265enc) não está disponível".to_string());
        } else if resolved_config.codec == VideoCodec::Av1 && !capabilities.av1_available {
            return Err("O encoder AV1 (svtav1enc) não está disponível".to_string());
        }
        #[cfg(not(test))]
        if resolved_config.codec == VideoCodec::H264 {
            crate::system::write_debug_log(&format!(
                "[Capture] Encoder H.264 ativo: {}",
                resolved_config.h264_encoder.as_str()
            ));
        }
        let check_d3d12 = resolved_config.capture_backend != CaptureBackend::D3d11
            && resolved_config.codec == VideoCodec::H264
            && resolved_config.h264_encoder == H264EncoderBackend::Nvenc;
        let d3d12_available = check_d3d12 && ["d3d12screencapturesrc", "d3d12convert", "d3d12download"]
            .iter().all(|element| runtime.inspect_element(element));
        resolved_config.capture_backend = resolved_config.capture_backend.resolve(
            resolved_config.codec, resolved_config.h264_encoder, d3d12_available,
        )?;
        if resolved_config.audio_mode != AudioMode::None && !capabilities.system_audio_available {
            return Err("O áudio loopback WASAPI/Opus não está disponível".to_string());
        }
        if resolved_config.audio_mode == AudioMode::Process && !capabilities.process_audio_available
        {
            return Err(
                "O compartilhamento de áudio exclusivo de janela requer Windows 11 (build 22000+) e não é suportado pelo Windows 10."
                    .to_string(),
            );
        }
        if resolved_config.audio_mode == AudioMode::Process && source.process_id.is_none() {
            return Err("A captura de áudio da janela exige uma janela com processo (PID) válido selecionado.".to_string());
        }
        if resolved_config.exclude_process_id.is_some() && !capabilities.process_audio_available {
            log::warn!("[Capture] Exclusão de processo de áudio não suportada nesta versão do Windows; ignorando");
            resolved_config.exclude_process_id = None;
        }
        Ok((runtime, resolved_config))
    }

    pub(crate) fn spawn_child(
        runtime: &GStreamerRuntime,
        source: &ValidatedSource,
        config: &MediaWorkerConfig,
        video_rtp_port: u16,
        audio_rtp_port: Option<u16>,
    ) -> Result<std::process::Child, String> {
        let args = build_pipeline(source, config, video_rtp_port, audio_rtp_port)?;
        #[cfg(windows)]
        if let Some(hwnd) = source.hwnd {
            unsafe {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
                let _ = ShowWindow(HWND(hwnd as *mut _), SW_SHOWNOACTIVATE);
            }
        }
        #[cfg(not(test))]
        crate::system::write_debug_log(&format!(
            "[GStreamer Pipeline] gst-launch-1.0 {}",
            args.join(" ")
        ));
        let mut command = runtime.command();
        command
            .arg("-e")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Falha ao iniciar worker GStreamer: {error}"))?;
        #[cfg(windows)]
        assign_child_to_job_object(&child);
        if let Some(stdout) = child.stdout.take() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::new();
                while let Ok(n) = reader.read_until(b'\n', &mut buf) {
                    if n == 0 {
                        break;
                    }
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    buf.clear();
                    log::info!("[GStreamer worker stdout] {line}");
                    #[cfg(not(test))]
                    crate::system::write_debug_log(&format!("[GStreamer worker stdout] {line}"));
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::new();
                while let Ok(n) = reader.read_until(b'\n', &mut buf) {
                    if n == 0 {
                        break;
                    }
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    buf.clear();
                    log::warn!("[GStreamer worker] {line}");
                    #[cfg(not(test))]
                    crate::system::write_debug_log(&format!("[GStreamer worker] {line}"));
                    #[cfg(test)]
                    eprintln!("[GStreamer worker] {line}");
                }
                #[cfg(not(test))]
                crate::system::write_debug_log(
                    "[GStreamer worker] stderr stream encerrado (processo fechou stderr)",
                );
            });
        }
        Ok(child)
    }

    pub fn start(source: &ValidatedSource, config: MediaWorkerConfig) -> Result<Self, String> {
        let requested_backend = config.capture_backend;
        let (runtime, resolved_config) = Self::resolve_and_validate_config(config, source)?;
        let (video_rtp_port, video_lease) = allocate_loopback_port()?;
        let audio_port_and_lease = (resolved_config.audio_mode != AudioMode::None)
            .then(allocate_loopback_port)
            .transpose()?;
        let audio_rtp_port = audio_port_and_lease.as_ref().map(|(port, _)| *port);
        let mut rtp_port_leases = vec![video_lease];
        if let Some((_, lease)) = audio_port_and_lease {
            rtp_port_leases.push(lease);
        }
        Self::start_resolved(source, runtime, resolved_config, requested_backend,
            video_rtp_port, audio_rtp_port, rtp_port_leases)
    }

    pub fn start_with_ports(
        source: &ValidatedSource,
        config: MediaWorkerConfig,
        video_rtp_port: u16,
        audio_rtp_port: Option<u16>,
    ) -> Result<Self, String> {
        let requested_backend = config.capture_backend;
        let (runtime, resolved_config) = Self::resolve_and_validate_config(config, source)?;
        Self::start_resolved(source, runtime, resolved_config, requested_backend,
            video_rtp_port, audio_rtp_port, Vec::new())
    }

    fn start_resolved(
        source: &ValidatedSource, runtime: GStreamerRuntime, mut config: MediaWorkerConfig,
        requested_backend: CaptureBackend, video_rtp_port: u16,
        audio_rtp_port: Option<u16>, rtp_port_leases: Vec<UdpSocket>,
    ) -> Result<Self, String> {
        let active_capture_backend = config.capture_backend;
        config.capture_backend = requested_backend;
        let mut worker = Self {
            runtime,
            child: None,
            rtp_port_leases,
            config,
            active_capture_backend,
            capture_fallback_reason: None,
            video_rtp_port,
            audio_rtp_port,
        };
        if let Err(error) = worker.spawn_current(source) {
            worker.fallback_to_d3d11(source, &error)?;
        }
        thread::sleep(Duration::from_millis(150));
        worker.health_error(source)?;
        Ok(worker)
    }

    fn spawn_current(&mut self, source: &ValidatedSource) -> Result<(), String> {
        let mut pipeline_config = self.config.clone();
        pipeline_config.capture_backend = self.active_capture_backend;
        #[cfg(not(test))]
        crate::system::write_debug_log(&format!(
            "[Capture] Backend ativo: {}; preferência: {}; fila de vídeo: {}; fallback: {:?}",
            self.active_capture_backend.as_str(), self.config.capture_backend.as_str(),
            self.config.raw_video_queue.as_str(),
            self.capture_fallback_reason,
        ));
        self.child = Some(Self::spawn_child(&self.runtime, source, &pipeline_config,
            self.video_rtp_port, self.audio_rtp_port)?);
        Ok(())
    }

    pub(crate) fn fallback_to_d3d11(&mut self, source: &ValidatedSource, error: &str) -> Result<(), String> {
        if self.config.capture_backend != CaptureBackend::Auto
            || self.active_capture_backend != CaptureBackend::D3d12 {
            return Err(error.to_string());
        }
        self.stop_process();
        // Set before spawning: even if D3D11 fails, there can be no retry loop.
        self.active_capture_backend = CaptureBackend::D3d11;
        self.capture_fallback_reason = Some(error.to_string());
        log::warn!("[Capture] D3D12 falhou; tentando D3D11: {error}");
        self.spawn_current(source).map_err(|fallback_error|
            format!("D3D12 falhou: {error}; fallback D3D11 falhou: {fallback_error}"))?;
        thread::sleep(Duration::from_millis(150));
        self.health_error(source)
    }

    pub fn restart_audio_mode(
        &mut self,
        source: &ValidatedSource,
        audio_mode: AudioMode,
    ) -> Result<(), String> {
        let mut config = self.config.clone();
        config.audio_mode = audio_mode;
        self.stop_process();
        let mut replacement =
            Self::start_with_ports(source, config, self.video_rtp_port, self.audio_rtp_port)?;
        self.runtime = replacement.runtime.clone();
        self.child = replacement.child.take();
        self.config = replacement.config.clone();
        self.active_capture_backend = replacement.active_capture_backend;
        self.capture_fallback_reason = replacement.capture_fallback_reason.clone();
        self.video_rtp_port = replacement.video_rtp_port;
        self.audio_rtp_port = replacement.audio_rtp_port;
        Ok(())
    }

    pub fn stop(mut self) {
        self.stop_process();
    }

    /// Detecta uma saída assíncrona do gst-launch depois que a captura já foi
    /// marcada como live. Isso permite que o comando de estado e a UI
    /// propaguem a falha em vez de manter uma sessão fantasma.
    pub fn health_error(&mut self, source: &ValidatedSource) -> Result<(), String> {
        let Some(child) = self.child.as_mut() else {
            return Err("Worker GStreamer não está ativo".to_string());
        };
        match child
            .try_wait()
            .map_err(|error| format!("Falha ao verificar worker GStreamer: {error}"))?
        {
            Some(status) => {
                self.child = None;
                self.fallback_to_d3d11(source, &format!(
                    "Worker GStreamer encerrou inesperadamente: {status}"
                ))
            }
            None => Ok(()),
        }
    }

    pub fn release_rtp_port_leases(&mut self) {
        if let Ok(mut guard) = HANDOFF_LEASES.lock() {
            guard.extend(self.rtp_port_leases.drain(..));
        } else {
            self.rtp_port_leases.clear();
        }
    }

    pub(crate) fn stop_process(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
        self.child = None;
        thread::sleep(Duration::from_millis(60));
    }
}

pub(crate) static HANDOFF_LEASES: std::sync::Mutex<Vec<UdpSocket>> =
    std::sync::Mutex::new(Vec::new());

pub fn clear_handoff_leases() {
    if let Ok(mut guard) = HANDOFF_LEASES.lock() {
        guard.clear();
    }
}

impl Drop for NativeMediaWorker {
    fn drop(&mut self) {
        self.stop_process();
        clear_handoff_leases();
    }
}
