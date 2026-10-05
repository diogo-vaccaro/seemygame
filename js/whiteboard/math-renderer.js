export const MAX_LATEX_LENGTH = 2000;
const MAX_CACHE_ENTRIES = 2048;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const forbiddenCommands = /\\(?:require|href|url|includegraphics|html\w*|style|class|cssId|def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|DeclareMathOperator|global|csname|catcode|unicode|label|ref|eqref)\b/i;
let runtimePromise;

export function validateLatex(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Digite uma expressão matemática.');
  if (source.length > MAX_LATEX_LENGTH) throw new Error('A expressão é muito longa.');
  if (forbiddenCommands.test(source)) throw new Error('Este comando não está disponível na lousa.');
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '{' && ++depth > 32) throw new Error('Simplifique os grupos da expressão.');
    if (source[i] === '}' && --depth < 0) throw new Error('Confira as chaves { } da expressão.');
  }
  if (depth) throw new Error('Confira as chaves { } da expressão.');
}

export function loadMathJax() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => { script.remove(); reject(new Error('Não foi possível carregar o editor matemático.')); }, 15000);
    window.MathJax = {
      loader: { load: ['input/tex-base', '[tex]/ams', 'output/svg'] },
      startup: { typeset: false },
      tex: { packages: ['base', 'ams'], maxBuffer: 4096, maxTemplateSubtitutions: 1000,
        formatError: (_jax, error) => { throw error; } },
      output: { font: 'mathjax-newcm', fontPath: new URL('../vendor/mathjax/font', import.meta.url).href },
      svg: { fontCache: 'local' }
    };
    script.src = new URL('../vendor/mathjax/startup.js', import.meta.url).href;
    script.onload = () => {
      Promise.resolve(window.MathJax.startup?.promise).then(() => {
        clearTimeout(timer);
        if (!window.MathJax.tex2svgPromise) throw new Error('Renderizador matemático indisponível.');
        resolve(window.MathJax);
      }).catch(error => { clearTimeout(timer); reject(error); });
    };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Não foi possível carregar o editor matemático.')); };
    document.head.append(script);
  }).catch(error => { runtimePromise = null; throw error; });
  return runtimePromise;
}

const SVG_STYLES = '[data-frame],[data-line]{stroke-width:70px;fill:none}.mjx-dashed{stroke-dasharray:140}.mjx-dotted{stroke-linecap:round;stroke-dasharray:0,140}use[data-c]{stroke-width:3px}';
export async function renderLatexSvg(latex, { fontSize = 32, color = '#ffffff', display = true } = {}) {
  validateLatex(latex);
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 96 || !HEX_COLOR.test(color)) throw new Error('Estilo matemático inválido.');
  const mathjax = await loadMathJax();
  const result = await mathjax.tex2svgPromise(latex, { display, em: fontSize, ex: fontSize / 2 });
  const svg = result.querySelector('svg');
  if (!svg || svg.querySelector('[data-mml-node="merror"]')) throw new Error('Confira a expressão matemática.');
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    if (['script', 'foreignObject', 'image', 'a'].includes(node.localName)) throw new Error('Conteúdo matemático inválido.');
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || (attribute.localName === 'href' && !attribute.value.startsWith('#'))) throw new Error('Recurso externo indisponível.');
      if (attribute.value === 'currentColor') node.setAttribute(attribute.name, color);
    }
  }
  const toPixels = value => {
    const number = Number.parseFloat(value);
    return number * (value.endsWith('ex') ? fontSize / 2 : value.endsWith('em') ? fontSize : 1);
  };
  const width = toPixels(svg.getAttribute('width') || ''), height = toPixels(svg.getAttribute('height') || '');
  const depth = Math.max(0, -toPixels(svg.style.verticalAlign || '0'));
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 4096)) throw new Error('Reduza o tamanho da expressão.');
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style'); style.textContent = SVG_STYLES; svg.prepend(style);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
  svg.style.color = color; svg.style.verticalAlign = ''; svg.removeAttribute('aria-hidden');
  const markup = new XMLSerializer().serializeToString(svg);
  return { svg: markup, width, height, baseline: Math.max(0, Math.min(height, height - depth)) };
}

export function decodeMathSvg(svg) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Não foi possível desenhar a expressão.'));
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

export const mathKey = (latex, options) => JSON.stringify([latex, options.fontSize, options.color, options.display]);
export function createMathRenderer({ render = renderLatexSvg, decode = decodeMathSvg, onReady = () => {} } = {}) {
  const cache = new Map();
  let disposed = false;
  return {
    cache,
    get(latex, options) {
      const key = mathKey(latex, options);
      if (cache.has(key)) return cache.get(key);
      if (disposed || cache.size >= MAX_CACHE_ENTRIES) return { status: 'error', error: new Error('Limite de fórmulas atingido.') };
      const entry = { key, status: 'pending' }; cache.set(key, entry);
      entry.promise = Promise.resolve().then(() => render(latex, options)).then(async result => {
        const image = await decode(result.svg); Object.assign(entry, result, { image, status: 'ready' });
      }).catch(error => { entry.status = 'error'; entry.error = error; }).then(() => {
        if (!disposed && cache.get(key) === entry) onReady(entry);
        return entry;
      });
      return entry;
    },
    prune(keys) { for (const [key] of cache) if (!keys.has(key)) cache.delete(key); },
    dispose() { disposed = true; cache.clear(); }
  };
}

/** Only explicit delimiters opt text into mathematics; currency stays literal. */
export function parseMathText(text) {
  const segments = [];
  let start = 0, index = 0;
  while (index < text.length - 1) {
    if (text[index] !== '\\') { index++; continue; }
    if (text[index + 1] === '\\') { index += 2; continue; }
    const delimiter = text[index + 1];
    if (delimiter !== '(' && delimiter !== '[') { index += 2; continue; }
    const closing = delimiter === '(' ? ')' : ']';
    let end = index + 2;
    for (; end < text.length - 1; end++) {
      if (text[end] !== '\\') continue;
      if (text[end + 1] === closing) break;
      end++;
    }
    if (end >= text.length - 1) { segments.incomplete = true; index += 2; continue; }
    if (index > start) segments.push({ type: 'text', text: text.slice(start, index) });
    segments.push({ type: 'math', latex: text.slice(index + 2, end), display: delimiter === '[', source: text.slice(index, end + 2) });
    index = start = end + 2;
  }
  if (start < text.length || !segments.length) segments.push({ type: 'text', text: text.slice(start) });
  return segments;
}
