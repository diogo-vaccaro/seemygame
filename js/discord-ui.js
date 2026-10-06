import { chatManager } from './chat.js';
import { voiceManager } from './voice.js';
import { SOUNDBOARD_PRESETS, soundboardManager } from './soundboard.js';
import { EMOJI_REACTION_PRESETS } from './discord-ui/shared.js';
export * from './discord-ui/shared.js';
import { withDiscordUIControllerDrawer } from './discord-ui/drawer.js';
import { withDiscordUIControllerSoundboard } from './discord-ui/soundboard.js';
import { withDiscordUIControllerChat } from './discord-ui/chat.js';
import { withDiscordUIControllerVoice } from './discord-ui/voice.js';
import { withDiscordUIControllerStage } from './discord-ui/stage.js';
import { bindRoomChannels, renderRoomChannels } from './discord-ui/channels.js';
export class DiscordUIController extends withDiscordUIControllerStage(withDiscordUIControllerVoice(withDiscordUIControllerChat(withDiscordUIControllerSoundboard(withDiscordUIControllerDrawer(class {}))))) {
constructor(options = {}) {
    super();
    const {
      chatManager: customChat,
      voiceManager: customVoice,
      soundboardManager: customSoundboard,
      roomManager: customRoom,
      onSendMessage,
      onJoinVoice,
      onLeaveVoice,
      onCreateVoiceChannel,
      onPlaySound,
      onPlayCustomSound,
      onSendReaction,
      onToggleMic,
      onToggleDeaf,
      onToggleStream,
      onOpenTuning,
      onOpenWhiteboard,
      onLeaveRoom,
    } = options;

    this.chatManager = customChat || chatManager;
    this.voiceManager = customVoice || voiceManager;
    this.soundboardManager = customSoundboard || soundboardManager;
    this.roomManager = customRoom || null;

    this.onSendMessage = onSendMessage || ((text) => {
      if (this.chatManager) {
        const message = this.chatManager.createMessage({
          senderId: this.roomManager?.myPeerId || 'anon',
          senderName: this.roomManager?.userName || 'Amigo',
          role: this.roomManager?.isMaster ? 'host' : 'viewer',
          text,
          channel: this.chatManager.getActiveChannel()
        });
        const storedMessage = message && this.chatManager.addMessage(message);
        if (storedMessage && this.roomManager) {
          this.roomManager.broadcast({ type: 'CHAT_MESSAGE', message: storedMessage });
        }
      }
    });
    this.onJoinVoice = onJoinVoice || (() => {
      if (this.voiceManager) this.voiceManager.joinVoice();
    });
    this.onLeaveVoice = onLeaveVoice || (() => {
      if (this.voiceManager) this.voiceManager.leaveVoice();
    });
    this.onCreateVoiceChannel = onCreateVoiceChannel || (() => false);
    this.onPlaySound = onPlaySound || (() => {});
    this.onPlayCustomSound = onPlayCustomSound || ((sound) => {
      this.onPlaySound(sound.id);
    });
    this.onSendReaction = onSendReaction || (() => {});
    this.onToggleMic = onToggleMic || (() => {});
    this.onToggleDeaf = onToggleDeaf || (() => {});
    this.onToggleStream = onToggleStream || (() => {});
    this.onOpenTuning = onOpenTuning || (() => {});
    this.onOpenWhiteboard = onOpenWhiteboard || (() => {});
    this.onLeaveRoom = onLeaveRoom || (() => {});
    this.activeTab = 'chat'; // 'chat' | 'voice' | 'emojis' | 'soundboard'
    this.isDrawerOpen = false;

    this.elements = {};
    this._cleanupFns = [];
    this._destroyed = false;
  }

init() {
    if (typeof document === 'undefined') return;

    this.elements = {
      drawer: document.getElementById('discord-drawer'),
      toggleChatBtn: document.getElementById('toggle-chat-btn'),
      toggleVoiceBtn: document.getElementById('toggle-voice-btn'),
      toggleEmojisBtn: document.getElementById('toggle-emojis-btn'),
      toggleSoundBtn: document.getElementById('toggle-soundboard-btn'),
      railChatBtn: document.getElementById('rail-btn-chat'),
      railVoiceBtn: document.getElementById('rail-btn-voice'),
      railEmojisBtn: document.getElementById('rail-btn-emojis'),
      railSoundboardBtn: document.getElementById('rail-btn-soundboard'),
      chatBadge: document.getElementById('chat-unread-badge'),
      voiceBadge: document.getElementById('voice-badge'),
      railChatBadge: document.getElementById('rail-chat-badge'),
      railVoiceBadge: document.getElementById('rail-voice-badge'),
      closeBtn: document.getElementById('drawer-close-btn'),
      tabVoice: document.getElementById('tab-btn-voice'),
      tabChat: document.getElementById('tab-btn-chat'),
      tabEmojis: document.getElementById('tab-btn-emojis'),
      tabSoundboard: document.getElementById('tab-btn-soundboard'),
      panelVoice: document.getElementById('drawer-panel-voice'),
      panelChat: document.getElementById('drawer-panel-chat'),
      panelEmojis: document.getElementById('drawer-panel-emojis'),
      panelSoundboard: document.getElementById('drawer-panel-soundboard'),
      emojisGrid: document.getElementById('emojis-grid'),
      soundboardGrid: document.getElementById('soundboard-grid'),
      chatMessages: document.getElementById('chat-messages-container'),
      chatInput: document.getElementById('chat-input'),
      chatSendBtn: document.getElementById('chat-send-btn'),
      chatEmojiTriggerBtn: document.getElementById('chat-emoji-trigger-btn'),
      voiceParticipants: document.getElementById('voice-participants-list'),
      voiceMuteBtn: document.getElementById('voice-mute-btn'),
      voiceDeafBtn: document.getElementById('voice-deaf-btn'),
      voiceModeBtn: document.getElementById('voice-mode-btn'),
      voiceConnectBtn: document.getElementById('voice-connect-btn'),
      voiceStatusBar: document.getElementById('voice-status-bar'),
      voiceSelfMicSlider: document.getElementById('voice-self-mic-slider'),
      voiceSelfMicVal: document.getElementById('voice-self-mic-val'),
      voiceSelfOutputSlider: document.getElementById('voice-self-output-slider'),
      voiceSelfOutputVal: document.getElementById('voice-self-output-val'),
      voiceSelfResetBtn: document.getElementById('voice-self-reset-btn'),

      // Elementos do Layout da Sala (Room-First)
      roomParticipantsList: document.getElementById('room-participants-list'),
      voiceStageGrid: document.getElementById('voice-stage-grid'),
      videoGrid: document.getElementById('video-grid'),
      sidebarMembersCount: document.getElementById('sidebar-members-count'),
      sidebarRoomName: document.getElementById('sidebar-room-name'),
      localUserName: document.getElementById('local-user-name'),
      localAvatar: document.getElementById('local-avatar'),
      dockMicBtn: document.getElementById('dock-mic-btn'),
      dockDeafBtn: document.getElementById('dock-deaf-btn'),
      dockStreamBtn: document.getElementById('dock-stream-btn'),
      dockTuningBtn: document.getElementById('dock-tuning-btn'),
      dockWhiteboardBtn: document.getElementById('dock-whiteboard-btn'),
      dockLeaveBtn: document.getElementById('dock-leave-btn'),
      quickMicBtn: document.getElementById('quick-mic-btn'),
      quickDeafBtn: document.getElementById('quick-deaf-btn'),
      quickTuningBtn: document.getElementById('quick-tuning-btn'),
      sidebarVoiceStatus: document.getElementById('sidebar-voice-status'),
      sidebarVoiceDot: document.getElementById('sidebar-voice-dot'),
      sidebarVoiceStatusContainer: document.getElementById('sidebar-voice-status-container'),
      bottomControlDock: document.getElementById('bottom-control-dock'),
      reactionsDock: document.getElementById('reactions-dock'),
      roomStage: document.getElementById('room-stage'),
      roomChannels: document.getElementById('room-channels-list'),
    };

    this.bindEvents();
    this.bindChatEvents();
    this.bindVoiceEvents();
    this.updateVoiceControls(this.voiceManager.getLocalVoiceState());
    this.renderVoiceParticipants(this.voiceManager.getParticipantsList());
    this.bindRoomDockEvents();
    bindRoomChannels(this);
    this.initSoundboard();
    this.initEmojis();
    this.initStageDockAutoHide();
    this._destroyed = false;
    const unsubscribeSoundboard = this.soundboardManager.onChange(() => {
      this.initSoundboard();
    });
    this._cleanupFns.push(unsubscribeSoundboard);
  }

renderRoomChannels() { renderRoomChannels(this); }

listen(target, event, listener, options) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    target.addEventListener(event, listener, options);
    const remove = () => {
      try { target.removeEventListener(event, listener, options); } catch (e) {}
    };
    this._cleanupFns.push(remove);
    return remove;
  }

observe(manager, event, listener) {
    if (!manager || typeof manager.on !== 'function') return;
    manager.on(event, listener);
    this._cleanupFns.push(() => manager.off?.(event, listener));
  }

dispose() {
    this.destroy();
  }

destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const fn of this._cleanupFns.splice(0).reverse()) {
      try { fn(); } catch (e) {}
    }
    if (this.elements.drawer) {
      this.elements.drawer.classList.remove('open');
    }
    this.isDrawerOpen = false;
  }
}
