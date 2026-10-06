# Auditoria das alterações locais — 06/10/2026

> Registro da auditoria antes das correções. A remediação posterior e os novos resultados estão em [correcao-achados-auditoria-2026-10-06.md](correcao-achados-auditoria-2026-10-06.md). Os achados abaixo descrevem a versão auditada, não o estado após a remediação.

## Parecer

Há melhorias plausíveis no caminho de captura, mas as alterações ainda não estão prontas para homologação. Foi reproduzida uma regressão na troca de qualidade durante uma transmissão web na sala. O novo seletor de adaptação também aciona uma reconfiguração nativa desnecessária. Os documentos de desempenho atribuem resultados a condições diferentes das efetivamente registradas e extrapolam benchmarks de componentes para fluidez ponta a ponta.

A aprovação dos testes unitários e estruturais não contradiz esses achados: eles não exercitam a integração entre os eventos dos controles, a sessão e os parâmetros efetivos do sender.

## Escopo e limites

- Branch local `main`, base `a589052` (`feat(room): add silent lobby and isolated voice channels`).
- Revisados os diffs dos 19 arquivos modificados, os dois documentos novos e `tools/e2e/verify-web-resolution-fps.mjs`.
- Conferidos os caminhos relacionados de eventos, captura, reconfiguração Rust, fallback, WebRTC, prioridades e benchmark.
- Não foram alterados arquivos de produção, feitas correções, commits ou push nesta auditoria. Foram criados este relatório e probes em `output/playwright/audit-2026-10-06/`, diretório ignorado pelo Git.
- Não foram executadas novas cargas de GPU, comparações entre duas máquinas ou benchmarks com jogo real. Os números de desempenho abaixo foram auditados nos JSONs existentes.
- O E2E executado usa Chrome isolado e mídia sintética. Ele valida integração e isolamento de canais, não a captura de hardware ou o desempenho de um executável Tauri atualizado.

## Validação executada

