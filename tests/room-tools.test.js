import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomToolsController } from '../js/room/room-tools.js';
import { streamerMode } from '../js/room/streamer-mode.js';
import { pollManager } from '../js/room/poll-manager.js';
import { pipController } from '../js/room/pip-controller.js';
import { annotateManager } from '../js/room/annotate.js';

describe('RoomToolsController', () => {
  let controller;

  beforeEach(() => {
    document.body.innerHTML = `
      <header>
        <button id="streamer-mode-btn">Streamer</button>
      </header>
      <div id="bottom-control-dock">
        <button id="dock-room-tools-btn">Ferramentas</button>
        <button id="dock-whiteboard-btn">Lousa</button>
        <button id="toggle-soundboard-btn">Sons</button>
      </div>
      <div id="poll-modal" style="display: none;">
        <button class="poll-modal-close"></button>
        <form id="poll-create-form">
          <input id="poll-question-input" value="Test?" />
          <input id="poll-opt-1" value="A" />
          <input id="poll-opt-2" value="B" />
          <select id="poll-duration-select"><option value="30">30s</option></select>
          <button type="submit">Iniciar</button>
        </form>
        <div id="poll-create-section"></div>
        <div id="poll-active-section" style="display: none;"></div>
        <div id="poll-active-card-container"></div>
      </div>
      <div id="multitrack-modal" style="display: none;">
        <button class="multitrack-modal-close"></button>
        <button id="multitrack-start-btn">Iniciar</button>
        <button id="multitrack-stop-btn" style="display: none;">Parar</button>
        <span id="multitrack-timer"></span>
        <span id="multitrack-status-badge"></span>
      </div>
    `;

    controller = new RoomToolsController();
  });

  afterEach(() => {
    controller.dispose();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('binds session and dispatches remote events', () => {
    const registered = new Map();
    const session = {
      dispatcher: {
        register: vi.fn((type, handler) => {
          registered.set(type, handler);
          return vi.fn();
        })
      }
    };
    const broadcast = vi.fn();

    controller.bindSession({ session, broadcast });

    expect(session.dispatcher.register).toHaveBeenCalledWith('ANNOTATE_DRAW', expect.any(Function));
    expect(session.dispatcher.register).toHaveBeenCalledWith('POLL_CREATE', expect.any(Function));

    // Remote poll create
    const pollSpy = vi.spyOn(pollManager, 'handleRemoteMessage');
    registered.get('POLL_CREATE')({
      type: 'POLL_CREATE',
      poll: { id: 'p1', question: 'Q', options: [{ text: 'A' }, { text: 'B' }] }
    });
    expect(pollSpy).toHaveBeenCalled();
  });

  it('opens and closes tools menu from dock button', () => {
    controller.bindDOM();
    const btn = document.getElementById('dock-room-tools-btn');

    btn.click();
    expect(document.getElementById('room-tools-menu')).not.toBeNull();
    expect(controller.isMenuOpen).toBe(true);

    btn.click();
    expect(document.getElementById('room-tools-menu')).toBeNull();
    expect(controller.isMenuOpen).toBe(false);
  });

  it('triggers streamer mode when streamer action is clicked', () => {
    const toggleSpy = vi.spyOn(streamerMode, 'toggle');
    controller.bindDOM();

    controller.openMenu();
    const streamerItem = document.querySelector('[data-action="streamer"]');
    streamerItem.click();

    expect(toggleSpy).toHaveBeenCalled();
    expect(controller.isMenuOpen).toBe(false);
  });

  it('opens poll modal and handles creation form', () => {
    const createPollSpy = vi.spyOn(pollManager, 'createPoll');
    controller.bindSession({ getPeerId: () => 'alice', getDisplayName: () => 'Alice' });
    controller.bindDOM();

    controller.openMenu();
    const pollItem = document.querySelector('[data-action="poll"]');
    pollItem.click();

    const modal = document.getElementById('poll-modal');
    expect(modal.style.display).toBe('flex');

    const form = document.getElementById('poll-create-form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(createPollSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Test?',
        options: ['A', 'B'],
        creatorId: 'alice',
        creatorName: 'Alice'
      })
    );
  });
});
