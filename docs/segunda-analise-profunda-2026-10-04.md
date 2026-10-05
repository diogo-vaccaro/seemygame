# Segunda análise profunda — SeeMyGame

Data: 04/10/2026. Base: `2cb55ea`, incluindo as alterações locais presentes durante a revisão e as correções da primeira auditoria. Esta etapa acrescenta documentação e reproduções; não aplica novas correções ao produto.

Atualização de 05/10/2026: os 22 achados receberam correções no código. Consulte [o relatório de correção](correcao-segunda-analise-2026-10-05.md) para a implementação, validação e limites. Este documento conserva os resultados históricos da investigação. Os executáveis abaixo agora encaminham para testes de regressão que verificam o comportamento corrigido; os logs e screenshots originais continuam preservados.

Foram identificados **20 defeitos reproduzidos e 2 riscos nativos demonstrados pela leitura do código**: 8 P1, 13 P2 e 1 P3. P1 indica impacto alto sobre funcionamento, isolamento de dados ou liberação de comandos; P2 indica impacto relevante em condições específicas; P3 indica uma falha em uma API auxiliar sem chamada pelo fluxo atual das páginas.

As reproduções de JavaScript executam as funções reais com transporte, mídia e IPC controlados. O caso de pings usa dois contextos Chrome, sinalização PeerJS real e duas transmissões sintéticas. O Companion é importado integralmente com drivers falsos antes do import, sem injetar comandos no sistema operacional. Os dois riscos Rust não foram reproduzidos em uma janela Tauri com hardware real.

## Resultado por área

| ID | Prioridade | Achado | Evidência |
| --- | --- | --- | --- |
| B01 | P1 | Falha de entrada antiga desativa uma entrada de voz mais recente | Teste JS |
| B02 | P3 | `customStream` ignora a saída processada de ganho | Teste JS; API auxiliar |
| B03 | P2 | Conexões simultâneas do Viewer criam dois peers e misturam suas operações | Teste JS |
| B04 | P1 | PIN solicitado pelo host A é enviado ao host B | Teste JS |
| B05 | P1 | Fechar conexão duplicada da sala remove o membro ainda conectado | Teste JS |
| B06 | P2 | Entrada de voz cancelada anuncia `VOICE_JOINED` depois de `LEAVE` | Teste JS |
| B07 | P1 | Soltar teclado/mouse fora do card deixa comandos pressionados | Teste JS com eventos DOM |
| B08 | P1 | Desconectar gamepad físico não neutraliza o estado enviado | Teste JS |
| B09 | P2 | Aprovação nativa antiga pode desconectar o slot ocupado pelo sucessor | Teste JS com IPC controlado |
| B10 | P2 | Inicializações do Companion antes de `open` criam múltiplos sockets | Teste JS |
| B11 | P2 | Coordenadas do mouse incluem as barras pretas do vídeo | Teste JS de geometria |
| B12 | P1 | Pings se projetam sobre outra transmissão em salas com múltiplas lives | Chrome, PeerJS e screenshots |
| B13 | P2 | Cliente com token inválido limpa inputs de outro cliente autenticado | Teste Python |
| B14 | P1 | Instalação só com gamepad não executa reset global de gamepads | Teste Python |
| B15 | P2 | Reset individual de slot não libera mouse pressionado | Teste Python |
| B16 | P2 | Desfazer/refazer envia snapshot que excede o limite da sala | Teste JS através da UI e `RoomManager` |
| B17 | P2 | Traço de caneta com mais de 2.000 pontos desaparece ao soltar | Teste JS com eventos DOM |
| B18 | P2 | Imagens removidas continuam acumuladas no cache da lousa | Teste JS |
| B19 | P2 | Slots anunciados apenas para gamepad aceitam teclado e mouse | Teste JS |
| B20 | P1 | Slot 0 do Party Mode nativo escreve no slot 1 | Teste JS |
| B21 | P2 | Caminhos nativos de erro preservam pipeline e memória do replay | Risco estático Rust |
| B22 | P2 | Reconfiguração rejeitada pode alterar estado de exclusão sem alterar o worker | Risco estático Rust |

