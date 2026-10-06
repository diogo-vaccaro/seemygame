import { sendSessionMessage } from '../protocol/transport.js';

export const DEFAULT_VOICE_CHANNELS = Object.freeze([
  Object.freeze({ id: 'voice-1', name: 'Bate-papo 1' }),
  Object.freeze({ id: 'voice-2', name: 'Bate-papo 2' })
]);
export const MAX_VOICE_CHANNELS = 12;
const validName = name => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 32;

/** The coordinator owns the catalog; each member owns their voice presence. */
export const withRoomVoiceChannels = Base => class extends Base {
  setLocalVoiceChannel(channelId) {
    if (channelId !== null && !this.voiceChannels.has(channelId)) return false;
    this.voiceChannelId = channelId;
    this.setLocalVoiceState({ voiceChannelId: channelId, isSpeaking: false });
    return true;
  }
  createVoiceChannel(name) {
    if (!validName(name)) return this.channelError('Use um nome de 1 a 32 caracteres.');
    if (!this.isInRoom) return this.channelError('Aguarde a conexão com a sala.');
    if (!this.isMaster) {
      const conn = this.meshConnections.get(this.masterPeerId);
      if (!conn?.open || !this.isPeerAuthorized(this.masterPeerId)) return this.channelError('Aguarde a conexão com o anfitrião.');
      return sendSessionMessage({ getPeerId: () => this.myPeerId }, conn, { type: 'ROOM_VOICE_CHANNEL_CREATE', roomId: this.roomId, name: name.trim() });
    }
    if (this.voiceChannels.size >= MAX_VOICE_CHANNELS) return this.channelError(`A sala permite até ${MAX_VOICE_CHANNELS} canais de voz.`);
    if ([...this.voiceChannels.values()].some(c => c.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) return this.channelError('Já existe uma sala de voz com esse nome.');
    const id = `voice-${crypto.randomUUID()}`;
    this.voiceChannels.set(id, { id, name: name.trim() });
    this.voiceChannelsRevision++;
    this.broadcast({ type: 'ROOM_VOICE_CHANNELS', roomId: this.roomId, channels: [...this.voiceChannels.values()], revision: this.voiceChannelsRevision });
    this.emit('voiceChannelsUpdated', [...this.voiceChannels.values()]);
    return true;
  }
  channelError(message) { this.emit('voiceChannelError', { message }); return false; }
  applyVoiceChannels(channels, revision) {
    if (!Array.isArray(channels) || channels.length < 2 || channels.length > MAX_VOICE_CHANNELS || !Number.isSafeInteger(revision) || revision < this.voiceChannelsRevision) return false;
    const next = new Map();
    for (const c of channels) {
      if (!c || typeof c.id !== 'string' || !/^voice-[a-zA-Z0-9-]{1,60}$/.test(c.id) || !validName(c.name) || next.has(c.id)) return false;
      next.set(c.id, { id: c.id, name: c.name.trim() });
    }
    if (!DEFAULT_VOICE_CHANNELS.every(c => next.has(c.id))) return false;
    this.voiceChannels = next; this.voiceChannelsRevision = revision;
    this.emit('voiceChannelsUpdated', [...next.values()]);
    return true;
  }
  handleVoiceChannelMessage(peerId, message, conn) {
    if (!['ROOM_VOICE_CHANNEL_CREATE', 'ROOM_VOICE_CHANNELS', 'ROOM_VOICE_CHANNEL_ERROR'].includes(message.type)) return false;
    if (message.roomId !== this.roomId || !this.isPeerAuthorized(peerId)) return true;
    if (message.type === 'ROOM_VOICE_CHANNEL_CREATE') {
      if (!this.isMaster) return true;
      let reason = null;
      const onError = ({ message }) => { reason = message; };
      this.on('voiceChannelError', onError);
      const created = this.createVoiceChannel(message.name);
      this.off('voiceChannelError', onError);
      if (!created) sendSessionMessage({ getPeerId: () => this.myPeerId }, conn, { type: 'ROOM_VOICE_CHANNEL_ERROR', roomId: this.roomId, error: reason });
    } else if (peerId === this.masterPeerId && this.meshConnections.get(peerId) === conn) {
      if (message.type === 'ROOM_VOICE_CHANNELS') this.applyVoiceChannels(message.channels, message.revision);
      else if (typeof message.error === 'string' && message.error.length <= 160) this.channelError(message.error);
    }
    return true;
  }
};
