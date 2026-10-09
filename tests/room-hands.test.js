import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedToolsService } from '../js/room/tools/shared-tools-service.js';
import { HandsManager } from '../js/room/tools/hands.js';

describe('HandsManager - Fila de Fala e Levantar Mão', () => {
  let hostService;
  let hands;

  beforeEach(() => {
    hostService = new SharedToolsService({
      isHost: () => true,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      getCoordinatorPeerId: () => 'host-peer',
      roomEpoch: 'epoch-1'
    });

    hands = new HandsManager({
      service: hostService,
      getLocalPeerId: () => 'host-peer',
      getDisplayName: () => 'Host',
      getCoordinatorPeerId: () => 'host-peer',
      isHost: () => true,
      getIsReadonly: () => false
    });
  });

  afterEach(() => {
    hands.dispose();
    hostService.dispose();
  });

  it('permite que participante peça a palavra e adiciona à fila com sequência do host', async () => {
    const res1 = await hands._applyProposalOnHost(
      { action: 'request_hand', displayName: 'Jogador 1' },
      { authorPeerId: 'player-1' }
    );
    expect(res1.success).toBe(true);
    expect(hands.getQueue()).toHaveLength(1);
    expect(hands.getQueue()[0].sequence).toBe(1);

    const res2 = await hands._applyProposalOnHost(
      { action: 'request_hand', displayName: 'Jogador 2' },
      { authorPeerId: 'player-2' }
    );
    expect(res2.success).toBe(true);
    expect(hands.getQueue()).toHaveLength(2);
    expect(hands.getQueue()[1].sequence).toBe(2);
  });

  it('ignora pedidos duplicados do mesmo participante (uma entrada por pessoa)', async () => {
    await hands._applyProposalOnHost(
      { action: 'request_hand', displayName: 'Jogador 1' },
      { authorPeerId: 'player-1' }
    );
    await hands._applyProposalOnHost(
      { action: 'request_hand', displayName: 'Jogador 1' },
      { authorPeerId: 'player-1' }
    );
    expect(hands.getQueue()).toHaveLength(1);
  });

  it('permite cancelar o próprio pedido de fala', async () => {
    await hands._applyProposalOnHost(
      { action: 'request_hand', displayName: 'Jogador 1' },
      { authorPeerId: 'player-1' }
    );
    expect(hands.getQueue()).toHaveLength(1);

    await hands._applyProposalOnHost(
      { action: 'cancel_hand' },
      { authorPeerId: 'player-1' }
    );
    expect(hands.getQueue()).toHaveLength(0);
  });

  it('coordenador concede a palavra e define o orador atual', async () => {
    await hands._applyProposalOnHost(
      { action: 'request_hand', displayName: 'Jogador 1' },
      { authorPeerId: 'player-1' }
    );

    const grant = await hands._applyProposalOnHost(
      { action: 'grant_speaker', peerId: 'player-1', displayName: 'Jogador 1' },
      { authorPeerId: 'host-peer' }
    );
    expect(grant.success).toBe(true);
    expect(hands.currentSpeakerPeerId).toBe('player-1');
    expect(hands.getQueue()).toHaveLength(0); // Sai da fila ao ganhar a palavra
  });

  it('impede que participante comum conceda a vez a si mesmo', async () => {
    const grant = await hands._applyProposalOnHost(
      { action: 'grant_speaker', peerId: 'player-1' },
      { authorPeerId: 'player-1' } // Não é host nem coordenador
    );
    expect(grant.success).toBe(false);
    expect(grant.reason).toBe('unauthorized_only_host');
    expect(hands.currentSpeakerPeerId).toBeNull();
  });

  it('avalia audibilidade correta no modo de áudio moderado', () => {
    hands.policy = 'open';
    // No modo aberto, todos são audíveis
    expect(hands.isPeerAudible('player-1')).toBe(true);
    expect(hands.isPeerAudible('player-2')).toBe(true);

    // No modo moderado
    hands.policy = 'moderated';
    hands.currentSpeakerPeerId = 'player-1';

    // Host e Orador atual são audíveis
    expect(hands.isPeerAudible('host-peer')).toBe(true);
    expect(hands.isPeerAudible('player-1')).toBe(true);
    // Outro participante sem a palavra fica silenciado na reprodução
    expect(hands.isPeerAudible('player-2')).toBe(false);
  });

  it('limpa participante da fila e revoga fala caso desconecte da sala', () => {
    hands.queue = [{ peerId: 'leaver-1', displayName: 'Leaver', sequence: 1 }];
    hands.currentSpeakerPeerId = 'leaver-1';

    hands.handlePeerDisconnected('leaver-1');
    expect(hands.queue).toHaveLength(0);
    expect(hands.currentSpeakerPeerId).toBeNull();
  });
});
