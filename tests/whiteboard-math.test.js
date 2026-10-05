import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { WhiteboardManager, isSafeWhiteboardElement } from '../js/whiteboard.js';
import { createMathRenderer, parseMathText, validateLatex, mathKey } from '../js/whiteboard/math-renderer.js';

const options = { fontSize: 24, color: '#ffffff', display: false };
const formula = { id: 'math1', type: 'formula', x: 100, y: 200, latex: '\\frac{a}{b}', fontSize: 32, color: '#ffffff' };
let manager, ctx, render;
beforeEach(() => {
  document.body.innerHTML = '<div><canvas></canvas></div>';
  ctx = new Proxy({ measureText: text => ({ width: text.length * 12 }) }, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  const canvas = document.querySelector('canvas'); canvas.width = 1920; canvas.height = 1080;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1920, height: 1080 });
  canvas.parentElement.getBoundingClientRect = canvas.getBoundingClientRect;
  render = vi.fn(async latex => { validateLatex(latex); if (latex.includes('bad')) throw new Error('Comando inválido');
    return { svg: 'svg', width: 80, height: 50, baseline: 35 }; });
  const mathRenderer = createMathRenderer({ render, decode: async () => ({}), onReady: () => { manager.render(); manager.updateMathPreview(); } });
  manager = new WhiteboardManager({ canvas, mathRenderer, onElementCreated: vi.fn(), onElementUpdated: vi.fn() });
});
afterEach(() => { manager.dispose(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('LaTeX source and lifecycle', () => {
  it('recognizes explicit inline/block delimiters, escaped delimiters and currency', () => {
    expect(parseMathText('R$ 10')).toEqual([{ type: 'text', text: 'R$ 10' }]);
    expect(parseMathText(String.raw`Área \(x^2\) e \[\frac{a}{b}\]`).map(segment => segment.type)).toEqual(['text', 'math', 'text', 'math']);
    expect(parseMathText(String.raw`\\(literal\\)`)).toEqual([{ type: 'text', text: String.raw`\\(literal\\)` }]);
    expect(parseMathText(String.raw`\(x` ).incomplete).toBe(true);
  });
  it.each(['', '\\href{https://example.com}{x}', '\\require{html}', '\\newcommand{\\a}{x}', '{x', 'x}', '{'.repeat(33)])('rejects invalid or unsafe input %s', latex => {
    expect(() => validateLatex(latex)).toThrow();
  });
  it('validates formula wire data and bounds source/style limits', () => {
    expect(isSafeWhiteboardElement(formula)).toBe(true);
    for (const change of [{ latex: '' }, { latex: 'x'.repeat(2001) }, { fontSize: 97 }, { x: NaN }]) expect(isSafeWhiteboardElement({ ...formula, ...change })).toBe(false);
  });
  it('coalesces repeated rendering and ignores completion of pruned entries', async () => {
    let resolve; const ready = vi.fn();
    const cache = createMathRenderer({ render: () => new Promise(r => { resolve = r; }), decode: async () => ({}), onReady: ready });
    const first = cache.get('x', options); expect(cache.get('x', options)).toBe(first);
    await Promise.resolve(); cache.prune(new Set()); resolve({ svg: 'svg', width: 5, height: 5 }); await first.promise;
    expect(ready).not.toHaveBeenCalled(); expect(cache.cache.size).toBe(0); cache.dispose();
  });
  it('uses source/style cache keys and retains only used document entries', async () => {
    manager.addElement(formula); await manager.prepareMathElement(formula); expect(render).toHaveBeenCalledTimes(1);
    await manager.prepareMathElement(formula); expect(render).toHaveBeenCalledTimes(1);
    expect(manager.mathRenderer.cache.has(mathKey(formula.latex, manager.mathOptions(formula)))).toBe(true);
    manager.removeElement(formula.id); expect(manager.mathRenderer.cache.size).toBe(0);
  });
});

describe('Canvas formula elements and mixed text', () => {
  it('synchronizes only editable source; supports move, resize and undo/redo', async () => {
    manager.addElement(formula, true); await manager.prepareMathElement(formula);
    expect(manager.onElementCreated).toHaveBeenCalledWith(formula);
    expect(manager.elements[0]).not.toHaveProperty('svg');
    expect(manager.getElementBounds(formula)).toMatchObject({ width: 80, height: 50 });
    const moved = { ...formula }; manager.translateElement(moved, formula, 20, 30); expect(moved).toMatchObject({ x: 120, y: 230 });
    manager.resizeElement(moved, formula, 'br', 80, 50); expect(moved.fontSize).toBe(64);
    manager.undo(); expect(manager.elements).toHaveLength(0); manager.redo(); expect(manager.elements[0].latex).toBe(formula.latex);
  });
  it('aligns inline expressions by baseline and gives display expressions a separate row', async () => {
    const text = { ...formula, type: 'text', fontSize: 24, text: String.raw`Área: \(\frac{a}{b}\) unidades
\[x^2\]
fim` };
    manager.addElement(text); await manager.prepareMathElement(text);
    const layout = manager.getTextLayout(text), [label, fraction, units] = layout.runs;
    expect(label.y + label.baseline).toBe(fraction.y + fraction.baseline); expect(units.y + units.baseline).toBe(fraction.y + fraction.baseline);
    expect(layout.runs.find(run => run.text === String.raw`\[x^2\]`).y).toBeGreaterThan(fraction.y);
    manager.renderText(ctx, text); expect(ctx.drawImage).toHaveBeenCalled(); expect(manager.getElementBounds(text).height).toBe(layout.height);
  });
  it('waits for formula rendering before PNG export', async () => {
    manager.canvas.toBlob = vi.fn(callback => callback(new Blob(['png'], { type: 'image/png' })));
    manager.addElement(formula); const blob = await manager.exportToBlob();
    expect(blob.type).toBe('image/png'); expect(ctx.drawImage).toHaveBeenCalled();
  });
  it('keeps original formula metrics throughout a resize gesture', async () => {
    manager.addElement(formula); await manager.prepareMathElement(formula);
    manager.isResizingElement = true; manager.resizeInitialState = { ...formula };
    manager.elements[0] = { ...formula, fontSize: 64 }; manager.render();
    expect(manager.getElementBounds(manager.resizeInitialState).width).toBe(80);
    expect(manager.mathRenderer.cache.has(mathKey(formula.latex, manager.mathOptions(formula)))).toBe(true);
    manager.isResizingElement = false; manager.render();
    expect(manager.mathRenderer.cache.has(mathKey(formula.latex, manager.mathOptions(formula)))).toBe(false);
  });
});

describe('Direct mathematical editing', () => {
  const open = (element = null, math = true) => { manager.beginTextEditing({ x: 200, y: 300 }, element, math); return manager.textEditing.editor; };
  it('commits after validation and exposes a local preview without dialogs', async () => {
    const editor = open(); editor.value = '\\sqrt{x}'; editor.dispatchEvent(new Event('input'));
    expect(await manager.finishTextEditing()).toBe(true); expect(manager.elements[0]).toMatchObject({ type: 'formula', latex: '\\sqrt{x}', x: 200, y: 300 });
    expect(manager.onElementCreated).toHaveBeenCalledTimes(1); expect(document.querySelector('textarea')).toBeNull();
  });
  it('keeps invalid edits open and preserves the previous synchronized expression', async () => {
    manager.addElement(formula); const editor = open(formula); editor.value = '\\bad{x}';
    expect(await manager.finishTextEditing()).toBe(false); expect(manager.textEditing).toBeTruthy();
    expect(manager.elements[0].latex).toBe(formula.latex); expect(manager.onElementUpdated).not.toHaveBeenCalled();
    expect(manager.textEditing.status.textContent).toContain('inválido'); manager.finishTextEditing(false);
  });
  it('cancellation prevents late validation from creating an element', async () => {
    const editor = open(); editor.value = 'x^2'; const commit = manager.finishTextEditing(); manager.finishTextEditing(false);
    expect(await commit).toBe(false); expect(manager.elements).toHaveLength(0);
  });
  it('coalesces blur/Enter commits and allows changing the source during validation', async () => {
    const editor = open(); editor.value = 'x'; const commit = manager.finishTextEditing();
    expect(manager.finishTextEditing()).toBe(commit); editor.value = 'y'; expect(await commit).toBe(false);
    expect(await manager.finishTextEditing()).toBe(true); expect(manager.elements[0].latex).toBe('y');
  });
  it('inserts symbols at the caret and wraps math inserted in plain text', async () => {
    const editor = open(null, false); editor.value = 'Área: '; editor.setSelectionRange(6, 6);
    manager.textEditing.preview.querySelector('button').click(); expect(editor.value).toBe(String.raw`Área: \(\frac{a}{b}\)`);
    expect(await manager.finishTextEditing()).toBe(true); expect(manager.elements[0].type).toBe('text');
  });
  it('does not close or switch tools while an invalid expression is being edited', async () => {
    manager.setTool('formula'); const editor = open(); editor.value = '\\bad'; manager.setTool('pencil'); await manager.textEditing.pendingCommit;
    expect(manager.textEditing).toBeTruthy(); expect(manager.selectedTool).toBe('formula');
    editor.value = 'x'; manager.setTool('select'); await manager.textEditing.pendingCommit; expect(manager.selectedTool).toBe('select');
  });
  it('refuses incomplete math delimiters instead of silently committing source', async () => {
    const editor = open(null, false); editor.value = String.raw`Área: \(x`;
    expect(await manager.finishTextEditing()).toBe(false); expect(manager.elements).toHaveLength(0);
  });
  it('Escape on the palette cancels editing without invoking global shortcuts', () => {
    open(); const listener = vi.fn(); window.addEventListener('keydown', listener);
    manager.textEditing.preview.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(manager.textEditing).toBeNull(); expect(listener).not.toHaveBeenCalled(); window.removeEventListener('keydown', listener);
  });
});