## Achados reproduzidos

### B01 — Uma falha antiga invalida a voz atual

Origem: [capture.js:41](G:/SeeMyGame/js/voice/capture.js:41), [capture.js:119](G:/SeeMyGame/js/voice/capture.js:119).

Duas chamadas de `joinVoice()` começam enquanto `isInVoice` ainda é falso. A segunda recebe o microfone e entra com sucesso; a primeira falha depois. O caminho de fallback não verifica a geração antes de iniciar novas capturas, e o `catch` final atribui `isInVoice = false` sem conferir a geração. A reprodução deixa a faixa atual viva, mas o gerenciador considera que saiu da voz, e faz quatro pedidos de captura. Isso também permite que nova entrada substitua referências sem liberar a captura existente. Aplicar o mesmo controle de geração aos fallbacks, erros e metadados, ou serializar a entrada inteira.

### B02 — Stream fornecido diretamente contorna o controle de ganho

Origem: [capture.js:18](G:/SeeMyGame/js/voice/capture.js:18).

O ramo `customStream` chama `setupLocalAudioProcessing()`, mas conserva o stream original como `localStream` e retorno. A saída do nó de ganho fica em `processedStream`, sem ser a faixa entregue ao consumidor. A reprodução retorna o stream bruto apesar de existir uma saída processada diferente. Não localizei uso desse parâmetro nas páginas atuais: o impacto confirmado é no contrato público da API e em integrações que o utilizem. Atribuir o retorno do processamento a `localStream`, como no ramo `getUserMedia`.

### B03 — Inicialização concorrente do PeerJS no Viewer

Origem: [viewer-session.js:151](G:/SeeMyGame/js/session/viewer-session.js:151), [viewer-session.js:251](G:/SeeMyGame/js/session/viewer-session.js:251).

Dois `connectToStreamer()` durante a inicialização passam pela verificação de peer inexistente e criam duas instâncias. Cada `initViewerPeer()` aguarda o próprio evento `open`, mas os consumidores usam o campo compartilhado `viewerState.peer`. Quando o primeiro abre, sua conexão é criada na segunda instância, que ainda não abriu. A reprodução confirma duas instâncias e a associação cruzada. Manter uma promessa única de inicialização e usar o peer retornado por ela.

### B04 — PIN entregue ao streamer errado

Origem: [viewer-session.js:109](G:/SeeMyGame/js/session/viewer-session.js:109).

O Viewer conecta A e depois B. A envia `PIN_REQUIRED`, e a tela identifica A como alvo, mas `submitViewerPin()` usa `activeConn`, ainda associada a B. A reprodução confirma envio de `1234` a B e nenhum envio a A. Há falha de autenticação e exposição do PIN a outro participante. Resolver a conexão pelo host identificado no desafio, armazenar autenticação por host e impedir que a resposta de outro host feche o desafio pendente.

### B05 — Conexão duplicada derruba o membro válido

Origem: [admission.js:12](G:/SeeMyGame/js/room/admission.js:12), [room-session.js:468](G:/SeeMyGame/js/session/room-session.js:468).

`registerConnection()` preserva a conexão autenticada existente, mas retorna sucesso para a duplicada. O runtime ainda instala nela um handler de fechamento que chama `removeMember(peerId)` incondicionalmente. Na reprodução, fechar a duplicada elimina membro, autorização e conexão da malha, enquanto a conexão original permanece aberta. Os caminhos A08–A10 da primeira auditoria não cobriam esse runtime Room. Diferenciar conexão aceita/ignorada e validar identidade da conexão em dados, fechamento e erro.

### B06 — Sinal de entrada depois de uma saída cancelada

Origem: [room-session.js:547](G:/SeeMyGame/js/session/room-session.js:547).

