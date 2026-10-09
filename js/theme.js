/* Runs before styles to avoid a flash of the wrong theme, including in Tauri. */
(() => {
  const storageKey = 'smg-theme';
  const root = document.documentElement;
  const OFFICIAL_THEMES = ['dark', 'light', 'cyberpunk', 'midnight', 'forest', 'sunset'];
  const validTheme = value => OFFICIAL_THEMES.includes(value);
  let initialTheme = 'dark';
  try {
    const saved = localStorage.getItem(storageKey);
    if (validTheme(saved)) initialTheme = saved;
  } catch { /* The theme remains usable when storage is unavailable. */ }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const isLight = theme === 'light';
      const label = isLight ? 'Ativar tema escuro' : 'Ativar tema claro';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(isLight));
      const text = button.querySelector('.theme-toggle-label');
      if (text) text.textContent = isLight ? 'Tema escuro' : 'Tema claro';
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#eaf1f5' : '#101216';
  }

  applyTheme(initialTheme);
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(root.dataset.theme);
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.addEventListener('click', () => {
        const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(theme);
        try { localStorage.setItem(storageKey, theme); } catch { /* Optional persistence. */ }
      });
    });
  }, { once: true });
  window.addEventListener('storage', event => {
    if (event.key === storageKey) applyTheme(validTheme(event.newValue) ? event.newValue : 'dark');
  });
})();
