# Teste da anotação sobre a transmissão — 07/10/2026

Foi reproduzida uma falha funcional na opção **Ferramentas → Anotar no Vídeo**: o seletor incluía qualquer elemento `video` da página. O navegador retornava o vídeo oculto da prévia de clipes, que aparece antes da transmissão no DOM. A barra e o canvas eram criados dentro do modal oculto e o usuário não conseguia desenhar.

A seleção agora procura apenas vídeos visíveis dos cards de transmissão e prioriza o card ativo. O menu de PiP usava o mesmo seletor e recebeu a mesma correção.

## Validação

- Dois contextos isolados do Chrome, sinalização PeerJS local e conexão WebRTC real.
- Ativação pelo botão do card e pelo menu Ferramentas.
- Desenho por eventos reais de mouse: caneta, marca-texto, seta, retângulo e círculo.
- Leitura dos pixels do canvas nas duas telas confirma que os desenhos foram renderizados.
- O participante recebe o desenho e consegue ativar a edição para desenhar de volta ao transmissor.
- Borracha e limpeza removem os desenhos nas duas pontas.
- Redimensionamento, modo expandido e tela cheia preservam desenho e sincronização.
- 30 testes unitários/regressões passaram em três arquivos; grafo de módulos validado.

Teste reproduzível: `node tests/e2e-annotation-interaction.mjs`. Para testar o frontend compilado em `dist`, definir `SEEMYGAME_E2E_DIST=1` antes do comando. Evidências e screenshots ficam em `output/playwright/annotation-interaction-*/`.

A captura de tela é sintética. O teste de interação cobre o Chrome, não uma sessão real entre o executável nativo e o site publicado. O executável local é recompilado com o frontend corrigido; a correção permanece local, sem publicação no site.
