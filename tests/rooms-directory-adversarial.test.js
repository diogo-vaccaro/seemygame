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

describe('Diretório Avançado: Estresse, Expiração TTL, XSS e Resiliência', () => {
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

  describe('Expiração Estrita por TTL de 90s', () => {
    it('sala deve estar ativa aos 89s e ser expurgada automaticamente aos 91s', async () => {
      vi.useFakeTimers();
      const baseTime = 1_000_000_000;
      vi.setSystemTime(baseTime);

      // Registra sala no tempo 0s
      mockReq.method = 'POST';
      mockReq.body = { id: 'sala-ttl-teste', title: 'Sala TTL' };
      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(200);

      // Avança 89 segundos
      vi.setSystemTime(baseTime + 89_000);
      mockReq.method = 'GET';
      mockReq.body = null;
      vi.clearAllMocks();

      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(200);
      let res = jsonMock.mock.calls[0][0];
      expect(res.count).toBe(1);
      expect(res.rooms[0].id).toBe('sala-ttl-teste');

      // Avança mais 2 segundos (completando 91 segundos)
      vi.setSystemTime(baseTime + 91_000);
      vi.clearAllMocks();

      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(200);
      res = jsonMock.mock.calls[0][0];
      expect(res.count).toBe(0); // expirou e foi expurgada!

      vi.useRealTimers();
    });

    it('heartbeat contínuo de 60s deve renovar TTL e impedir que a sala expire', async () => {
      vi.useFakeTimers();
      const baseTime = 1_000_000_000;
      vi.setSystemTime(baseTime);

      // Pulso 1: 0s
      mockReq.method = 'POST';
      mockReq.body = { id: 'sala-ativa-longa', secretKey: 'minha-chave' };
      await handler(mockReq, mockRes);

      // Pulso 2: 60s
      vi.setSystemTime(baseTime + 60_000);
      await handler(mockReq, mockRes);

      // Pulso 3: 120s
      vi.setSystemTime(baseTime + 120_000);
      await handler(mockReq, mockRes);

      // Verifica aos 150s (2 minutos e meio após o início, mas 30s após o último pulso)
      vi.setSystemTime(baseTime + 150_000);
      mockReq.method = 'GET';
      mockReq.body = null;
      vi.clearAllMocks();

      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(200);
      const res = jsonMock.mock.calls[0][0];
      expect(res.count).toBe(1);
      expect(res.rooms[0].id).toBe('sala-ativa-longa');

      vi.useRealTimers();
    });
  });

  describe('Sanitização e Proteção contra Entradas Adversárias (XSS e Injeções)', () => {
    it('deve truncar e sanitizar título e jogo contra injeções de tags maliciosas', async () => {
      mockReq.method = 'POST';
      mockReq.body = {
        id: 'sala-segura',
        title: '<script>alert("hack")</script><img src=x onerror=alert(1)>',
        game: '<b>Jogo Perigoso</b>'.repeat(10), // string longa
        memberCount: 999 // deve ser clamped para 32
      };

      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(200);

      mockReq.method = 'GET';
      mockReq.body = null;
      vi.clearAllMocks();

      await handler(mockReq, mockRes);
      const room = jsonMock.mock.calls[0][0].rooms[0];
      expect(room.memberCount).toBe(32); // clamped
      expect(room.game.length).toBeLessThanOrEqual(40); // truncado
      expect(room.title.length).toBeLessThanOrEqual(60); // truncado
    });

    it('deve rejeitar tentativas de path traversal ou IDs de sala com caracteres de controle', async () => {
      const maliciousIds = [
        '../malicious',
        '../../api/rooms',
        'sala/com/barras',
        'sala\\com\\contrabarras',
        'sala com espaços',
        'sala;drop table rooms;',
        '<script>'
      ];

      for (const id of maliciousIds) {
        mockReq.method = 'POST';
        mockReq.body = { id };
        vi.clearAllMocks();

        await handler(mockReq, mockRes);
        expect(statusMock).toHaveBeenCalledWith(400);
      }
    });

    it('LobbyDirectory deve escapar HTML para neutralizar XSS ao montar cards', () => {
      document.body.innerHTML = `
        <div id="directory-rooms-list"></div>
        <div id="directory-room-count"></div>
      `;

      const maliciousRoom = {
        id: 'xss-room',
        title: '<b id="injected-tag">Texto Negrito</b>',
        game: '<script>window.hacked=true;</script>',
        locationText: '"><img src=x onerror=hacked()>',
        isPrivate: false,
        memberCount: 1,
        maxMembers: 8
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ rooms: [maliciousRoom], count: 1 })
      });

      const directory = initLobbyDirectory();

      return new Promise((resolve) => {
        setTimeout(() => {
          // Garante que o elemento injetado NÃO foi instanciado como tag HTML real
          const injectedElement = document.getElementById('injected-tag');
          expect(injectedElement).toBeNull();

          // Garante que o conteúdo foi renderizado como texto escapado
          const list = document.getElementById('directory-rooms-list');
          expect(list.innerHTML).toContain('&lt;b id="injected-tag"&gt;');
          directory.dispose();
          resolve();
        }, 20);
      });
    });
  });

  describe('Geolocalização com Cidades Acentuadas e Diversas Regiões', () => {
    it('deve decodificar cidades acentuadas e codificadas em URL', async () => {
      const testCases = [
        { headerCity: 'S%C3%A3o%20Paulo', expected: 'São Paulo' },
        { headerCity: 'Bras%C3%ADlia', expected: 'Brasília' },
        { headerCity: 'M%C3%BCnchen', expected: 'München' },
        { headerCity: 'Montr%C3%A9al', expected: 'Montréal' }
      ];

      for (const tc of testCases) {
        resetMemoryRooms();
        mockReq.method = 'POST';
        mockReq.headers = {
          'x-vercel-ip-country': 'BR',
          'x-vercel-ip-country-region': 'SP',
          'x-vercel-ip-city': tc.headerCity
        };
        mockReq.body = { id: 'sala-geo' };
        vi.clearAllMocks();

        await handler(mockReq, mockRes);
        expect(statusMock).toHaveBeenCalledWith(200);

        mockReq.method = 'GET';
        mockReq.body = null;
        vi.clearAllMocks();

        await handler(mockReq, mockRes);
        const room = jsonMock.mock.calls[0][0].rooms[0];
        expect(room.city).toBe(tc.expected);
        expect(room.locationText).toContain(tc.expected);
      }
    });

    it('deve gerar bandeiras corretas para países dos principais continentes', () => {
      expect(countryCodeToEmoji('CA')).toBe('🇨🇦');
      expect(countryCodeToEmoji('FR')).toBe('🇫🇷');
      expect(countryCodeToEmoji('GB')).toBe('🇬🇧');
      expect(countryCodeToEmoji('AR')).toBe('🇦🇷');
      expect(countryCodeToEmoji('CL')).toBe('🇨🇱');
      expect(countryCodeToEmoji('KR')).toBe('🇰🇷');
      expect(countryCodeToEmoji('AU')).toBe('🇦🇺');
    });
  });

  describe('Ordenação e Capacidade em Alta Concorrência', () => {
    it('deve ordenar 15 salas simultâneas por número de membros decrescente', async () => {
      for (let i = 1; i <= 15; i++) {
        mockReq.method = 'POST';
        mockReq.body = {
          id: `sala-${i}`,
          title: `Sala ${i}`,
          memberCount: i
        };
        await handler(mockReq, mockRes);
      }

      mockReq.method = 'GET';
      mockReq.body = null;
      vi.clearAllMocks();

      await handler(mockReq, mockRes);
      const { rooms, count } = jsonMock.mock.calls[0][0];
      expect(count).toBe(15);
      expect(rooms[0].memberCount).toBe(15);
      expect(rooms[0].id).toBe('sala-15');
      expect(rooms[14].memberCount).toBe(1);
      expect(rooms[14].id).toBe('sala-1');
    });
  });

  describe('Resiliência do RoomPublisher', () => {
    it('deve sobreviver a falha temporária de rede no heartbeat e retomar no próximo ciclo', async () => {
      vi.useFakeTimers();
      const publisher = new RoomPublisher();

      let calls = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        calls++;
        if (calls === 2) {
          // Segundo envio (aos 60s) falha com erro de rede
          throw new Error('Falha de rede / Timeout 504');
        }
        return { ok: true };
      });

      await publisher.start({ roomId: 'sala-resiliente' });
      expect(publisher.isActive).toBe(true);
      expect(calls).toBe(1);

      // Avança 60s -> falha ocorre
      vi.advanceTimersByTime(60_000);
      expect(calls).toBe(2);
      expect(publisher.isActive).toBe(true); // não crashou nem morreu

      // Avança mais 60s -> terceiro heartbeat recupera
      vi.advanceTimersByTime(60_000);
      expect(calls).toBe(3);
      expect(publisher.isActive).toBe(true);

      await publisher.stop();
      vi.useRealTimers();
    });

    it('DELETE com secretKey incorreta deve ser rejeitado no backend', async () => {
      // Cria com secretKey A
      mockReq.method = 'POST';
      mockReq.body = { id: 'sala-segura', secretKey: 'chave-a' };
      await handler(mockReq, mockRes);

      // Tenta apagar com secretKey B
      mockReq.method = 'DELETE';
      mockReq.url = '/api/rooms?id=sala-segura&secret=chave-b';
      mockReq.body = null;
      vi.clearAllMocks();

      await handler(mockReq, mockRes);
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ ok: true, deleted: false }));

      // Confirma que a sala continua viva
      mockReq.method = 'GET';
      mockReq.url = '/api/rooms';
      vi.clearAllMocks();

      await handler(mockReq, mockRes);
      expect(jsonMock.mock.calls[0][0].count).toBe(1);
    });
  });
});
