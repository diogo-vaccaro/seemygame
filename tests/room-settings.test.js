import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionContext } from '../js/core/session-context.js';
import { bindRoomSettings } from '../js/session/room-settings.js';
let session, room, apply, toast;
const el = id => document.getElementById(id);
beforeEach(() => {
  document.body.innerHTML = readFileSync('room.html', 'utf8');
  session = createSessionContext();
  room = { isInRoom: true, isMaster: true, roomId: 'controls', roomPin: '1234', roomKey: '0123456789abcdef' };
  apply = vi.fn(); toast = vi.fn();
  bindRoomSettings(session, { getRoomManager: () => room, applySettings: apply, showToast: toast });
});
afterEach(() => { session?.dispose(); document.body.innerHTML = ''; });
it('opens and cancels the actual Room modal, validates and applies the coordinator settings', () => {
  el('edit-id-btn').click(); expect(el('custom-id-modal').style.display).toBe('flex');
  expect(el('custom-id-input').value).toBe('controls'); expect(el('room-pin-input').value).toBe('1234');
  el('custom-id-cancel-btn').click(); expect(el('custom-id-modal').style.display).toBe('none');
  el('edit-id-btn').click(); el('room-pin-input').value = 'abc'; el('custom-id-save-btn').click();
  expect(apply).not.toHaveBeenCalled(); expect(el('custom-id-error').style.display).toBe('block');
  el('room-pin-input').value = '9876'; el('custom-id-input').value = 'New-room'; el('custom-id-save-btn').click();
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'new-room', roomPin: '9876', url: expect.stringContaining('#room=new-room&key=0123456789abcdef&pin=9876') }));
  expect(el('custom-id-modal').style.display).toBe('none');
});
it('removes the PIN on reset and releases all controls on disposal', () => {
  el('edit-id-btn').click(); el('custom-id-reset-btn').click(); el('custom-id-save-btn').click();
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'controls', roomPin: null }));
  session.dispose(); el('edit-id-btn').click(); expect(el('custom-id-modal').style.display).toBe('none');
});
it('allows a member to see the policy but prevents edits even if controls are re-enabled', () => {
  room.isMaster = false;
  el('edit-id-btn').click(); expect(el('custom-id-modal').style.display).toBe('flex');
  expect(el('custom-id-save-btn').disabled).toBe(true); expect(el('room-pin-input').value).toBe('');
  el('custom-id-save-btn').disabled = false; el('custom-id-save-btn').click(); expect(apply).not.toHaveBeenCalled();
  el('custom-id-cancel-btn').click(); expect(el('custom-id-modal').style.display).toBe('none');
});
