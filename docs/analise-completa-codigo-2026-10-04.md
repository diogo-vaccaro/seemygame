# Análise de código — 4 de outubro de 2026

**Status posterior: A01–A16 corrigidos.** Consulte [correções e validação](G:/SeeMyGame/docs/correcao-achados-2026-10-04.md). O conteúdo abaixo registra a auditoria antes das correções; os scripts de reprodução agora executam os testes de comportamento correto.

A análise encontrou **14 bugs reproduzidos** e **dois riscos adicionais nos caminhos Rust do aplicativo**, identificados por inspeção. Os problemas mais urgentes envolvem captura de microfone depois de sair da voz, interrupção do áudio ao trocar de dispositivo, aprovação de Co-op e eventos de conexões antigas que apagam conexões novas.

Os testes existentes passam, mas não cobrem essas sequências de cancelamento, reconexão e integração entre funcionalidades.

## Escopo e estado do workspace

Referência Git: `2cb55ea`. O workspace estava limpo no início. Durante a análise apareceram alterações paralelas em voz, negociação nativa, configurações de sala e testes. Elas foram preservadas; os achados foram conferidos contra os arquivos atuais e a suíte foi repetida ao final.

Foram revisados os fluxos de Streamer, Viewer e Room; admissão e identidade no transporte P2P; voz, dispositivos e processamento de áudio; captura e negociação WebRTC nativa; Co-op e companion; cartões de vídeo; pings/laser; replay; whiteboard; plugins e descarte de recursos. A validação estrutural abrangeu todos os 170 módulos autorais reconhecidos pelo verificador.

Esta entrega adiciona relatório e reproduções isoladas. **Não modifica o código do produto.** As alterações paralelas listadas por `git status` não fazem parte desta análise.

## Verificações executadas

| Verificação | Resultado |
|---|---|
| Vitest, suite inicial | 119 arquivos; 1.142 testes passaram |
| Vitest, suite após alterações paralelas | 121 arquivos; 1.152 testes passaram |
| Reproduções desta análise | 16 testes passaram, confirmando comportamentos defeituosos de 13 achados |
| Chrome real, duas sessões Room e PeerJS local | Confirmou A11 e A13; sem erros de página |
| Rust `cargo test --locked --offline --lib` | 53 passaram; 3 ignorados |
| Rust `cargo check --locked --offline --lib` | Passou, incluindo caminhos excluídos do build de testes |
| Companion Python, drivers substituídos | 5 testes passaram; nenhuma injeção real de input |
| Grafo de módulos | 170 módulos; 430 imports/exports válidos |
| HTML e CSS | Verificações passaram |
| Smoke de importação ESM | 164 módulos; sem inicialização de listeners, rede, áudio ou timers de página |

Os testes isolados **afirmam o defeito observado**, para guardar evidência reproduzível. Não são testes de regressão que demonstram uma correção e não entram na suite normal `tests/**/*.test.js`.

## Achados reproduzidos

### A01 — P1: troca de microfone reativa captura depois de sair da voz

Local: [devices.js:64](G:/SeeMyGame/js/voice/devices.js:64), [capture.js](G:/SeeMyGame/js/voice/capture.js).

Sequência: entrar na voz, iniciar `setAudioInputDevice()`, sair antes de `getUserMedia()` responder e então liberar a resposta. A saída incrementa `captureGeneration`, mas a troca de dispositivo não verifica essa geração. Ela instala um novo stream mesmo com `isInVoice === false`.

**Evidência:** A01 constatou `localStream` novamente preenchido, faixa `live` e `enabled === true` depois da saída. O problema envolve captura local; a reprodução não afirma que houve transmissão dessa faixa a outro usuário.

Correção sugerida: invalidar também as trocas de dispositivo na saída e em trocas posteriores; conferir geração depois de cada captura assíncrona e parar imediatamente as faixas de respostas obsoletas.

### A02 — P2: troca de microfone preserva captura antiga e abandona o processamento de ganho

