import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler, {
  resetMemoryRooms,
  countryCodeToEmoji
} from '../api/rooms.js';
import {
  RoomPublisher,
  HEARTBEAT_INTERVAL_MS
} from '../js/directory/room-publisher.js';
import { initLobbyDirectory } from '../js/directory/lobby-directory.js';

describe('Diretório de Salas: api/rooms.js e Geolocation Vercel', () => {
  let mockReq;
  let mockRes;
  let statusMock;
  let jsonMock;
  let setHeaderMock;
  let endMock;

  beforeEach(() => {
    resetMemoryRooms();
    jsonMock = vi.fn();
    endMock = vi.fn();
    statusMock = vi.fn(() => ({ json: jsonMock, end: endMock }));
    setHeaderMock = vi.fn();

    mockReq = {
      method: 'GET',
      url: '/api/rooms',
      headers: {}
    };
    mockRes = {
      status: statusMock,
      json: jsonMock,
      setHeader: setHeaderMock,
      end: endMock
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Conversor de Código de País para Emoji (countryCodeToEmoji)', () => {
    it('deve converter corretamente códigos de países de 2 letras para bandeiras', () => {
      expect(countryCodeToEmoji('BR')).toBe('🇧🇷');
      expect(countryCodeToEmoji('US')).toBe('🇺🇸');
      expect(countryCodeToEmoji('PT')).toBe('🇵🇹');
      expect(countryCodeToEmoji('JP')).toBe('🇯🇵');
      expect(countryCodeToEmoji('DE')).toBe('🇩🇪');
      expect(countryCodeToEmoji('br')).toBe('🇧🇷'); // case-insensitive
    });

    it('deve retornar globo para códigos inválidos ou nulos', () => {
      expect(countryCodeToEmoji(null)).toBe('🌐');
      expect(countryCodeToEmoji('')).toBe('🌐');
      expect(countryCodeToEmoji('BRA')).toBe('🌐');
      expect(countryCodeToEmoji('12')).toBe('🌐');
    });
  });

  describe('CORS e Métodos HTTP', () => {
    it('deve responder OPTIONS com 200 e headers de CORS', async () => {
      mockReq.method = 'OPTIONS';
      await handler(mockReq, mockRes);

      expect(setHeaderMock).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      expect(setHeaderMock).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(endMock).toHaveBeenCalled();
    });

    it('deve rejeitar métodos não permitidos com 405', async () => {
      mockReq.method = 'PUT';
      await handler(mockReq, mockRes);

      expect(statusMock).toHaveBeenCalledWith(405);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ error: 'Method Not Allowed' }));
    });
  });

  describe('POST /api/rooms: Heartbeat e Registro', () => {
    it('deve registrar sala com sucesso e extrair geolocalização dos headers da Vercel', async () => {
      mockReq.method = 'POST';
      mockReq.headers = {
        'x-vercel-ip-country': 'BR',
        'x-vercel-ip-country-region': 'SP',
        'x-vercel-ip-city': 'Sao%20Paulo'
      };
      mockReq.body = {
        id: 'squad-resenha',
        title: 'Squad Resenha',
        game: 'Valorant',
        isPrivate: false,
        hasPlayer2Slot: true,
        memberCount: 3,
        maxMembers: 8,
        secretKey: 'sec-123'
      };

      await handler(mockReq, mockRes);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        room: expect.objectContaining({
          id: 'squad-resenha',
          title: 'Squad Resenha',
          game: 'Valorant',
          isPrivate: false,
          hasPlayer2Slot: true,
          flag: '🇧🇷',
          locationText: 'Sao Paulo, SP'
        }),
        heartbeatIntervalSeconds: 60,
        ttlSeconds: 90
      }));
    });

    it('NUNCA deve persistir ou expor PIN mesmo se enviado no body (Segurança)', async () => {
      mockReq.method = 'POST';
      mockReq.body = {
        id: 'sala-secreta',
        title: 'Sala Secreta',
        roomPin: '123456', // tentativa de envio indevida
        pin: '123456',
        isPrivate: true
      };

      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(200);

      const returnedRoom = jsonMock.mock.calls[0][0].room;
      expect(returnedRoom.isPrivate).toBe(true);
      expect(returnedRoom.roomPin).toBeUndefined();
      expect(returnedRoom.pin).toBeUndefined();

      // Confirma no GET subsequente
      mockReq.method = 'GET';
      mockReq.body = null;
      await handler(mockReq, mockRes);
      const list = jsonMock.mock.calls[1][0].rooms;
      expect(list[0].roomPin).toBeUndefined();
      expect(list[0].pin).toBeUndefined();
      expect(list[0].secretKey).toBeUndefined();
    });

    it('deve validar e rejeitar IDs de sala inválidos', async () => {
      mockReq.method = 'POST';
      mockReq.body = {
        id: 'sala com espaços e caracteres inválidos!!!'
      };

      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('ID de sala inválido')
      }));
    });

    it('deve bloquear sobrescrita de sala com secretKey diferente', async () => {
      mockReq.method = 'POST';
      mockReq.body = {
        id: 'sala-protegida',
        title: 'Host Original',
        secretKey: 'chave-original'
      };
      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(200);

      // Tentativa de invasor com outra chave
      mockReq.body = {
        id: 'sala-protegida',
        title: 'Invasor',
        secretKey: 'chave-falsa'
      };
      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('não autorizada')
      }));
    });
  });

  describe('GET /api/rooms: Listagem e Filtros', () => {
    beforeEach(async () => {
      // Cria 3 salas para teste de filtros
      const rooms = [
        { id: 'sala-publica-val', game: 'Valorant', isPrivate: false, hasPlayer2Slot: true, memberCount: 4 },
        { id: 'sala-privada-elden', game: 'Elden Ring', isPrivate: true, hasPlayer2Slot: false, memberCount: 2 },
        { id: 'sala-publica-chat', game: 'Just Chatting', isPrivate: false, hasPlayer2Slot: false, memberCount: 1 }
      ];

      for (const r of rooms) {
        mockReq.method = 'POST';
        mockReq.body = r;
        await handler(mockReq, mockRes);
      }
      mockReq.method = 'GET';
      mockReq.body = null;
      vi.clearAllMocks();
    });

    it('deve listar todas as salas ativas ordenadas por número de membros', async () => {
      mockReq.url = '/api/rooms';
      await handler(mockReq, mockRes);

      expect(statusMock).toHaveBeenCalledWith(200);
      const { rooms, count } = jsonMock.mock.calls[0][0];
      expect(count).toBe(3);
      expect(rooms[0].id).toBe('sala-publica-val'); // 4 membros vem primeiro
      expect(rooms[0].memberCount).toBe(4);
    });

    it('deve filtrar apenas salas públicas com type=public', async () => {
      mockReq.url = '/api/rooms?type=public';
      await handler(mockReq, mockRes);

      const { rooms, count } = jsonMock.mock.calls[0][0];
      expect(count).toBe(2);
      expect(rooms.every(r => !r.isPrivate)).toBe(true);
    });

    it('deve filtrar apenas salas com PIN com type=private', async () => {
      mockReq.url = '/api/rooms?type=private';
      await handler(mockReq, mockRes);

      const { rooms, count } = jsonMock.mock.calls[0][0];
      expect(count).toBe(1);
      expect(rooms[0].id).toBe('sala-privada-elden');
      expect(rooms[0].isPrivate).toBe(true);
    });

    it('deve filtrar por vaga de Player 2 com player2=1', async () => {
      mockReq.url = '/api/rooms?player2=1';
      await handler(mockReq, mockRes);

      const { rooms, count } = jsonMock.mock.calls[0][0];
      expect(count).toBe(1);
      expect(rooms[0].id).toBe('sala-publica-val');
      expect(rooms[0].hasPlayer2Slot).toBe(true);
    });

    it('deve filtrar por busca de texto ou nome do jogo', async () => {
      mockReq.url = '/api/rooms?search=elden';
      await handler(mockReq, mockRes);

      const { rooms, count } = jsonMock.mock.calls[0][0];
      expect(count).toBe(1);
      expect(rooms[0].game).toBe('Elden Ring');
    });
  });

  describe('DELETE /api/rooms: Despublicação Imediata e sendBeacon', () => {
    it('deve remover sala via DELETE com id no query param', async () => {
      // Cria sala
      mockReq.method = 'POST';
      mockReq.body = { id: 'para-deletar' };
      await handler(mockReq, mockRes);

      // Deleta sala
      mockReq.method = 'DELETE';
      mockReq.url = '/api/rooms?id=para-deletar';
      mockReq.body = null;
      await handler(mockReq, mockRes);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ ok: true, deleted: true }));

      // Confirma que não aparece mais no GET
      mockReq.method = 'GET';
      mockReq.url = '/api/rooms';
      await handler(mockReq, mockRes);
      expect(jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0].count).toBe(0);
    });

    it('deve aceitar POST com action=delete para compatibilidade com navigator.sendBeacon', async () => {
      // Cria sala
      mockReq.method = 'POST';
      mockReq.body = { id: 'beacon-room' };
      await handler(mockReq, mockRes);

      // Deleta via sendBeacon POST ?action=delete
      mockReq.method = 'POST';
      mockReq.url = '/api/rooms?action=delete';
      mockReq.body = { id: 'beacon-room' };
      await handler(mockReq, mockRes);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ ok: true, deleted: true }));
    });
  });
});

