# LaTeX na lousa

Entrega de 05/10/2026.

## Uso

- **∑ Fórmula** ou **M**, seguido de um clique: escrever uma expressão no local escolhido, com prévia próxima. Enter confirma, Shift+Enter quebra a linha do código e Esc cancela.
- Dois cliques em uma fórmula existente reabrem o código original. Seleção, movimento, tamanho, cor e histórico usam os controles da lousa.
- A paleta insere modelos editáveis de fração, raiz, potência, índice, alfa, somatório, integral e matriz no cursor.
- No texto normal, `\(...\)` cria matemática na linha e `\[...\]` cria um bloco. Preços e comandos fora desses delimitadores permanecem texto.

```text
Área: \(A=\frac{b\cdot h}{2}\) unidades quadradas.
\[x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}\]
\[\begin{pmatrix}a&b\\c&d\end{pmatrix}\]
```

Uma expressão inválida conserva a edição aberta e mostra o problema ao lado do código. A fórmula anterior continua no documento compartilhado. Rascunhos e prévias não são transmitidos.

## Implementação

MathJax 4.1.3 produz SVG com paths locais, posteriormente decodificado e desenhado no canvas. Os arquivos e dados de glifos acompanham `js/vendor/mathjax` e a distribuição; não há CDN para fórmulas. A inicialização é sob demanda. `npm run vendor:mathjax` reproduz os arquivos a partir das versões do lockfile.

Elementos `formula` sincronizam `latex`, posição, tamanho e cor. O cache de SVG/imagem permanece local, compartilha conversões repetidas e descarta resultados de entradas removidas. Texto misto calcula larguras, alturas e baseline de cada segmento. Seleção e redimensionamento consultam essas medidas.

A confirmação aguarda a validação e a decodificação. Cancelamento, alteração do código durante a validação e múltiplas tentativas de confirmação não criam elementos atrasados ou duplicados. A exportação PNG pela interface aguarda as fórmulas e inclui suas imagens no canvas.

O suporte é de notação matemática TeX base/AMS, não de documentos LaTeX completos. Limites: 2.000 caracteres por fórmula, 500 no texto e fonte entre 8 e 96 unidades. Macros globais, links, HTML, imagens, carregamento de pacotes e referências entre fórmulas são recusados. SVGs também são verificados antes da decodificação.

O editor matemático mantém fonte legível no celular e posiciona a prévia fora do campo. O canvas conserva a transformação de coordenadas já usada pela lousa; em telas com proporção diferente de 16:9, o conteúdo do canvas ainda pode se deformar. Isso é uma limitação anterior à entrega, independente da prévia matemática.

## Validação

- Suíte unitária completa: 1.243 testes, 127 arquivos, aprovados.
- `tests/whiteboard-math.test.js`: validação, cache, cancelamento, confirmação concorrente, paleta, baseline, transformação, histórico e exportação.
- `npm run test:e2e:whiteboard-math`: dois participantes no Chrome; prévia, edição inválida, matriz, raiz, letras gregas, texto misto, sincronização, histórico, movimento, tamanho, PNG e celular. Primeira conversão também verificada com solicitações externas bloqueadas.
- E2E anterior das ferramentas didáticas e da lousa: aprovados, sem regressões.
- Módulos, HTML, CSS, importação ESM e build da distribuição: aprovados.

Evidências locais: `output/playwright/whiteboard-math-2026-10-05/`, incluindo `evidence.json`, prévias desktop/mobile e `board.png`.

## Referência

[Conversão e imagens SVG — documentação oficial MathJax](https://docs.mathjax.org/en/latest/web/convert.html).
