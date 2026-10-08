import { describe, it, expect } from 'vitest';
import { AdaptiveBitrateController } from '../js/abr.js';
import { RelayManager } from '../js/relay.js';
import { collectPeerMetrics } from '../js/stats/metrics.js';
import { tuneSdpForGaming } from '../js/webrtc/sdp.js';

const healthyLan = { packetLossRate: 0, rttMs: 2, isLan: true, isRelay: false };
const wan = { packetLossRate: 0, rttMs: 80, isLan: false, isRelay: true };
function candidateStats(type, addresses, rtt) {
  return [
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote', ...(rtt === undefined ? {} : { currentRoundTripTime: rtt }) },
    { id: 'local', type: 'local-candidate', candidateType: type, address: addresses[0] },
    { id: 'remote', type: 'remote-candidate', candidateType: type, address: addresses[1] },
  ];
}

describe('Revisão feat(lan): regressões não cobertas pelo commit', () => {
  it('R1: permite reduzir o alvo de 30 para 8 Mbps após reconhecer LAN', () => {
    const abr = new AdaptiveBitrateController({ targetBitrateBps: 30_000_000 });
    abr.processSample(healthyLan);
    abr.setTargetBitrate(8_000_000);
    expect(abr.targetBitrateBps).toBe(8_000_000);
  });
  it('R1: restaura Mesh Guard quando a rota deixa de ser LAN', () => {
    const abr = new AdaptiveBitrateController({ targetBitrateBps: 30_000_000 });
    abr.processSample(healthyLan, 'viewer');
    abr.processSample(wan, 'viewer');
    abr.applyMeshGuard(3, 8_000_000, 0);
    expect(abr.getCurrentBitrate('viewer')).toBeLessThanOrEqual(4_000_000);
  });
  it('R1: reset global restaura o piso configurado, sem manter piso LAN antigo', () => {
    const abr = new AdaptiveBitrateController({ targetBitrateBps: 30_000_000, minBitrateBps: 1_500_000 });
    abr.processSample(healthyLan);
    abr.reset();
    expect(abr.minBitrateBps).toBe(1_500_000);
  });
  it('R2: candidatos TURN com endereços privados não viram LAN', () => {
    const metrics = collectPeerMetrics(candidateStats('relay', ['10.0.0.2', '10.1.0.3'], .08));
    expect(metrics.isRelay).toBe(true);
    expect(metrics.isLan).toBe(false);
  });
  it('R2: host público sem RTT não prova conexão LAN', () => {
    const metrics = collectPeerMetrics(candidateStats('host', ['203.0.113.5', '198.51.100.8']));
    expect(metrics.rtt).toBe(null);
    expect(metrics.isLan).toBe(false);
  });
  it('R3: RTT null não libera conexão direta além da cota WAN', () => {
    const relay = new RelayManager({ originPeerId: 'host', maxDirectViewers: 1 });
    relay.registerViewer('first', { rtt: 50 });
    expect(relay.registerViewer('unknown', { rtt: null }).role).toBe('relay');
  });
  it('R3: TURN com RTT baixo e LAN explicitamente false respeita cota WAN', () => {
    const relay = new RelayManager({ originPeerId: 'host', maxDirectViewers: 1 });
    relay.registerViewer('first', { rtt: 50 });
    expect(relay.registerViewer('turn', { rtt: 2, isLan: false, isRelay: true }).role).toBe('relay');
  });
  it('R3: atualização de RTT para WAN desfaz inferência LAN antiga', () => {
    const relay = new RelayManager({ originPeerId: 'host', maxDirectViewers: 1 });
    relay.registerViewer('viewer', { rtt: 2 });
    relay.updateTelemetry('viewer', { rtt: 80, isRelay: true });
    expect(relay.getDirectNodes()[0].isLan).toBe(false);
  });
  it('R4: bitrate alto não ignora isLan=false na política SDP', () => {
    const sdp = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f'].join('\r\n');
    const tuned = tuneSdpForGaming(sdp, 30_000_000, { isLan: false });
    expect(tuned).toContain('x-google-min-bitrate=1000');
  });
});
