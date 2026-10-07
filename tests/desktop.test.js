import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
    isDesktopApp, 
    invokeDesktopCommand, 
    getCapturableWindows, 
    setHighPriority, 
    toggleAlwaysOnTop, 
    isAlwaysOnTop,
    createNativeViewerPeer,
    addNativeViewerIceCandidate,
    closeNativeViewerPeer
} from '../js/desktop.js';

describe('Módulo: desktop.js (Tauri v2 / Rust Integration)', () => {
    const originalTauri = window.__TAURI_INTERNALS__;

    beforeEach(() => {
        delete window.__TAURI_INTERNALS__;
        delete window.__TAURI__;
    });

    afterEach(() => {
        if (originalTauri) {
            window.__TAURI_INTERNALS__ = originalTauri;
        } else {
            delete window.__TAURI_INTERNALS__;
        }
        delete window.__TAURI__;
    });

    it('deve identificar ambiente web padrão como não-desktop', () => {
        expect(isDesktopApp()).toBe(false);
    });

    it('deve identificar ambiente desktop quando window.__TAURI_INTERNALS__ estiver presente', () => {
        window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
        expect(isDesktopApp()).toBe(true);
    });

    it('deve lançar erro ao tentar invocar comando fora do ambiente desktop', async () => {
        await expect(invokeDesktopCommand('test_cmd')).rejects.toThrow('Ambiente desktop Tauri não detectado');
    });

    it('deve chamar __TAURI_INTERNALS__.invoke com o comando e argumentos corretos', async () => {
        const mockInvoke = vi.fn().mockResolvedValue({ success: true });
        window.__TAURI_INTERNALS__ = { invoke: mockInvoke };

        const res = await invokeDesktopCommand('custom_cmd', { foo: 'bar' });
        expect(mockInvoke).toHaveBeenCalledWith('custom_cmd', { foo: 'bar' });
        expect(res).toEqual({ success: true });
    });

    it('getCapturableWindows deve retornar array vazio em ambiente web', async () => {
        const list = await getCapturableWindows();
        expect(list).toEqual([]);
    });

    it('getCapturableWindows deve invocar list_capturable_windows e retornar a lista de janelas em desktop', async () => {
        const mockWindows = [
            { id: '1234', title: 'Counter-Strike 2', process_name: 'cs2.exe', is_minimized: false },
            { id: '5678', title: 'Discord', process_name: 'Discord.exe', is_minimized: false }
        ];
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue(mockWindows)
        };

        const list = await getCapturableWindows();
        expect(list).toHaveLength(2);
        expect(list[0].title).toBe('Counter-Strike 2');
        expect(list[0].process_name).toBe('cs2.exe');
    });

    it('setHighPriority deve invocar set_high_priority e retornar true', async () => {
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue(true)
        };

        const result = await setHighPriority();
        expect(result).toBe(true);
    });

    it('setHighPriority deve retornar false em caso de falha', async () => {
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockRejectedValue(new Error('Permission denied'))
        };

        const result = await setHighPriority();
        expect(result).toBe(false);
    });

    it('toggleAlwaysOnTop deve invocar toggle_always_on_top e alternar estado', async () => {
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue(true)
        };

        const res = await toggleAlwaysOnTop();
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('toggle_always_on_top', {});
        expect(res).toBe(true);
    });

    it('toggleAlwaysOnTop deve retornar false em ambiente web', async () => {
        const res = await toggleAlwaysOnTop();
        expect(res).toBe(false);
    });

    it('isAlwaysOnTop deve invocar is_always_on_top e retornar booleano', async () => {
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue(false)
        };

        const res = await isAlwaysOnTop();
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('is_always_on_top', {});
        expect(res).toBe(false);
    });

    it('createNativeViewerPeer deve invocar create_native_viewer_peer com parâmetros corretos', async () => {
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0...' })
        };
        const res = await createNativeViewerPeer('session-1', 'viewer-a', 'v=0\r\no=...');
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('create_native_viewer_peer', {
            sessionId: 'session-1',
            viewerId: 'viewer-a',
            offerSdp: 'v=0\r\no=...'
        });
        expect(res.type).toBe('answer');
    });

    it('createNativeViewerPeer deve propagar iceServers se fornecido', async () => {
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0...' })
        };
        const res = await createNativeViewerPeer('session-1', 'viewer-a', 'v=0\r\no=...', ['turn:user:pass@turn.example.com:3478']);
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('create_native_viewer_peer', {
            sessionId: 'session-1',
            viewerId: 'viewer-a',
            offerSdp: 'v=0\r\no=...',
            iceServers: ['turn:user:pass@turn.example.com:3478']
        });
        expect(res.type).toBe('answer');
    });

    it('serializes browser STUN/TURN objects to the Rust Vec<String> contract', async () => {
        const { DEFAULT_ICE_SERVERS } = await import('../js/config.js');
        window.__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue({ sdp: 'answer' }) };
        await createNativeViewerPeer('capture', 'guest', 'v=0 offer', DEFAULT_ICE_SERVERS, 'generation');
        const payload = window.__TAURI_INTERNALS__.invoke.mock.calls[0][1];
        expect(payload.negotiationId).toBe('generation');
        expect(payload.iceServers).toEqual([
            ...DEFAULT_ICE_SERVERS.slice(0, 6).map(server => server.urls),
            'turn://0fef8ed280773c0576776519:h7BwoMMBzRcnz2R5@br.relay.metered.ca:80',
            'turn://0fef8ed280773c0576776519:h7BwoMMBzRcnz2R5@br.relay.metered.ca:443',
            'turns://0fef8ed280773c0576776519:h7BwoMMBzRcnz2R5@br.relay.metered.ca:443?transport=tcp'
        ]);
    });

    it('normalizes multiple TURN URLs and escaped credentials for both native commands', async () => {
        const { startNativeViewer } = await import('../js/desktop.js');
        window.__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue({ sdp: 'answer' }) };
        const servers = [{ urls: ['turn:relay.example:3478?transport=udp', 'turns:relay.example:443'], username: 'user:@ /', credential: 'p@ss:/?' }, { urls: 'stun:stun.example:3478' }];
        await createNativeViewerPeer('capture', 'guest', 'offer', servers);
        await startNativeViewer('host', 'offer', servers, false);
        for (const [, payload] of window.__TAURI_INTERNALS__.invoke.mock.calls) {
            expect(payload.iceServers).toEqual([
                'turn://user%3A%40%20%2F:p%40ss%3A%2F%3F@relay.example:3478?transport=udp',
                'turns://user%3A%40%20%2F:p%40ss%3A%2F%3F@relay.example:443',
                'stun:stun.example:3478'
            ]);
        }
    });

    it('addNativeViewerIceCandidate deve invocar add_native_viewer_ice_candidate com tipos corretos', async () => {
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue(null)
        };
        await addNativeViewerIceCandidate('session-1', 'viewer-a', '0', 'candidate:1 1 UDP ...');
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('add_native_viewer_ice_candidate', {
            sessionId: 'session-1',
            viewerId: 'viewer-a',
            mlineIndex: 0,
            candidate: 'candidate:1 1 UDP ...'
        });
    });

    it('closeNativeViewerPeer deve invocar close_native_viewer_peer', async () => {
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue(null)
        };
        await closeNativeViewerPeer('session-1', 'viewer-a');
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('close_native_viewer_peer', {
            sessionId: 'session-1',
            viewerId: 'viewer-a'
        });
    });

    it('installViGEmDriver deve invocar install_vigem_driver no desktop', async () => {
        const { installViGEmDriver, checkVirtualGamepadDriver } = await import('../js/desktop.js');
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockImplementation((cmd) => {
                if (cmd === 'install_vigem_driver') return Promise.resolve('Driver instalado');
                if (cmd === 'check_gamepad_driver_status') return Promise.resolve({ vigem_available: true, active_slots: [] });
                return Promise.resolve(null);
            })
        };
        const status = await checkVirtualGamepadDriver();
        expect(status.vigem_available).toBe(true);

        const res = await installViGEmDriver();
        expect(res).toBe('Driver instalado');
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('install_vigem_driver');
    });

    it('startNativeViewer deve invocar start_native_viewer no desktop', async () => {
        const { startNativeViewer, addNativeViewerCandidate, stopNativeViewer } = await import('../js/desktop.js');
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockImplementation((cmd) => {
                if (cmd === 'start_native_viewer') return Promise.resolve({ type: 'answer', sdp: 'v=0...' });
                if (cmd === 'add_native_viewer_candidate') return Promise.resolve();
                if (cmd === 'stop_native_viewer') return Promise.resolve();
                return Promise.resolve(null);
            })
        };
        const answer = await startNativeViewer('host-42', 'v=0 offer', ['stun:stun.l.google.com:19302'], true);
        expect(answer.type).toBe('answer');
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('start_native_viewer', {
            hostId: 'host-42',
            offerSdp: 'v=0 offer',
            iceServers: ['stun:stun.l.google.com:19302'],
            openDedicatedWindow: true
        });

        await addNativeViewerCandidate(0, 'candidate:123');
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('add_native_viewer_candidate', {
            mlineIndex: 0,
            candidate: 'candidate:123'
        });

        await stopNativeViewer();
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('stop_native_viewer');
    });

    it('getAudioExclusionCandidates deve retornar lista normalizada de candidatos no desktop', async () => {
        const { getAudioExclusionCandidates } = await import('../js/desktop.js');
        const mockCandidates = [
            { id: 'seemygame', label: '🎮 SeeMyGame (Ignorar Voz)', process_name: 'seemygame.exe', process_id: 1234, is_running: true },
            { id: 'discord', label: '🎧 Discord', process_name: 'Discord.exe', process_id: 5678, is_running: true },
            { id: 'pid:9999', label: '📱 Spotify (Spotify.exe)', process_name: 'Spotify.exe', process_id: 9999, is_running: true }
        ];
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockResolvedValue(mockCandidates)
        };

        const result = await getAudioExclusionCandidates();
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('list_audio_exclusion_candidates');
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({
            id: 'seemygame',
            label: '🎮 SeeMyGame (Ignorar Voz)',
            processName: 'seemygame.exe',
            processId: 1234,
            isRunning: true
        });
        expect(result[1].processId).toBe(5678);
    });

    it('startNativeCapture e reconfigureNativeCapture devem repassar excludeApp e normalizar estado', async () => {
        const { startNativeCapture, reconfigureNativeCapture } = await import('../js/desktop.js');
        const mockState = {
            state: 'live',
            session_id: 'session-42',
            source_id: 'capture_1_window_0',
            audio_mode: 'system',
            exclude_app: 'seemygame',
            exclude_pid: 1234
        };
        window.__TAURI_INTERNALS__ = {
            invoke: vi.fn().mockImplementation((cmd, args) => {
                if (cmd === 'start_native_capture') {
                    return Promise.resolve({ ...mockState, exclude_app: args.excludeApp });
                }
                if (cmd === 'reconfigure_native_capture') {
                    return Promise.resolve({ ...mockState, exclude_app: args.excludeApp, exclude_pid: 5678 });
                }
                return Promise.resolve(null);
            })
        };

        const started = await startNativeCapture({
            sourceId: 'capture_1_window_0',
            audioMode: 'system',
            excludeApp: 'discord'
        });
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('start_native_capture', expect.objectContaining({
            sourceId: 'capture_1_window_0',
            audioMode: 'system',
            excludeApp: 'discord'
        }));
        expect(started.excludeApp).toBe('discord');

        const reconfigured = await reconfigureNativeCapture({
            sessionId: 'session-42',
            excludeApp: 'none'
        });
        expect(window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('reconfigure_native_capture', {
            sessionId: 'session-42',
            excludeApp: 'none'
        });
        expect(reconfigured.excludeApp).toBe('none');
        expect(reconfigured.excludePid).toBe(5678);
    });
});

