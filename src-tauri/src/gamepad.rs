use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GamepadReport {
    /// 17 botões do padrão W3C Gamepad API
    #[serde(default)]
    pub buttons: Vec<bool>,
    /// Gatilhos analógicos opcionais [left (0.0..1.0), right (0.0..1.0)]
    #[serde(default)]
    pub triggers: Option<Vec<f32>>,
    /// Eixos analógicos [lx, ly, rx, ry] (-1.0..1.0)
    #[serde(default)]
    pub axes: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GamepadStatus {
    pub vigem_available: bool,
    pub active_slots: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct XInputButtonSnapshot {
    pub pressed: bool,
    pub value: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct XInputGamepadSnapshot {
    pub index: u32,
    pub id: String,
    pub connected: bool,
    pub buttons: Vec<XInputButtonSnapshot>,
    pub axes: Vec<f32>,
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;
    use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

    #[repr(C)]
    struct XInputVibration {
        left_motor_speed: u16,
        right_motor_speed: u16,
    }

    #[repr(C)]
    #[derive(Default)]
    struct XInputGamepadState {
        buttons: u16,
        left_trigger: u8,
        right_trigger: u8,
        left_thumb_x: i16,
        left_thumb_y: i16,
        right_thumb_x: i16,
        right_thumb_y: i16,
    }

    #[repr(C)]
    #[derive(Default)]
    struct XInputState {
        packet_number: u32,
        gamepad: XInputGamepadState,
    }

    #[link(name = "xinput")]
    unsafe extern "system" {
        fn XInputSetState(user_index: u32, vibration: *const XInputVibration) -> u32;
        fn XInputGetState(user_index: u32, state: *mut XInputState) -> u32;
    }

    static RUMBLE_GENERATIONS: [AtomicU64; 4] = [
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
    ];

    pub fn connected_xinput_gamepads() -> Vec<XInputGamepadSnapshot> {
        (0..4)
            .filter_map(|user_index| {
                let mut state = XInputState::default();
                if unsafe { XInputGetState(user_index, &mut state) } != 0 {
                    return None;
                }

                let gamepad = state.gamepad;
                let is_pressed = |mask: u16| gamepad.buttons & mask != 0;
                let button = |pressed: bool| XInputButtonSnapshot {
                    pressed,
                    value: if pressed { 1.0 } else { 0.0 },
                };
                let trigger = |value: u8| XInputButtonSnapshot {
                    pressed: value >= 30,
                    value: value as f32 / u8::MAX as f32,
                };
                let normalize_axis = |value: i16| (value as f32 / i16::MAX as f32).clamp(-1.0, 1.0);

                Some(XInputGamepadSnapshot {
                    index: user_index,
                    id: format!("Controle Xbox {} (Windows XInput)", user_index + 1),
                    connected: true,
                    buttons: vec![
                        button(is_pressed(0x1000)), // A
                        button(is_pressed(0x2000)), // B
                        button(is_pressed(0x4000)), // X
                        button(is_pressed(0x8000)), // Y
                        button(is_pressed(0x0100)), // LB
                        button(is_pressed(0x0200)), // RB
                        trigger(gamepad.left_trigger),
                        trigger(gamepad.right_trigger),
                        button(is_pressed(0x0020)), // Back
                        button(is_pressed(0x0010)), // Start
                        button(is_pressed(0x0040)), // L3
                        button(is_pressed(0x0080)), // R3
                        button(is_pressed(0x0001)), // Up
                        button(is_pressed(0x0002)), // Down
                        button(is_pressed(0x0004)), // Left
                        button(is_pressed(0x0008)), // Right
                        button(false),              // Guide is not reported by XInputGetState
                    ],
                    axes: vec![
                        normalize_axis(gamepad.left_thumb_x),
                        -normalize_axis(gamepad.left_thumb_y),
                        normalize_axis(gamepad.right_thumb_x),
                        -normalize_axis(gamepad.right_thumb_y),
                    ],
                })
            })
            .collect()
    }

    pub fn test_vibration(
        user_index: u32,
        strong_magnitude: f32,
        weak_magnitude: f32,
        duration_ms: u64,
    ) -> Result<(), String> {
        let generation =
            RUMBLE_GENERATIONS[user_index as usize].fetch_add(1, Ordering::SeqCst) + 1;
        let vibration = XInputVibration {
            left_motor_speed: (strong_magnitude * u16::MAX as f32).round() as u16,
            right_motor_speed: (weak_magnitude * u16::MAX as f32).round() as u16,
        };
        let result = unsafe { XInputSetState(user_index, &vibration) };
        if result != 0 {
            let stopped = XInputVibration {
                left_motor_speed: 0,
                right_motor_speed: 0,
            };
            let _ = unsafe { XInputSetState(user_index, &stopped) };
            return Err(if result == 1167 {
                format!("O XInput não detectou um controle no índice {user_index}.")
            } else {
                format!("Falha ao iniciar a vibração XInput (código {result}).")
            });
        }

        thread::spawn(move || {
            thread::sleep(Duration::from_millis(duration_ms));
            if RUMBLE_GENERATIONS[user_index as usize].load(Ordering::SeqCst) != generation {
                return;
            }
            let stopped = XInputVibration {
                left_motor_speed: 0,
                right_motor_speed: 0,
            };
            let stop_result = unsafe { XInputSetState(user_index, &stopped) };
            if stop_result != 0 {
                log::debug!("[Gamepad] XInputSetState ao parar vibração retornou {stop_result}");
            }
        });
        Ok(())
    }

    pub struct NativeGamepadManager {
        client: Option<Arc<Client>>,
        targets: HashMap<u8, Xbox360Wired<Arc<Client>>>,
    }

    impl NativeGamepadManager {
        pub fn new() -> Self {
            let client = Client::connect().ok().map(Arc::new);
            if client.is_some() {
                log::info!("[Gamepad] ViGEmBus driver conectado com sucesso!");
            } else {
                log::warn!("[Gamepad] ViGEmBus driver não disponível ou serviço parado.");
            }
            Self {
                client,
                targets: HashMap::new(),
            }
        }

        pub fn is_available(&mut self) -> bool {
            if self.client.is_none() {
                self.client = Client::connect().ok().map(Arc::new);
            }
            self.client.is_some()
        }

        pub fn plug(&mut self, slot: u8) -> Result<(), String> {
            if self.targets.contains_key(&slot) {
                return Ok(()); // Já conectado
            }
            let client = self
                .client
                .as_ref()
                .ok_or_else(|| "Driver ViGEmBus não está conectado".to_string())?
                .clone();

            let mut target: Xbox360Wired<Arc<Client>> =
                Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
            target
                .plugin()
                .map_err(|e| format!("Falha ao plugar controle virtual: {:?}", e))?;
            let _ = target.wait_ready();
            log::info!(
                "[Gamepad] Controle virtual Xbox 360 plugado com sucesso no Slot {}",
                slot
            );
            self.targets.insert(slot, target);
            Ok(())
        }

        pub fn update(&mut self, slot: u8, report: &GamepadReport) -> Result<(), String> {
            let target = self
                .targets
                .get_mut(&slot)
                .ok_or_else(|| format!("Nenhum controle virtual ativo no Slot {}", slot))?;

            let xgamepad = convert_report_to_xgamepad(report);
            target
                .update(&xgamepad)
                .map_err(|e| format!("Falha ao enviar relatório para controle: {:?}", e))?;
            Ok(())
        }

        pub fn unplug(&mut self, slot: u8) -> Result<(), String> {
            if let Some(target) = self.targets.remove(&slot) {
                // Drop do target desconecta o dispositivo do ViGEmBus
                drop(target);
                log::info!("[Gamepad] Controle virtual no Slot {} desconectado.", slot);
            }
            Ok(())
        }

        pub fn unplug_all(&mut self) -> Result<(), String> {
            let count = self.targets.len();
            self.targets.clear();
            if count > 0 {
                log::info!(
                    "[Gamepad] Todos os {} controles virtuais foram desconectados.",
                    count
                );
            }
            Ok(())
        }

        pub fn active_slots(&self) -> Vec<u8> {
            let mut slots: Vec<u8> = self.targets.keys().copied().collect();
            slots.sort();
            slots
        }
    }

    pub fn convert_report_to_xgamepad(report: &GamepadReport) -> XGamepad {
        let mut buttons_mask = 0u16;

        // Mapeamento W3C Standard Gamepad para constantes XInput
        // 0: A (0x1000)
        // 1: B (0x2000)
        // 2: X (0x4000)
        // 3: Y (0x8000)
        // 4: LB (0x0100)
        // 5: RB (0x0200)
        // 8: Back (0x0020)
        // 9: Start (0x0010)
        // 10: LS (0x0040)
        // 11: RS (0x0080)
        // 12: D-Up (0x0001)
        // 13: D-Down (0x0002)
        // 14: D-Left (0x0004)
        // 15: D-Right (0x0008)
        let get_btn = |idx: usize| -> bool { report.buttons.get(idx).copied().unwrap_or(false) };

        if get_btn(0) {
            buttons_mask |= 0x1000;
        } // A
        if get_btn(1) {
            buttons_mask |= 0x2000;
        } // B
        if get_btn(2) {
            buttons_mask |= 0x4000;
        } // X
        if get_btn(3) {
            buttons_mask |= 0x8000;
        } // Y
        if get_btn(4) {
            buttons_mask |= 0x0100;
        } // LB
        if get_btn(5) {
            buttons_mask |= 0x0200;
        } // RB
        if get_btn(8) {
            buttons_mask |= 0x0020;
        } // Back
        if get_btn(9) {
            buttons_mask |= 0x0010;
        } // Start
        if get_btn(10) {
            buttons_mask |= 0x0040;
        } // Left Thumb (LS)
        if get_btn(11) {
            buttons_mask |= 0x0080;
        } // Right Thumb (RS)
        if get_btn(12) {
            buttons_mask |= 0x0001;
        } // D-Pad Up
        if get_btn(13) {
            buttons_mask |= 0x0002;
        } // D-Pad Down
        if get_btn(14) {
            buttons_mask |= 0x0004;
        } // D-Pad Left
        if get_btn(15) {
            buttons_mask |= 0x0008;
        } // D-Pad Right

        // Gatilhos analógicos: 0 a 255
        let left_trigger = if let Some(trigs) = &report.triggers {
            (trigs.first().copied().unwrap_or(0.0).clamp(0.0, 1.0) * 255.0) as u8
        } else if get_btn(6) {
            255
        } else {
            0
        };

        let right_trigger = if let Some(trigs) = &report.triggers {
            (trigs.get(1).copied().unwrap_or(0.0).clamp(0.0, 1.0) * 255.0) as u8
        } else if get_btn(7) {
            255
        } else {
            0
        };

        // Eixos analógicos: -32768 a 32767
        // Nota crítica: no Web Gamepad API, Y negativo é CIMA (-1.0 = Up).
        // No DirectX/XInput, Y positivo é CIMA (+32767 = Up).
        // Portanto, thumb_ly = -axis_y * 32767.0!
        let get_axis = |idx: usize| -> f32 {
            report
                .axes
                .get(idx)
                .copied()
                .unwrap_or(0.0)
                .clamp(-1.0, 1.0)
        };

        let thumb_lx = (get_axis(0) * 32767.0) as i16;
        let thumb_ly = (-get_axis(1) * 32767.0) as i16;
        let thumb_rx = (get_axis(2) * 32767.0) as i16;
        let thumb_ry = (-get_axis(3) * 32767.0) as i16;

        XGamepad {
            buttons: XButtons { raw: buttons_mask },
            left_trigger,
            right_trigger,
            thumb_lx,
            thumb_ly,
            thumb_rx,
            thumb_ry,
        }
    }
}

// Fallback não-Windows / stub
#[cfg(not(windows))]
mod native {
    use super::*;

    pub struct NativeGamepadManager;
    impl NativeGamepadManager {
        pub fn new() -> Self {
            Self
        }
        pub fn is_available(&mut self) -> bool {
            false
        }
        pub fn plug(&mut self, _slot: u8) -> Result<(), String> {
            Err("ViGEmBus é suportado apenas no Windows".into())
        }
        pub fn update(&mut self, _slot: u8, _report: &GamepadReport) -> Result<(), String> {
            Err("ViGEmBus é suportado apenas no Windows".into())
        }
        pub fn unplug(&mut self, _slot: u8) -> Result<(), String> {
            Ok(())
        }
        pub fn unplug_all(&mut self) -> Result<(), String> {
            Ok(())
        }
        pub fn active_slots(&self) -> Vec<u8> {
            Vec::new()
        }
    }
}

static GAMEPAD_MANAGER: Mutex<Option<native::NativeGamepadManager>> = Mutex::new(None);

fn with_manager<F, R>(f: F) -> R
where
    F: FnOnce(&mut native::NativeGamepadManager) -> R,
{
    let mut lock = GAMEPAD_MANAGER.lock().unwrap();
    if lock.is_none() {
        *lock = Some(native::NativeGamepadManager::new());
    }
    f(lock.as_mut().unwrap())
}

#[tauri::command]
pub fn check_gamepad_driver_status() -> GamepadStatus {
    with_manager(|mgr| GamepadStatus {
        vigem_available: mgr.is_available(),
        active_slots: mgr.active_slots(),
    })
}

#[tauri::command]
pub fn plug_virtual_gamepad(slot: u8) -> Result<(), String> {
    with_manager(|mgr| mgr.plug(slot))
}

#[tauri::command]
pub fn update_virtual_gamepad(slot: u8, report: GamepadReport) -> Result<(), String> {
    with_manager(|mgr| mgr.update(slot, &report))
}

#[tauri::command]
pub fn unplug_virtual_gamepad(slot: u8) -> Result<(), String> {
    with_manager(|mgr| mgr.unplug(slot))
}

#[tauri::command]
pub fn unplug_all_virtual_gamepads() -> Result<(), String> {
    with_manager(|mgr| mgr.unplug_all())
}

#[tauri::command]
pub fn get_xinput_gamepads() -> Vec<XInputGamepadSnapshot> {
    #[cfg(windows)]
    {
        native::connected_xinput_gamepads()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub fn test_gamepad_vibration(
    gamepad_index: u32,
    strong_magnitude: f64,
    weak_magnitude: f64,
    duration_ms: u64,
) -> Result<(), String> {
    if gamepad_index > 3 {
        return Err("O índice do controle deve estar entre 0 e 3 no Windows.".to_string());
    }
    if !strong_magnitude.is_finite()
        || !weak_magnitude.is_finite()
        || !(0.0..=1.0).contains(&strong_magnitude)
        || !(0.0..=1.0).contains(&weak_magnitude)
    {
        return Err("A intensidade da vibração deve estar entre 0 e 1.".to_string());
    }
    if duration_ms == 0 || duration_ms > 2_000 {
        return Err("A duração da vibração deve estar entre 1 e 2000 ms.".to_string());
    }

    #[cfg(windows)]
    {
        native::test_vibration(
            gamepad_index,
            strong_magnitude as f32,
            weak_magnitude as f32,
            duration_ms,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (gamepad_index, strong_magnitude, weak_magnitude, duration_ms);
        Err("A vibração nativa só está disponível no Windows.".to_string())
    }
}

#[tauri::command]
pub async fn install_vigem_driver() -> Result<String, String> {
    #[cfg(windows)]
    {
        let mut script_path = None;
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let candidates = [
                    parent.join("tools").join("install-vigem.ps1"),
                    parent.join("resources").join("tools").join("install-vigem.ps1"),
                    parent.join("resources").join("install-vigem.ps1"),
                ];
                for cand in candidates {
                    if cand.exists() {
                        script_path = Some(cand);
                        break;
                    }
                }
                if script_path.is_none() {
                    for ancestor in parent.ancestors().take(7) {
                        let candidate = ancestor.join("tools").join("install-vigem.ps1");
                        if candidate.exists() {
                            script_path = Some(candidate);
                            break;
                        }
                    }
                }
            }
        }

        let script = script_path.ok_or_else(|| {
            "Script de instalação tools/install-vigem.ps1 não encontrado".to_string()
        })?;

        log::info!("[Gamepad] Invocando instalador do ViGEmBus com elevação: {}", script.display());

        let ps_cmd = format!(
            "Start-Process powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"{}\"' -Verb RunAs -Wait",
            script.display()
        );

        let status = std::process::Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-Command")
            .arg(&ps_cmd)
            .status()
            .map_err(|e| format!("Falha ao invocar processo de instalação: {e}"))?;

        if !status.success() {
            return Err("A instalação do driver foi cancelada ou falhou".to_string());
        }

        let mut lock = GAMEPAD_MANAGER.lock().unwrap();
        *lock = Some(native::NativeGamepadManager::new());
        if let Some(mgr) = lock.as_mut() {
            if mgr.is_available() {
                return Ok("Driver ViGEmBus instalado e conectado com sucesso!".to_string());
            }
        }

        Ok("Instalação concluída. Verifique se o serviço ViGEmBus está ativo.".to_string())
    }
    #[cfg(not(windows))]
    {
        Err("ViGEmBus é suportado apenas no Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gamepad_report_defaults() {
        let json = r#"{"buttons": [true, false], "axes": [0.5, -0.5]}"#;
        let report: GamepadReport = serde_json::from_str(json).expect("should parse");
        assert_eq!(report.buttons.len(), 2);
        assert!(report.buttons[0]);
        assert!(!report.buttons[1]);
        assert_eq!(report.axes.len(), 2);
        assert_eq!(report.axes[0], 0.5);
        assert_eq!(report.axes[1], -0.5);
        assert!(report.triggers.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn maps_w3c_buttons_and_inverts_y_axis() {
        let mut buttons = vec![false; 17];
        buttons[0] = true; // A
        buttons[12] = true; // D-Pad Up
        let triggers = Some(vec![0.75, 1.0]);
        let axes = vec![0.5, 0.8, -0.2, -1.0]; // Ly = 0.8 (Down), Ry = -1.0 (Up)

        let report = GamepadReport {
            buttons,
            triggers,
            axes,
        };

        let xgp = native::convert_report_to_xgamepad(&report);
        // A (0x1000) | D-Pad Up (0x0001) = 0x1001
        assert_eq!(xgp.buttons.raw, 0x1001);
        // Triggers 0.75 * 255 = 191, 1.0 * 255 = 255
        assert_eq!(xgp.left_trigger, (0.75 * 255.0) as u8);
        assert_eq!(xgp.right_trigger, 255);
        // Sticks:
        assert_eq!(xgp.thumb_lx, (0.5 * 32767.0) as i16);
        // Ly was 0.8 in Web (downwards), must be negative in XInput:
        assert_eq!(xgp.thumb_ly, (-0.8 * 32767.0) as i16);
        assert_eq!(xgp.thumb_rx, (-0.2 * 32767.0) as i16);
        // Ry was -1.0 in Web (upwards), must be positive 32767 in XInput:
        assert_eq!(xgp.thumb_ry, (1.0 * 32767.0) as i16);
    }
}
