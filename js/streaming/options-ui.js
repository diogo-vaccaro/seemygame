import { isDesktopApp, getNativeCaptureCapabilities } from '../desktop.js';
import { getVideoCapabilities, selectCodec } from './codecs.js';

const preferences = { 'video-codec-select': 'seemygame_video_codec', 'h264-encoder-select': 'seemygame_h264_encoder', 'capture-backend-select': 'seemygame_capture_backend', 'capture-method-select': 'seemygame_capture_method', 'degradation-preference-select': 'seemygame_degradation_preference' };
const codecCopy = {
  auto: 'Prefere um formato compatível. O diagnóstico confirma o codec negociado.',
  h264: 'Ampla compatibilidade. O encoder pode ser NVENC, Media Foundation ou CPU no app.',
  hevc: 'HEVC é o formato H.265, não o encoder. Experimental: exige suporte na prévia local e no receptor.',
  av1: 'No app, usa SVT-AV1 por CPU. Pode exigir bastante processamento; o receptor precisa decodificar AV1.',
  vp8: 'Codec WebRTC do navegador. O pipeline nativo atual não produz VP8.',
  vp9: 'Codec WebRTC do navegador. O pipeline nativo atual não produz VP9.'
};

/** Reflect only combinations implemented by the shipping worker, not hardware possibilities. */
export function syncStreamingOptions({ desktop = isDesktopApp(), capabilities = null, browserCapabilities = getVideoCapabilities() } = {}) {
  const codec = document.getElementById('video-codec-select');
  const encoder = document.getElementById('h264-encoder-select');
  const api = document.getElementById('capture-backend-select');
  const method = document.getElementById('capture-method-select');
  if (!codec) return;
  for (const option of codec.options) option.disabled = desktop && ['vp8', 'vp9'].includes(option.value);
  if (codec.selectedOptions[0]?.disabled || !codec.value) codec.value = 'auto';
  const selected = codec.value;
  const h264 = selected === 'h264' || selected === 'auto';
  let correction = '';
  if (encoder) {
    encoder.disabled = !desktop;
    for (const option of encoder.options) {
      option.disabled = option.value !== 'auto' && (!desktop ||
        (option.value === 'nvenc' && (!h264 || capabilities?.supports_nvenc_h264 === false)) ||
        (option.value === 'mf' && (selected === 'av1' || (h264 && capabilities?.supports_mf_h264 === false) || (selected === 'hevc' && capabilities?.supports_hevc === false))) ||
        (option.value === 'cpu' && (selected === 'hevc' || (h264 && capabilities?.supports_cpu_h264 === false) || (selected === 'av1' && capabilities?.supports_av1 === false))));
      if (option.value === 'cpu') option.textContent = selected === 'av1' ? 'CPU — SVT-AV1' : 'CPU — x264 (H.264)';
    }
    if (encoder.selectedOptions[0]?.disabled || !encoder.value) { encoder.value = 'auto'; correction = 'O encoder anterior não atende a esta combinação. Seleção ajustada para automática. '; }
  }
  if (api) {
    api.disabled = !desktop;
    const d12 = [...api.options].find(option => option.value === 'd3d12');
    if (d12) d12.disabled = !desktop || !h264 || !['auto', 'nvenc'].includes(encoder?.value || 'auto') || capabilities?.supports_nvenc_h264 === false || capabilities?.supports_d3d12 === false;
    if (api.selectedOptions[0]?.disabled || !api.value) { api.value = 'auto'; correction += 'D3D12 não atende a esta combinação. API ajustada para automática. '; }
  }
  const choice = selectCodec(selected, browserCapabilities, desktop ? 'receive' : 'send', desktop ? capabilities : null);
  const setNote = (id, text) => { const node = document.getElementById(id); if (node) node.textContent = text; };
  setNote('video-codec-note', (desktop ? 'Pipeline nativo. ' : 'No navegador. ') + codecCopy[selected] + (choice.reason ? ' ' + choice.reason : ''));
  const encoderCopy = !desktop ? 'Gerenciado pelo navegador. A API web não permite forçar NVENC, Media Foundation ou CPU.' :
    selected === 'hevc' ? 'Neste app, HEVC usa hardware via Media Foundation. NVENC direto para HEVC ainda não foi integrado.' :
    selected === 'av1' ? 'Neste app, AV1 usa SVT-AV1 por CPU. NVENC/Media Foundation para AV1 ainda não foram integrados.' :
    ({ auto: 'Em H.264, prefere NVENC, depois Media Foundation e depois CPU, conforme disponibilidade.', nvenc: 'Hardware dedicado NVIDIA. A captura e o jogo ainda podem disputar recursos da GPU.', mf: 'Interface do Windows para hardware NVIDIA, Intel ou AMD disponível nesta máquina.', cpu: 'x264 por software. Aumenta a carga de CPU; a captura ainda usa a GPU.' })[encoder?.value || 'auto'];
  setNote('h264-encoder-note', correction + encoderCopy);
  const apiCopy = !desktop ? 'Gerenciada pelo navegador via getDisplayMedia. A API web não permite escolher D3D11 ou D3D12.' :
    api?.value === 'd3d12' ? 'Seleção explícita: exige H.264/NVENC e não faz fallback automático.' :
    api?.value === 'd3d11' ? 'Seleção explícita do caminho D3D11. Disponível para os encoders e codecs nativos atuais.' :
    !h264 || !['auto', 'nvenc'].includes(encoder?.value || 'auto') || capabilities?.supports_nvenc_h264 === false || capabilities?.supports_d3d12 === false ? 'Esta combinação usa D3D11. D3D12 está integrado para H.264/NVENC com plugins compatíveis.' :
    'Prefere D3D12 com H.264/NVENC disponível; pode retornar a D3D11 se necessário.';
  setNote('capture-backend-note', apiCopy);
  if (method) method.disabled = !desktop;
  setNote('capture-method-note', !desktop
    ? 'Gerenciado pelo navegador via getDisplayMedia. WGC/DXGI só podem ser escolhidos no app desktop.'
    : method?.value === 'dxgi'
      ? 'Somente monitor inteiro: tudo que aparecer nele será compartilhado. Para uma janela, escolha WGC ou Automático. Aplicado ao reiniciar.'
      : method?.value === 'wgc'
        ? 'Captura uma janela específica ou um monitor pelo Windows. Aplicado ao reiniciar.'
        : 'Tenta DXGI para monitor inteiro, com recuperação por WGC se falhar. Usa WGC para janelas; o FPS depende do hardware e da carga.');
  const degradation = document.getElementById('degradation-preference-select');
  if (degradation) {
    const degCopy = {
      'maintain-resolution': 'Prioriza a resolução escolhida no envio pelo navegador. Sob falta de banda ou recursos, pode reduzir FPS e qualidade; não garante nitidez constante.',
      'maintain-framerate': 'Prioriza taxa de quadros contínua (60/120 FPS). O navegador pode reduzir a resolução dinamicamente sob estresse ou oscilação de banda.',
      'balanced': 'Equilibrado. O navegador reduz gradualmente tanto a resolução quanto a taxa de quadros sob sobrecarga.'
    }[degradation.value || 'maintain-resolution'] || '';
    setNote('degradation-preference-note', degCopy + (desktop ? ' No envio nativo direto, esta preferência do navegador não altera o encoder Rust.' : ' Confira a preferência efetiva no diagnóstico exportado.'));
  }
  // Preserve the selected explanation when the user hovers the actual field.
  for (const [select, note] of [[codec, 'video-codec-note'], [encoder, 'h264-encoder-note'], [api, 'capture-backend-note'], [method, 'capture-method-note'], [degradation, 'degradation-preference-note']]) if (select) select.title = document.getElementById(note)?.textContent || '';
}