O usuário inicia voz, sai enquanto a permissão está pendente e depois a captura termina. `VoiceManager` descarta corretamente o stream tardio, mas `joinRoomVoice()` não verifica o retorno ou `isInVoice` e publica `VOICE_JOINED`. A reprodução registra `LEAVE` seguido de `VOICE_JOINED` com voz desativada. Conferir geração, stream e estado após o `await`. O mesmo padrão merece ser eliminado dos callbacks de entrada das outras páginas.

### B07 — Teclas e cliques ficam retidos ao sair da área de controle

Origem: [input.js:27](G:/SeeMyGame/js/coop/input.js:27), [input.js:287](G:/SeeMyGame/js/coop/input.js:287).

Os listeners de `keyup` e `mouseup` ficam no wrapper do vídeo. Pressionar W, mudar o foco para chat e soltar W não envia liberação. Pressionar mouse no wrapper e soltar fora também não envia liberação. Não há reset por perda de foco do wrapper. A reprodução envia apenas os dois comandos `down`. Rastrear comandos pressionados e garantir liberação em nível de janela, blur e cancelamento; manter a restrição de campos editáveis apenas para novas pressões.

### B08 — Gamepad removido mantém o último comando

Origem: [input.js:249](G:/SeeMyGame/js/coop/input.js:249).

`pollGamepads()` só envia estados quando há controle conectado. Depois de enviar botão A e analógico X=1, retirar o dispositivo não envia estado neutro e não limpa `lastGamepadState`. A reprodução observa somente a mensagem inicial. O gamepad virtual do host pode continuar pressionado até reset/revogação; no Companion existe ainda o timeout global, que não substitui a liberação imediata. Neutralizar o slot na transição conectado → desconectado e ao trocar o dispositivo selecionado.

### B09 — Limpeza de aprovação antiga atua sobre o novo ocupante

Origem: [host.js:68](G:/SeeMyGame/js/coop/host.js:68), [windows.rs:204](G:/SeeMyGame/src-tauri/src/gamepad/windows.rs:204).

Uma aprovação reserva o slot e aguarda `plugVirtualGamepad()`. O slot é liberado e outro jogador passa a ocupá-lo. Ao terminar a operação antiga, `isStillValid()` falha, mas sua limpeza desconecta o slot apenas pelo número. A reprodução com promessas IPC controladas deixa B aprovado e na tabela, mas executa `unplugVirtualGamepad(1)` por causa de A. A intercalação foi reproduzida no controlador; não foi exercitada em ViGEm real. Fazer limpeza por identidade/generation do recurso, ou impedir essa limpeza quando já existir outro ocupante.

### B10 — Sockets concorrentes do Companion

Origem: [transport.js:87](G:/SeeMyGame/js/coop/transport.js:87).

`companionSocket` só recebe o socket em `onopen`. Duas inicializações anteriores à abertura passam pelo guard e criam dois sockets. Além disso, callbacks antigos de fechamento/erro alteram capacidades e `isCompanionConnected` mesmo quando o socket atual é outro. A reprodução confirma as duas conexões pendentes. Registrar o socket assim que criado, conferir identidade em todos os callbacks e invalidar operações no fechamento da sessão.

### B11 — Mouse remoto incorreto em vídeo com barras pretas

Origem: [input.js:65](G:/SeeMyGame/js/coop/input.js:65), [video-grid.css:113](G:/SeeMyGame/css/components/video-grid.css:113).

O vídeo usa `object-fit: contain`, mas a normalização usa todo seu retângulo CSS. Uma imagem 16:9 em uma área 1.000×1.000 começa em Y=218,75. Clicar na borda superior da imagem envia Y=0,21875, quando a coordenada do conteúdo seria zero. A reprodução usa esses valores exatos. Calcular a área efetivamente ocupada pela imagem, rejeitar/interceptar as barras e então aplicar a transformação para o alvo do host.

### B12 — Ping no jogo errado em múltiplas transmissões