Local: [devices.js:68](G:/SeeMyGame/js/voice/devices.js:68).

A entrada na voz cria `rawLocalStream → source → gain → processedStream`. A troca para somente o áudio de `localStream`, que normalmente é a saída processada, e instala o novo microfone diretamente. Não para o microfone bruto anterior nem reconstrói o grafo.

**Evidência:** A02 manteve a faixa bruta antiga `live`, a fonte conectada e `rawLocalStream` apontando para o microfone anterior; `processedStream` passou a conter a faixa encerrada e o novo `localStream` era a captura bruta. O controle de ganho continua ligado ao dispositivo antigo.

Correção sugerida: encerrar o grafo e a captura anteriores e passar o novo dispositivo pelo mesmo processamento usado na entrada inicial.

### A03 — P1: trocar de microfone deixa os senders de voz com uma faixa encerrada

Local: [devices.js:81](G:/SeeMyGame/js/voice/devices.js:81), [session-handlers.js:84](G:/SeeMyGame/js/protocol/session-handlers.js:84).

A troca emite `audioInputTrackChange`, mas os handlers das sessões atuais não assinam esse evento para substituir o áudio das chamadas PeerJS. A faixa enviada é parada pela troca, enquanto as chamadas permanecem abertas.

**Evidência:** A03 respondeu uma chamada, trocou o microfone e constatou que o sender conservava uma faixa `ended`, sem chamada a `replaceTrack()` e sem listener de `audioInputTrackChange`.

Correção sugerida: ligar o evento à substituição dos senders de todas as chamadas de voz ativas, com tratamento de falha e remoção do listener no descarte.

### A04 — P1: participantes Room não processam a aprovação recebida de Co-op

Local: [session-handlers.js:135](G:/SeeMyGame/js/protocol/session-handlers.js:135).

Todas as mensagens Co-op de `role === 'room'` são enviadas a `handleHostCoopMessage()`. Entretanto, um participante da sala pode conceder controle da própria transmissão e receber controle da transmissão de outro participante. `COOP_RESPONSE`, capacidades e revogação recebidas precisam também do comportamento de jogador.

**Evidência:** A04 entregou uma aprovação de slot 2 pelo dispatcher Room: apenas o handler host foi chamado. O handler viewer, que define `isPlayer2`, o slot e os listeners de entrada, não recebeu a aprovação.

Correção sugerida: rotear por tipo e direção do comando, vinculando respostas ao host solicitado; fornecer também o cartão correspondente ao handler de jogador. Não basta classificar toda a sessão Room como host ou viewer.

### A05 — P2: participante pode falsificar o estado de voz de outro participante

Local: [session-handlers.js:54](G:/SeeMyGame/js/protocol/session-handlers.js:54).

`VOICE_STATE_UPDATE` aceita o `data.peerId` declarado sem vinculá-lo a `sourceConn.peer`. A validação geral verifica a identidade do envelope, mas não esse identificador interno. Assim, um membro já admitido pode alterar indicadores de mute, deaf ou fala de outro membro.

**Evidência:** A05 enviou a mensagem pela conexão `attacker`, declarando `peerId: 'victim'`; o estado `isMuted` da vítima mudou. A reprodução comprova falsificação do estado apresentado, não acesso ao microfone da vítima.

Correção sugerida: derivar a identidade da conexão em mensagens diretas; para retransmissões legítimas do Streamer, estabelecer um contrato explícito de relay confiável, como já existe no chat.

### A06 — P2: reset de entrada perde o slot e pode atingir todos os jogadores

Local: [input.js:50](G:/SeeMyGame/js/coop/input.js:50), [host.js:163](G:/SeeMyGame/js/coop/host.js:163).

Ao ocultar a página, o jogador envia `INPUT_RESET` sem seu slot. O host assume slot 1. Jogadores atribuídos aos slots 2/3 não são reconhecidos e suas entradas não são liberadas. Para o jogador do slot 1, o reset normal chama `dispatchHostInputReset()` sem escopo, embora o transporte suporte reset por slot.

