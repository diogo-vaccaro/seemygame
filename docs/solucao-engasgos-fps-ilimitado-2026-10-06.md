# Investigação de engasgos sob GPU saturada — evidências revalidadas

Data: 06/10/2026. Revisão após a auditoria do código e dos report.json.

## O que os dados permitem concluir

Os probes recentes medem captura→encode no transmissor, sem receptor remoto, áudio, replay, preview ou WebRTC. Eles ajudam a localizar atraso de componentes, mas não comprovam fluidez visual, sincronismo A/V nem eliminação de stutters ponta a ponta.

A tabela anterior identificava incorretamente o resultado DXGI de 60,09 FPS como Latest + GPU HIGH. Na rodada components-2026-10-06T04-48-26-938Z-24132e, a configuração efetiva foi **D3D11 + DXGI + Bounded + GPU normal (classe 2)**. A rodada foi marcada resource-pressure-unqualified. O resultado deve ser tratado como exploratório.

A rodada components-2026-10-06T04-49-41-530Z-284749 foi qualificada e registrou aproximadamente 60,1 FPS codificados com **D3D12 + janela WGC + Latest + GPU normal**, p50 captura→encode de 4,033 ms. Esse resultado é promissor para a combinação e hardware testados; não prova que a prioridade HIGH é responsável pelo ganho.

A tabela auditável é gerada diretamente dos JSONs em [evidencias-captura-componentes-2026-10-06.md](evidencias-captura-componentes-2026-10-06.md). Ela preserva fila, prioridade efetiva, status, resolução e escopo.

## Hipóteses que continuam abertas

- Retenção e backpressure nas filas de vídeo cru.
- Disponibilidade de quadros de WGC sob carga de GPU e composição.
- Diferenças entre D3D11/D3D12 e WGC/DXGI.
- Efeito real da prioridade de processo na apresentação do espectador.

Não há evidência direta suficiente para afirmar starvation do frame pool, perda de v-blank do DWM ou bypass total do compositor por scanout. Não atribuir a diferença de FPS a uma variável quando backend, método, fila ou carga também mudaram.

## Implementação após as correções da auditoria

- Auto tenta DXGI em monitor e WGC em janela. Se a aquisição DXGI falhar no Auto, o worker pode tentar WGC no **mesmo monitor**, sem migrar uma janela para captura de tela inteira.
- Backend solicitado, método solicitado e método ativo permanecem separados. A recuperação não faz loops infinitos e o estado informa o método efetivo.
- DXGI explícito permanece explícito; a recuperação de método não substitui a escolha deliberada do usuário.
- A solicitação HIGH do worker registra sucesso da prioridade CPU, status Set/Get e classe GPU efetiva. Isso não garante prioridade por fila/dispositivo nem FPS.
- A função sem chamadas que supostamente elevaria o host foi removida.
- Bounded permanece padrão enquanto a homologação com áudio/replay/receptor está pendente. Latest continua disponível explicitamente por configuração/SEEMYGAME_NATIVE_RAW_QUEUE para os testes controlados.
- new-pref=1.0 foi removido: com drop-only=true, esse comparador não governa a seleção no GStreamer 1.28.7. skip-to-first é uma opção de inicialização, não uma solução demonstrada para saturação.
- O runner inclui casos DXGI Bounded, DXGI Latest normal e DXGI Latest HIGH. O JSON e comparison.md usam os valores efetivamente registrados. Os hashes incluem worker.rs e platform.rs.

## Validação e próxima homologação

Os testes de recuperação usam falha determinística de runtime para verificar transições, preservação de preferências/portas e ausência de loops, sem depender de provocar uma falha no driver real. A compilação normal verifica também os comandos Tauri, que não entram nos testes Rust de biblioteca.

A próxima comparação de desempenho deve alternar a ordem, repetir pelo menos três intervalos de 60 segundos após warm-up e manter iguais codec, encoder, resolução, áudio, replay e carga. Separar comparação de backend de comparação de método, fila e prioridade. Registrar recursos externos, prioridade do worker real, frames ópticos distintos, p95/p99 de frametime, pausas de apresentação, perdas, jitter e A/V no espectador.

O problema de stutters sob jogo **ainda não está declarado resolvido**. Esta revisão corrige o código funcional e a atribuição das evidências; a homologação de desempenho continua exigindo E2E controlado.