Origem: [ping-input.js:49](G:/SeeMyGame/js/ping-input.js:49), [ping-plugin.js:29](G:/SeeMyGame/js/plugins/ping-plugin.js:29).

As coordenadas são normalizadas sobre o canvas de todo o palco. A mensagem não identifica a transmissão apontada. Com cada participante exibindo seu card local primeiro, um ping no centro da transmissão A aparece sobre a transmissão B no destinatário. O teste Chrome confirmou erro de aproximadamente **500 pixels**, sem erro de console. O laser usa a mesma transformação e também carece da identificação da transmissão; a evidência visual executada é de ping. Transmitir o identificador canônico da fonte e coordenadas relativas ao conteúdo dessa fonte; projetar sobre o card correspondente, inclusive em fullscreen e layouts diferentes.

Evidência: [JSON](G:/SeeMyGame/output/playwright/deep-audit-2026-10-04/evidence.json), [origem](G:/SeeMyGame/output/playwright/deep-audit-2026-10-04/sender.png), [destinatário](G:/SeeMyGame/output/playwright/deep-audit-2026-10-04/recipient.png).

### B13 — Falha de autenticação de um socket limpa outro

Origem: [coop-agent.py:431](G:/SeeMyGame/tools/coop-agent.py:431).

O `finally` de `handle_client()` chama `release_all()` inclusive para sockets que falharam na autenticação. A reprodução mantém um cliente válido com W pressionado e abre outro com token errado: o segundo é rejeitado, mas W do primeiro é liberado. Ambos usam uma origem permitida; o teste não pressupõe contornar a validação de origem. Só limpar recursos que o cliente efetivamente adquiriu, usando propriedade por conexão, e definir uma política explícita para conexões simultâneas.

### B14 — Reset global falha quando só há suporte a gamepad

Origem: [coop-agent.py:103](G:/SeeMyGame/tools/coop-agent.py:103).

`release_all()` retorna imediatamente quando PyAutoGUI está ausente, antes de chegar ao bloco de reset dos gamepads. Com `HAVE_VGAMEPAD = True` e `HAVE_PYAUTOGUI = False`, a reprodução retorna sucesso sem executar `reset()` ou `update()` do controle. Isso afeta emergência, desconexão e timeout nessa instalação. Executar a limpeza dos dois subsistemas independentemente e calcular sucesso a partir de ambos.

### B15 — Reset do slot deixa mouse pressionado

Origem: [coop-agent.py:76](G:/SeeMyGame/tools/coop-agent.py:76).

`release_slot()` neutraliza gamepad e teclas, mas não solta `pressed_mouse_buttons`. A visibilidade e a revogação de Co-op enviam resets com slot; portanto, um clique retido pode sobreviver a esses resets. A reprodução deixa o botão esquerdo pressionado após `release_slot(1)`. Rastrear a propriedade do mouse por slot e liberar botões sem afetar entradas pertencentes a outros clientes/slots.

### B16 — Desfazer/refazer falha para estados maiores que o pacote permitido

Origem: [whiteboard-ui.js:177](G:/SeeMyGame/js/whiteboard-ui.js:177), [shared.js:53](G:/SeeMyGame/js/room/shared.js:53).

Adicionar uma imagem grande usa chunks; desfazer/refazer manda `WHITEBOARD_SYNC` com toda a lousa em uma mensagem. No teste, uma imagem com 300.000 caracteres mais um retângulo já estão sincronizados; desfazer pela UI remove o retângulo localmente, mas o `RoomManager.broadcast()` rejeita o snapshot por exceder 256 KiB. O outro participante conserva o retângulo. Utilizar `sendWhiteboardSnapshot()` também nos botões e atalhos de histórico, com o protocolo de montagem atômica já existente.

### B17 — Traço longo desaparece sem aviso

Origem: [input.js:211](G:/SeeMyGame/js/whiteboard/input.js:211), [shared.js:122](G:/SeeMyGame/js/whiteboard/shared.js:122).

