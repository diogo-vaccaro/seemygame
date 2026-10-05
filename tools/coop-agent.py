#!/usr/bin/env python3
"""
SeeMyGame - Co-op Native Companion Agent (Windows)
--------------------------------------------------
Servidor WebSocket local que recebe os comandos do Player 2
enviados via WebRTC pelo SeeMyGame e os simula diretamente no
Windows com latência mínima.

Permite que seu amigo controle jogos nativos de PC (Steam,
emuladores, jogos de luta/co-op) como se estivesse sentado ao seu lado!

Dependências:
    pip install websockets pyautogui
"""

import argparse
import asyncio
import json
import sys
import urllib.parse


try:
    import websockets
except ImportError:
    print("ERRO: Pacote 'websockets' não instalado. Execute: pip install websockets")
    sys.exit(1)

try:
    import pyautogui
    # A06: Failsafe ATIVADO - Mover o mouse para qualquer canto da tela aborta o controle imediatamente
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.001     # Sem atraso artificial entre comandos
    HAVE_PYAUTOGUI = True
except ImportError:
    HAVE_PYAUTOGUI = False
    print("AVISO: 'pyautogui' não encontrado. Execute: pip install pyautogui para suporte a teclado/mouse.")

try:
    import vgamepad as vg
    HAVE_VGAMEPAD = True
except ImportError:
    HAVE_VGAMEPAD = False

class _NoFailsafeException(Exception):
    pass

PyAutoGUIFailSafe = getattr(globals().get("pyautogui"), "FailSafeException", _NoFailsafeException) if HAVE_PYAUTOGUI else _NoFailsafeException

# Instâncias de gamepads virtuais ativos por slot (1 = P2, 2 = P3, 3 = P4)
virtual_gamepads = {}

# Rastreamento de teclas e botões pressionados para liberação total em pânico/desconexão (A06)
pressed_keys = set()
pressed_mouse_buttons = set()
slot_pressed_keys = {}
slot_pressed_mouse_buttons = {}
active_client = None

def _release_input(call, **kwargs):
    """Release an input even when the pointer is on PyAutoGUI's failsafe corner."""
    if not HAVE_PYAUTOGUI:
        return True

    # Failsafe is deliberately enabled during normal input handling. Cleanup
    # is the exception: refusing keyUp/mouseUp at the corner leaves a real
    # game input physically stuck. Restore the safety setting immediately.
    previous_failsafe = getattr(pyautogui, "FAILSAFE", True)
    try:
        pyautogui.FAILSAFE = False
        call(**kwargs)
        return True
    except Exception:
        return False
    finally:
        pyautogui.FAILSAFE = previous_failsafe

def release_slot(slot):
    """Libera entradas retidas exclusivamente para um slot específico sem interferir nos outros."""
    try:
        target_slot = int(slot)
    except (TypeError, ValueError):
        return release_all()

    succeeded = True
    # 1. Reset do gamepad virtual correspondente ao slot
    if HAVE_VGAMEPAD and target_slot in virtual_gamepads:
        try:
            virtual_gamepads[target_slot].reset()
            virtual_gamepads[target_slot].update()
        except Exception:
            succeeded = False

    # 2. Reset das teclas retidas por este slot
    if HAVE_PYAUTOGUI and target_slot in slot_pressed_keys:
        keys_to_release = list(slot_pressed_keys[target_slot])
        slot_pressed_keys[target_slot].clear()
        for k in keys_to_release:
            # Verifica se nenhum outro slot ativo ainda segura a mesma tecla
            if not any(k in s_keys for s_id, s_keys in slot_pressed_keys.items() if s_id != target_slot):
                if _release_input(pyautogui.keyUp, key=k):
                    pressed_keys.discard(k)
                else:
                    slot_pressed_keys[target_slot].add(k)
                    succeeded = False

    buttons = slot_pressed_mouse_buttons.pop(target_slot, set())
    if target_slot == 1:
        buttons |= pressed_mouse_buttons - set().union(*slot_pressed_mouse_buttons.values())
    if HAVE_PYAUTOGUI:
        for button in buttons:
            if any(button in held for held in slot_pressed_mouse_buttons.values()):
                continue
            if _release_input(pyautogui.mouseUp, button=button):
                pressed_mouse_buttons.discard(button)
            else:
                slot_pressed_mouse_buttons.setdefault(target_slot, set()).add(button)
                succeeded = False

    return succeeded

