# Terceira análise profunda — 05/10/2026

Atualização: C01–C07 receberam correções. Consulte [implementação, validação e limites](correcao-terceira-analise-2026-10-05.md). O restante deste documento preserva os resultados históricos da investigação.

Base: `eeeca1aa0e34e52ac826a0e071aa098c37aa04a4`. Nenhum arquivo do produto foi modificado nesta análise. Foram acrescentados este relatório e dois scripts de reprodução; os quatro artefatos não rastreados da revisão anterior foram preservados.

**Sete bugs novos encontrados: um P1 e seis P2.** Seis foram reproduzidos no Chrome com sinalização PeerJS e transporte reais. O sétimo foi demonstrado executando o renderizador com contexto de canvas controlado. “Novo” significa não registrado nas duas auditorias anteriores, e não necessariamente introduzido pelo último commit.

## Achados

| ID | Prioridade | Defeito | Reprodução |
| --- | --- | --- | --- |
| C01 | P1 | Sair da sala mantém a página, a sessão e a captura local ativas | Chrome, dois participantes |
| C02 | P2 | Parar a própria transmissão também elimina o replay remoto | Chrome, duas transmissões |
| C03 | P2 | Caps Lock e Ctrl direito não ativam o microfone em PTT | Chrome, teclas reais em Room |
| C04 | P2 | Desfazer de um Viewer não chega aos outros Viewers | Chrome, Streamer e dois Viewers |
| C05 | P2 | Relay atribui cursores dos Viewers ao host e substitui autores distintos | Chrome, Streamer e dois Viewers |
| C06 | P2 | Cursor remoto ignora zoom e pan da lousa que o recebe | Contexto de canvas controlado |
| C07 | P2 | Imagem pendente reaparece e é transmitida após limpar a lousa | Chrome, PNG real e entrega de `onload` controlada |

### C01 — Saída não encerra o runtime nem retorna ao início

Origem: [room-session.js:404](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:404). Encerramento completo existente: [room-session.js:918](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:918).

O callback de `onLeaveRoom` chama somente `leaveRoomVoice`, `rm.leave` e `peer.destroy`. Não navega nem chama `runtime.dispose`, que libera captura, UI, plugins e sessão. Depois do clique real em `#dock-leave-btn`, o outro participante reconheceu a saída, mas o cliente conservou a URL `room.html`, `session.isDisposed=false`, `localStream`, o card local e a faixa de vídeo em `readyState=live`. A voz saiu corretamente. Como controle positivo, disparar `pagehide` na mesma página deixou a sessão descartada e a mesma faixa em `ended`.

Impacto: a interface aparenta continuar na sala, os serviços permanecem montados e a captura local continua após uma ação explícita de saída. Corrigir usando um caminho único de encerramento completo e navegação à página inicial, incluindo cancelamento de capturas e permissões ainda pendentes.

### C02 — Parar a transmissão local elimina fontes de replay remotas

Origem: [room-session.js:636](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:636), [clipping-plugin.js:32](C:/Users/Diogo/SeeMyGame/js/plugins/clipping-plugin.js:32), [registry.js:171](C:/Users/Diogo/SeeMyGame/js/clipping/registry.js:171).

`stopRoomCapture` emite `stream:stopped` sem `sourceId`. O plugin interpreta a ausência como `null`, e `ClipRecorderRegistry.stop(null)` para todos os gravadores, apaga todas as fontes e a seleção. Com A e B transmitindo, o replay de B estava gravando em A; parar apenas a transmissão de A deixou `sources=[]`, `recorders=[]` e `isRecording=false`. O vídeo remoto continuou decodificado em 640×360 e sua faixa continuou `live`.

Impacto: perda do buffer e da possibilidade de clipar a transmissão remota que continua em andamento. Emitir a parada da fonte `local-me`, reservando a parada global para o encerramento da sessão.

### C03 — PTT anunciado pela UI não recebe eventos de teclado

Origem: [drawer.js:124](C:/Users/Diogo/SeeMyGame/js/discord-ui/drawer.js:124), [mount-page.js:4](C:/Users/Diogo/SeeMyGame/js/pages/mount-page.js:4). Implementação antiga desconectada: [page-controller.js:119](C:/Users/Diogo/SeeMyGame/js/app/page-controller.js:119).

