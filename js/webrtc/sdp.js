/** sdp: commands receive explicit compatibility ports; no page initialization. */
export function tuneSdpForGaming(sdp, bitrateBps, options = {}) {
  if (!sdp) return sdp;

  const lines = sdp.split(/\r?\n/);
  const kbps = Math.round(bitrateBps / 1000);
  const isLan = options?.isLan === true;

  // Divide o SDP em blocos: sessão global e seções m=
  const sections = [];
  let currentSection = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=')) {
      if (currentSection.length > 0) {
        sections.push(currentSection);
      }
      currentSection = [line];
    } else {
      currentSection.push(line);
    }
  }
  if (currentSection.length > 0) {
    sections.push(currentSection);
  }

  // Processa cada bloco independentemente
  const processedSections = sections.map((section) => {
    const header = section[0];
    if (!header) return section;

    // 1. Bloco de Áudio (Opus)
    if (header.startsWith('m=audio')) {
      let opusPt = null;
      for (const line of section) {
        if (line.startsWith('a=rtpmap:') && line.toLowerCase().includes('opus')) {
          const match = line.match(/^a=rtpmap:(\d+)\s+opus/i);
          if (match) opusPt = match[1];
        }
      }

      return section.map((line) => {
        if (line.startsWith('a=fmtp:') && (line.includes('opus') || (opusPt && line.startsWith(`a=fmtp:${opusPt}`)))) {
          // Parse de parâmetros chave-valor do fmtp para evitar duplicações
          const prefixMatch = line.match(/^(a=fmtp:\d+\s+)(.*)$/);
          if (!prefixMatch) return line;

          const prefix = prefixMatch[1];
          const rawParams = prefixMatch[2];
          const paramMap = new Map();

          rawParams.split(';').forEach((pair) => {
            const trimmed = pair.trim();
            if (!trimmed) return;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
              const k = trimmed.substring(0, eqIdx).trim();
              const v = trimmed.substring(eqIdx + 1).trim();
              paramMap.set(k, v);
            } else {
              paramMap.set(trimmed, '');
            }
          });

          // Define parâmetros Opus Gamer estéreo 128 kbps CBR
          paramMap.set('stereo', '1');
          paramMap.set('sprop-stereo', '1');
          paramMap.set('maxaveragebitrate', '128000');
          paramMap.set('cbr', '1');
          paramMap.set('usedtx', '0');
          paramMap.set('maxplaybackrate', '48000');

          const formattedParams = Array.from(paramMap.entries())
            .map(([k, v]) => (v ? `${k}=${v}` : k))
            .join(';');

          return `${prefix}${formattedParams}`;
        }
        return line;
      });
    }

    // 2. Bloco de Vídeo (H.264 & Limites de Banda RFC 8866)
    if (header.startsWith('m=video')) {
      // Remove quaisquer b=AS ou b=TIAS existentes neste bloco de vídeo
      const filtered = section.filter((l) => !l.startsWith('b=AS:') && !l.startsWith('b=TIAS:'));

      const minK = isLan ? Math.max(5000, Math.round(kbps * 0.4)) : 1000;
      const startK = isLan ? Math.round(kbps * 0.95) : Math.max(2500, Math.round(kbps * 0.7));
      const maxK = Math.round(kbps * 1.3);

      // Identifica payload types de H.264 presentes no SDP
      const h264Pts = new Set();
      for (const line of filtered) {
        if (line.startsWith('a=rtpmap:') && line.toLowerCase().includes('h264')) {
          const match = line.match(/^a=rtpmap:(\d+)\s+h264/i);
          if (match) h264Pts.add(match[1]);
        }
      }

      // Ajusta parâmetros fmtp de todos os codecs de vídeo no bloco
      const modifiedLines = filtered.map((line) => {
        if (line.startsWith('a=fmtp:')) {
          const prefixMatch = line.match(/^(a=fmtp:(\d+)\s+)(.*)$/);
          if (!prefixMatch) return line;

          const prefix = prefixMatch[1];
          const pt = prefixMatch[2];
          const rawParams = prefixMatch[3];
          const paramMap = new Map();

          rawParams.split(';').forEach((pair) => {
            const trimmed = pair.trim();
            if (!trimmed) return;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
              paramMap.set(trimmed.substring(0, eqIdx).trim(), trimmed.substring(eqIdx + 1).trim());
            } else {
              paramMap.set(trimmed, '');
            }
          });

          // Se for H.264 ou contiver parâmetros H.264 conhecidos
          if (h264Pts.has(pt) || line.includes('42e01f') || line.includes('packetization-mode=1') || line.includes('profile-level-id')) {
            paramMap.set('level-asymmetry-allowed', '1');
            paramMap.set('packetization-mode', '1');
          }

          paramMap.set('x-google-min-bitrate', String(minK));
          paramMap.set('x-google-start-bitrate', String(startK));
          paramMap.set('x-google-max-bitrate', String(maxK));

          const formattedParams = Array.from(paramMap.entries())
            .map(([k, v]) => (v ? `${k}=${v}` : k))
            .join(';');

          return `${prefix}${formattedParams}`;
        }
        return line;
      });

      // Posição RFC 8866: linhas b= devem vir logo após c= (ou após m= se c= não existir)
      let insertIdx = -1;
      for (let j = 0; j < modifiedLines.length; j++) {
        if (modifiedLines[j].startsWith('c=')) {
          insertIdx = j + 1;
          break;
        }
      }
      if (insertIdx === -1) {
        insertIdx = 1; // Logo após m=
      }

      const bandwidthLines = [`b=AS:${kbps}`, `b=TIAS:${bitrateBps}`];
      modifiedLines.splice(insertIdx, 0, ...bandwidthLines);
      if (!modifiedLines.some(l => l.startsWith('a=rtcp-rsize'))) {
        modifiedLines.push('a=rtcp-rsize');
      }
      return modifiedLines;
    }

    return section;
  });

  return processedSections.flat().join('\r\n');
}

export function hookPeerConnectionSdp(pc, getBitrateBps, getOptions) {
  if (!pc || pc._sdpHooked) return;
  pc._sdpHooked = true;

  const originalSetLocal = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async function(desc) {
    if (desc && desc.sdp) {
      const bitrate = typeof getBitrateBps === 'function' ? getBitrateBps() : (getBitrateBps || 7500000);
      const options = typeof getOptions === 'function' ? getOptions() : (getOptions || {});
      desc.sdp = tuneSdpForGaming(desc.sdp, bitrate, options);
    }
    return originalSetLocal(desc);
  };
}