A captura da caneta acumula pontos sem aplicar `MAX_WHITEBOARD_POINTS`. Ao soltar, `addElement()` rejeita o traço acima de 2.000 pontos, e `currentElement` é apagado. A reprodução desenha mais de 2.000 pontos, solta e termina com documento vazio e nenhuma mensagem de criação. Simplificar durante a captura ou dividir o traço em segmentos válidos; evitar descarte silencioso.

### B18 — Cache retém imagens já apagadas

Origem: [renderer.js:325](G:/SeeMyGame/js/whiteboard/renderer.js:325), [document.js:143](G:/SeeMyGame/js/whiteboard/document.js:143).

`renderImage()` armazena cada URL e objeto `Image`, mas remover elementos, limpar ou substituir a lousa não elimina entradas que ficaram sem uso. O cache é limpo apenas no dispose. A reprodução adiciona, renderiza e remove 60 imagens diferentes: o documento termina vazio e o cache conserva 60 objetos. A retenção pode crescer durante sessões longas mesmo com poucos elementos visíveis. Aplicar orçamento de cache e descartar entradas que não sejam necessárias ao documento ou histórico recuperável.

### B19 — Capacidades de teclado/mouse não são aplicadas por slot

Origem: [host.js:44](G:/SeeMyGame/js/coop/host.js:44), [host.js:157](G:/SeeMyGame/js/coop/host.js:157), [input.js:3](G:/SeeMyGame/js/coop/input.js:3).

A aprovação anuncia teclado e mouse apenas para o slot 1. O host, porém, verifica ocupante e slot, sem aplicar essas capacidades ao tipo de comando. Um jogador do slot 2 consegue despachar `INPUT_KEY` e `INPUT_MOUSE`; o cliente também envia teclado quando `activeHostCapabilities.keyboard` é falso. Mouse efetivo depende de Companion conectado com suporte global. A reprodução confirma os despachos. Centralizar uma política de capacidades por slot e validá-la no host, além de respeitá-la na UI.

### B20 — Party Mode envia Player 1 ao controle do Player 2

Origem: [transport.js:225](G:/SeeMyGame/js/coop/transport.js:225).

`Number(data.slot) || 1` converte o slot válido zero em um. O Party Mode permite reservar o slot 0 e cria seu controle corretamente, mas os reports nativos vão ao slot 1. A reprodução confirma `updateVirtualGamepad(1, ...)` para input do slot 0. Isso pode controlar o gamepad do outro jogador ou falhar se o slot 1 estiver ausente. Usar validação explícita e preservar zero como valor válido.

## Riscos nativos sem reprodução interativa

### B21 — Replay permanece nos caminhos de erro do worker

Origem: [commands.rs:299](G:/SeeMyGame/src-tauri/src/capture/commands.rs:299), [commands.rs:527](G:/SeeMyGame/src-tauri/src/capture/commands.rs:527), [replay.rs:168](G:/SeeMyGame/src-tauri/src/replay.rs:168).

O monitor de saúde e a falha crítica de rollback drenam bridges, fanout e worker, mas não retiram `session.replay`. O replay mantém pipeline GStreamer, portas e ring de até 128 MiB; seu encerramento está no `Drop`. A sessão é preservada em estado `error`, portanto a liberação depende de uma parada posterior. O fechamento automático da ponte JS pode provocar essa parada mais tarde, mas esses caminhos nativos não a garantem por si mesmos. Incluir replay na limpeza de erro e testar falha injetada com replay ativo. A retenção resulta do fluxo de ownership observado; não foi medido seu tempo de vida em Tauri real.

### B22 — Estado de exclusão muda mesmo quando a alteração é rejeitada

Origem: [commands.rs:417](G:/SeeMyGame/src-tauri/src/capture/commands.rs:417), [commands.rs:435](G:/SeeMyGame/src-tauri/src/capture/commands.rs:435), [commands.rs:448](G:/SeeMyGame/src-tauri/src/capture/commands.rs:448).

