import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { WhiteboardManager, isSafeWhiteboardElement, MAX_WHITEBOARD_POINTS } from '../js/whiteboard.js';
import { bindWhiteboardUI } from '../js/whiteboard-ui.js';

let manager, canvas, ctx, ui;
beforeEach(() => {
  document.body.innerHTML = readFileSync('templates/whiteboard-modal/default.html', 'utf8');
  canvas = document.getElementById('whiteboard-canvas'); canvas.width = 1920; canvas.height = 1080;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1920, height: 1080 });
  canvas.parentElement.getBoundingClientRect = canvas.getBoundingClientRect;
  ctx = new Proxy({ measureText: text => ({ width: text.length * 12 }) }, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
  canvas.getContext = () => ctx;
  manager = new WhiteboardManager({ canvas });
  manager.onElementCreated = vi.fn(); manager.onElementUpdated = vi.fn();
});
afterEach(() => { ui?.destroy(); ui = null; manager.dispose(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
const event = (type, x, y, detail = 1) => new MouseEvent(type, { clientX: x, clientY: y, button: 0, detail, bubbles: true, cancelable: true });
const down = (x, y, detail) => canvas.onmousedown(event('mousedown', x, y, detail));
const move = (x, y) => canvas.onmousemove(event('mousemove', x, y));
const up = (x, y) => window.dispatchEvent(event('mouseup', x, y));
const click = (x, y) => { down(x, y); up(x, y); };
const doubleClick = (x, y) => { click(x, y); down(x, y, 2); up(x, y); canvas.ondblclick(event('dblclick', x, y, 2)); };

describe('Texto no próprio ponto clicado', () => {
  it('abre por dois cliques sem prompt e preserva posição sob zoom/pan', () => {
    const prompt = vi.spyOn(window, 'prompt'); manager.zoom = 2; manager.panX = 40; manager.panY = 20;
    doubleClick(440, 320);
    const editor = document.querySelector('.wb-inline-text-editor');
    expect(prompt).not.toHaveBeenCalled(); expect(document.activeElement).toBe(editor);
    expect(editor.style.left).toBe('440px'); expect(editor.style.top).toBe('320px');
    editor.value = 'Área = base × altura'; editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(manager.elements).toEqual([expect.objectContaining({ type: 'text', x: 200, y: 150, text: 'Área = base × altura' })]);
    expect(manager.onElementCreated).toHaveBeenCalledTimes(1);
    expect(document.querySelector('textarea')).toBeNull();
  });
  it('edita texto existente sem duplicar; Escape preserva o texto', () => {
    manager.addElement({ id: 'note', type: 'text', x: 300, y: 300, fontSize: 24, text: 'Antes' }, false);
    manager.setTool('select'); doubleClick(320, 310);
    const editor = document.querySelector('textarea'); editor.value = 'Depois'; editor.blur();
    expect(manager.elements).toHaveLength(1); expect(manager.elements[0].text).toBe('Depois');
    expect(manager.onElementUpdated).toHaveBeenCalledTimes(1);
    doubleClick(320, 310); document.querySelector('textarea').value = 'Cancelado';
    document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(manager.elements[0].text).toBe('Depois');
    expect(manager.undo()).toBe(true); expect(manager.elements[0].text).toBe('Antes');
  });
  it('Shift+Enter e composição não concluem a edição; texto multilinha é renderizado', () => {
    manager.setTool('text'); click(500, 300);
    const editor = document.querySelector('textarea'); editor.value = 'Base\nAltura';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(document.querySelector('textarea')).toBe(editor); editor.blur();
    expect(manager.elements[0].text).toBe('Base\nAltura');
    expect(ctx.fillText).toHaveBeenCalledWith('Base', 500, 300);
    expect(ctx.fillText).toHaveBeenCalledWith('Altura', 500, 332.4);
    expect(manager.getElementBounds(manager.elements[0]).height).toBeCloseTo(64.8);
  });
  it('não insere texto vazio e limita o conteúdo sincronizado', () => {
    manager.setTool('text'); click(500, 300); document.querySelector('textarea').blur(); expect(manager.elements).toHaveLength(0);
    click(500, 300); const editor = document.querySelector('textarea'); editor.value = 'a'.repeat(600); editor.blur();
    expect(manager.elements[0].text).toHaveLength(500);
    expect(isSafeWhiteboardElement(manager.elements[0])).toBe(true);
    expect(isSafeWhiteboardElement({ ...manager.elements[0], fontSize: Infinity })).toBe(false);
  });
  it('apagar o conteúdo remove a nota com histórico, sem recriar texto apagado remotamente', () => {
    manager.addElement({ id: 'note', type: 'text', x: 500, y: 300, text: 'Nota' }, false);
    manager.beginTextEditing({ x: 500, y: 300 }, manager.elements[0]);
    document.querySelector('textarea').value = ''; manager.finishTextEditing(true);
    expect(manager.elements).toHaveLength(0); manager.undo(); expect(manager.elements[0].text).toBe('Nota');
    manager.beginTextEditing({ x: 500, y: 300 }, manager.elements[0]);
    manager.removeElement('note', false); document.querySelector('textarea').value = 'Texto novo'; manager.finishTextEditing(true);
    expect(manager.elements).toHaveLength(0);
  });
});

describe('Linha por arraste ou vários vértices', () => {
  beforeEach(() => manager.setTool('line'));
  it('arrastar conclui uma linha do início à soltura fora do canvas', () => {
    down(200, 250); move(400, 350); up(600, 500);
    expect(manager.elements[0].points).toEqual([{ x: 200, y: 250 }, { x: 600, y: 500 }]);
    expect(manager.lineDraft).toBeNull(); expect(manager.onElementCreated).toHaveBeenCalledTimes(1);
  });
  it('cliques adicionam vértices, movimento mostra prévia e duplo clique finaliza sem duplicata', () => {
    click(200, 250); move(400, 350); click(400, 350);
    expect(manager.elements).toHaveLength(0); expect(manager.lineDraft.element.points).toHaveLength(2);
    move(650, 250); expect(manager.currentElement.points.at(-1)).toEqual({ x: 650, y: 250 });
    doubleClick(650, 250);
    expect(manager.elements[0].points).toEqual([{ x: 200, y: 250 }, { x: 400, y: 350 }, { x: 650, y: 250 }]);
    expect(manager.onElementCreated).toHaveBeenCalledTimes(1); expect(document.querySelector('textarea')).toBeNull();
    expect(manager.undo()).toBe(true); expect(manager.elements).toHaveLength(0); manager.redo(); expect(manager.elements[0].points).toHaveLength(3);
  });
  it('Enter conclui; Escape e troca de ferramenta cancelam sem transmitir rascunho', () => {
    click(200, 250); click(400, 350); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(manager.elements).toHaveLength(1);
    click(600, 250); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(manager.lineDraft).toBeNull();
    click(600, 250); manager.setTool('pencil'); expect(manager.currentElement).toBeNull();
    expect(manager.onElementCreated).toHaveBeenCalledTimes(1);
  });
  it('seleção e borracha seguem os segmentos, e mover/redimensionar preservam os vértices', () => {
    click(200, 250); click(400, 450); doubleClick(600, 250);
    const element = manager.elements[0], initial = structuredClone(element);
    expect(manager.hitTest(element, 300, 350, 5)).toBe(true); expect(manager.hitTest(element, 400, 250, 5)).toBe(false);
    manager.translateElement(element, initial, 20, 30); expect(element.points[1]).toEqual({ x: 420, y: 480 });
    manager.resizeElement(element, initial, 'br', 100, 100); expect(element.points[2]).toEqual({ x: 700, y: 250 });
    expect(isSafeWhiteboardElement(JSON.parse(JSON.stringify(element)))).toBe(true);
    expect(isSafeWhiteboardElement({ ...element, points: new Array(MAX_WHITEBOARD_POINTS + 1).fill({ x: 0, y: 0 }) })).toBe(false);
    expect(isSafeWhiteboardElement({ id: 'legacy', type: 'line', startX: 0, startY: 0, endX: 20, endY: 30 })).toBe(true);
  });
});

describe('Formas e integração com a interface', () => {
  it.each(['triangle', 'right-triangle', 'hexagon'])('%s desenha, sincroniza, seleciona e pode ser desfeita', type => {
    manager.setTool(type); manager.setFill('semi'); down(300, 250); move(500, 450); up(500, 450);
    const element = manager.elements[0]; expect(element.type).toBe(type); expect(isSafeWhiteboardElement(element)).toBe(true);
    expect(ctx.fill).toHaveBeenCalled(); expect(manager.findElementAt(400, 350)).toBe(element);
    const remote = new WhiteboardManager(); remote.addElement(JSON.parse(JSON.stringify(element)), false);
    expect(remote.elements).toEqual(manager.elements); remote.dispose();
    manager.undo(); expect(manager.elements).toHaveLength(0);
  });
  it('menu de formas seleciona, fecha fora e permite navegação pelo teclado', () => {
    ui = bindWhiteboardUI(manager); ui.open();
    const trigger = document.getElementById('wb-shapes-btn'), menu = document.getElementById('wb-shapes-menu');
    trigger.click(); expect(menu.hidden).toBe(false); expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const first = document.activeElement; first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement.dataset.tool).toBe('circle');
    menu.querySelector('[data-tool="triangle"]').click(); expect(manager.selectedTool).toBe('triangle'); expect(menu.hidden).toBe(true);
    expect(trigger.classList.contains('active')).toBe(true);
    trigger.click(); menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.hidden).toBe(true); expect(document.getElementById('whiteboard-modal').style.display).toBe('flex');
    trigger.click(); canvas.dispatchEvent(new Event('pointerdown', { bubbles: true })); expect(menu.hidden).toBe(true);
  });
  it('digitar não troca ferramentas; fechar confirma texto e descarta linha pendente', () => {
    const broadcast = vi.fn(); ui = bindWhiteboardUI(manager, { broadcast }); ui.open();
    manager.setTool('text'); click(500, 300); const editor = document.querySelector('textarea'); editor.value = 'Triângulos';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })); expect(manager.selectedTool).toBe('text');
    ui.close(); expect(manager.elements[0].text).toBe('Triângulos');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'WHITEBOARD_ELEMENT_ADD' }));
    ui.open(); manager.setTool('line'); click(300, 250); click(500, 450);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(manager.lineDraft).toBeNull();
    expect(document.getElementById('whiteboard-modal').style.display).toBe('flex'); ui.close();
    expect(manager.elements).toHaveLength(1);
  });
});
