import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Catálogo de Temas Oficiais & Tokens', () => {
  it('contém definições de tokens para todos os temas oficiais no CSS', () => {
    const cssPath = path.resolve('css/theme-tokens.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    const expectedThemes = ['cyberpunk', 'midnight', 'forest', 'sunset', 'light'];
    for (const theme of expectedThemes) {
      expect(cssContent).toContain(`data-theme='${theme}'`);
      expect(cssContent).toContain(`--bg-dark`);
      expect(cssContent).toContain(`--accent`);
      expect(cssContent).toContain(`--text-main`);
    }
  });

  it('script bootstrap js/theme.js inclui allowlist dos temas oficiais', () => {
    const jsPath = path.resolve('js/theme.js');
    const jsContent = fs.readFileSync(jsPath, 'utf8');

    const expectedThemes = ['dark', 'light', 'cyberpunk', 'midnight', 'forest', 'sunset'];
    for (const theme of expectedThemes) {
      expect(jsContent).toContain(theme);
    }
  });
});
