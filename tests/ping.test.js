import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TacticalPingManager } from '../js/ping.js';

describe('Módulo: ping.js (TacticalPingManager)', () => {
  let manager;
  let mockCanvas;
  let mockCtx;

  beforeEach(() => {
    mockCtx = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
    };

    mockCanvas = {
      width: 1280,
      height: 720,
      getContext: vi.fn(() => mockCtx),
    };

    manager = new TacticalPingManager();
    manager.setCanvas(mockCanvas);
  });

  afterEach(() => manager.dispose());

  it('keeps an empty active trail renderable when drawing starts between frames', () => {
    manager.startLaserTrail();
    manager.render();
    manager.addLaserPoint({ x: .1, y: .2 });
    manager.render();
    expect(manager.laserTrails).toHaveLength(1);
    expect(mockCtx.arc).toHaveBeenCalledWith(128, 144, 3, 0, Math.PI * 2);
    expect(mockCtx.fill).toHaveBeenCalled();
  });

  it('resumes drawing after all previous points expire and removes a stopped empty trail', () => {
    manager.addLaserPoint({ x: .1, y: .2 });
    manager.currentLaserTrail.points[0].time = Date.now() - 3000;
    manager.render();
    manager.addLaserPoint({ x: .3, y: .4 });
    manager.render();
    expect(manager.laserTrails).toHaveLength(1);
    expect(mockCtx.arc).toHaveBeenLastCalledWith(384, 288, 3, 0, Math.PI * 2);
    manager.stopLaserTrail();
    manager.laserTrails[0].points[0].time = Date.now() - 3000;
    manager.render();
    expect(manager.laserTrails).toHaveLength(0);
  });

  it('continues a long stroke beyond the point limit', () => {
    manager.maxLaserPoints = 2;
    for (const x of [.1, .2, .3]) manager.addLaserPoint({ x, y: .5 });
    expect(manager.currentLaserTrail.points.map(p => p.x)).toEqual([.2, .3]);
  });

  it('recreates a visible trail after its previous trail was evicted', () => {
    manager.maxLaserTrails = 1;
    manager.addLaserPoint({ senderId: 'alice', x: .1, y: .2 });
    manager.addLaserPoint({ senderId: 'bob', x: .3, y: .4 });
    expect(manager.activeLaserTrails.has('alice')).toBe(false);
    manager.addLaserPoint({ senderId: 'alice', x: .5, y: .6 });
    expect(manager.laserTrails[0].senderId).toBe('alice');
    expect(manager.laserTrails[0].points[0].x).toBe(.5);
  });

  it('deve adicionar um ping tático com coordenadas clampadas entre 0 e 1', () => {
    const ping = manager.addPing({ x: 0.5, y: 0.75, senderName: 'Player1' });

    expect(ping).toBeDefined();
    expect(ping.x).toBe(0.5);
    expect(ping.y).toBe(0.75);
    expect(ping.senderName).toBe('Player1');
    expect(manager.pings.length).toBe(1);

    // Teste com valor fora dos limites
    const outOfBounds = manager.addPing({ x: -0.2, y: 1.5 });
    expect(outOfBounds.x).toBe(0);
    expect(outOfBounds.y).toBe(1);
  });

  it('deve suportar tipo danger com cor vermelha padrão', () => {
    const danger = manager.addPing({ x: 0.2, y: 0.2, type: 'danger' });
    expect(danger.color).toBe('#ef4444');
  });

  it('deve iniciar e adicionar pontos ao traço de laser', () => {
    manager.startLaserTrail({ color: '#ff00ff' });
    expect(manager.isDrawingLaser).toBe(true);

    manager.addLaserPoint({ x: 0.1, y: 0.2 });
    manager.addLaserPoint({ x: 0.3, y: 0.4 });

    expect(manager.laserTrails.length).toBe(1);
    expect(manager.laserTrails[0].points.length).toBe(2);
    expect(manager.laserTrails[0].color).toBe('#ff00ff');

    manager.stopLaserTrail();
    expect(manager.isDrawingLaser).toBe(false);
  });

  it('deve isolar traçados de laser entre diferentes remetentes (sem conectar traços de pessoas distintas)', () => {
    // Usuário A desenha
    manager.startLaserTrail({ senderId: 'user-a', color: '#10b981' });
    manager.addLaserPoint({ senderId: 'user-a', x: 0.1, y: 0.1 });
    manager.addLaserPoint({ senderId: 'user-a', x: 0.2, y: 0.2 });

    // Usuário B desenha simultaneamente
    manager.startLaserTrail({ senderId: 'user-b', color: '#3b82f6' });
    manager.addLaserPoint({ senderId: 'user-b', x: 0.8, y: 0.8 });
    manager.addLaserPoint({ senderId: 'user-b', x: 0.9, y: 0.9 });

    // Ambos devem ter trilhas separadas
    expect(manager.laserTrails.length).toBe(2);

    const trailA = manager.laserTrails.find(t => t.senderId === 'user-a');
    const trailB = manager.laserTrails.find(t => t.senderId === 'user-b');

    expect(trailA).toBeDefined();
    expect(trailB).toBeDefined();
    expect(trailA.points.length).toBe(2);
    expect(trailB.points.length).toBe(2);

    // Pontos do usuário A não devem conter coordenadas de B
    expect(trailA.points[0].x).toBe(0.1);
    expect(trailA.points[1].x).toBe(0.2);
    expect(trailB.points[0].x).toBe(0.8);
    expect(trailB.points[1].x).toBe(0.9);

    // Parar o traço do usuário A não deve afetar a trilha ativa do usuário B
    manager.stopLaserTrail('user-a');
    expect(manager.activeLaserTrails.has('user-a')).toBe(false);
    expect(manager.activeLaserTrails.has('user-b')).toBe(true);

    // Usuário B continua adicionando pontos
    manager.addLaserPoint({ senderId: 'user-b', x: 0.95, y: 0.95 });
    expect(trailB.points.length).toBe(3);
  });

  it('clear(senderId) deve remover apenas a trilha do remetente especificado', () => {
    manager.addLaserPoint({ senderId: 'peer-1', x: 0.1, y: 0.1 });
    manager.addLaserPoint({ senderId: 'peer-2', x: 0.5, y: 0.5 });
    expect(manager.laserTrails.length).toBe(2);

    manager.clear('peer-1');
    expect(manager.laserTrails.length).toBe(1);
    expect(manager.laserTrails[0].senderId).toBe('peer-2');
  });

  it('render() deve desenhar pings e lasers chamando métodos do contexto 2D', () => {
    manager.addPing({ x: 0.5, y: 0.5, senderName: 'Tester' });
    manager.startLaserTrail();
    manager.addLaserPoint({ x: 0.1, y: 0.1 });
    manager.addLaserPoint({ x: 0.2, y: 0.2 });

    manager.render();

    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 1280, 720);
    expect(mockCtx.arc).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
  });

  it('render() deve expirar pings após a duração configurada', () => {
    const ping = manager.addPing({ x: 0.5, y: 0.5, duration: 100 });
    expect(manager.pings.length).toBe(1);

    // Força o startTime para o passado
    ping.startTime = Date.now() - 500;

    manager.render();
    expect(manager.pings.length).toBe(0);
  });

  it('clear() deve limpar pings e lasers', () => {
    manager.addPing({ x: 0.1, y: 0.1 });
    manager.startLaserTrail();
    manager.addLaserPoint({ x: 0.2, y: 0.2 });

    manager.clear();
    expect(manager.pings.length).toBe(0);
    expect(manager.laserTrails.length).toBe(0);
    expect(mockCtx.clearRect).toHaveBeenCalled();
  });
});
