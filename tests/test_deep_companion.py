"""Companion regressions for B13-B15 with synthetic drivers; never injects OS input."""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('companion_helpers', Path(__file__).resolve().parents[1] / 'tests' / 'test_pending_companion.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

class Pad:
    def __init__(self): self.resets = 0; self.updates = 0
    def reset(self): self.resets += 1
    def update(self): self.updates += 1

class DeepCompanionAudit(unittest.TestCase):
    def setUp(self):
        fixture = helpers.CompanionRegression()
        fixture.setUp()
        self.agent, self.driver = fixture.agent, fixture.driver

    def test_B13_invalid_token_connection_preserves_the_live_authenticated_owner(self):
        async def scenario():
            class LiveSocket(helpers.Socket):
                async def recv(socket):
                    if socket.reads < 2: return await super(LiveSocket, socket).recv()
                    socket.reads += 1
                    await asyncio.Future()
            live = LiveSocket([{'type': 'AUTH', 'token': self.agent.auth_token}, {'type': 'INPUT_KEY', 'code': 'KeyW', 'action': 'down'}])
            task = asyncio.create_task(self.agent.handle_client(live))
            try:
                for _ in range(20):
                    await asyncio.sleep(0)
                    if 'w' in self.driver.keys: break
                self.assertIn('w', self.driver.keys)
                bad = helpers.Socket([{'type': 'AUTH', 'token': 'wrong'}])
                await self.agent.handle_client(bad)
                self.assertEqual(bad.closed[0][0], 4001)
                self.assertFalse(task.done())
                self.assertEqual(self.driver.keys, {'w'})
                duplicate = helpers.Socket([{'type': 'AUTH', 'token': self.agent.auth_token}])
                await self.agent.handle_client(duplicate)
                self.assertEqual(duplicate.closed[0][0], 4009)
                self.assertEqual(self.driver.keys, {'w'})
            finally:
                task.cancel()
                try: await task
                except asyncio.CancelledError: pass
        asyncio.run(scenario())

    def test_B14_gamepad_only_installation_resets_gamepads_on_global_release(self):
        pad = Pad()
        self.agent.HAVE_PYAUTOGUI = False
        self.agent.HAVE_VGAMEPAD = True
        self.agent.virtual_gamepads[1] = pad
        self.assertTrue(self.agent.release_all())
        self.assertEqual(pad.resets, 1)
        self.assertEqual(pad.updates, 1)

    def test_B15_scoped_mouse_reset_releases_a_held_mouse_button(self):
        self.driver.buttons.add('left')
        self.agent.pressed_mouse_buttons.add('left')
        self.assertTrue(self.agent.release_slot(1))
        self.assertNotIn('left', self.driver.buttons)

    def test_B15_shared_mouse_button_remains_down_until_its_last_slot_releases(self):
        self.driver.buttons.add('left')
        self.agent.pressed_mouse_buttons.add('left')
        self.agent.slot_pressed_mouse_buttons.update({1: {'left'}, 2: {'left'}})
        self.assertTrue(self.agent.release_slot(1))
        self.assertIn('left', self.driver.buttons)
        self.assertTrue(self.agent.release_slot(2))
        self.assertNotIn('left', self.driver.buttons)

    def test_B14_gamepad_reset_failure_is_not_reported_as_success(self):
        class FailedPad(Pad):
            def reset(self): raise RuntimeError('synthetic unavailable driver')
        self.agent.HAVE_PYAUTOGUI = False
        self.agent.HAVE_VGAMEPAD = True
        self.agent.virtual_gamepads[1] = FailedPad()
        self.assertFalse(self.agent.release_all())

if __name__ == '__main__': unittest.main(verbosity=2)