A reconfiguração altera `session.state.exclude_app` e `exclude_pid` antes de validar ativação de áudio e troca de codec. Se uma dessas validações rejeita o pedido, o worker anterior é restaurado, mas os campos de estado já foram alterados. Um rollback bem-sucedido após falha de reinício também conserva essa mutação prévia. O estado consultado pode indicar exclusão diferente da efetiva. Preparar o estado completo temporariamente e publicá-lo só após sucesso; em falhas, restaurar o snapshot anterior. Essa conclusão vem da ordem das mutações e retornos; não foi exercitado um worker de captura real com esse pedido misto.

## Verificações e limites

- Suíte principal: **123 arquivos, 1.179 testes JavaScript aprovados**; inclui regressões da auditoria anterior. Algumas mensagens conhecidas de jsdom sobre navegação não implementada continuam no log.
- Rust: **61 testes aprovados, 3 ignorados**, com `--locked --offline --lib`; incluindo negociação WebRTC e replay com RTP real. Vários comandos e caminhos de ownership estão sob `cfg(not(test))`, portanto esse resultado não prova os riscos B21/B22 resolvidos.
- Novas reproduções: **16 testes JS + 3 Python + 1 cenário Chrome aprovados**. “Aprovado” aqui significa que o teste confirmou o comportamento defeituoso atual, não que o corrigiu. Os probes estão em `docs`, fora da suíte de regressão normal.
- A reprodução de pings foi repetida e confirmou a projeção na transmissão errada. Nenhum erro de página foi registrado.
- `git diff --check` passou. As alterações pré-existentes do workspace foram preservadas.
- Uma hipótese sobre desativar Co-op sem card foi descartada como achado independente após conferir que o fluxo normal do host envia revogação dos slots. A hipótese inicial de undo sem sincronização também foi refinada: a UI sincroniza, mas envia um pacote grande demais em B16.
- Não foram validados ViGEm físico, captura interativa WGC/DXGI, falha real de worker ou condições de rede externa. Esta revisão priorizou concorrência, isolamento, liberação de input, geometria e limites de recursos; não representa garantia de ausência de outros bugs.

Artefatos executáveis: [probes JS](G:/SeeMyGame/docs/deep-audit-2026-10-04.probes.test.js), [configuração](G:/SeeMyGame/docs/deep-audit-2026-10-04.config.mjs), [cenário Chrome](G:/SeeMyGame/docs/deep-audit-2026-10-04.browser.mjs), [probes Python](G:/SeeMyGame/docs/deep-audit-2026-10-04.python.py).

Logs: [suíte principal](G:/SeeMyGame/output/deep-audit-2026-10-04-vitest.log), [Rust](G:/SeeMyGame/output/deep-audit-2026-10-04-rust.log), [probes JS](G:/SeeMyGame/output/deep-audit-2026-10-04-probes.log), [Python](G:/SeeMyGame/output/deep-audit-2026-10-04-python.log), [Chrome](G:/SeeMyGame/output/deep-audit-2026-10-04-browser.log).

Reexecução, na raiz do repositório:

```powershell
node node_modules/vitest/vitest.mjs run --config docs/deep-audit-2026-10-04.config.mjs --configLoader native
python docs/deep-audit-2026-10-04.python.py
node docs/deep-audit-2026-10-04.browser.mjs
```

## Ordem recomendada de correção

1. Corrigir isolamento e liberações: B04, B05, B07, B08, B14 e B20.
2. Corrigir entrada de voz e coordenadas por transmissão: B01, B06, B11 e B12.
3. Estabelecer ownership/generation para slots e sockets: B09, B10, B13, B15 e B19.
4. Corrigir inicialização Viewer e lousa: B03, B16, B17 e B18.
5. Reproduzir B21/B22 com falha injetada no desktop e aplicar limpeza/commit de estado; corrigir a API auxiliar B02.