describe('RoomPublisher: Heartbeat de 60s e Ciclo de Vida', () => {
  let publisher;

  beforeEach(() => {
    vi.useFakeTimers();
    publisher = new RoomPublisher();
  });

  afterEach(() => {
    publisher.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deve ter intervalo de heartbeat de exatamente 60 segundos', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(publisher.intervalMs).toBe(60_000);
  });

  it('deve enviar heartbeat inicial e agendar envio periódico a cada 60s', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });

    await publisher.start({
      roomId: 'minha-sala',
      title: 'Minha Sala',
      game: 'Elden Ring',
      isPrivate: false,
      memberCount: 2
    });

    expect(publisher.isActive).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCallPayload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(firstCallPayload.id).toBe('minha-sala');
    expect(firstCallPayload.game).toBe('Elden Ring');

    // Avança 59 segundos -> não deve ter enviado novo heartbeat
    vi.advanceTimersByTime(59_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Avança mais 1 segundo (completando 60s) -> dispara segundo heartbeat
    vi.advanceTimersByTime(1_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Avança mais 60s -> dispara terceiro heartbeat
    vi.advanceTimersByTime(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('updateMetrics deve atualizar métricas que são enviadas no próximo heartbeat', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });

    await publisher.start({ roomId: 'sala-teste', memberCount: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    publisher.updateMetrics({ memberCount: 4, hasPlayer2Slot: true });

    vi.advanceTimersByTime(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const secondCallPayload = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(secondCallPayload.memberCount).toBe(4);
    expect(secondCallPayload.hasPlayer2Slot).toBe(true);
  });

  it('stop deve cancelar o timer e enviar DELETE da sala', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });

    await publisher.start({ roomId: 'sala-fechando' });
    expect(publisher.isActive).toBe(true);

    await publisher.stop();
    expect(publisher.isActive).toBe(false);

    // Verificamos que o último fetch foi DELETE
    const deleteCall = fetchSpy.mock.calls.find(c => c[1]?.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain('id=sala-fechando');

    // Avança o tempo e confirma que nenhum outro heartbeat é disparado
    vi.advanceTimersByTime(120_000);
    const postCallsAfterStop = fetchSpy.mock.calls.filter(c => c[1]?.method === 'POST');
    expect(postCallsAfterStop.length).toBe(1); // apenas o inicial
  });
});

