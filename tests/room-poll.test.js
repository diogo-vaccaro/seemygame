import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PollManager } from '../js/room/poll-manager.js';

describe('PollManager', () => {
  let pollMgr;

  beforeEach(() => {
    vi.useFakeTimers();
    pollMgr = new PollManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates poll and broadcasts POLL_CREATE', () => {
    const broadcast = vi.fn();
    pollMgr.setBroadcast(broadcast);

    const poll = pollMgr.createPoll({
      question: 'Qual jogo jogar agora?',
      options: ['CS2', 'Valorant', 'Rocket League'],
      durationSeconds: 30,
      creatorId: 'user1',
      creatorName: 'Diogo'
    });

    expect(poll.id).toBeDefined();
    expect(poll.options).toHaveLength(3);
    expect(pollMgr.currentPoll).toBe(poll);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'POLL_CREATE',
        poll: expect.objectContaining({
          question: 'Qual jogo jogar agora?'
        })
      })
    );
  });

  it('votes on options, updates percentages, and prevents double voting when allowMultiple is false', () => {
    const poll = pollMgr.createPoll({
      question: 'Escolha',
      options: ['A', 'B'],
      durationSeconds: 60
    });

    pollMgr.vote(poll.id, 0, 'user1');
    pollMgr.vote(poll.id, 1, 'user2');

    let results = pollMgr.getResults();
    expect(results.totalVotes).toBe(2);
    expect(results.options[0].percent).toBe(50);
    expect(results.options[1].percent).toBe(50);
    expect(results.isTie).toBe(true);

    // user1 switches vote to B
    pollMgr.vote(poll.id, 1, 'user1');
    results = pollMgr.getResults();
    expect(results.totalVotes).toBe(2);
    expect(results.options[0].count).toBe(0);
    expect(results.options[1].count).toBe(2);
    expect(results.winner.text).toBe('B');
  });

  it('announces results to chat when poll ends', () => {
    const chatAnnounce = vi.fn();
    pollMgr.setOnChatAnnounce(chatAnnounce);

    const poll = pollMgr.createPoll({
      question: 'Mapa favorito',
      options: ['Mirage', 'Inferno'],
      durationSeconds: 10
    });

    pollMgr.vote(poll.id, 0, 'user1');

    vi.advanceTimersByTime(10001);

    expect(poll.isActive).toBe(false);
    expect(chatAnnounce).toHaveBeenCalled();
    const [msg] = chatAnnounce.mock.calls[0];
    expect(msg).toContain('Mirage');
    expect(msg).toContain('Vencedor');
  });

  it('handles remote messages for CREATE, VOTE, and END', () => {
    pollMgr.handleRemoteMessage({
      type: 'POLL_CREATE',
      poll: {
        id: 'remote-poll-1',
        question: 'Pergunta Remota',
        options: [{ text: 'Sim', voterIds: [] }, { text: 'Não', voterIds: [] }],
        durationSeconds: 60,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
        creatorId: 'peerX',
        creatorName: 'Bob',
        allowMultiple: false,
        isActive: true
      }
    });

    expect(pollMgr.currentPoll).not.toBeNull();
    expect(pollMgr.currentPoll.question).toBe('Pergunta Remota');

    pollMgr.handleRemoteMessage({
      type: 'POLL_VOTE',
      pollId: 'remote-poll-1',
      optionIndex: 0,
      voterId: 'peerX'
    });

    expect(pollMgr.currentPoll.options[0].voterIds).toContain('peerX');

    pollMgr.handleRemoteMessage({
      type: 'POLL_END',
      pollId: 'remote-poll-1'
    });

    expect(pollMgr.currentPoll.isActive).toBe(false);
  });

  it('renders poll card and allows interactive voting', () => {
    const container = document.createElement('div');
    const poll = pollMgr.createPoll({
      question: 'Votar?',
      options: ['Sim', 'Não'],
      durationSeconds: 60
    });

    pollMgr.renderPollCard(container, 'user1');

    const rows = container.querySelectorAll('.poll-option-row');
    expect(rows).toHaveLength(2);

    rows[0].click();
    expect(poll.options[0].voterIds).toContain('user1');
  });
});