**Evidência:** A06 confirmou ausência de slot e nenhum efeito para jogador do slot 2. A06b confirmou que um reset autorizado do slot 1 foi despachado sem argumentos, mesmo havendo outro jogador no slot 2.

Correção sugerida: incluir o slot atribuído no envio e preservar esse escopo ao liberar teclado, mouse e gamepad no host.

### A07 — P2: condição de clique do mouse está invertida

Local: [input.js:77](G:/SeeMyGame/js/coop/input.js:77), [input.js:87](G:/SeeMyGame/js/coop/input.js:87).

A expressão `!activeHostCapabilities.mouse === false` faz o handler retornar quando `mouse` é verdadeiro e continuar quando é falso. O movimento do mouse usa a comparação correta, produzindo comportamento inconsistente entre mover e clicar.

**Evidência:** A07 transmitiu o clique com capacidade desabilitada e não o transmitiu com capacidade habilitada. A mesma expressão ocorre no mouse up.

Correção sugerida: comparar diretamente `activeHostCapabilities.mouse === false`, mantendo as verificações de jogador/conexão e de autorização no host.

### A08 — P1: conexão antiga do Viewer apaga a conexão substituta

Local: [viewer-session.js:211](G:/SeeMyGame/js/session/viewer-session.js:211).

Reconectar ao mesmo host substitui a entrada de `watchingHosts`, mas o callback `close` da conexão anterior remove o cartão e a entrada por ID sem conferir qual conexão está armazenada. Também emite uma desconexão que pode encerrar o receptor nativo atual.

**Evidência:** A08 criou duas conexões ao mesmo host e encerrou a antiga. A nova continuou aberta, mas desapareceu do mapa e o cartão foi removido.

Correção sugerida: encerrar explicitamente a conexão substituída e conferir a identidade da conexão antes de executar callbacks de estado, dados e descarte.

### A09 — P1: eventos de chamada de mídia antiga removem ou sobrescrevem vídeo novo

Local: [viewer-session.js:289](G:/SeeMyGame/js/session/viewer-session.js:289), [viewer-session.js:320](G:/SeeMyGame/js/session/viewer-session.js:320).

O Viewer aceita uma nova chamada por host, mas `stream` e `close` das chamadas anteriores continuam modificando o vídeo atual. O fechamento antigo para estatísticas, remove o cartão e emite `stream:stopped`, interrompendo também o replay daquele host.

**Evidência:** A09 fechou a chamada antiga depois de a nova receber vídeo: o cartão foi removido e `stream:stopped` emitido, embora o mapa ainda guardasse a chamada nova. A09b entregou um stream atrasado da chamada antiga e ele substituiu `remoteStream`.

Correção sugerida: em ambos os eventos, conferir sessão ativa e identidade da chamada; fechar a chamada anterior ao substituí-la. Room já protege seu callback de fechamento, mas seu callback de stream também merece a mesma proteção contra resposta antiga.

### A10 — P1: conexão antiga no Streamer revoga autenticação e encerra mídia nova

Local: [streamer-session.js:290](G:/SeeMyGame/js/session/streamer-session.js:290).

O Streamer sobrescreve `connectedViewers` ao abrir outra conexão do mesmo peer. O `close` da conexão anterior apaga esse peer, revoga admissão e fecha a chamada de mídia guardada pelo ID, mesmo que seja a chamada nova.

**Evidência:** A10 usou uma sala protegida por PIN, autenticou a conexão substituta e instalou sua chamada. O fechamento da conexão antiga removeu a conexão atual do mapa, revogou sua autenticação e fechou sua mídia.

Correção sugerida: associar a limpeza à conexão que a originou, protegendo admissão, mídia e evento `streamer:viewerDisconnected` contra gerações anteriores.

### A11 — P2: “Pedir Controle” não funciona em cartões Room e nativos

Local: [room-session.js:495](G:/SeeMyGame/js/session/room-session.js:495), [native-media-plugin.js:135](G:/SeeMyGame/js/plugins/native-media-plugin.js:135), [video-cards.js:395](G:/SeeMyGame/js/ui/video-cards.js:395).

