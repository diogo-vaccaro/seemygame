/** Room navigation. Voice entry is explicit; the lobby keeps its text chat open. */
import { createParticipantVolumePopover } from '../ui/participant-controls.js';
export function bindRoomChannels(ui) {
  if (!ui.elements.roomChannels) return;
  ui.listen(ui.elements.roomChannels, 'click', event => {
    const button = event.target.closest('button[data-voice-channel]');
    if (!button) return;
    if (button.dataset.voiceChannel === 'lobby') ui.onLeaveVoice();
    else ui.onJoinVoice(button.dataset.voiceChannel);
  });
  ui.listen(document.getElementById('create-voice-channel-btn'), 'click', () => {
    const form = document.getElementById('create-voice-channel-form');
    form.hidden = !form.hidden;
    document.getElementById('create-voice-channel-btn').setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) document.getElementById('voice-channel-name').focus();
  });
  ui.listen(document.getElementById('create-voice-channel-form'), 'submit', event => {
    event.preventDefault();
    const input = document.getElementById('voice-channel-name');
    if (ui.onCreateVoiceChannel(input.value)) {
      input.value = ''; event.currentTarget.hidden = true;
      document.getElementById('create-voice-channel-btn').setAttribute('aria-expanded', 'false');
    }
  });
  ui.listen(document.getElementById('room-chat-toggle'), 'click', () => {
    const panel = document.getElementById('room-chat');
    panel.classList.toggle('is-collapsed');
    document.getElementById('room-chat-toggle').setAttribute('aria-expanded', String(!panel.classList.contains('is-collapsed')));
    ui.chatManager.setChatOpen(!panel.classList.contains('is-collapsed'));
    if (!panel.classList.contains('is-collapsed')) ui.chatManager.markChannelAsRead();
  });
  let compact;
  const syncChatLayout = () => {
    const nextCompact = window.innerWidth <= 1000;
    if (nextCompact === compact) return;
    compact = nextCompact;
    document.getElementById('room-chat')?.classList.toggle('is-collapsed', compact);
    document.getElementById('room-chat-toggle')?.setAttribute('aria-expanded', String(!compact));
    ui.chatManager.setChatOpen(!compact);
  };
  ui.listen(window, 'resize', syncChatLayout); syncChatLayout();
  ui.renderRoomChannels();
}

export function renderRoomChannels(ui) {
  const list = ui.elements.roomChannels, rm = ui.roomManager;
  if (!list || !rm) return;
  const focusedChannel = list.contains(document.activeElement) ? document.activeElement.dataset.voiceChannel : null;
  list.querySelectorAll('.participant-volume-wrapper').forEach(wrapper => wrapper.cleanup?.());
  list.replaceChildren();
  const add = (id, name, members) => {
    const item = document.createElement('div'); item.className = 'room-channel';
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'room-channel-button'; button.dataset.voiceChannel = id;
    const active = id === 'lobby' ? !rm.voiceChannelId : rm.voiceChannelId === id;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    const icon = document.createElement('span'); icon.textContent = id === 'lobby' ? '#' : '◖))'; icon.className = 'room-channel-icon'; icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = name;
    const count = document.createElement('span'); count.className = 'room-channel-count'; count.textContent = String(members.length);
    button.append(icon, label, count); item.append(button);
    if (id !== 'lobby') {
      const people = document.createElement('div'); people.className = 'room-channel-people';
      for (const member of members) {
        const person = document.createElement('div'); person.className = 'room-channel-person';
        const name = document.createElement('span'); name.textContent = member.name || 'Amigo'; person.append(name);
        if (ui.voiceManager && member.peerId && member.peerId !== rm.myPeerId && rm.voiceChannelId === id) {
          const control = createParticipantVolumePopover({ peerId: member.peerId, name: member.name, voiceManager: ui.voiceManager });
          if (control) person.append(control);
        }
        person.classList.toggle('speaking', Boolean(member.isSpeaking)); people.append(person);
      }
      if (!members.length) { const empty = document.createElement('small'); empty.textContent = 'Entrar para ouvir e falar'; people.append(empty); }
      item.append(people);
    }
    list.append(item);
  };
  const members = rm.getMembersList();
  add('lobby', 'Lobby', members.filter(m => !m.voiceChannelId));
  for (const c of rm.voiceChannels.values()) add(c.id, c.name, members.filter(m => m.voiceChannelId === c.id));
  if (focusedChannel) [...list.querySelectorAll('button')].find(b => b.dataset.voiceChannel === focusedChannel)?.focus({ preventScroll: true });
  const status = ui.elements.sidebarVoiceStatus;
  if (status) status.textContent = rm.voiceChannelId ? rm.voiceChannels.get(rm.voiceChannelId)?.name || 'Voz conectada' : 'No lobby · voz desconectada';
  const disconnect = document.getElementById('voice-connect-btn');
  if (disconnect) { disconnect.hidden = !rm.voiceChannelId; disconnect.style.display = rm.voiceChannelId ? 'inline-flex' : 'none'; disconnect.textContent = 'Desconectar da voz'; }
  const sounds = document.getElementById('toggle-soundboard-btn');
  if (sounds) { sounds.disabled = !rm.voiceChannelId; sounds.title = rm.voiceChannelId ? 'Sons compartilhados nesta sala de voz' : 'Entre em uma sala de voz para compartilhar sons'; }
  for (const id of ['quick-mic-btn', 'quick-deaf-btn']) { const b = document.getElementById(id); if (b) { b.disabled = !rm.voiceChannelId; b.title = !rm.voiceChannelId ? 'Entre em uma sala de voz para usar este controle' : id === 'quick-mic-btn' ? 'Mutar/desmutar microfone' : 'Silenciar/ativar áudio da conversa'; } }
}
