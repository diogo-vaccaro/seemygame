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
mod native_viewer;
#[cfg(not(test))]
mod system;
mod webrtc_bridge;
mod windows_list;

#[cfg(not(test))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                tauri::WindowEvent::Destroyed => {
                    log::info!("[SeeMyGame Desktop] Janela destruída, encerrando captura e controles virtuais...");
                    if let Err(error) = capture::stop_native_capture(window.app_handle().clone(), None) {
                        log::warn!("[SeeMyGame Desktop] Falha ao encerrar captura nativa: {error}");
                    }
                    let _ = gamepad::unplug_all_virtual_gamepads();
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    log::info!("[SeeMyGame Desktop] Fechamento solicitado, garantindo encerramento limpo de processos...");
                    if let Err(error) = capture::stop_native_capture(window.app_handle().clone(), None) {
                        log::warn!("[SeeMyGame Desktop] Falha ao encerrar captura nativa: {error}");
                    }
                    let _ = gamepad::unplug_all_virtual_gamepads();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            system::set_high_priority,
            capture::get_native_capture_capabilities,
            capture::get_native_capture_state,
            capture::start_native_capture,
            capture::reconfigure_native_capture,
            capture::set_native_capture_audio_mode,
            capture::stop_native_capture,
            capture::create_native_capture_peer,
            capture::add_native_capture_ice_candidate,
            capture::close_native_capture_peer,
            capture::create_native_viewer_peer,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