O cartão remoto sempre mostra o botão, mas só instala ação se receber `onCoopClick`. Nem a recepção PeerJS Room nem a recepção nativa fornece esse callback. O caminho PeerJS do Viewer fornece a ação corretamente.

**Evidência:** Chrome com dois membros Room e transmissão real entre eles encontrou “Pedir Controle” com `onclick === null`. A11 confirmou também ausência do callback no cartão criado por `NativeMediaPlugin.ontrack`.

Correção sugerida: fornecer a ação usando a conexão e o controlador Co-op da sessão correspondente. Corrigir A04 junto com isso; instalar o botão sozinho não resolve a aprovação Room.

### A12 — P2: “Clipar” no Viewer pode exportar a transmissão selecionada de outra pessoa

Local: [viewer-session.js:300](G:/SeeMyGame/js/session/viewer-session.js:300), [video-cards.js:352](G:/SeeMyGame/js/ui/video-cards.js:352).

O cartão PeerJS do Viewer não recebe `onClipClick`. Seu botão recai no `clip-btn` global, que exporta a fonte selecionada para replay. Se há múltiplos hosts e a fonte selecionada é A, clicar no cartão de B exporta A.

**Evidência:** A12 confirmou o callback ausente na criação do cartão Viewer. A12b criou o cartão real de B, com exportação global selecionada em A, e o clique exportou A.

Correção sugerida: passar o `sourceId` específico ao editor de clipes. Se a fonte não tem histórico gravado, mostrar esse estado; o registry já impede fallback para outra fonte quando recebe um ID explícito.

### A13 — P2: tela cheia exclui laser, pings e demais overlays

Local: [video-cards.js:371](G:/SeeMyGame/js/ui/video-cards.js:371).

O botão promove o elemento `<video>` a fullscreen. O canvas tático e os controles estão fora desse elemento, portanto não entram na apresentação em tela cheia.

**Evidência:** Chrome confirmou `document.fullscreenElement.tagName === 'VIDEO'`, canvas existente e `fullscreenElement.contains(pingCanvas) === false`. Isso explica por que ferramentas táticas podem parecer não funcionar nessa modalidade, mesmo após a correção anterior de pings/laser.

Correção sugerida: promover um contêiner que contenha vídeo e overlays; conferir posição, dimensões e roteamento de input ao entrar e sair de fullscreen.

### A16 — P2: remover cartão deixa listeners globais e DOM antigo retidos

Local: [video-cards.js:643](G:/SeeMyGame/js/ui/video-cards.js:643), [video-cards.js:150](G:/SeeMyGame/js/ui/video-cards.js:150).

Cada cartão registra dois listeners de fullscreen no `document`. `removeVideoCard()` remove o DOM e monitores, mas não desregistra esses listeners. Recriar cartões acumula callbacks e referências ao DOM removido. O timer de esconder controles também não possui um descarte associado ao cartão.

**Evidência:** A16 criou e removeu um cartão real; os dois listeners continuaram registrados e um evento de fullscreen ainda alterou um botão do cartão desconectado do documento.

Correção sugerida: dar ao cartão uma função de descarte que remova os listeners, cancele o timer e limpe `srcObject`; executá-la na remoção, reconstrução e descarte da sessão.

## Riscos nativos identificados por inspeção

Estes dois itens não receberam reprodução interativa no Tauri. A compilação passou, mas isso não exercita as sequências descritas.

### A14 — P1: negociação nativa pode inserir uma ponte antiga na captura nova

Local: [commands.rs:817](G:/SeeMyGame/src-tauri/src/capture/commands.rs:817), [commands.rs:873](G:/SeeMyGame/src-tauri/src/capture/commands.rs:873).

`create_native_viewer_peer()` valida sessão e estado com o mutex, solta o mutex para construir a ponte e negociar SDP e depois adquire novamente `active_session`. Nesse segundo acesso não revalida `session_id`, estado `live` ou geração da negociação antes de adicionar portas ao fanout e inserir a ponte.