| Verificação | Resultado | Alcance |
| --- | --- | --- |
| `npm run verify` | Aprovado | Módulos, HTML, CSS, smoke ESM, **131 arquivos / 1.286 testes**, build de assets |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline` | **63 aprovados / 3 ignorados / 0 falhas** | Biblioteca e testes Rust; os três probes ignorados não foram executados por esse comando |
| `git diff --check` | Aprovado | Sem erros de whitespace; avisos de normalização LF/CRLF |
| `node tests/e2e-room-channels.mjs` | **12 verificações aprovadas** | Quatro participantes, lobby silencioso, texto global, canais isolados, entrada tardia, soundboard, saída e transmissão |
| Probe do controlador com `SessionContext` real e jsdom | Regressões reproduzidas | Ausência de eventos; chamada desnecessária ao provider; escala; fallback opcional |
| Probe de sala com dois contextos reais do Chrome e WebRTC | **Regressão reproduzida** | Sender ativo continua com os valores antigos após eventos reais de mudança no DOM |

Evidências:

- `output/playwright/audit-2026-10-06/probe.mjs` e `probe-results.json`.
- `output/playwright/audit-2026-10-06/room-quality-probe.mjs` e `room-quality-results.json`.
- `output/playwright/room-channels-1791290804714/report.json` e screenshots.

## Achados

### R1 — P1 — O controlador compartilhado não registra os eventos de mudança

**Local:** `js/streaming/settings-controller.js:8`; contrato em `js/core/session-context.js:94`.

O novo código chama `session.addEventListener(element, callback)`, omitindo `'change'`. O contrato é `(target, event, listener, options)`. Assim, o callback fica na posição do nome do evento, sem listener válido para `change`.

Afeta os controles de qualidade, bitrate, codec e adaptação desse controlador. Na sala web, nenhuma atualização de constraints, estado ou sender ocorre por esse caminho. Na página streamer existem handlers adicionais para perfil e bitrate; portanto, o efeito pode ser parcial nessa página. Esses handlers adicionais não recuperam o controlador nem tornam a integração correta.

**Reprodução no produto:** transmissão ativa entre duas salas Chrome, receptor apresentando vídeo. Após selecionar `ultra` (720p), bitrate `5000` e adaptação `balanced`:

| Observação | Antes | Depois |
| --- | --- | --- |
| Altura configurada em `roomState.captureSettings` | 1080 | 1080 |
| Limite efetivo do sender | 7.500.000 bps | 7.500.000 bps |
| Preferência efetiva do sender | maintain-resolution | maintain-resolution |
| Valores visíveis selecionados | Perfil inicial | ultra / 5000 / balanced |

A altura acima é a **configuração da sessão**, não a resolução recebida: a fonte sintética desse probe é 640×360. Não há exceção de página, o que torna a falha silenciosa.

**Correção:** restaurar `'change'`. Testar com o `SessionContext` real e validar o estado da sessão, constraints e `sender.getParameters()` após cada controle. Incluir o aviso de reinício ao mudar codec. Evitar mocks permissivos para a assinatura de listeners.

### R2 — P2 — Mudar adaptação reinicia a captura nativa sem aplicar a preferência ao pipeline Rust

**Locais:** `js/capture/settings.js:28`, `js/capture/settings.js:43`, `js/desktop/capture.js:136`, `src-tauri/src/capture/commands.rs:490`.

O seletor `degradation-preference-select` foi incluído na lista de reconfiguração do provider nativo. O probe confirmou uma chamada a `provider.reconfigure()` ao mudar apenas esse campo.

O wrapper desktop não envia `degradationPreference` ao comando Rust. Mesmo com os outros valores inalterados, `reconfigure_native_capture` para o worker e inicia outro. Logo, uma preferência de adaptação do sender do navegador passa a provocar uma interrupção da captura, sem configurar essa preferência no encoder nativo. O caminho nativo direto também não é governado pelos senders JS usados pelo controlador compartilhado.

**Correção:** separar opções da captura das opções do sender. Não reconfigurar Rust por uma mudança exclusiva dessa preferência. Para o caminho nativo direto, explicar a política realmente disponível ou implementar adaptação específica. Testar que essa mudança não troca o processo/PID nem interrompe áudio, RTP e vídeo.

### R3 — P2 — A atualização ao vivo desfaz a escala inicial quando a fonte não aceita o novo tamanho

**Locais:** `js/streaming/settings-controller.js:20–24`; escala inicial em `js/session/room-session.js:551` e `js/session/streamer-session.js:356`; handler adicional em `js/session/streamer-session.js:519`.

As sessões agora calculam a escala inicial a partir da altura real da track. Porém, a atualização compartilhada passa `scaleResolutionDownBy = 1` incondicionalmente. Quando `applyConstraints()` falha, o erro é tratado, mas o sender continua recebendo escala 1. Uma captura 1080p antes enviada a 720p com escala 1,5 pode voltar a ser enviada a 1080p. O handler adicional do streamer também usa `profile.scaleFactor || 1`, sem consultar a track real.

**Reprodução isolada:** para alcançar o handler, o probe fornece o argumento de evento ausente apenas por um adapter de auditoria; nenhum arquivo de produção foi corrigido. Track 1080p, alvo 720p, escala anterior 1,5 e constraints recusadas resultam em escala 1. Trata-se de uma segunda falha, atualmente mascarada por R1 no controlador compartilhado.

**Correção:** centralizar o cálculo de escala com os settings efetivos da track após constraints; preservá-lo quando a fonte não redimensionar. Considerar largura e altura, orientação e proporção, evitando arredondamento antecipado. Testar mudança de bitrate/adaptação sem alterar escala e troca 1080p↔720p com constraints aceitas, recusadas e ignoradas.

### R4 — P2 — O novo teste pode aprovar cenários que não homologam a funcionalidade anunciada

**Locais:** `tools/e2e/verify-web-resolution-fps.mjs:100`, `:159`, `:275`, `:388`.

Todos os casos usam `canvas.captureStream()` e WebRTC loopback na mesma página. Os casos rotulados como “Nativo” não usam Rust/WGC/DXGI. A troca dinâmica chama diretamente `applySenderOptimizations`, sem passar pelo seletor, `bindStreamingQuality` ou pela sessão. Esse isolamento é útil para validar um componente, mas deixa R1 e R2 completamente fora do teste.

A aprovação de resolução estática verifica somente a **menor altura**. Uma sequência 720, 1080, 1080 pode ser aprovada para alvo 720. Largura e proporção não são critérios; no caso dinâmico, só são comparadas alturas inicial/final. A tabela ainda mostra “PASSOU” sem incorporar o critério de FPS usado no exit final. Não há assert de codec efetivo nem de preferência aplicada. A animação usa rAF sem limitar a produção ao FPS declarado, e o teste não exporta um relatório reprodutível com hashes. `videoReady` não tem prazo explícito e a limpeza não está em `finally`.

**Correção:** nomear o teste como componente web. Manter esse smoke e adicionar um E2E do produto que opere os controles e observe o receptor. Verificar todas as amostras válidas após estabilização, ambas as dimensões, codec efetivo, cadence/presentation e parâmetros aplicados. Exportar JSON, impor timeout e limpar recursos em `finally`. Não usar média ≥50 FPS como homologação universal de um perfil solicitado de 60 FPS.

### R5 — P2 — O relatório atribui o resultado DXGI à fila e prioridade erradas

**Locais:** `docs/solucao-engasgos-fps-ilimitado-2026-10-06.md:37`; definição dos casos em `tools/e2e/compare-capture-components.mjs:25` e env em `:42`.

O documento apresenta 60,09 FPS / 1,59 ms / 0,022 ms como “DXGI Latest, prioridade GPU HIGH”. O JSON da rodada correspondente registra:

| Campo | Valor auditado |
| --- | --- |
| Arquivo | `components-2026-10-06T04-48-26-938Z-24132e/report.json` |
| Caso | monitor-dxgi |
| Backend / codec / encoder | D3D11 / H.264 / NVENC |
| Resolução / alvo | 1280×720 / 60 FPS |
| Política real, também presente no pipeline | **bounded**, 3 buffers / 50 ms |
| Classe GPU solicitada e efetiva | **normal / 2** |
| Qualificação | **resource-pressure-unqualified** |
| p50 captura→encode / fila | 1,591 ms / 0,0227 ms |

O runner força `SMG_COMPARE_RAW_QUEUE = c.rawQueue ?? 'bounded'`; o caso DXGI não define Latest. Os dados não permitem atribuir esse resultado a HIGH ou Latest.

A rodada `components-2026-10-06T04-49-41-530Z-284749/report.json` está qualificada e registrou aproximadamente 60,1 FPS com **D3D12 + janela WGC + Latest + GPU normal**, p50 captura→encode 4,033 ms. É um sinal positivo para essa combinação no hardware testado.

**Limite decisivo:** ambos são probes de captura/encode de aproximadamente 10 segundos, sem receptor remoto, áudio, replay, preview ou WebRTC. Contar cerca de 600 buffers codificados não comprova 600 imagens distintas apresentadas regularmente pelo espectador. A origem de starvation do frame pool ou falhas de v-blank do DWM não foi diretamente demonstrada pelos dados apresentados. O texto “bypass total do DWM via scanout” e a garantia de 60 FPS sob qualquer carga não decorrem dessas medições.

**Correção:** gerar tabelas a partir dos JSONs e preservar status, configuração e escopo. Tratar rodadas não qualificadas como exploratórias. Comparar as variáveis separadamente e realizar E2E antes de declarar a causa resolvida ou os novos padrões homologados.

### R6 — P2 — Automático agora usa DXGI, mas não tem fallback de método para WGC

**Locais:** `src-tauri/src/media/config.rs:174`; `src-tauri/src/media/worker.rs:284`.

Monitor no modo Auto passa a resolver para DXGI. O fallback existente altera D3D12 para D3D11, mantendo `config.capture_api`. Portanto, se a falha for do método DXGI, a segunda tentativa continua em DXGI.

A Microsoft documenta falhas de Desktop Duplication por modo não suportado, limite de duplicações, adapter incompatível, acesso e sessão desconectada. Isso não significa que WGC resolva todos esses casos; significa que a seleção Auto passou a depender de uma API com falhas próprias, sem uma tentativa alternativa de método. Esta auditoria identificou a lacuna por análise de caminhos, sem provocar troca de modo, bloqueio ou suspensão dos monitores.

**Correção:** no Auto, distinguir falha de backend de falha de aquisição e permitir uma tentativa controlada de WGC para o mesmo monitor quando apropriado. Preservar DXGI explícito e o isolamento de janela. Registrar motivo e caminho efetivo. Testar recuperação, multi-monitor, suspensão/retomada e falha sem loops de reinício.

Fonte: [Microsoft — DuplicateOutput](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput).

### R7 — P2 — O fallback opcional remove a preferência de resolução e ainda informa sucesso

**Locais:** `js/streaming/sender-parameters.js:12`; `js/webrtc/sender.js:25`; textos em `templates/streaming-options/default.html:110`.

Essa condição **já existia**, mas o novo padrão e a promessa de resolução constante passaram a depender dela. Quando `setParameters` rejeita um campo de prioridade opcional com `NotSupportedError` ou `InvalidModificationError`, a tentativa seguinte remove também `degradationPreference`, mesmo que ela seja suportada. O probe simula rejeição exclusiva de `networkPriority`: a função retorna true, bitrate é aplicado e a preferência fica ausente.

Como a track recebe `contentHint = 'motion'`, a ausência de preferência explícita é especialmente relevante: a especificação orienta o navegador a usar maintain-framerate nesse caso. Além disso, maintain-resolution é uma preferência de degradação, não uma garantia de imagem nítida ou FPS máximo.

**Correção:** retirar apenas os campos rejeitados, em etapas; conferir os parâmetros efetivos após aplicação e expor fallback no diagnóstico. Ajustar os textos para “prioriza resolução; pode reduzir FPS”, sem prometer 1080p nítido ou 60/120 FPS a qualquer custo. Validar também o navegador que suporta preferência mas rejeita prioridade.

Fonte: [W3C — preferência de degradação e contentHint](https://www.w3.org/TR/mst-content-hint/#degradation-preference-when-encoding).

## Observações de desempenho e manutenção

1. **`new-pref=1.0` não explica os ganhos nesse pipeline.** O runtime registrado é GStreamer 1.28.7, com a propriedade disponível. No código dessa versão, `drop-only=true` decide emitir/descartar o buffer pelo timestamp e não passa pelo comparador last/next que usa `new_pref`. O pipeline já ativa drop-only. A explicação documental de priorização do frame mais recente por essa propriedade deve ser corrigida. `skip-to-first` tem efeito de inicialização; não comprova fluidez sob carga. Fontes: [videorate](https://gstreamer.freedesktop.org/documentation/videorate/index.html) e [implementação 1.28.7](https://github.com/GStreamer/gstreamer/blob/1.28.7/subprojects/gst-plugins-base/gst/videorate/gstvideorate.c).
2. **Prioridade do worker foi implementada, mas o ganho não foi isolado.** `assign_child_to_job_object` chama Set/Get da classe GPU e registra statuses. Isso é melhor que presumir aplicação. O probe de componentes tem prioridade própria e roda in-process; não comprova a elevação do processo worker real. `set_current_process_high_priority()` não tem chamada encontrada, e ignora retorno. Não confundir a função adicionada com host já elevado.
3. **Latest foi promovida sem E2E correspondente nas evidências novas.** A política está limitada a vídeo cru e mantém áudio/RTP fora do descarte, o que é adequado. Ainda falta confirmar a troca do padrão com áudio, replay, recuperação, encoder alternativo e receptor apresentando vídeo sob carga. O comentário acima do enum ainda pede manter o padrão até concluir essas validações.
4. **Os novos testes Rust verificam configuração e montagem de pipeline.** Eles confirmam o seletor e as duas filas pré-encode, mas não comprovam ausência de stutters, recuperação de DXGI ou ganho de prioridade em hardware.
5. **As mudanças de resolução têm uma direção útil.** Calcular escala a partir da track real é mais confiável que supor a resolução do monitor. Porém, o cálculo está duplicado, considera só altura e arredonda para duas casas; uma função comum pode cobrir proporção e orientação, e deve ser testada com capturas ultrawide/portrait e mudança do tamanho da janela.

## Ordem recomendada de correção e testes

1. **Corrigir R1 e R2 primeiro.** São problemas concretos no fluxo do usuário. Adicionar testes do binding real e reinício/PID para impedir regressão silenciosa.
2. **Unificar escala e atualização do sender (R3 e R7).** Um teste com constraints recusadas deve preservar 720p; outro com prioridade não suportada deve preservar maintain-resolution.
3. **Revisar o teste e os documentos (R4 e R5).** Separar smoke de componente, integração de produto e homologação de desempenho. Usar resolução/codec efetivos e distribuição de apresentação, não somente FPS codificado ou média.
4. **Cobrir fallback Auto de monitor (R6).** Exercitar falhas de método separadamente de falhas de D3D12 e garantir limpeza de processos, ports e bridges.
5. **Homologar a política Latest e a prioridade em E2E controlado.** Comparar D3D11/WGC e D3D12/WGC em janela; comparar WGC/DXGI em monitor. Para cada par, manter codec, encoder, resolução, áudio, replay e carga iguais. Alternar ordem e repetir ao menos três rodadas de 60 segundos após warm-up, preservando a qualificação de recursos.
6. **Coletar evidência no espectador.** Glass-to-glass calibrado, frames ópticos distintos, cadence de decode/apresentação, p95/p99 de frametime, pausas consecutivas, perdas, jitter, sincronismo A/V e fila de cada estágio. Registrar PID e prioridade efetiva do worker real. Rodadas de componentes continuam úteis para localizar gargalos, mas não substituem essa medição.

Critério de conclusão: controles alteram o estado e o sender efetivo, mudanças exclusivas de adaptação não reiniciam captura, configuração do relatório coincide com a executada, e ganhos de componentes persistem na apresentação remota sem regressão de áudio/replay/recuperação. As alterações atuais ainda não atendem a esse conjunto.
