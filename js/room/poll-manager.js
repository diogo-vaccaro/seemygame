/**
 * SeeMyGame - PollManager
 * Gerenciador de enquetes rápidas em tempo real na sala com sincronização P2P,
 * temporizador regressivo e anúncio automático de resultados no chat.
 */

export class PollManager {
  constructor(options = {}) {
    this.broadcast = options.broadcast || null;
    this.onChatAnnounce = options.onChatAnnounce || null;
    this.currentPoll = null;
    this.timerId = null;
    this.listeners = new Set();
  }

  setBroadcast(fn) {
    this.broadcast = fn;
  }

  setOnChatAnnounce(fn) {
    this.onChatAnnounce = fn;
  }

  onPollChange(listener) {
    if (typeof listener === 'function') {
      this.listeners.add(listener);
    }
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.currentPoll);
      } catch (err) {
        console.error('[PollManager] Erro no listener:', err);
      }
    }
  }

  createPoll({
    question,
    options,
    durationSeconds = 60,
    creatorId = 'host',
    creatorName = 'Host',
    allowMultiple = false
  }) {
    const cleanQuestion = typeof question === 'string' ? question.trim() : '';
    if (!cleanQuestion || !Array.isArray(options) || options.length < 2) {
      throw new Error('A enquete precisa de uma pergunta e pelo menos duas opções.');
    }

    const cleanOptions = options
      .map(opt => (typeof opt === 'string' ? opt.trim() : ''))
      .filter(Boolean);

    if (cleanOptions.length < 2 || cleanOptions.length > 10 || cleanQuestion.length > 500 || cleanOptions.some(text => text.length > 200)) {
      throw new Error('A enquete precisa de pelo menos 2 opções válidas.');
    }

    if (this.currentPoll && this.currentPoll.isActive) this.endPoll(this.currentPoll.id, false);
    const duration = Math.min(86400, Math.max(0, parseInt(durationSeconds, 10) || 0));
    const now = Date.now();
    const expiresAt = duration > 0 ? now + duration * 1000 : null;

    const poll = {
      id: 'poll-' + now + '-' + Math.random().toString(36).slice(2, 7),
      question: cleanQuestion,
      options: cleanOptions.map(text => ({ text, voterIds: [] })),
      durationSeconds: duration,
      createdAt: now,
      expiresAt,
      creatorId: String(creatorId || 'host'),
      creatorName: String(creatorName || 'Host'),
      allowMultiple: Boolean(allowMultiple),
      isActive: true
    };

    this.currentPoll = poll;
    this.localPollId = poll.id;

    if (expiresAt) {
      this._scheduleTimer(expiresAt - now);
    }

    if (this.broadcast) {
      this.broadcast({
        type: 'POLL_CREATE',
        poll: this._serializePoll(poll)
      });
    }

    this.notify();
    return poll;
  }

  vote(pollId, optionIndex, voterId) {
    if (!this.currentPoll || !this.currentPoll.isActive || this.currentPoll.id !== pollId ||
        (this.currentPoll.expiresAt && Date.now() >= this.currentPoll.expiresAt)) {
      return false;
    }

    const poll = this.currentPoll;
    const idx = Number(optionIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= poll.options.length) {
      return false;
    }

    const cleanVoterId = voterId != null ? String(voterId).trim() : '';
    if (!cleanVoterId) {
      return false;
    }

    if (!poll.allowMultiple) {
      // Remove voto de outras opções
      for (const opt of poll.options) {
        opt.voterIds = opt.voterIds.filter(id => id !== cleanVoterId);
      }
    }

    const targetOpt = poll.options[idx];
    if (!targetOpt.voterIds.includes(cleanVoterId)) {
      targetOpt.voterIds.push(cleanVoterId);
    }

    if (this.broadcast) {
      this.broadcast({
        type: 'POLL_VOTE',
        pollId,
        optionIndex: idx,
        voterId: cleanVoterId
      });
    }

    this.notify();
    return true;
  }

  endPoll(pollId = null, notify = true) {
    if (!this.currentPoll) return null;
    if (pollId && this.currentPoll.id !== pollId) return null;
    if (!this.currentPoll.isActive) return this.getResults();

    this._clearTimer();
    this.currentPoll.isActive = false;

    const results = this.getResults();

    if (notify) {
      if (this.broadcast) {
        this.broadcast({
          type: 'POLL_END',
          pollId: this.currentPoll.id,
          results
        });
      }

      if (this.onChatAnnounce) {
        const text = this.formatResultSummary(results);
        this.onChatAnnounce(text, results);
      }
    }

    this.notify();
    return results;
  }

  getResults() {
    if (!this.currentPoll) return null;

    const poll = this.currentPoll;
    let totalVotes = 0;
    for (const opt of poll.options) {
      totalVotes += opt.voterIds.length;
    }

    const options = poll.options.map((opt, idx) => {
      const count = opt.voterIds.length;
      const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
      return {
        index: idx,
        text: opt.text,
        count,
        percent
      };
    });

    let maxVotes = -1;
    let winner = null;
    let isTie = false;

    for (const opt of options) {
      if (opt.count > maxVotes) {
        maxVotes = opt.count;
        winner = opt;
        isTie = false;
      } else if (opt.count === maxVotes && maxVotes > 0) {
        isTie = true;
      }
    }

    return {
      id: poll.id,
      question: poll.question,
      totalVotes,
      options,
      winner: totalVotes > 0 && !isTie ? winner : null,
      isTie: totalVotes > 0 && isTie,
      creatorName: poll.creatorName
    };
  }

  formatResultSummary(results) {
    if (!results) return '';

    let msg = `📊 **Enquete:** ${results.question}\n`;
    for (const opt of results.options) {
      msg += `• ${opt.text}: ${opt.count} voto${opt.count !== 1 ? 's' : ''} (${opt.percent}%)\n`;
    }

    if (results.totalVotes === 0) {
      msg += `Nenhum voto registrado.`;
    } else if (results.isTie) {
      msg += `🤝 Empate entre as opções mais votadas! (Total: ${results.totalVotes} votos)`;
    } else if (results.winner) {
      msg += `🏆 Vencedor: **${results.winner.text}** com ${results.winner.count} voto${results.winner.count !== 1 ? 's' : ''}!`;
    }

    return msg.trim();
  }

  handleRemoteMessage(msg, senderId = null) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'POLL_SYNC_REQUEST') {
      if (this.currentPoll && this.currentPoll.isActive && this.broadcast && this.localPollId === this.currentPoll.id) {
        this.broadcast({
          type: 'POLL_SYNC',
          poll: this._serializePoll(this.currentPoll)
        });
      }
      return;
    }

    if ((msg.type === 'POLL_CREATE' || msg.type === 'POLL_SYNC') && msg.poll) {
      const incoming = msg.poll;
      if (typeof incoming.id !== 'string' || !incoming.id || incoming.id.length > 128 ||
          typeof incoming.question !== 'string' || !incoming.question.trim() || incoming.question.length > 500 ||
          !Array.isArray(incoming.options) || incoming.options.length < 2 || incoming.options.length > 10 ||
          incoming.options.some(option => !option || typeof option.text !== 'string' || !option.text.trim() || option.text.length > 200 ||
            (option.voterIds != null && (!Array.isArray(option.voterIds) || option.voterIds.length > 256 ||
              option.voterIds.some(id => typeof id !== 'string' || !id || id.length > 128)))) ||
          (incoming.expiresAt != null && (!Number.isFinite(incoming.expiresAt) || incoming.expiresAt - Date.now() > 86400000))) return;
      if (senderId && incoming.creatorId !== senderId) return;
      if (this.currentPoll?.id === incoming.id) return;
      if (this.currentPoll && Number(incoming.createdAt) < Number(this.currentPoll.createdAt)) return;
      if (this.currentPoll && this.currentPoll.isActive) {
        this._clearTimer();
      }

      this.currentPoll = {
        ...msg.poll,
        options: (msg.poll.options || []).map(opt => ({
          text: opt?.text || '',
          voterIds: [...(opt?.voterIds || [])]
        }))
      };

      if (this.currentPoll.expiresAt && this.currentPoll.isActive) {
        const remaining = this.currentPoll.expiresAt - Date.now();
        if (remaining > 0) {
          this._scheduleTimer(remaining, false);
        } else {
          this.endPoll(this.currentPoll.id, false);
        }
      }

      this.notify();
    } else if (msg.type === 'POLL_VOTE' && msg.pollId) {
      if (this.currentPoll && this.currentPoll.id === msg.pollId && this.currentPoll.isActive) {
        const { optionIndex } = msg;
        const voterId = senderId || msg.voterId;
        const idx = Number(optionIndex);
        if (this.currentPoll.expiresAt && Date.now() >= this.currentPoll.expiresAt) return;
        if (Number.isInteger(idx) && idx >= 0 && idx < this.currentPoll.options.length && typeof voterId === 'string' && voterId.trim() && voterId.length <= 128) {
          if (!this.currentPoll.allowMultiple) {
            for (const opt of this.currentPoll.options) {
              opt.voterIds = opt.voterIds.filter(id => id !== voterId);
            }
          }
          const opt = this.currentPoll.options[idx];
          if (!opt.voterIds.includes(voterId)) {
            opt.voterIds.push(voterId);
          }
          this.notify();
        }
      }
    } else if (msg.type === 'POLL_END' && msg.pollId) {
      if (this.currentPoll && this.currentPoll.id === msg.pollId && (!senderId || senderId === this.currentPoll.creatorId)) {
        this.endPoll(msg.pollId, false);
      }
    }
  }

  _scheduleTimer(ms, announce = true) {
    this._clearTimer();
    this.timerId = setTimeout(() => {
      this.endPoll(this.currentPoll?.id, announce);
    }, ms);
  }

  _clearTimer() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  dispose() {
    this._clearTimer();
    this.currentPoll = null; this.localPollId = null;
    this.broadcast = this.onChatAnnounce = null;
    this.listeners.clear();
  }

  _serializePoll(poll) {
    return {
      id: poll.id,
      question: poll.question,
      options: poll.options.map(o => ({ text: o.text, voterIds: [...o.voterIds] })),
      durationSeconds: poll.durationSeconds,
      createdAt: poll.createdAt,
      expiresAt: poll.expiresAt,
      creatorId: poll.creatorId,
      creatorName: poll.creatorName,
      allowMultiple: poll.allowMultiple,
      isActive: poll.isActive
    };
  }

  renderPollCard(container, currentUserId = null) {
    if (!container) return;
    if (container._pollTimerInterval) {
      clearInterval(container._pollTimerInterval);
      container._pollTimerInterval = null;
    }
    container.innerHTML = '';

    if (!this.currentPoll) return;

    const poll = this.currentPoll;
    const results = this.getResults();

    const card = document.createElement('div');
    card.className = `poll-card glass-panel ${poll.isActive ? 'active' : 'ended'}`;

    // Timer display
    const formatTime = (remainingSec) => {
      const m = Math.floor(remainingSec / 60);
      const s = remainingSec % 60;
      return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    let timerText = '';
    if (poll.isActive && poll.expiresAt) {
      const remainingSec = Math.max(0, Math.ceil((poll.expiresAt - Date.now()) / 1000));
      timerText = formatTime(remainingSec);
    }

    card.innerHTML = `
      <div class="poll-header">
        <div class="poll-badge">${poll.isActive ? '🟢 Enquete Ao Vivo' : '🏁 Enquete Encerrada'}</div>
        ${timerText ? `<div class="poll-timer" id="poll-timer-badge">⏱️ ${timerText}</div>` : ''}
      </div>
      <h4 class="poll-question"></h4>
      <div class="poll-options-list"></div>
      <div class="poll-footer">
        <span class="poll-meta-votes">${results.totalVotes} voto${results.totalVotes !== 1 ? 's' : ''}</span>
        ${poll.isActive && currentUserId && (currentUserId === poll.creatorId || currentUserId === 'host') ? `
          <button type="button" class="btn btn-sm btn-outline-danger poll-end-btn">Encerrar</button>
        ` : ''}
      </div>
    `;

    // Atualização em tempo real do timer se ativo
    if (poll.isActive && poll.expiresAt) {
      const timerBadge = card.querySelector('#poll-timer-badge');
      if (timerBadge) {
        container._pollTimerInterval = setInterval(() => {
          const remainingSec = Math.max(0, Math.ceil((poll.expiresAt - Date.now()) / 1000));
          if (remainingSec <= 0) {
            clearInterval(container._pollTimerInterval);
            container._pollTimerInterval = null;
            timerBadge.textContent = '⏱️ 0:00';
          } else {
            timerBadge.textContent = `⏱️ ${formatTime(remainingSec)}`;
          }
        }, 1000);
      }
    }

    card.querySelector('.poll-question').textContent = poll.question;
    const optionsList = card.querySelector('.poll-options-list');

    results.options.forEach((opt) => {
      const isUserVoted = currentUserId && poll.options[opt.index].voterIds.includes(currentUserId);
      const row = document.createElement('div');
      row.className = `poll-option-row ${isUserVoted ? 'voted' : ''} ${!poll.isActive && results.winner?.index === opt.index ? 'winner' : ''}`;

      row.innerHTML = `
        <div class="poll-option-bar" style="width: ${opt.percent}%;"></div>
        <div class="poll-option-content">
          <span class="poll-option-title">${isUserVoted ? '✓ ' : ''}${this._escape(opt.text)}</span>
          <span class="poll-option-pct">${opt.percent}% (${opt.count})</span>
        </div>
      `;

      if (poll.isActive) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          if (currentUserId) {
            this.vote(poll.id, opt.index, currentUserId);
          }
        });
      }

      optionsList.appendChild(row);
    });

    const endBtn = card.querySelector('.poll-end-btn');
    if (endBtn) {
      endBtn.addEventListener('click', () => {
        this.endPoll(poll.id, true);
      });
    }

    container.appendChild(card);
  }

  _escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

export const pollManager = new PollManager();