describe('LobbyDirectory UI: Renderização e Interação', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="directory-rooms-list"></div>
      <div id="directory-room-count">0 ativas</div>
      <button id="directory-refresh-btn"><span class="refresh-icon">🔄</span> Atualizar</button>
      <input type="text" id="directory-search-input">
      <div class="directory-filters">
        <button class="dir-filter-pill active" data-filter="all">Todas</button>
        <button class="dir-filter-pill" data-filter="public">Abertas</button>
        <button class="dir-filter-pill" data-filter="private">Com PIN</button>
        <button class="dir-filter-pill" data-filter="player2">Player 2</button>
      </div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('deve renderizar salas recebidas e disparar onSelectRoom ao clicar em Entrar', async () => {
    const mockRooms = [
      {
        id: 'sala-e2e',
        title: 'Sala E2E',
        game: 'Counter-Strike 2',
        isPrivate: false,
        hasPlayer2Slot: true,
        memberCount: 3,
        maxMembers: 10,
        flag: '🇧🇷',
        locationText: 'Curitiba, PR'
      }
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ rooms: mockRooms, count: 1 })
    });

    const onSelectRoomMock = vi.fn();
    const directory = initLobbyDirectory({
      onSelectRoom: onSelectRoomMock
    });

    // Aguarda microtask da busca de salas
    await new Promise(r => setTimeout(r, 10));

    const card = document.querySelector('.dir-room-card');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Sala E2E');
    expect(card.textContent).toContain('Counter-Strike 2');
    expect(card.textContent).toContain('Curitiba, PR');
    expect(card.textContent).toContain('3/10');
    expect(card.textContent).toContain('🟢 Aberta');
    expect(card.textContent).toContain('🎮 Player 2');

    // Clica no botão Entrar
    const joinBtn = card.querySelector('.dir-join-btn');
    joinBtn.click();

    expect(onSelectRoomMock).toHaveBeenCalledWith('sala-e2e');
    directory.dispose();
  });
});
