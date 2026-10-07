import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnnotateManager } from '../js/room/annotate.js';
import { PollManager } from '../js/room/poll-manager.js';
import { MultitrackRecorder } from '../js/room/multitrack-recorder.js';
import { ZipBuilder, calculateCrc32 } from '../js/utils/zip-builder.js';
import { StreamerModeController } from '../js/room/streamer-mode.js';
import { PipController } from '../js/room/pip-controller.js';
import { createParticipantVolumePopover } from '../js/ui/participant-controls.js';

describe('Adversarial & Edge Case Tests: Suite de Ferramentas de Sala', () => {

  // =========================================================================
  // 1. ANNOTATE MANAGER (TELESTRATOR) ADVERSARIAL TESTS
  // =========================================================================
  describe('AnnotateManager - Adversarial & Boundary Tests', () => {
    let annotate;
    let container;

    beforeEach(() => {
      container = document.createElement('div');
      container.getBoundingClientRect = () => ({
        width: 800,
        height: 600,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600
      });
      document.body.appendChild(container);
      annotate = new AnnotateManager();
      annotate.attach(container);
    });

    afterEach(() => {
      vi.useRealTimers();
      annotate.detach();
      if (container.parentElement) {
        container.parentElement.removeChild(container);
      }
    });

    it('renderiza corretamente clique único (1 ponto/ponto isolado) sem falhas', () => {
      annotate.strokes.push({
        id: 'stroke-single-dot',
        tool: 'pen',
        color: '#ff0000',
        width: 6,
        points: [{ x: 0.5, y: 0.5 }]
      });

      // redraw deve executar sem erros
      expect(() => annotate.redraw()).not.toThrow();
      expect(annotate.strokes).toHaveLength(1);
    });

    it('ignora coordenadas malformadas ou NaN e não interrompe o canvas', () => {
      annotate.strokes.push({
        id: 'stroke-malformed',
        tool: 'pen',
        points: [
          { x: NaN, y: 0.5 },
          { x: 0.2, y: undefined },
          { x: 0.4, y: 0.4 },
          { x: Infinity, y: -Infinity }
        ]
      });

      expect(() => annotate.redraw()).not.toThrow();
    });

    it('desenha seta com distância nula ou minúscula sem erro de trigonometria', () => {
      annotate.strokes.push({
        id: 'arrow-zero-length',
        tool: 'arrow',
        shapeStart: { x: 0.3, y: 0.3 },
        shapeEnd: { x: 0.3, y: 0.3 }, // distância 0
        width: 4
      });

      expect(() => annotate.redraw()).not.toThrow();
    });

    it('suporta stress de 100 traços consecutivos com alta frequência', () => {
      for (let i = 0; i < 100; i++) {
        annotate.strokes.push({
          id: `stress-stroke-${i}`,
          tool: i % 2 === 0 ? 'pen' : 'highlighter',
          points: [
            { x: i / 100, y: i / 100 },
            { x: (i + 1) / 100, y: (i + 1) / 100 }
          ],
          width: 4
        });
      }

      expect(annotate.strokes).toHaveLength(100);
      expect(() => annotate.redraw()).not.toThrow();

      // Borracha com raio amplo apagando múltiplos traços
      annotate._eraseNear({ x: 0.5, y: 0.5 }, 0.2);
      expect(annotate.strokes.length).toBeLessThan(100);
    });

    it('gerencia e limpa todos os timers de auto-clear ao limpar ou desconectar', () => {
      vi.useFakeTimers();
      annotate.setAutoClear(true, 2000);

      annotate.currentStroke = {
        id: 'timed-stroke',
        tool: 'pen',
        points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]
      };
      annotate._onPointerUp();

      expect(annotate.strokes).toHaveLength(1);
      expect(annotate.autoClearTimers.size).toBe(1);

      // Limpar deve cancelar os timeouts pendentes
      annotate.clear();
      expect(annotate.strokes).toHaveLength(0);
      expect(annotate.autoClearTimers.size).toBe(0);

      // Avançar o tempo não deve ressuscitar nem tentar remover
      vi.advanceTimersByTime(3000);
      expect(annotate.strokes).toHaveLength(0);

      vi.useRealTimers();
    });

    it('responde ao ciclo de sincronização de novo participante (ANNOTATE_REQUEST_SYNC -> ANNOTATE_SYNC)', () => {
      const broadcast = vi.fn();
      annotate.setBroadcast(broadcast);

      annotate.strokes.push({ id: 's1', tool: 'pen', points: [{ x: 0.1, y: 0.1 }] });

      // Mensagem recebida de um participante recém-conectado
      annotate.handleRemoteMessage({ type: 'ANNOTATE_REQUEST_SYNC' });

      expect(broadcast).toHaveBeenCalledWith({
        type: 'ANNOTATE_SYNC',
        strokes: annotate.strokes
      });
    });

    it('ignora pacotes remotos corrompidos ou desconhecidos', () => {
      expect(() => annotate.handleRemoteMessage(null)).not.toThrow();
      expect(() => annotate.handleRemoteMessage({})).not.toThrow();
      expect(() => annotate.handleRemoteMessage('string-invalida')).not.toThrow();
      expect(() => annotate.handleRemoteMessage({ type: 'UNKNOWN_TOOL_ACTION' })).not.toThrow();
    });
  });

  // =========================================================================
  // 2. POLL MANAGER ADVERSARIAL TESTS
  // =========================================================================
  describe('PollManager - Adversarial & Boundary Tests', () => {
    let pollMgr;

    beforeEach(() => {
      pollMgr = new PollManager();
    });

    afterEach(() => {
      pollMgr._clearTimer();
    });

    it('formata adequadamente sumário de enquete encerrada com ZERO votos', () => {
      const poll = pollMgr.createPoll({
        question: 'Alguém online?',
        options: ['Sim', 'Não'],
        durationSeconds: 30
      });

      const results = pollMgr.endPoll(poll.id);
      expect(results.totalVotes).toBe(0);
      expect(results.winner).toBeNull();
      expect(results.isTie).toBe(false);

      const summary = pollMgr.formatResultSummary(results);
      expect(summary).toContain('Nenhum voto registrado');
    });

    it('detecta e formata empate triplo (3-way tie)', () => {
      const poll = pollMgr.createPoll({
        question: 'Escolha de jogo',
        options: ['Valorant', 'CS2', 'Apex'],
        durationSeconds: 30
      });

      pollMgr.vote(poll.id, 0, 'player-1');
      pollMgr.vote(poll.id, 1, 'player-2');
      pollMgr.vote(poll.id, 2, 'player-3');

      const results = pollMgr.getResults();
      expect(results.totalVotes).toBe(3);
      expect(results.isTie).toBe(true);
      expect(results.winner).toBeNull();

      const summary = pollMgr.formatResultSummary(results);
      expect(summary).toContain('Empate entre as opções mais votadas');
    });

    it('suporta alternância rápida de voto pelo mesmo usuário', () => {
      const poll = pollMgr.createPoll({
        question: 'Mapa da partida',
        options: ['Mirage', 'Inferno', 'Dust II'],
        durationSeconds: 60
      });

      // Jogador 1 muda de ideia 10 vezes
      for (let i = 0; i < 10; i++) {
        const optIdx = i % 3;
        pollMgr.vote(poll.id, optIdx, 'voter-123');
      }

      // O total de votos deve ser exatamente 1 na opção 0 (9 % 3 === 0)
      const results = pollMgr.getResults();
      expect(results.totalVotes).toBe(1);
      expect(poll.options[0].voterIds).toEqual(['voter-123']);
    });

    it('rejeita votos com índices inválidos, NaN ou strings sem quebrar o estado', () => {
      const poll = pollMgr.createPoll({
        question: 'Dúvida',
        options: ['A', 'B']
      });

      expect(pollMgr.vote(poll.id, -1, 'user1')).toBe(false);
      expect(pollMgr.vote(poll.id, 999, 'user1')).toBe(false);
      expect(pollMgr.vote(poll.id, NaN, 'user1')).toBe(false);
      expect(pollMgr.vote(poll.id, 'invalido', 'user1')).toBe(false);
      expect(pollMgr.vote(poll.id, 0, '')).toBe(false); // voterId vazio
      expect(pollMgr.vote(poll.id, 0, null)).toBe(false);

      expect(pollMgr.getResults().totalVotes).toBe(0);
    });

    it('sanitiza injeção de HTML e aspas nas opções e perguntas', () => {
      const poll = pollMgr.createPoll({
        question: '<script>alert("xss")</script> Qual o melhor?',
        options: ['<b>Negrito</b>', 'Opção "Com Aspas" & Símbolos'],
        creatorName: '<img src=x onerror=alert(1)>'
      });

      const container = document.createElement('div');
      pollMgr.renderPollCard(container, 'user-1');

      // Não deve conter scripts executáveis no innerHTML não escapados
      const titles = Array.from(container.querySelectorAll('.poll-option-title')).map(el => el.textContent);
      expect(titles[0]).toContain('<b>Negrito</b>');
      expect(titles[1]).toContain('Opção "Com Aspas" & Símbolos');
    });

    it('sincroniza enquetes ativas para participantes que entraram tardiamente (POLL_SYNC_REQUEST)', () => {
      const broadcast = vi.fn();
      pollMgr.setBroadcast(broadcast);

      pollMgr.createPoll({
        question: 'Enquete em andamento',
        options: ['Opção 1', 'Opção 2']
      });

      pollMgr.handleRemoteMessage({ type: 'POLL_SYNC_REQUEST' });

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'POLL_SYNC',
        poll: expect.objectContaining({
          question: 'Enquete em andamento',
          isActive: true
        })
      }));
    });
  });

  // =========================================================================
  // 3. ZIP BUILDER & MULTITRACK RECORDER ADVERSARIAL TESTS
  // =========================================================================
  describe('ZipBuilder & MultitrackRecorder - Robustness Tests', () => {
    it('remove barras iniciais e barras invertidas de nomes de arquivos para conformidade PKZIP', async () => {
      const zip = new ZipBuilder();
      await zip.addFile('/pasta/subpasta/arquivo.txt', 'conteudo');
      await zip.addFile('\\windows\\estilo\\outro.txt', 'outro conteudo');

      expect(zip.entries[0].name).toBe('pasta/subpasta/arquivo.txt');
      expect(zip.entries[1].name).toBe('windows/estilo/outro.txt');

      const blob = zip.buildBlob();
      expect(blob.size).toBeGreaterThan(0);
    });

    it('manipula arquivos com caracteres Unicode/UTF-8 e emojis', async () => {
      const zip = new ZipBuilder();
      await zip.addFile('trilhas/Áudio do Participante 🎮.webm', 'áudio binário simulado 🎧');

      const blob = zip.buildBlob();
      expect(blob.size).toBeGreaterThan(0);
    });

    it('calcula CRC-32 correto e cria arquivo válido para arquivos de 0 bytes', async () => {
      const crcZero = calculateCrc32(new Uint8Array(0));
      expect(crcZero).toBe(0);

      const zip = new ZipBuilder();
      await zip.addFile('empty.bin', new Uint8Array(0));
      const blob = zip.buildBlob();
      expect(blob.size).toBeGreaterThan(0);
    });

    it('mascara com segurança datas extremas para formato MS-DOS sem overflow', async () => {
      const zip = new ZipBuilder();
      // Data antes de 1980 (deve clampar para 1980)
      await zip.addFile('antigo.txt', 'texto', new Date('1970-01-01'));
      // Data no futuro distante
      await zip.addFile('futuro.txt', 'texto', new Date('2099-12-31T23:59:59'));

      expect(() => zip.build()).not.toThrow();
    });

    it('MultitrackRecorder lança erro claro se nenhuma trilha for fornecida', async () => {
      const recorder = new MultitrackRecorder();
      await expect(recorder.startRecording({})).rejects.toThrow('Nenhuma faixa de mídia ativa');
    });

    it('MultitrackRecorder impede início duplo simultâneo', async () => {
      const recorder = new MultitrackRecorder();
      const fakeStream = {
        getTracks: () => [{ id: 'track-1', stop: vi.fn() }],
        getVideoTracks: () => []
      };

      // Mock MediaRecorder se não existir no ambiente de teste
      globalThis.MediaRecorder = class {
        constructor() {
          this.state = 'inactive';
        }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
      };

      await recorder.startRecording({ track1: fakeStream });
      await expect(recorder.startRecording({ track2: fakeStream })).rejects.toThrow('Uma gravação já está em andamento');

      await recorder.stopRecording();
      expect(recorder.isRecording).toBe(false);
    });
  });

  // =========================================================================
  // 4. STREAMER MODE ADVERSARIAL TESTS
  // =========================================================================
  describe('StreamerModeController - Dynamic DOM & Stress', () => {
    let streamer;

    beforeEach(() => {
      try { localStorage.clear(); } catch (_) {}
      streamer = new StreamerModeController();
      document.title = 'SeeMyGame - Lobby Inicial';
    });

    afterEach(() => {
      streamer.destroy();
      try { localStorage.clear(); } catch (_) {}
    });

    it('suporta 50 alternâncias consecutivas mantendo a coerência de estado', () => {
      for (let i = 0; i < 50; i++) {
        streamer.toggle();
      }
      expect(streamer.enabled).toBe(false);
      expect(document.body.classList.contains('streamer-mode-active')).toBe(false);
      expect(document.title).toBe('SeeMyGame - Lobby Inicial');
    });

    it('MutationObserver detecta e mascara novos inputs de código inseridos dinamicamente', async () => {
      streamer.init();
      streamer.setStreamerMode(true);

      // Inserir um novo campo de código no DOM após o modo streamer estar ativo
      const newCodeInput = document.createElement('input');
      newCodeInput.id = 'share-room-code-display';
      newCodeInput.value = 'ABCD-1234';
      document.body.appendChild(newCodeInput);

      // Aguarda o callback de microtask/MutationObserver
      await new Promise(r => setTimeout(r, 50));

      expect(newCodeInput.value).toBe('••••••••');
      expect(newCodeInput.dataset.realValue).toBe('ABCD-1234');

      newCodeInput.remove();
    });

    it('responde tanto ao atalho Ctrl+Shift+S quanto Cmd+Shift+S', () => {
      streamer.init();

      // Ctrl + Shift + S
      streamer.onKeydown({ ctrlKey: true, shiftKey: true, key: 'S', preventDefault: vi.fn() });
      expect(streamer.enabled).toBe(true);

      // Meta (Cmd no Mac) + Shift + s
      streamer.onKeydown({ metaKey: true, shiftKey: true, key: 's', preventDefault: vi.fn() });
      expect(streamer.enabled).toBe(false);
    });
  });

  // =========================================================================
  // 5. PARTICIPANT CONTROLS & VOICE MIXER BOUNDARY TESTS
  // =========================================================================
  describe('ParticipantControls - Boundary & Accessibility Tests', () => {
    it('fecha o popover de volume ao pressionar a tecla Escape', () => {
      const mockVoiceManager = {
        getUserVolume: vi.fn().mockReturnValue(100),
        setUserVolume: vi.fn(),
        isUserLocallyMuted: vi.fn().mockReturnValue(false),
        setUserLocallyMuted: vi.fn()
      };

      const wrapper = createParticipantVolumePopover({
        peerId: 'peer-test-esc',
        name: 'Gamer 1',
        voiceManager: mockVoiceManager
      });

      document.body.appendChild(wrapper);
      const toggleBtn = wrapper.querySelector('.btn-participant-volume-toggle');
      const popover = wrapper.querySelector('.participant-volume-popover');

      // Abre popover
      toggleBtn.click();
      expect(popover.style.display).toBe('flex');

      // Pressiona Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(popover.style.display).toBe('none');

      wrapper.cleanup();
      wrapper.remove();
    });

    it('limpa listeners ao invocar cleanup sem deixar memory leak', () => {
      const mockVoiceManager = {
        getUserVolume: vi.fn().mockReturnValue(100),
        setUserVolume: vi.fn(),
        isUserLocallyMuted: vi.fn().mockReturnValue(false),
        setUserLocallyMuted: vi.fn()
      };

      const wrapper = createParticipantVolumePopover({
        peerId: 'peer-clean',
        voiceManager: mockVoiceManager
      });

      expect(() => wrapper.cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // 6. PIP CONTROLLER BOUNDARY TESTS
  // =========================================================================
  describe('PipController - Boundary Tests', () => {
    it('encerra PiP ativo antes de iniciar novo PiP em outro elemento', async () => {
      const pip = new PipController();
      const exitSpy = vi.spyOn(pip, 'exitPip').mockResolvedValue(true);

      const video1 = document.createElement('video');
      video1.requestPictureInPicture = vi.fn().mockResolvedValue({});

      pip.activePipVideo = video1;

      const video2 = document.createElement('video');
      video2.requestPictureInPicture = vi.fn().mockResolvedValue({});

      await pip.enterPip(video2);

      expect(exitSpy).toHaveBeenCalled();
    });

    it('lida com container sem elemento pai sem lançar erro de replaceChild', async () => {
      const pip = new PipController();
      const detachedContainer = document.createElement('div'); // sem parentElement
      const video = document.createElement('video');

      expect(detachedContainer.parentElement).toBeNull();
      // Não deve lançar erro
      await expect(pip.enterPip(video, detachedContainer)).resolves.not.toThrow();
    });
  });
});
