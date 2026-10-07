import { describe, it, expect, vi, beforeEach } from 'vitest';
import turnHandler from '../api/turn.js';

describe('Serverless: api/turn.js', () => {
  let mockReq;
  let mockRes;
  let statusMock;
  let jsonMock;
  let setHeaderMock;

  beforeEach(() => {
    jsonMock = vi.fn();
    statusMock = vi.fn(() => ({ json: jsonMock }));
    setHeaderMock = vi.fn();

    mockReq = { method: 'GET' };
    mockRes = {
      status: statusMock,
      json: jsonMock,
      setHeader: setHeaderMock
    };
  });

  it('deve retornar 405 para métodos diferentes de GET', async () => {
    mockReq.method = 'POST';
    await turnHandler(mockReq, mockRes);
    expect(statusMock).toHaveBeenCalledWith(405);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Method Not Allowed') }));
  });

  it('deve retornar lista de servidores ICE padrão quando variáveis de ambiente não estão definidas', async () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env.METERED_DOMAIN;
    delete process.env.METERED_API_KEY;

    await turnHandler(mockReq, mockRes);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
      iceServers: expect.any(Array),
      source: 'metered-openrelay-fallback'
    }));

    process.env = originalEnv;
  });

  it('deve retornar servidores estáticos quando TURN_USERNAME e TURN_PASSWORD estão configurados', async () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env.METERED_DOMAIN;
    delete process.env.METERED_API_KEY;
    process.env.TURN_USERNAME = '0fef8ed280773c0576776519';
    process.env.TURN_PASSWORD = 'h7BwoMMBzRcnz2R5';

    await turnHandler(mockReq, mockRes);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'metered-static-credentials',
      iceServers: expect.arrayContaining([
        expect.objectContaining({ urls: 'stun:stun.relay.metered.ca:80' }),
        expect.objectContaining({
          urls: 'turn:br.relay.metered.ca:80',
          username: '0fef8ed280773c0576776519',
          credential: 'h7BwoMMBzRcnz2R5'
        })
      ])
    }));

    process.env = originalEnv;
  });

  it('deve rejeitar origens externas não configuradas', async () => {
    mockReq.headers = { origin: 'https://evilseemygame.com' };

    await turnHandler(mockReq, mockRes);

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Origin not allowed' });
  });
});

