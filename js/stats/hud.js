const number=(v,unit='ms')=>typeof v==='number'&&Number.isFinite(v)?`${v.toFixed(1)} ${unit}`:'N/D';
export function createStatsHud(peerId) {
 const hud=document.createElement('div');hud.className='stats-hud';
 const header=document.createElement('div');header.className='stats-heading';header.textContent='Diagnóstico ao vivo';hud.appendChild(header);
 const source=document.createElement('select');source.className='stats-source';source.setAttribute('aria-label','Conexão exibida no diagnóstico');source.hidden=true;hud.append(source);
 const main=[['fps','FPS do vídeo'],['rtt','RTT da rede'],['bitrate','Bitrate'],['res','Resolução'],['codec','Codec ativo']];
 const details=[['presented','FPS apresentados'],['encode','Encode / frame'],['decode','Decode / frame'],['jitter','Jitter RTP'],['buffer','Buffer de jitter'],['frametime','Frametime p95'],['pause','Maior pausa'],['loss','Pacotes perdidos'],['quality','Limitação'],['implementation','Encoder / decoder'],['adaptation-requested','Adaptação pedida'],['adaptation-effective','Adaptação ativa']];
 const add=(target,[key,label])=>{
  const row=document.createElement('div');row.className='stats-row';
  const caption=document.createElement('span');caption.className='stats-label';caption.textContent=label;
  const value=document.createElement('span');value.className='stats-val';value.id=`stat-${key}-${peerId}`;value.textContent='N/D';row.append(caption,value);target.append(row);
 };
 main.forEach(item=>add(hud,item));
 const graph=document.createElementNS('http://www.w3.org/2000/svg','svg');graph.classList.add('stats-history');graph.setAttribute('viewBox','0 0 240 48');graph.setAttribute('role','img');graph.setAttribute('aria-label','Histórico: FPS em azul, frametime p95 em laranja');
 for(const name of ['fps','frametime']){const path=document.createElementNS(graph.namespaceURI,'polyline');path.setAttribute('class',`stats-line-${name}`);graph.append(path);}hud.append(graph);
 const legend=document.createElement('div');legend.className='stats-legend';legend.textContent='Histórico · FPS 0–120 / p95 0–100 ms';hud.append(legend);
 const disclosure=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Tempos e estabilidade';disclosure.append(summary);details.forEach(item=>add(disclosure,item));hud.append(disclosure);
 [['produced','FPS na saída nativa'],['producer-gap','Pausa nativa (sessão)'],['producer-age','Último frame nativo']].forEach(item=>add(disclosure,item));
 const note=document.createElement('p');note.className='stats-note';note.textContent='RTT não é latência visual. Pausa e frametime usam metadados de frames consecutivos. N/D = métrica indisponível.';hud.append(note);
 const diagnosis=document.createElement('p');diagnosis.className='stats-note';diagnosis.id=`stat-diagnosis-${peerId}`;diagnosis.textContent='Hipóteses aguardando amostras.';hud.append(diagnosis);
 const button=document.createElement('button');button.type='button';button.className='stats-export';button.textContent='Exportar diagnóstico';button.disabled=true;hud.append(button);return hud;
}
export function renderStatsHud(peerId,isLocal,m,history=[]) {
  if(typeof document==='undefined')return;
  const codecText = m.codec?.replace(/^video\//i,'').toUpperCase() || (
    m.iceConnectionState === 'failed' || m.connectionState === 'failed' ? 'Falha ICE/NAT' :
    m.iceConnectionState === 'disconnected' ? 'Conexão interrompida' :
    m.iceConnectionState === 'checking' ? 'Conectando (ICE)...' :
    ['connected', 'completed'].includes(m.iceConnectionState) ? 'Negociando codec...' :
    'Aguardando negociação'
  );
  const values={rtt:m.rtt===null||m.rtt===undefined?'N/D':`${m.rtt} ms${m.isLan?' (LAN)':m.isRelay?' (Relay)':''}`,fps:m.fps===null||m.fps===undefined?'N/D':`${m.fps} FPS`,bitrate:m.bitrateText?m.bitrateText==='N/D'?'N/D':`${m.bitrateText} Mbps${isLocal?' (Envio)':''}`:'N/D',res:m.width&&m.height?`${m.width}x${m.height}`:'N/D',codec:codecText,presented:number(m.presentedFps,'FPS'),encode:number(m.encodeTimeMs),decode:number(m.decodeTimeMs),jitter:number(m.jitterMs),buffer:number(m.jitterBufferDelayMs),frametime:number(m.frametimeP95Ms),pause:number(m.maxPauseMs),loss:m.packetsLost==null?'N/D':`${m.packetsLost} perdidos`,quality:m.sampleError?'Sem amostra':m.qualityReason==='none'?'Normal':m.qualityReason?.toUpperCase()||'N/D',implementation:m.encoderImplementation||m.decoderImplementation||'N/D'};
 for(const [key,value] of Object.entries(values)){const elem=document.getElementById(`stat-${key}-${peerId}`);if(elem)elem.innerText=value;}
 const adaptationLabels={'maintain-resolution':'Resolução','maintain-framerate':'FPS',balanced:'Equilibrada'};
 for(const [key,value] of [['adaptation-requested',adaptationLabels[m.requestedDegradationPreference]||'N/D'],['adaptation-effective',adaptationLabels[m.effectiveDegradationPreference]||(m.requestedDegradationPreference?'Padrão do navegador':'N/D')]]){const elem=document.getElementById(`stat-${key}-${peerId}`);if(elem)elem.innerText=value;}
 for(const [key,value] of [['produced',number(m.producedFps,'FPS')],['producer-gap',number(m.producerMaxPauseMs)],['producer-age',number(m.producerFrameAgeMs)]]){const elem=document.getElementById(`stat-${key}-${peerId}`);if(elem)elem.innerText=value;}
 const diagnosis=document.getElementById(`stat-diagnosis-${peerId}`);if(diagnosis)diagnosis.textContent=m.diagnosis?`Hipótese: ${m.diagnosis.message}`:'Aguardando amostras';
 const hud=document.getElementById(`card-${peerId}`)?.querySelector('.stats-hud');if(!hud)return;
 const points=history.slice(-120);
 for(const [key,name,max] of [['measuredFps','fps',120],['frametimeP95Ms','frametime',100]]){
  const line=hud.querySelector(`.stats-line-${name}`);
  // Gaps remain gaps; no invented zero values when a metric is unavailable.
  const tail=points.slice(points.findLastIndex(p=>!Number.isFinite(p[key]))+1);
  line?.setAttribute('points',tail.map((p,i)=>`${240*(points.length-tail.length+i)/Math.max(1,points.length-1)},${46-44*Math.min(max,Math.max(0,p[key]))/max}`).join(' '));
 }
}
