//! Secondary windows own only their own resources.
pub(crate) fn close_window_resources(
    label: &str,
    stop_capture: impl FnOnce(),
    unplug_controllers: impl FnOnce(),
    stop_viewer: impl FnOnce(),
) {
    match label {
        "main" => { stop_capture(); unplug_controllers(); stop_viewer(); }
        "native-player" => stop_viewer(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn player_close_preserves_main_capture_and_controllers() {
        let mut capture_live = true;
        let mut controllers_connected = true;
        let mut viewer_live = true;
        close_window_resources("native-player", || capture_live = false,
            || controllers_connected = false, || viewer_live = false);
        assert!(capture_live && controllers_connected);
        assert!(!viewer_live);
        close_window_resources("main", || capture_live = false,
            || controllers_connected = false, || viewer_live = false);
        assert!(!capture_live && !controllers_connected && !viewer_live);
    }
    #[test]
    fn unrelated_window_does_not_release_session_resources() {
        close_window_resources("settings", || panic!("capture"),
            || panic!("controllers"), || panic!("viewer"));
    }
}