A UI ativa `voiceMode=ptt` e anuncia Caps Lock/Ctrl direito. Entretanto, as únicas chamadas de `setPttActive` por teclado estão no inicializador antigo `initGamerKeybindings`, que não é chamado pelo ciclo atual das páginas. No Chrome em Room, alternar para PTT e segurar cada uma dessas teclas produziu os eventos `ControlRight` e `CapsLock`, mas manteve `isPttActive=false`, `isMuted=true` e a faixa de microfone desabilitada.

Impacto: o participante deixa de ser ouvido ao selecionar o modo anunciado. Vincular atalhos ao VoiceManager da sessão atual, com limpeza por sessão e liberação ao perder foco/visibilidade. A reprodução de teclado foi feita em Room; o código antigo e os três pontos de montagem foram examinados, sem extrapolar esse teste para Tauri físico.

### C04 — Snapshots de histórico não são retransmitidos pelo host

Origem: [whiteboard-plugin.js:97](C:/Users/Diogo/SeeMyGame/js/plugins/whiteboard-plugin.js:97).

Os handlers de adicionar, atualizar e apagar elementos retransmitem mensagens quando o host atende múltiplos Viewers. Os de `WHITEBOARD_SYNC`, `WHITEBOARD_SYNC_BATCH` e `WHITEBOARD_SYNC_END` somente aplicam o snapshot no host. Desfazer pela UI usa esse protocolo. Com Streamer S e Viewers A/B, A criou dois retângulos, que chegaram aos três clientes. Ao desfazer em A, A e S ficaram com um retângulo, enquanto B conservou dois.

Uma mensagem de cursor posterior foi recebida por B através do mesmo relay, confirmando que a observação não antecedeu o processamento do canal. A falha usa um snapshot pequeno; portanto, é independente do limite de pacote corrigido em B16. Propagar o documento confirmado aos outros Viewers preservando montagem atômica, ordem e limites de transferência. O caminho de refazer usa o mesmo protocolo; a ação de histórico reproduzida aqui foi desfazer.

### C05 — Cursores de autores distintos colapsam na identidade do host

Origem: [whiteboard-plugin.js:77](C:/Users/Diogo/SeeMyGame/js/plugins/whiteboard-plugin.js:77).

O handler usa `sourceConn.peer` como chave do cursor e retransmite o payload sem conservar a identidade autenticada do autor. No destinatário de um relay, essa conexão pertence ao host, inclusive quando o movimento veio de um Viewer. B recebeu um cursor de A, mas a chave em `remoteCursors` era a de S. Ao S mover o próprio cursor depois, B continuou com somente a chave de S: o cursor de A foi substituído.

Impacto: colaboradores não conseguem acompanhar simultaneamente ponteiros de autores diferentes. Preservar a origem autenticada no relay e aceitar origem encaminhada apenas pelo host autorizado; adicionar um campo livre ao payload sem validar confiança criaria possibilidade de falsificação.

### C06 — Projeção de cursor remoto não acompanha a transformação da lousa

Origem: [renderer.js:429](C:/Users/Diogo/SeeMyGame/js/whiteboard/renderer.js:429).

O desenho do documento aplica escala, zoom e pan. Os cursores, desenhados após restaurar o contexto, usam somente `cursor.x * width` e `cursor.y * height`. As coordenadas de envio já estão normalizadas no documento virtual. Para canvas 1000×800, cursor `(0,25; 0,25)`, zoom 2 e pan `(100; 50)`, o primeiro `moveTo` observado foi `(250; 200)`, quando a posição do documento apontado era `(600; 450)`.

Impacto: um colaborador aponta para uma região diferente do desenho quando o destinatário usa zoom ou pan. Aplicar ao cursor a mesma projeção do documento e definir a visibilidade fora da área. Este caso usa a função real com contexto de desenho controlado; não é medição visual de screenshot.

### C07 — Limpar não invalida uma importação de imagem pendente

Origem: [document.js:226](C:/Users/Diogo/SeeMyGame/js/whiteboard/document.js:226), inserção tardia em [document.js:272](C:/Users/Diogo/SeeMyGame/js/whiteboard/document.js:272).