export function bindStreamingOptions(session, { desktop = isDesktopApp(), loadCapabilities = getNativeCaptureCapabilities } = {}) {
  if (session.streamingOptionsBound || !document.getElementById('video-codec-select')) return;
  session.streamingOptionsBound = true;
  let capabilities = null;
  const update = () => syncStreamingOptions({ desktop, capabilities });
  for (const [id, key] of Object.entries(preferences)) {
    const element = document.getElementById(id);
    try { const saved = localStorage.getItem(key); if (saved && [...(element?.options || [])].some(o => o.value === saved)) element.value = saved; } catch (_) {}
    session.addEventListener(element, 'change', () => {
      update();
      for (const [field, storageKey] of Object.entries(preferences)) {
        const value = document.getElementById(field)?.value;
        if (value) try { localStorage.setItem(storageKey, value); } catch (_) {}
      }
    });
  }
  update();
  if (desktop) Promise.resolve().then(loadCapabilities).then(result => { if (!session.isDisposed) { capabilities = result; update(); } }).catch(() => {});

  let open = null;
  const close = () => { if (!open) return; open.tip.hidePopover?.(); open.tip.hidden = true; open.tip.classList.remove('is-open'); open.button.setAttribute('aria-expanded', 'false'); open = null; };
  const show = button => {
    if (open?.button === button) return;
    close();
    const tip = document.getElementById(button.dataset.streamingHelp);
    if (!tip) return;
    const rect = button.getBoundingClientRect();
    tip.hidden = false; tip.classList.add('is-open'); tip.showPopover?.();
    const width = Math.min(360, window.innerWidth - 24);
    tip.style.width = `${width}px`;
    tip.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    tip.style.maxHeight = `${Math.max(100, window.innerHeight - 24)}px`;
    const height = tip.getBoundingClientRect().height;
    tip.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12))}px`;
    button.setAttribute('aria-expanded', 'true'); open = { button, tip };
  };
  for (const button of document.querySelectorAll('[data-streaming-help]')) {
    session.addEventListener(button, 'pointerenter', () => show(button));
    session.addEventListener(button, 'focus', () => show(button));
    session.addEventListener(button, 'click', () => show(button));
    session.addEventListener(button, 'pointerleave', event => { if (event.relatedTarget !== open?.tip && !open?.tip.contains(event.relatedTarget) && document.activeElement !== button) close(); });
    session.addEventListener(button, 'blur', () => close());
    session.addEventListener(document.getElementById(button.dataset.streamingHelp), 'pointerleave', () => { if (document.activeElement !== button) close(); });
  }
  session.addEventListener(document, 'keydown', event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); } }, true);
  session.addEventListener(document, 'pointerdown', event => { if (open && !open.button.contains(event.target) && !open.tip.contains(event.target)) close(); });
  session.addEventListener(window, 'resize', close);
  session.addEventListener(document, 'scroll', close, true);
  session.registerCleanup(close);
}