def release_all():
    """Liberação total de todas as teclas e botões do mouse (All-Up / Emergency Stop)."""
    succeeded = True
    remaining_keys = set()
    for k in list(pressed_keys) if HAVE_PYAUTOGUI else []:
        if not _release_input(pyautogui.keyUp, key=k):
            remaining_keys.add(k)
    pressed_keys.clear()
    pressed_keys.update(remaining_keys)
    slot_pressed_keys.clear()

    remaining_buttons = set()
    for b in list(pressed_mouse_buttons) if HAVE_PYAUTOGUI else []:
        if not _release_input(pyautogui.mouseUp, button=b):
            remaining_buttons.add(b)
    pressed_mouse_buttons.clear()
    pressed_mouse_buttons.update(remaining_buttons)
    slot_pressed_mouse_buttons.clear()

    # Liberação total de todos os gamepads virtuais ativos
    if HAVE_VGAMEPAD and virtual_gamepads:
        for slot, gp in list(virtual_gamepads.items()):
            try:
                gp.reset()
                gp.update()
            except Exception:
                succeeded = False

    return succeeded and not pressed_keys and not pressed_mouse_buttons

# Mapeamento W3C Standard Gamepad para constantes XUSB do ViGEmBus
W3C_TO_XUSB = {
    0: "XUSB_GAMEPAD_A",
    1: "XUSB_GAMEPAD_B",
    2: "XUSB_GAMEPAD_X",
    3: "XUSB_GAMEPAD_Y",
    4: "XUSB_GAMEPAD_LEFT_SHOULDER",
    5: "XUSB_GAMEPAD_RIGHT_SHOULDER",
    8: "XUSB_GAMEPAD_BACK",
    9: "XUSB_GAMEPAD_START",
    10: "XUSB_GAMEPAD_LEFT_THUMB",
    11: "XUSB_GAMEPAD_RIGHT_THUMB",
    12: "XUSB_GAMEPAD_DPAD_UP",
    13: "XUSB_GAMEPAD_DPAD_DOWN",
    14: "XUSB_GAMEPAD_DPAD_LEFT",
    15: "XUSB_GAMEPAD_DPAD_RIGHT",
    16: "XUSB_GAMEPAD_GUIDE"
}

def get_or_create_gamepad(slot=1):
    if not HAVE_VGAMEPAD:
        return None
    if slot not in virtual_gamepads:
        try:
            virtual_gamepads[slot] = vg.VX360Gamepad()
            print(f"[Co-op Agent] Controle virtual Xbox 360 criado para o Slot {slot}!")
        except Exception as e:
            print(f"[Co-op Agent] Falha ao criar controle virtual no Slot {slot}: {e}")
            return None
    return virtual_gamepads.get(slot)

# Mapeamento de teclas Web (KeyboardEvent.code) para nomes do PyAutoGUI
KEY_MAP = {
    "KeyW": "w", "KeyA": "a", "KeyS": "s", "KeyD": "d",
    "ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right",
    "Space": "space", "Enter": "enter", "Escape": "esc", "Tab": "tab",
    "ShiftLeft": "shiftleft", "ShiftRight": "shiftright",
    "ControlLeft": "ctrlleft", "ControlRight": "ctrlright",
    "KeyJ": "j", "KeyK": "k", "KeyL": "l", "KeyU": "u", "KeyI": "i", "KeyO": "o",
    "KeyZ": "z", "KeyX": "x", "KeyC": "c", "KeyV": "v"
}

