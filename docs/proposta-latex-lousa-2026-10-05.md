# Proposta de expressões matemáticas na lousa

Data: 05/10/2026. Proposta original, implementada após aprovação. Consulte [a entrega e sua validação](latex-lousa-2026-10-05.md).

## Recomendação

Oferecer duas entradas para o mesmo renderizador: **∑ Fórmula**, para expressões independentes, e comandos delimitados no texto, para anotações que misturam explicação e matemática. Começar pelo botão e acrescentar texto misto depois que renderização, medidas, sincronização e exportação estiverem validadas.

## Experiência de uso

O botão ∑ Fórmula ativa uma ferramenta. Clicar no canvas abre um campo no ponto escolhido, com prévia próxima, sem diálogo modal. O usuário escreve `\frac{b\cdot h}{2}` e vê a fração formatada. Uma pequena paleta oferece fração, raiz, potência, índice, letras gregas, soma, integral e matriz, inserindo exemplos editáveis no campo.

Enter confirma; Esc cancela. Dois cliques numa fórmula existente reabrem o código original. A fórmula pode ser movida, redimensionada, recolorida e desfeita como os demais elementos. Enquanto a expressão estiver incompleta, a prévia indica o problema e conserva o código digitado; a fórmula anterior permanece até uma confirmação válida.

No texto normal, reconhecer somente delimitadores explícitos:

```text
A área é \(A=\frac{b\cdot h}{2}\).
A solução é \(x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}\).
\[\int_0^1 x^2\,dx=\frac13\]
```

`\(...\)` representa matemática na linha; `\[...\]` representa um bloco. Evitar `$...$` por padrão para não interpretar preços ou textos comuns como matemática. Comandos fora desses delimitadores permanecem texto literal.

## Renderizador e integração com o código

Recomenda-se **MathJax com saída SVG** para esta arquitetura. A lousa já usa `canvas`, inclusive para exportar PNG. MathJax oferece conversão assíncrona de TeX para SVG, e a documentação descreve como produzir uma imagem independente com paths locais e estilos embutidos. O SVG resultante pode ser decodificado como imagem e desenhado no canvas, mantendo o LaTeX original editável.

KaTeX também atende à notação matemática e seria uma opção para uma lousa baseada em elementos HTML. Suas saídas documentadas são HTML/MathML; adotá-lo aqui exigiria uma etapa adicional de composição/rasterização para manter a exportação atual. Uma camada HTML sobre o canvas, sozinha, não entraria no PNG gerado por `canvas.toBlob()`.

Representação proposta para uma fórmula independente:

```js
{
  id: 'wb_...',
  type: 'formula',
  latex: '\\frac{b\\cdot h}{2}',
  x: 400,
  y: 300,
  fontSize: 32,
  color: '#ffffff'
}
```

Sincronizar código e propriedades pelo protocolo de elementos existente. Cada participante produz a imagem localmente, com a mesma versão do renderizador. SVGs e objetos `Image` são cache local, sem converter a fórmula permanentemente em imagem colada.

Pontos de integração:

- `shared.js`: novo tipo e validação de fórmula, limites de código e tamanho.
- `text-editor.js` e `input.js`: modo de edição de fórmula, prévia, atalhos e duplo clique contextual.
- Novo `math-renderer.js`: carregamento sob demanda, conversão assíncrona, métricas e cache. Alterações recebem uma geração para descartar prévias antigas que terminem depois de uma edição nova.
- `renderer.js` e `geometry.js`: imagem no canvas e bounds reais para seleção, movimento e redimensionamento.
- `exporter.js`: aguardar conversão/decodificação pendentes antes de gerar PNG.
- Templates e CSS: botão ∑, paleta compacta e mensagens próximas ao editor.

Biblioteca, componentes e dados necessários devem acompanhar a distribuição local para funcionar offline no desktop. O renderizador deve usar configuração restrita para conteúdo vindo de participantes, sem recursos externos ou macros globais compartilhadas entre fórmulas.

Texto misto exige um layout por segmentos: texto e fórmula têm larguras, alturas e linhas de base diferentes. Isso substitui a atual medida simples por linha em `getWhiteboardTextLayout`; reconhecer delimitadores sem fazer esse layout provocaria sobreposição de frações, índices e raízes.

## Entrega sugerida

1. Botão ∑ Fórmula, prévia sem modal e fórmulas independentes editáveis; sincronização, histórico, transformação e PNG.
2. Comandos de matemática dentro do texto, com cálculo correto de baseline e quebras de linha.
3. Paleta expandida com modelos didáticos como Bhaskara, sistemas, matrizes e limites, conforme uso real.

Validar frações, raízes, índices, somas, integrais e matrizes; erros e edição interrompida; zoom/pan; dois participantes; desfazer/refazer; exportação PNG; funcionamento offline e limpeza do cache.

## Fontes oficiais

- [Conversão e SVGs independentes — MathJax](https://docs.mathjax.org/en/latest/web/convert.html).
- [Saída SVG — MathJax](https://docs.mathjax.org/en/latest/output/svg.html).
- [Cache local dos paths — MathJax](https://docs.mathjax.org/en/latest/options/output/svg.html).
- [Opções e formatos de saída — KaTeX](https://katex.org/docs/options.html).
- [Conteúdo fornecido por usuários — MathJax](https://docs.mathjax.org/en/latest/web/components/misc.html#ui-safe).
