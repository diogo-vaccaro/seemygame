import { getWhiteboardTextLayout, MAX_WHITEBOARD_TEXT_LENGTH, WHITEBOARD_REF_WIDTH, WHITEBOARD_REF_HEIGHT } from './shared.js';
import { MAX_LATEX_LENGTH } from './math-renderer.js';

const SYMBOLS = [
  ['a/b', '\\frac{a}{b}', 'Fração'], ['√', '\\sqrt{x}', 'Raiz'], ['x²', 'x^{2}', 'Potência'],
  ['xₙ', 'x_{n}', 'Índice'], ['α', '\\alpha', 'Letra grega'], ['∑', '\\sum_{i=1}^{n} x_i', 'Somatório'],
  ['∫', '\\int_{a}^{b} f(x)\\,dx', 'Integral'], ['▦', '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', 'Matriz']
];

/** The editor overlays the same reference coordinates as the canvas text. */
export const withWhiteboardManagerTextEditor = Base => class extends Base {
  beginTextEditing(position, element = null, formula = false) {
    if (!this.canvas?.parentElement) return;
    if (this.textEditing) {
      const finished = this.finishTextEditing(true);
      if (finished?.then) { finished.then(ok => { if (ok) this.beginTextEditing(position, element, formula); }); return; }
      if (!finished) return;
    }
    this.cancelDrawing();
    formula = element ? element.type === 'formula' : formula;
    const editor = document.createElement('textarea');
    editor.className = 'wb-inline-text-editor';
    if (formula) editor.classList.add('wb-latex-source');
    editor.setAttribute('aria-label', formula ? 'Expressão LaTeX' : 'Escrever na lousa');
    editor.title = 'Enter conclui · Shift+Enter quebra a linha · Esc cancela';
    editor.placeholder = formula ? '\\frac{a}{b} + \\sqrt{x}' : 'Escreva aqui…';
    editor.maxLength = formula ? MAX_LATEX_LENGTH : MAX_WHITEBOARD_TEXT_LENGTH;
    editor.wrap = 'off';
    editor.spellcheck = false;
    editor.value = (formula ? element?.latex : element?.text) || '';
    const draft = element ? { ...element } : {
      id: 'wb_' + Math.random().toString(36).slice(2, 11), type: formula ? 'formula' : 'text',
      x: position.x, y: position.y, color: this.currentColor, fontSize: formula ? 32 : 24, strokeWidth: this.currentWidth
    };
    this.textEditing = { editor, draft, elementId: element?.id || null };
    this.canvas.parentElement.append(editor);
    const preview = document.createElement('div'); preview.className = 'wb-math-preview'; preview.hidden = !formula;
    preview.setAttribute('aria-label', 'Prévia matemática');
    const status = document.createElement('div'); status.className = 'wb-math-status'; status.setAttribute('role', 'status');
    const previewCanvas = document.createElement('canvas'); previewCanvas.setAttribute('aria-label', 'Expressão renderizada');
    const palette = document.createElement('div'); palette.className = 'wb-math-palette';
    SYMBOLS.forEach(([label, latex, title]) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title;
      button.setAttribute('aria-label', title); button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        const value = formula ? latex : `\\(${latex}\\)`;
        if (editor.value.length - (editor.selectionEnd - editor.selectionStart) + value.length > editor.maxLength) return;
        editor.setRangeText(value, editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input')); editor.focus();
      }); palette.append(button);
    });
    preview.append(previewCanvas, status, palette); this.canvas.parentElement.append(preview);
    preview.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.finishTextEditing(false); this.canvas?.focus(); }
    });
    preview.addEventListener('focusout', event => {
      if (event.relatedTarget !== editor && !preview.contains(event.relatedTarget)) this.finishTextEditing(true);
    });
    Object.assign(this.textEditing, { preview, previewCanvas, status });
    editor.addEventListener('input', () => {
      editor.value = editor.value.slice(0, editor.maxLength);
      const editing = this.textEditing;
      if (editing) {
        editing.previewCanvas.hidden = true;
        editing.status.textContent = 'Preparando prévia…'; editing.status.classList.remove('is-error');
      }
      clearTimeout(this.textEditing?.previewTimer);
      if (this.textEditing) this.textEditing.previewTimer = setTimeout(() => this.updateMathPreview(), 120);
      this.positionTextEditor();
    });
    editor.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.finishTextEditing(false); this.canvas?.focus(); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault();
        Promise.resolve(this.finishTextEditing(true)).then(ok => { if (ok) this.canvas?.focus(); }); }
    });
    editor.addEventListener('blur', event => {
      if (!preview.contains(event.relatedTarget)) this.finishTextEditing(true);
    });
    this.render();
    this.positionTextEditor();
    this.updateMathPreview();
    editor.focus();
    if (element) editor.select();
  }

  getEditingDraft() {
    const editing = this.textEditing;
    return editing ? { ...editing.draft, [editing.draft.type === 'formula' ? 'latex' : 'text']: editing.editor.value.slice(0, editing.editor.maxLength).trim() } : null;
  }

  updateMathPreview() {
    const editing = this.textEditing; if (!editing) return;
    const draft = this.getEditingDraft(), segments = this.mathSegments(draft);
    const mathematical = draft.type === 'formula' || segments.incomplete || segments.some(segment => segment.type === 'math');
    editing.preview.hidden = !mathematical;
    if (!mathematical) return;
    if (draft.type === 'formula' && !draft.latex) { editing.status.textContent = 'Digite LaTeX ou escolha um símbolo'; editing.previewCanvas.hidden = true; return; }
    const entries = this.mathEntries(draft), error = entries.find(entry => entry.status === 'error');
    editing.status.textContent = segments.incomplete ? 'Feche a expressão com \\) ou \\].' : error ? error.error.message : entries.some(entry => entry.status === 'pending') ? 'Preparando prévia…' : 'Enter conclui · Esc cancela';
    editing.status.classList.toggle('is-error', Boolean(error || segments.incomplete));
    const layout = this.getTextLayout(draft), canvas = editing.previewCanvas;
    canvas.hidden = entries.some(entry => entry.status !== 'ready') || Boolean(segments.incomplete);
    if (!canvas.hidden) {
      const scale = Math.min(1, 300 / layout.width, 140 / layout.height), ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.ceil(layout.width * scale * ratio)); canvas.height = Math.max(1, Math.ceil(layout.height * scale * ratio));
      canvas.style.width = `${layout.width * scale}px`; canvas.style.height = `${layout.height * scale}px`;
      const ctx = canvas.getContext('2d'); ctx.scale(scale * ratio, scale * ratio); this.drawElement(ctx, { ...draft, x: 0, y: 0 });
    }
    this.positionTextEditor();
  }

  positionTextEditor() {
    if (!this.textEditing || !this.canvas?.parentElement) return;
    const { editor, draft } = this.textEditing;
    const rect = this.canvas.getBoundingClientRect(), parent = this.canvas.parentElement.getBoundingClientRect();
    const sx = rect.width / WHITEBOARD_REF_WIDTH * (this.zoom || 1);
    const sy = rect.height / WHITEBOARD_REF_HEIGHT * (this.zoom || 1);
    const layout = getWhiteboardTextLayout({ ...draft, text: editor.value }, this.ctx);
    const left = rect.left - parent.left + (this.panX || 0) * rect.width / (this.canvas.width || WHITEBOARD_REF_WIDTH) + draft.x * sx;
    const top = rect.top - parent.top + (this.panY || 0) * rect.height / (this.canvas.height || WHITEBOARD_REF_HEIGHT) + draft.y * sy;
    const mathematical = draft.type === 'formula' || !this.textEditing.preview?.hidden;
    const editorFont = mathematical ? Math.max(14, Math.min(20, layout.fontSize * sx)) : layout.fontSize * sx;
    const editorLine = mathematical ? editorFont * 1.4 : layout.lineHeight * sx;
    Object.assign(editor.style, {
      left: `${left}px`, top: `${top}px`, color: draft.color,
      fontSize: `${editorFont}px`, lineHeight: `${editorLine}px`,
      width: `${Math.max(mathematical ? 240 : 150, layout.width * sx + 24)}px`,
      height: `${Math.max(editorLine, layout.lines.length * editorLine) + 4}px`,
      maxWidth: `${Math.max(60, parent.width - left - 12)}px`,
      transform: mathematical ? 'none' : `scaleY(${sx ? sy / sx : 1})`
    });
    const preview = this.textEditing.preview;
    if (preview) {
      const paneWidth = Math.min(340, Math.max(120, parent.width - 16));
      Object.assign(preview.style, { width: `${paneWidth}px`, maxHeight: `${Math.max(100, parent.height - 32)}px`, left: `${Math.max(8, Math.min(left, parent.width - paneWidth - 8))}px` });
      const below = top + editor.getBoundingClientRect().height + 8;
      const previewTop = below + preview.offsetHeight <= parent.height - 8 ? below : top - preview.offsetHeight - 12;
      preview.style.top = `${Math.max(8, Math.min(previewTop, parent.height - preview.offsetHeight - 8))}px`;
    }
  }

  finishTextEditing(commit = true) {
    const editing = this.textEditing;
    if (!editing) return false;
    const draft = this.getEditingDraft();
    const key = draft.type === 'formula' ? 'latex' : 'text';
    const text = draft[key];
    if (commit && text) {
      const segments = this.mathSegments(draft), entries = this.mathEntries(draft);
      if (segments.incomplete || entries.some(entry => entry.status !== 'ready')) {
        if (editing.pendingCommit) return editing.pendingCommit;
        editing.pendingCommit = this.prepareMathElement(draft).then(() => {
          if (this.textEditing !== editing || this.getEditingDraft()[key] !== text) return false;
          editing.pendingCommit = null; return this.finishTextEditing(true);
        }).catch(error => {
          if (this.textEditing === editing) { editing.status.textContent = error.message; editing.status.classList.add('is-error'); editing.editor.focus(); }
          return false;
        }).finally(() => { editing.pendingCommit = null; });
        return editing.pendingCommit;
      }
    }
    this.textEditing = null;
    clearTimeout(editing.previewTimer);
    editing.editor.remove();
    editing.preview.remove();
    if (commit) {
      if (editing.elementId) {
        const current = this.elements.find(element => element.id === editing.elementId);
        if (current && !text) this.removeElement(editing.elementId, true);
        else if (current && current[key] !== text) this.updateElement({ ...current, [key]: text }, true);
      } else if (text) this.addElement(draft, true);
    }
    this.render();
    return true;
  }
};