ALLOWED_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "tauri.localhost"}
ALLOWED_PRODUCTION_HOSTS = {"seemygame.vercel.app", "seemygame.com", "www.seemygame.com", "seemygame.pages.dev"}
SESSION_TIMEOUT_SECONDS = 30
MAX_MESSAGE_BYTES = 64 * 1024

def agent_capabilities():
    return {
        "keyboard": HAVE_PYAUTOGUI,
        "mouse": HAVE_PYAUTOGUI,
        "gamepad": HAVE_VGAMEPAD,
        "mouseCoordinateSpace": "target-rect-or-primary-screen"
    }

def normalize_target_rect(value):
    if not isinstance(value, dict):
        return None
    try:
        left = int(round(float(value.get("left", 0))))
        top = int(round(float(value.get("top", 0))))
        width = int(round(float(value.get("width", 0))))
        height = int(round(float(value.get("height", 0))))
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0 or width > 32768 or height > 32768:
        return None
    return {"left": left, "top": top, "width": width, "height": height}

def is_valid_origin(origin_header):
    """Valida a origem da requisição WebSocket (A05)."""
    if not origin_header:
        return False

    try:
        parsed = urllib.parse.urlparse(origin_header)
        hostname = (parsed.hostname or "").lower()
        scheme = (parsed.scheme or "").lower()
        if scheme in {"http", "https"} and hostname in ALLOWED_LOCAL_HOSTS:
            return True
        if origin_header.rstrip("/") == "tauri://localhost":
            return True
        if scheme == "https" and hostname in ALLOWED_PRODUCTION_HOSTS:
            return True
    except Exception:
        pass
    return False

# Token de autenticação obrigatório (A05)
auth_token = None

