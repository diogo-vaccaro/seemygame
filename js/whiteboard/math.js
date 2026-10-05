import { getWhiteboardTextLayout } from './shared.js';
import { parseMathText, mathKey } from './math-renderer.js';

export const withWhiteboardManagerMath = Base => class extends Base {
  mathOptions(element, display = true) {
    return { fontSize: element.fontSize || (element.type === 'formula' ? 32 : 15),
      color: /^#[0-9a-f]{3,8}$/i.test(element.color || '') ? element.color : '#ffffff', display };
  }
  mathSegments(element) {
    return element.type === 'formula' ? [{ type: 'math', latex: element.latex || '', display: true, source: element.latex || '' }]
      : element.type === 'text' ? parseMathText(element.text || '') : [];
  }
  mathEntries(element) {
    return this.mathSegments(element).filter(segment => segment.type === 'math')
      .map(segment => this.mathRenderer.get(segment.latex, this.mathOptions(element, segment.display)));
  }
  async prepareMathElement(element) {
    const segments = this.mathSegments(element);
    if (segments.incomplete) throw new Error('Feche a expressão com \\) ou \\].');
    const entries = this.mathEntries(element);
    await Promise.all(entries.map(entry => entry.promise));
    const failed = entries.find(entry => entry.status !== 'ready');
    if (failed) throw failed.error || new Error('Não foi possível renderizar a expressão.');
  }
  pruneMathCache() {
    const keys = new Set();
    const elements = [...this.elements];
    // Resizing keeps measuring the gesture's original element while its new
    // font sizes render asynchronously. Keep that original layout cached.
    if (this.isResizingElement && this.resizeInitialState) elements.push(this.resizeInitialState);
    if (this.textEditing) elements.push(this.getEditingDraft());
    for (const element of elements) for (const segment of this.mathSegments(element)) {
      if (segment.type === 'math') keys.add(mathKey(segment.latex, this.mathOptions(element, segment.display)));
    }
    this.mathRenderer.prune(keys);
  }
  getTextLayout(element, ctx = this.ctx) {
    const plain = getWhiteboardTextLayout(element, ctx);
    const segments = this.mathSegments(element);
    if (element.type === 'formula') {
      const entry = this.mathEntries(element)[0];
      return { ...plain, width: entry.width || 160, height: entry.height || plain.lineHeight, entry };
    }
    if (!segments.some(segment => segment.type === 'math')) return plain;
    const runs = []; let row = [], width = 0, height = 0, maxWidth = 1;
    const fontSize = plain.fontSize;
    const flush = (force = false) => {
      if (!row.length && !force) return;
      const ascent = Math.max(fontSize * .9, ...row.map(run => run.baseline));
      const descent = Math.max(fontSize * .45, ...row.map(run => run.height - run.baseline));
      for (const run of row) runs.push({ ...run, y: height + ascent - run.baseline });
      height += ascent + descent; maxWidth = Math.max(maxWidth, width); row = []; width = 0;
    };
    ctx?.save?.(); if (ctx) ctx.font = plain.font;
    for (const segment of segments) {
      if (segment.type === 'text') {
        segment.text.split('\n').forEach((text, index) => {
          if (index) flush(true);
          const measured = ctx?.measureText?.(text)?.width ?? text.length * fontSize * .6;
          row.push({ type: 'text', text, x: width, width: measured, height: fontSize * 1.35, baseline: fontSize * .9 }); width += measured;
        });
      } else {
        if (segment.display) flush();
        const entry = this.mathRenderer.get(segment.latex, this.mathOptions(element, segment.display));
        const w = entry.width || Math.max(fontSize, segment.source.length * fontSize * .6);
        row.push({ type: 'math', entry, text: segment.source, x: width, width: w,
          height: entry.height || fontSize * 1.35, baseline: entry.baseline || fontSize * .9 }); width += w;
        if (segment.display) flush();
      }
    }
    flush(); ctx?.restore?.();
    return { ...plain, rich: true, runs, width: maxWidth, height: Math.max(fontSize * 1.35, height) };
  }
  renderFormula(ctx, element) {
    const { entry } = this.getTextLayout(element, ctx);
    if (entry.status === 'ready') ctx.drawImage(entry.image, element.x, element.y, entry.width, entry.height);
    else { ctx.font = `${element.fontSize || 32}px Arial`; ctx.textBaseline = 'top';
      ctx.fillStyle = entry.status === 'error' ? '#f87171' : element.color || '#ffffff';
      ctx.fillText(entry.status === 'error' ? 'Expressão inválida' : 'Carregando fórmula…', element.x, element.y); }
  }
};
