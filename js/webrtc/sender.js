import { configureVideoCodecs } from '../streaming/codecs.js';
import { mutateVideoSender, getSenderParameterStatus } from '../streaming/sender-parameters.js';
/** Codec preference is a capability hint; getStats is the negotiated truth. */
export function applyTransceiverOptimizations(pc,latencyMode='ultra-low',preferredCodec='h264') {
 if(!pc?.getTransceivers)return [];
 const results=[];
 for(const t of pc.getTransceivers()) {
  const isAudio=t.sender?.track?.kind==='audio'||t.receiver?.track?.kind==='audio'||t.mid?.toLowerCase().includes('audio');
  if(t.receiver) {
   const targetMs=latencyMode==='stable'?50:latencyMode==='smooth'?25:0;
   try {if('jitterBufferTarget' in t.receiver)t.receiver.jitterBufferTarget=targetMs;if('playoutDelayHint' in t.receiver)t.receiver.playoutDelayHint=targetMs/1000;}catch(_){}
  }
  if(!isAudio)results.push(configureVideoCodecs(t,preferredCodec));
 }
 return results;
}

export async function applySenderOptimizations(pc, bitrateBps, fps = 60, scaleResolutionDownBy = 1, degradationPreference = 'maintain-resolution') {
  if (!pc) return false;

  let applied = false;
  try {
    const senders = pc.getSenders ? pc.getSenders() : [];
    for (const sender of senders) {
      if (sender.track && sender.track.kind === 'video') {
        sender.track.contentHint = 'motion';

        const ok = await mutateVideoSender(sender, params => {
          params.degradationPreference = degradationPreference || 'maintain-resolution';
          for (const encoding of params.encodings) {
            encoding.maxFramerate = Math.max(1, Math.min(120, Number(fps) || 60));
            encoding.maxBitrate = Math.max(256000, Math.min(50000000, Number(bitrateBps) || 7500000));
            encoding.priority = 'high'; encoding.networkPriority = 'high';
            encoding.scaleResolutionDownBy = Math.max(1, Number(scaleResolutionDownBy) || 1);
          }
        });
        applied ||= ok;
        console.log(`[FPS Target] Alvo: ${fps} FPS | Bitrate: ${(bitrateBps / 1000000).toFixed(1)} Mbps | Escala: ${scaleResolutionDownBy || 1}x | Adaptação solicitada: ${degradationPreference || 'maintain-resolution'} | Efetiva: ${getSenderParameterStatus(sender)?.effectiveDegradationPreference || 'não informada'}`);
      }
    }
    return applied;
  } catch (err) {
    console.warn('Erro ao aplicar parâmetros no sender:', err);
    return false;
  }
}

export function applySenderOptimizationsWhenReady(pc, getBitrateBps, getFps = 60, getScaleFactor = 1, getDegradationPreference = 'maintain-resolution') {
  if (!pc) return () => {};

  let cancelled = false;
  let retryTimer = null;
  let applying = false;

  const tryApply = async () => {
    if (cancelled || !pc || pc.connectionState === 'closed') {
      cleanup();
      return;
    }
    if (applying) return;
    applying = true;
    const bitrate = typeof getBitrateBps === 'function' ? getBitrateBps() : getBitrateBps;
    const fps = typeof getFps === 'function' ? getFps() : getFps;
    const scale = typeof getScaleFactor === 'function' ? getScaleFactor() : getScaleFactor;
    const degradation = typeof getDegradationPreference === 'function' ? getDegradationPreference() : getDegradationPreference;

    try {
      const ok = await applySenderOptimizations(pc, bitrate, fps, scale, degradation);
      if (ok) {
        cleanup();
      }
    } catch (_) {} finally { applying = false; }
  };

  const cleanup = () => {
    cancelled = true;
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    if (typeof pc.removeEventListener === 'function') {
      pc.removeEventListener('signalingstatechange', onSignaling);
      pc.removeEventListener('connectionstatechange', onConnection);
    }
  };

  const onSignaling = () => {
    if (pc.signalingState === 'stable') {
      tryApply();
    }
  };

  const onConnection = () => {
    if (pc.connectionState === 'connected') {
      tryApply();
    } else if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      cleanup();
    }
  };

  if (typeof pc.addEventListener === 'function') {
    pc.addEventListener('signalingstatechange', onSignaling);
    pc.addEventListener('connectionstatechange', onConnection);
  }

  let attempts = 0;
  retryTimer = setInterval(() => {
    attempts++;
    if (attempts > 30 || cancelled) {
      cleanup();
      return;
    }
    tryApply();
  }, 400);

  tryApply();

  return cleanup;
}

export async function updateSenderBitrate(pc, bitrateBps) {
  if (!pc || typeof pc.getSenders !== 'function') return false;
  try {
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track && sender.track.kind === 'video' && sender.setParameters) {
        return await mutateVideoSender(sender, params => {
          for (const encoding of params.encodings) encoding.maxBitrate = Math.max(256000, Math.min(50000000, Number(bitrateBps) || 7500000));
        });
      }
    }
    return false;
  } catch (err) {
    console.warn('[ABR] Falha ao atualizar bitrate no sender:', err);
    return false;
  }
}

export async function swapStreamAudioTrack(pc, newTrack = null) {
  if (!pc) return false;

  try {
    const senders = pc.getSenders ? pc.getSenders() : [];
    let audioSender = senders.find(s => s.track && s.track.kind === 'audio');

    // Se não encontrou sender com track de áudio ativa, procura transceiver de áudio
    if (!audioSender && pc.getTransceivers) {
      const transceivers = pc.getTransceivers();
      const audioTransceiver = transceivers.find(t => 
        (t.sender && t.sender.track && t.sender.track.kind === 'audio') ||
        (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') ||
        (t.mid && t.mid.toLowerCase().includes('audio'))
      );
      if (audioTransceiver && audioTransceiver.sender) {
        audioSender = audioTransceiver.sender;
      }
    }

    // Se ainda não encontrou, tenta qualquer sender sem track ou cujo tipo seja áudio
    if (!audioSender) {
      audioSender = senders.find(s => !s.track);
    }

    if (audioSender && typeof audioSender.replaceTrack === 'function') {
      await audioSender.replaceTrack(newTrack);
      console.log(`[Audio Swap] Trilha de áudio substituída: ${newTrack ? (newTrack.label || newTrack.id) : 'Nenhuma (Mudo)'}`);
      return true;
    } else {
      console.warn('[Audio Swap] Nenhum RTCRtpSender de áudio disponível para substituição.');
      return false;
    }
  } catch (err) {
    console.error('[Audio Swap] Erro ao trocar trilha de áudio:', err);
    return false;
  }
}
