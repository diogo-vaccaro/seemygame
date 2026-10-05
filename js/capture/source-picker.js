import { isDesktopApp, getCapturableSources, getAudioExclusionCandidates } from '../desktop.js';
import { readCaptureSettings } from './settings.js';

/** Desktop source selection is UI only; the caller owns capture and errors. */
export function bindSourcePicker(session, { start, stop, isStreaming, showToast }) {
  const modal = document.getElementById('desktop-picker-modal');
  const list = document.getElementById('desktop-windows-list');
  let generation = 0;
  const method = document.getElementById('capture-method-select');
  const acceptsSource = source => method?.value !== 'dxgi' || source.sourceType === 'monitor';
  const choose = source => {
    if (session.isDisposed) return;
    if (!acceptsSource(source)) {
      showToast('DXGI captura somente um monitor inteiro. Escolha WGC ou Automático para compartilhar uma janela.', 'info');
      return;
    }
    if (modal) modal.style.display = 'none';
    const exclusion = document.getElementById('picker-audio-exclude-select')?.value ||
      document.getElementById('audio-exclude-select')?.value ||
      (() => { try { return localStorage.getItem('seemygame_audio_exclude_app'); } catch (_) { return 'seemygame'; } })() ||
      'seemygame';
    return start({ ...readCaptureSettings(), sourceId: source.sourceId || source.id, sourceType: source.sourceType, excludeApp: exclusion });
  };
  const refresh = async () => {
    const current = ++generation;
    const [sources, exclusions] = await Promise.all([getCapturableSources(), getAudioExclusionCandidates()]);
    if (session.isDisposed || current !== generation) return;
    const status = document.getElementById('picker-native-status');
    if (status) status.textContent = method?.value === 'dxgi'
      ? 'DXGI: compartilha tudo que aparecer no monitor inteiro. Para uma janela, escolha WGC ou Automático.'
      : 'WGC: selecione uma janela específica ou um monitor.';
    if (list) {
      list.replaceChildren();
      for (const source of sources) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'window-item';
        button.textContent = source.title || source.name || source.sourceId;
        button.dataset.sourceType = source.sourceType;
        button.disabled = !acceptsSource(source);
        if (button.disabled) button.title = 'Para compartilhar somente esta janela, escolha WGC ou Automático nas opções avançadas.';
        button.onclick = () => choose(source)?.catch?.(error => showToast(error.message, 'error'));
        list.append(button);
      }
      if (!sources.length) list.textContent = 'Nenhuma janela ou monitor disponível.';
    }
    const select = document.getElementById('picker-audio-exclude-select');
    if (select) {
      let savedPref = 'seemygame';
      try { savedPref = localStorage.getItem('seemygame_audio_exclude_app') || 'seemygame'; } catch (_) {}
      const currentVal = select.value || savedPref;
      select.replaceChildren();

      // SeeMyGame (recomendado)
      select.add(new Option('🎮 SeeMyGame (Ignorar Voz da Sala / Recomendado)', 'seemygame'));

      // Discord
      const discordCand = exclusions.find(c => c.id === 'discord');
      select.add(new Option(discordCand?.label || '🎧 Discord (Ignorar Chamada Externa)', 'discord'));

      // Outras janelas
      exclusions.forEach(c => {
        if (c.id !== 'seemygame' && c.id !== 'discord') {
          select.add(new Option(c.label || c.title || c.name || c.process_name || c.id, c.id));
        }
      });

      // Nenhum
      select.add(new Option('🌐 Nenhum (Capturar todos os sons do PC)', 'none'));

      const match = Array.from(select.options).some(o => o.value === currentVal);
      select.value = match ? currentVal : 'seemygame';
    }
  };
  const toggle = async () => {
    if (isStreaming()) return stop();
    if (!isDesktopApp() || !modal) return start(readCaptureSettings());
    modal.style.display = 'flex';
    await refresh();
  };
  session.addEventListener(document.getElementById('picker-refresh-btn'), 'click', () => refresh().catch(error => showToast(error.message, 'error')));
  session.addEventListener(method, 'change', () => {
    for (const button of list?.querySelectorAll('[data-source-type]') || []) {
      button.disabled = !acceptsSource({ sourceType: button.dataset.sourceType });
      button.title = button.disabled ? 'Para compartilhar somente esta janela, escolha WGC ou Automático nas opções avançadas.' : '';
    }
  });
  session.addEventListener(document.getElementById('picker-cancel-btn'), 'click', () => { if (modal) modal.style.display = 'none'; });
  session.addEventListener(document.getElementById('picker-audio-exclude-select'), 'change', event => {
    const val = event.target.value;
    try { localStorage.setItem('seemygame_audio_exclude_app', val); } catch (_) {}
    const audioExclude = document.getElementById('audio-exclude-select');
    if (audioExclude && audioExclude.value !== val) {
      audioExclude.value = val;
    }
  });
  session.addEventListener(document.getElementById('picker-screen-fallback-btn'), 'click', async () => {
    try { const sources = await getCapturableSources(); const source = sources.find(source => source.sourceType === 'monitor'); if (source) await choose(source); }
    catch (error) { showToast(error.message, 'error'); }
  });
  session.registerCleanup(() => { generation++; if (modal) modal.style.display = 'none'; list?.replaceChildren(); });
  return { toggle, refresh };
}