`addImageFromDataUrl` aguarda o carregamento de `Image`, mas seu callback não verifica revisão do documento ou descarte. Limpar a lousa durante essa espera não cancela a operação. A reprodução no Chrome decodificou um PNG real, reteve somente a entrega do callback `onload`, limpou a lousa e entregou o callback depois. O documento passou de zero elementos para uma imagem, e essa imagem foi enviada ao segundo participante.

Impacto: uma imagem reaparece depois de o usuário apagar tudo, alterando também a lousa dos demais. Invalidar importações assíncronas ao limpar/substituir/descartar o documento, desde o começo do processamento do arquivo. A correção B18 protege o cache de renderização de imagens; este achado envolve a inserção no documento, que é outro caminho.

## Validação e regressões anteriores

| Verificação | Resultado nesta revisão | Log/evidência |
| --- | --- | --- |
| `npm run verify` | Módulos, HTML, CSS, smoke ESM, 1.243 testes em 127 arquivos e build aprovados | [Log](../output/audit-2026-10-05-verify.log) |
| Rust `test --locked --offline --lib` | 61 aprovados, 3 ignorados | [Log](../output/audit-2026-10-05-rust.log) |
| Rust `check --locked --offline --lib` | Compilação de produção aprovada | [Log](../output/audit-2026-10-05-rust-check.log) |
| Python Companion com drivers falsos | 10 aprovados | [Log](../output/audit-2026-10-05-python.log) |
| E2E Room controls | Mic, fone, presença, atalhos dos botões e reconexão aprovados | [Log](../output/audit-2026-10-05-controls.log) |
| E2E Room findings | Ambas as ordens de entrada na voz, RTP bidirecional, listeners limitados e configurações/PIN aprovados | [Log](../output/audit-2026-10-05-room-findings.log) |
| E2E Sessions | PIN, vídeo, chat relay, três membros, entrada tardia e snapshot grande aprovados | [Log](../output/audit-2026-10-05-sessions.log) |
| E2E Whiteboard math | Fórmulas, edição, sincronização e carregamento local de MathJax aprovados | [Log](../output/audit-2026-10-05-math.log) |
| Novas reproduções Chrome | Seis comportamentos incorretos confirmados e controle positivo de descarte aprovado; zero erros de página | [JSON](../output/playwright/audit-2026-10-05-1791232493279/report.json) |
| Probes de canvas/imagem | C06 e C07 confirmados com callbacks/contexto controlados; C07 também confirmado no Chrome acima | [JSON](../output/audit-2026-10-05-probes.json) |

As regressões incorporadas das auditorias anteriores passaram na suíte atual. Os problemas anteriores de mic/fone, cabeçalho de conexão, voz bidirecional, configurações da sala, listeners e snapshots grandes tiveram reexecução no navegador. Os achados novos acima cobrem combinações e sequências que esses testes não exercitam.

## Evidências e reexecução

- [Saída da sala: screenshot](../output/playwright/audit-2026-10-05-1791232493279/after-exit.png).
- [Viewer que conserva elemento desfeito: screenshot](../output/playwright/audit-2026-10-05-1791232493279/relay-undo-observer.png).
- [Script Chrome](audit-2026-10-05-browser.mjs): `node docs/audit-2026-10-05-browser.mjs`.
- [Script controlado](audit-2026-10-05-probes.mjs): `node docs/audit-2026-10-05-probes.mjs`.

Os scripts escrevem `passed=false` para cada expectativa de comportamento correto violada e `status=bugs-reproduced`. A conclusão bem-sucedida do processo significa que a investigação terminou, não que o comportamento do produto foi aprovado. Os probes ficam fora da suíte padrão.

## Limites

Os E2E desta etapa usaram Chrome na mesma máquina, contextos isolados, captura de tela sintética e dispositivo de microfone falso. PeerJS, canais de dados e WebRTC são reais. O teste C07 controla a entrega do evento de uma imagem realmente decodificada; o C06 controla o contexto de canvas.

Não houve E2E Desktop–Web em uma janela Tauri nesta etapa, uso de gamepad/ViGEm físicos nem injeção de falha em captura WGC/DXGI ou replay nativo ativo. Testes e compilação Rust foram executados; os três testes ignorados e caminhos dependentes de hardware não foram validados por esses resultados. Não foi reexecutado benchmark de FPS nesta revisão.
