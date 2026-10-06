// Unit tests exercise the native media/bridge layers without booting the
// Tauri runtime. The runtime-only command wiring is intentionally excluded
// from those test builds.
#![cfg_attr(test, allow(dead_code, unused_imports, unused_variables))]
#![allow(clippy::too_many_arguments)]

#[cfg(not(test))]
use tauri::Manager;

mod capture;
mod gamepad;
mod media;
mod replay;
mod native_viewer;
#[cfg(not(test))]
mod system;
mod webrtc_bridge;
mod webrtc_common;
mod windows_list;
mod window_lifecycle;
mod instance_profile;

#[cfg(not(test))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(windows)]
    let _profile_lease = {
        let explicit = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER")
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from);
        // Match Tauri's default Windows profile without changing the primary.
        // Use WebView2's environment override: the installed tauri-runtime
        // does not propagate WindowConfig.data_directory into its attributes.
        let default_directory = std::env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(&context.config().identifier);
        let base = explicit.as_deref().unwrap_or(&default_directory);
        let key = base.to_string_lossy();
        let lease = instance_profile::ProfileLease::acquire(&key);
        let slot = lease.as_ref().map(|lease| lease.slot).unwrap_or_else(|_| std::process::id().saturating_add(33));
        if let Some(directory) = instance_profile::secondary_directory(Some(base), slot) {
            // This executes before Tauri/WebView2 starts threads or reads the environment.
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &directory);
            system::write_debug_log(&format!("[InstanceProfile] isolated secondary slot={slot} directory={}", directory.display()));
        } else {
            system::write_debug_log("[InstanceProfile] primary profile preserved slot=1");
        }
        lease.ok()
    };
    tauri::Builder::default()
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    // The default LogDir target can prevent startup when a
                    // previous instance still owns the file or the install
                    // location denies write access. A GUI app must not fail
                    // before creating its window just because diagnostics
                    // cannot be persisted.
                    .clear_targets()
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    ))
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            log::info!("[SeeMyGame Desktop] Iniciando setup do SeeMyGame...");

            if let Some(window) = app.get_webview_window("main") {
                log::info!("[SeeMyGame Desktop] Janela 'main' encontrada!");
                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: 100.0, y: 100.0 }));
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                log::info!("[SeeMyGame Desktop] Janela 'main' configurada com sucesso (pos, show, unminimize, focus).");
            } else {
                log::warn!("[SeeMyGame Desktop] Janela 'main' não encontrada pelo label!");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            log::info!("[SeeMyGame Desktop] WindowEvent ({:?}): {:?}", window.label(), event);
            match event {
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. } => {
                    window_lifecycle::close_window_resources(window.label(), || {
                        if let Err(error) = capture::stop_native_capture(window.app_handle().clone(), None) {
                            log::warn!("[SeeMyGame Desktop] Falha ao encerrar captura nativa: {error}");
                        }
                    }, || { let _ = gamepad::unplug_all_virtual_gamepads(); }, || {
                        if let Err(error) = native_viewer::release_native_viewer() {
                            log::warn!("[SeeMyGame Desktop] Falha ao encerrar player nativo: {error}");
                        }
                    });
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            system::set_high_priority,
            capture::get_native_capture_capabilities,
            capture::list_audio_exclusion_candidates,
            capture::get_native_capture_state,
            capture::start_native_capture,
            capture::reconfigure_native_capture,
            capture::set_native_capture_audio_mode,
            capture::stop_native_capture,
            capture::start_native_replay,
            capture::stop_native_replay,
            capture::export_native_replay,
            capture::create_native_capture_peer,
            capture::add_native_capture_ice_candidate,
            capture::close_native_capture_peer,
            capture::create_native_viewer_peer,
            capture::get_native_stream_stats,
            capture::add_native_viewer_ice_candidate,
            capture::close_native_viewer_peer,
            windows_list::list_capture_sources,
            windows_list::list_capturable_windows,
            system::toggle_always_on_top,
            system::is_always_on_top,
            system::log_diagnostic,
            gamepad::check_gamepad_driver_status,
            gamepad::plug_virtual_gamepad,
            gamepad::update_virtual_gamepad,
            gamepad::unplug_virtual_gamepad,
            gamepad::unplug_all_virtual_gamepads,
            gamepad::get_xinput_gamepads,
            gamepad::test_gamepad_vibration,
            gamepad::install_vigem_driver,
            native_viewer::start_native_viewer,
            native_viewer::add_native_viewer_candidate,
            native_viewer::stop_native_viewer
        ])
        .run(context)
        .expect("error while running tauri application");
}
