/**
 * SeeMyGame - Controlador do Diretório de Salas no Lobby
 *
 * Gerencia a listagem de salas ativas da comunidade, busca em tempo real,
 * filtros (todas, abertas, com PIN, vaga Player 2) e atualização automática a cada 30s.
 */

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function initLobbyDirectory({ session, onSelectRoom, apiBase = '/api/rooms' } = {}) {
  if (typeof document === 'undefined') return { refresh: () => {}, dispose: () => {} };

  const roomsList = document.getElementById('directory-rooms-list');
  const countBadge = document.getElementById('directory-room-count');
  const refreshBtn = document.getElementById('directory-refresh-btn');
  const searchInput = document.getElementById('directory-search-input');
  const filterPills = document.querySelectorAll('.dir-filter-pill');

  if (!roomsList) return { refresh: () => {}, dispose: () => {} };

  let allRooms = [];
  let currentFilter = 'all';
  let searchQuery = '';
  let autoRefreshInterval = null;
  let isFetching = false;

  async function fetchRooms() {
    if (isFetching) return;
    isFetching = true;

    if (refreshBtn) {
      refreshBtn.disabled = true;
      const icon = refreshBtn.querySelector('.refresh-icon');
      if (icon) icon.style.display = 'inline-block';
    }

    try {
      const response = await fetch(`${apiBase}?ts=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      allRooms = Array.isArray(data.rooms) ? data.rooms : [];
      updateCountBadge(allRooms.length);
      renderList();
    } catch (err) {
      console.warn('[LobbyDirectory] Falha ao buscar salas:', err);
      // Se ainda não tiver salas carregadas, exibe estado vazio
      if (allRooms.length === 0) {
        renderEmptyState('Não foi possível carregar as salas no momento. Tente novamente em instantes.');
      }
    } finally {
      isFetching = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
      }
    }
  }

  function updateCountBadge(count) {
    if (countBadge) {
      countBadge.textContent = `${count} ${count === 1 ? 'ativa' : 'ativas'}`;
    }
  }

  function getFilteredRooms() {
    const query = searchQuery.trim().toLowerCase();
    return allRooms.filter((room) => {
      // Filtro de tipo
      if (currentFilter === 'public' && room.isPrivate) return false;
      if (currentFilter === 'private' && !room.isPrivate) return false;
      if (currentFilter === 'player2' && !room.hasPlayer2Slot) return false;

      // Filtro de busca de texto
      if (query) {
        const matchesId = room.id && room.id.toLowerCase().includes(query);
        const matchesTitle = room.title && room.title.toLowerCase().includes(query);
        const matchesGame = room.game && room.game.toLowerCase().includes(query);
        const matchesLocation = room.locationText && room.locationText.toLowerCase().includes(query);
        if (!matchesId && !matchesTitle && !matchesGame && !matchesLocation) return false;
      }
      return true;
    });
  }

  function renderEmptyState(customDesc = null) {
    const desc = customDesc || 'Crie sua sala no formulário ao lado e marque "Publicar no Diretório" para outros jogadores encontrarem você!';
    roomsList.innerHTML = `
      <div class="dir-empty-state">
        <div class="dir-empty-icon" aria-hidden="true">📡</div>
        <p class="dir-empty-title">Nenhuma sala encontrada</p>
        <p class="dir-empty-desc">${escapeHtml(desc)}</p>
      </div>
    `;
  }

  function renderList() {
    const filtered = getFilteredRooms();

    if (filtered.length === 0) {
      renderEmptyState(allRooms.length > 0 ? 'Nenhuma sala coincide com os filtros selecionados.' : null);
      return;
    }

    const cardsHtml = filtered.map((room) => {
      const flag = room.flag || '🌐';
      const safeId = escapeHtml(room.id);
      const safeTitle = escapeHtml(room.title || room.id);
      const safeGame = escapeHtml(room.game || 'Geral');
      const location = escapeHtml(room.locationText || 'Global');
      const memberCount = room.memberCount || 1;
      const maxMembers = room.maxMembers || 8;

      let statusBadge = room.isPrivate
        ? '<span class="dir-badge dir-badge-private" title="Protegida por senha">🔒 Com PIN</span>'
        : '<span class="dir-badge dir-badge-public" title="Entrada livre">🟢 Aberta</span>';

      let p2Badge = room.hasPlayer2Slot
        ? '<span class="dir-badge dir-badge-p2" title="Vaga para jogar como Player 2">🎮 Player 2</span>'
        : '';

      return `
        <div class="dir-room-card" data-room-id="${safeId}">
          <div class="dir-room-main">
            <div class="dir-room-title-line">
              <span class="dir-room-flag" aria-hidden="true">${flag}</span>
              <strong class="dir-room-name" title="${safeTitle}">${safeTitle}</strong>
              ${statusBadge}
              ${p2Badge}
            </div>
            <div class="dir-room-meta">
              <span class="dir-room-game">🎮 ${safeGame}</span>
              <span class="dir-room-location">📍 ${location}</span>
            </div>
          </div>
          <div class="dir-room-action">
            <div class="dir-members-count">👥 ${memberCount}/${maxMembers}</div>
            <button type="button" class="dune-btn dune-btn-primary dir-join-btn" data-room-id="${safeId}" aria-label="Entrar na sala ${safeTitle}">
              Entrar
            </button>
          </div>
        </div>
      `;
    }).join('');

    roomsList.innerHTML = cardsHtml;
  }

  // Delegação de cliques nos botões "Entrar" da lista
  const handleListClick = (e) => {
    const btn = e.target.closest('.dir-join-btn');
    if (btn) {
      const roomId = btn.dataset.roomId;
      if (roomId && typeof onSelectRoom === 'function') {
        onSelectRoom(roomId);
      }
    }
  };
  roomsList.addEventListener('click', handleListClick);

  // Busca em tempo real
  let searchTimeout = null;
  const handleSearchInput = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchQuery = searchInput.value || '';
      renderList();
    }, 150);
  };
  if (searchInput) {
    searchInput.addEventListener('input', handleSearchInput);
  }

  // Filtros em abas/pills
  filterPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      filterPills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.dataset.filter || 'all';
      renderList();
    });
  });

  // Botão de atualizar
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      fetchRooms();
    });
  }

  // Busca inicial imediata
  fetchRooms();

  // Auto-refresh a cada 30 segundos
  autoRefreshInterval = setInterval(() => {
    fetchRooms();
  }, 30_000);

  const dispose = () => {
    if (autoRefreshInterval) {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
    }
    clearTimeout(searchTimeout);
    roomsList.removeEventListener('click', handleListClick);
    if (searchInput) {
      searchInput.removeEventListener('input', handleSearchInput);
    }
  };

  if (session?.registerCleanup) {
    session.registerCleanup(dispose);
  }

  return {
    refresh: fetchRooms,
    dispose,
    getRooms: () => allRooms
  };
}