async def handle_client(websocket):
    global active_client
    # 1. Validação de Origem (A05)
    headers = getattr(websocket, "request_headers", None)
    if headers is None:
        headers = getattr(getattr(websocket, "request", None), "headers", None)

    origin = headers.get("Origin") or headers.get("origin") if headers else None
    if not is_valid_origin(origin):
        print(f"[Co-op Agent] Conexão rejeitada: Origem não permitida ({origin})")
        await websocket.close(4003, "Origin not allowed")
        return

    print(f"[Co-op Agent] Navegador conectado de {origin or 'local'}! Player 2 pronto para controlar.")
    screen_w, screen_h = pyautogui.size() if HAVE_PYAUTOGUI else (1920, 1080)
    target_rect = None

    authenticated = False

    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=SESSION_TIMEOUT_SECONDS)
                if isinstance(message, bytes):
                    if len(message) > MAX_MESSAGE_BYTES:
                        await websocket.close(4005, "Message too large")
                        return
                    message = message.decode("utf-8")
                elif not isinstance(message, str) or len(message.encode("utf-8")) > MAX_MESSAGE_BYTES:
                    await websocket.close(4005, "Message too large")
                    return
                data = json.loads(message)
                if not isinstance(data, dict):
                    continue
                msg_type = data.get("type")

                # Handshake de autenticação se token estiver ativado
                if not authenticated:
                    if msg_type == "AUTH" and auth_token and data.get("token") == auth_token:
                        if active_client is not None and active_client is not websocket:
                            await websocket.close(4009, "Another paired client is active")
                            return
                        active_client = websocket
                        authenticated = True
                        print("[Co-op Agent] Cliente autenticado com token de pareamento!")
                        await websocket.send(json.dumps({"type": "AUTH_OK", **agent_capabilities()}))
                        continue
                    else:
                        print("[Co-op Agent] Falha de autenticação de token.")
                        await websocket.send(json.dumps({"type": "AUTH_FAILED", "error": "Token inválido"}))
                        await websocket.close(4001, "Authentication failed")
                        return

                # Pânico / Reset de emergência (A06)
                if msg_type in ("INPUT_RESET", "COOP_REVOKE"):
                    slot = data.get("slot")
                    if slot is not None:
                        if not release_slot(slot):
                            await websocket.close(4002, "Input release failed")
                            return
                        continue
                    else:
                        if not release_all():
                            await websocket.close(4002, "Input release failed")
                            return
                        continue

                if msg_type == "EMERGENCY_STOP":
                    if not release_all():
                        await websocket.close(4002, "Input release failed")
                        return
                    continue

                if msg_type == "COOP_TARGET":
                    target_rect = normalize_target_rect(data.get("targetRect"))
                    continue

                # 1. Teclado
                if msg_type == "INPUT_KEY" and HAVE_PYAUTOGUI:
                    code = data.get("code")
                    action = data.get("action")
                    raw_key = data.get("key", "")
                    key = KEY_MAP.get(code)
                    if not key and isinstance(raw_key, str) and len(raw_key) <= 32:
                        candidate = raw_key.lower()
                        allowed_keys = set(KEY_MAP.values()) | {str(n) for n in range(10)}
                        if candidate in allowed_keys:
                            key = candidate

                    try:
                        slot = int(data.get("slot", 1))
                    except (TypeError, ValueError):
                        slot = 1
                    if slot not in slot_pressed_keys:
                        slot_pressed_keys[slot] = set()

                    if key and action in {"down", "up"}:
                        try:
                            if action == "down":
                                slot_pressed_keys[slot].add(key)
                                pressed_keys.add(key)
                                pyautogui.keyDown(key)
                            elif action == "up":
                                slot_pressed_keys[slot].discard(key)
                                if not any(key in s_keys for s_keys in slot_pressed_keys.values()):
                                    pyautogui.keyUp(key)
                                    pressed_keys.discard(key)
                        except PyAutoGUIFailSafe:
                            raise
                        except Exception:
                            pass

                # 2. Mouse
                elif msg_type == "INPUT_MOUSE" and HAVE_PYAUTOGUI:
                    try:
                        slot = int(data.get("slot", 1))
                    except (TypeError, ValueError):
                        continue
                    if slot not in range(4):
                        continue
                    action = data.get("action")
                    if action == "move":
                        try:
                            norm_x = min(1.0, max(0.0, float(data.get("x", 0))))
                            norm_y = min(1.0, max(0.0, float(data.get("y", 0))))
                        except (TypeError, ValueError):
                            continue
                        incoming_rect = normalize_target_rect(data.get("targetRect"))
                        rect = incoming_rect or target_rect
                        if rect:
                            target_x = rect["left"] + int(norm_x * max(1, rect["width"] - 1))
                            target_y = rect["top"] + int(norm_y * max(1, rect["height"] - 1))
                        else:
                            target_x = int(norm_x * max(1, screen_w - 1))
                            target_y = int(norm_y * max(1, screen_h - 1))
                        pyautogui.moveTo(target_x, target_y)
                    elif action in {"down", "up"} and data.get("button") in {0, 1, 2}:
                        btn = {0: "left", 1: "middle", 2: "right"}[data.get("button")]
                        if action == "up":
                            slot_pressed_mouse_buttons.setdefault(slot, set()).discard(btn)
                            if any(btn in held for held in slot_pressed_mouse_buttons.values()):
                                continue
                            try:
                                pyautogui.mouseUp(button=btn)
                            except PyAutoGUIFailSafe:
                                raise
                            except Exception:
                                continue
                            pressed_mouse_buttons.discard(btn)
                            continue
                        pressed_mouse_buttons.add(btn)
                        slot_pressed_mouse_buttons.setdefault(slot, set()).add(btn)
                        try:
                            pyautogui.mouseDown(button=btn)
                        except PyAutoGUIFailSafe:
                            raise
                        except Exception:
                            pass

                # 3. Gamepad Virtual (Xbox 360 XInput via ViGEmBus)
                elif msg_type == "INPUT_GAMEPAD" and HAVE_VGAMEPAD:
                    slot = int(data.get("slot", 1))
                    gp = get_or_create_gamepad(slot)
                    if gp:
                        state = data.get("state") if isinstance(data.get("state"), dict) else data
                        buttons = state.get("buttons") or []
                        triggers = state.get("triggers") or []
                        axes = state.get("axes") or []

                        # Botões
                        for idx, btn_name in W3C_TO_XUSB.items():
                            attr = getattr(vg.XUSB_BUTTON, btn_name, None)
                            if attr is not None:
                                is_pressed = bool(buttons[idx]) if idx < len(buttons) else False
                                if is_pressed:
                                    gp.press_button(button=attr)
                                else:
                                    gp.release_button(button=attr)

                        # Gatilhos analógicos (0.0 a 1.0)
                        if len(triggers) >= 2:
                            gp.left_trigger_float(value_float=float(max(0.0, min(1.0, triggers[0]))))
                            gp.right_trigger_float(value_float=float(max(0.0, min(1.0, triggers[1]))))
                        else:
                            lt = 1.0 if (len(buttons) > 6 and buttons[6]) else 0.0
                            rt = 1.0 if (len(buttons) > 7 and buttons[7]) else 0.0
                            gp.left_trigger_float(value_float=lt)
                            gp.right_trigger_float(value_float=rt)

                        # Analógicos: -1.0 a 1.0 com inversão de eixo Y (DirectX / XInput)
                        lx = float(axes[0]) if len(axes) > 0 else 0.0
                        ly = float(axes[1]) if len(axes) > 1 else 0.0
                        rx = float(axes[2]) if len(axes) > 2 else 0.0
                        ry = float(axes[3]) if len(axes) > 3 else 0.0

                        gp.left_joystick_float(x_value_float=max(-1.0, min(1.0, lx)), y_value_float=max(-1.0, min(1.0, -ly)))
                        gp.right_joystick_float(x_value_float=max(-1.0, min(1.0, rx)), y_value_float=max(-1.0, min(1.0, -ry)))

                        gp.update()

            except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
                raise
            except PyAutoGUIFailSafe:
                print("[Co-op Agent] FAILSAFE ACIONADO! Mouse levado ao canto da tela. Liberando todos os inputs.")
                # A failsafe event revokes the session unconditionally. The
                # cleanup path temporarily bypasses only the corner guard so
                # keyUp/mouseUp can actually reach the OS.
                release_all()
                await websocket.close(4002, "Failsafe emergency stop")
                return
            except Exception:
                pass

            # A sessão ociosa expira no próximo ciclo de leitura; o timeout de
            # wait_for garante que nenhuma tecla permaneça pressionada.
    except asyncio.TimeoutError:
        print("[Co-op Agent] Sessão ociosa expirada; liberando todos os inputs.")
        if authenticated and active_client is websocket:
            release_all()
        await websocket.close(4004, "Session timeout")

    except websockets.exceptions.ConnectionClosed:
        print("[Co-op Agent] Navegador desconectado.")
    finally:
        # A06: Garante que nenhuma tecla ou clique fique travado na desconexão
        if authenticated and active_client is websocket:
            release_all()
            active_client = None

async def main(host, port, token):
    global auth_token
    if not token:
        print("ERRO: --token é obrigatório. Gere um token exclusivo para esta sessão.")
        return
    auth_token = token

    print("=" * 60)
    print("🎮 SeeMyGame - Co-op Companion Agent (Player 2 para PC)")
    print("=" * 60)
    print(f"Iniciando escuta local em ws://{host}:{port}")
    if auth_token:
        print(f"🔒 Token de pareamento obrigatório: {auth_token}")
    print("Failsafe: ATIVADO (arraste o mouse para qualquer canto da tela para cancelar)")
    print("Pressione Ctrl + C no terminal para encerrar.")
    print("=" * 60)

    async with websockets.serve(handle_client, host, port):
        await asyncio.Future()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SeeMyGame Co-op Companion Agent")
    parser.add_argument("--host", default="127.0.0.1", help="Host de escuta (padrão: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9876, help="Porta WebSocket (padrão: 9876)")
    parser.add_argument("--token", default=None, help="Token de pareamento obrigatório para conexões")
    args = parser.parse_args()

    try:
        asyncio.run(main(args.host, args.port, args.token))
    except KeyboardInterrupt:
        release_all()
        print("\nAgente Co-op encerrado.")