Se a captura parar e outra iniciar durante a negociação, a ponte antiga pode ser inserida na captura nova, com codec/portas da captura anterior. Duas negociações simultâneas para o mesmo viewer também podem adicionar dois destinos ao fanout e substituir apenas a entrada do mapa, deixando um destino sem proprietário.

Correção sugerida: conferir a sessão e uma geração por viewer no segundo acesso; descartar resultados obsoletos e substituir ponte/destinos atomicamente. A geração adicionada ao protocolo JavaScript nas alterações paralelas não substitui essa validação dentro do Rust.

### A15 — P2: fechar uma janela secundária executa encerramento global

Local: [lib.rs:56](G:/SeeMyGame/src-tauri/src/lib.rs:56), [native_viewer/commands.rs](G:/SeeMyGame/src-tauri/src/native_viewer/commands.rs).

O handler global de janela executa `stop_native_capture(..., None)` e desconecta todos os gamepads tanto em `CloseRequested` quanto em `Destroyed`, sem restringir `window.label()`. O player nativo cria uma janela `native-player`; fechá-la, quando usada, também pode interromper uma captura e controles da janela principal. Esse handler não encerra explicitamente `ACTIVE_VIEWER` quando o player é fechado pelo usuário.

Correção sugerida: definir descarte por label; encerrar recursos do viewer no fechamento de `native-player` e reservar o encerramento global para a janela principal/saída do aplicativo.

## Ordem de correção sugerida

1. A01–A03: tornar troca de microfone cancelável, reconstruir o processamento e atualizar chamadas ativas.
2. A08–A10 e A14: proteger recursos e callbacks por conexão/chamada/geração; eliminar resultados obsoletos.
3. A04 e A11: completar o fluxo Room/native de pedido, aprovação e entrada Co-op.
4. A06–A07: corrigir escopo de reset e condição de mouse.
5. A05, A12–A13, A15–A16: identidade de voz, seleção do clipe, fullscreen e descarte de UI/janelas.

Para cada correção, transformar a reprodução correspondente em teste de comportamento correto na suite normal. Nas mudanças de mídia, adicionar integração com PeerJS e validação Tauri onde necessário, além do teste isolado.

## Como reproduzir

Na raiz do projeto:

```powershell
node node_modules/vitest/vitest.mjs run --config docs/audit-2026-10-04.config.mjs --configLoader native
node docs/audit-2026-10-04-browser.mjs
python -m unittest discover -s tests -p test_pending_companion.py
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib
cargo check --manifest-path src-tauri/Cargo.toml --locked --offline --lib
```

Reproduções: [probes.test.js](G:/SeeMyGame/docs/audit-2026-10-04.probes.test.js), [config](G:/SeeMyGame/docs/audit-2026-10-04.config.mjs), [browser.mjs](G:/SeeMyGame/docs/audit-2026-10-04-browser.mjs).

Evidências desta execução: [JSON do Chrome](G:/SeeMyGame/output/audit-2026-10-04-browser/evidence.json), [fullscreen](G:/SeeMyGame/output/audit-2026-10-04-browser/fullscreen.png), [cartão Room](G:/SeeMyGame/output/audit-2026-10-04-browser/room-coop.png), [probes](G:/SeeMyGame/output/audit-2026-10-04-probes.log), [Vitest final](G:/SeeMyGame/output/audit-2026-10-04-vitest-final.log), [Rust testes](G:/SeeMyGame/output/audit-2026-10-04-rust.log), [Rust compilação](G:/SeeMyGame/output/audit-2026-10-04-rust-check.log).

Os arquivos em `output/` são artefatos locais ignorados pelo Git. As reproduções em `docs/` permitem regenerá-los. A auditoria não valida hardware/GPU, NAT entre máquinas nem funcionamento interativo das janelas Tauri; A14 e A15 permanecem com essa limitação explícita.
