# Revalidação de código — 04/10/2026

## Resultado

Base: `247837dcf2ac61f9f1f7bcc550511125ed1caf4d` (`main`). Os cenários dos **20 achados originais** continuam corrigidos, assim como as **quatro famílias de problemas da revisão de 03/10**. Foram identificados **cinco achados novos**, descritos abaixo. A observação anterior de desempenho web continua aberta.

A suíte padrão passou com **1.080 testes JavaScript**; os testes Rust passaram com **45 aprovados e dois benchmarks ignorados pela configuração original**. Esses resultados não cobrem integralmente os cenários novos: as sondas complementares encontraram falhas, inclusive uma reprodução com voz WebRTC real em dois navegadores.

Esta tarefa fez análise e validação. **Nenhum código da aplicação foi corrigido nesta revisão.** Foram adicionados somente este relatório e as sondas em `docs/`; os logs e resultados estão no workspace. As alterações preexistentes em `viewer-agent.mjs`, `viewer-task.ps1` e o arquivo não rastreado `native-probe-task.ps1` foram preservados.

## Achados novos, por prioridade

### N03 — P1: entrar na voz depois pode deixar o microfone sem transmissão

**Cenário confirmado:** o participante com ID lexicograficamente menor entra primeiro na voz. Ele chama o outro membro da sala, que ainda não entrou na voz; a chamada é respondida sem stream local. Quando esse segundo membro finalmente entra, `joinRoomVoice` não cria outra chamada para o ID menor, e `connectVoiceTo` ignora o sinal porque já existe uma chamada no mapa. Nenhum caminho associa a nova faixa do microfone à chamada existente.

Na reprodução real Chrome–Chrome, ambos tinham `isInVoice=true` e uma faixa de áudio local. O primeiro tinha **um sender de áudio**, mas quem entrou depois tinha **zero senders de áudio** na chamada estabelecida. Seu microfone, portanto, não era enviado. Invertendo a ordem de entrada, ambos tinham um sender de áudio: controle positivo para distinguir o defeito de permissão/dispositivo.

Código: [room-session.js:539](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:539), [session-handlers.js:68](C:/Users/Diogo/SeeMyGame/js/protocol/session-handlers.js:68), [session-handlers.js:161](C:/Users/Diogo/SeeMyGame/js/protocol/session-handlers.js:161).

Correção recomendada: ao entrar na voz, associar e negociar o microfone nas chamadas previamente respondidas sem áudio local, ou recriar a chamada de forma coordenada. A regra de desempate por ID deve evitar duplicações sem impedir a atualização de uma chamada que começou em recepção apenas. Cobrir as duas ordens de entrada e conferir senders/RTP, além dos estados da UI.

Evidências: `output/playwright/review-room-1791146130559/report.json` (defeito), `output/playwright/review-room-1791146181743/report.json` (ordem inversa com áudio em ambos), `docs/revisao-2026-10-04-room-probes.log` e `docs/revisao-2026-10-04-room-control.log`.

### N01 — P2: ICE é roteado para a conexão errada quando um peer envia e recebe vídeo nativo

O handler de `DIRECT_STREAM_ICE_CANDIDATE` escolhe o envio nativo sempre que `senders` contém o peer. Ele não distingue o candidato da captura local daquele da captura recebida. As mensagens enviadas pelos dois caminhos também não incluem uma identidade de negociação para essa distinção.

Na sonda, havia simultaneamente um sender para `local-capture` e um receiver para `remote-capture`. Um candidato destinado ao receiver gerou **zero chamadas a `receiver.pc.addIceCandidate`** e foi enviado ao IPC de `local-capture`. Sem o sender simultâneo, o mesmo caminho entregou o candidato ao receiver corretamente.

Código: [native-media-plugin.js:28](C:/Users/Diogo/SeeMyGame/js/plugins/native-media-plugin.js:28), [native-media-plugin.js:64](C:/Users/Diogo/SeeMyGame/js/plugins/native-media-plugin.js:64), [native-media-plugin.js:115](C:/Users/Diogo/SeeMyGame/js/plugins/native-media-plugin.js:115).

Impacto: no compartilhamento nativo simultâneo entre os mesmos participantes, candidatos podem ser aplicados ao PeerConnection errado, prejudicando o estabelecimento ou a conectividade. A reprodução confirmou o roteamento com IPC/RTC controlados; não foi uma execução física entre dois desktops. Os E2E anteriores transmitiam nos dois sentidos **sequencialmente**, sem cobrir essa simultaneidade.

Correção recomendada: identificar sessão/direção/geração nas mensagens de negociação e ICE, guardar essa identidade nos receivers e selecionar explicitamente a conexão correspondente.

### N02 — P2: uma negociação antiga que falha pode encerrar a transmissão nova

`receive` substitui o receiver por peer, mas seu `catch` fecha pelo ID do peer sem verificar se o receiver ainda pertence à operação que falhou. Uma oferta antiga pode estar pendente quando chega um novo `START_DIRECT_STREAM`; ao rejeitar depois, fecha o novo receiver.

A sonda manteve a primeira `createOffer` pendente, criou com sucesso o receiver substituto e só então rejeitou a oferta antiga. Resultado: **o novo receiver foi removido e seu PeerConnection foi fechado uma vez**. A guarda de identidade existente no envio da oferta não protege a limpeza em caso de erro.

Código: [native-media-plugin.js:123](C:/Users/Diogo/SeeMyGame/js/plugins/native-media-plugin.js:123).

Correção recomendada: antes de fechar na continuação de uma operação assíncrona, conferir que `receivers.get(peer)?.pc === pc` ou a geração correspondente. Adicionar regressão para reinício de compartilhamento enquanto uma oferta anterior ainda está pendente.

### N04 — P2: o botão “Sala” não abre os ajustes anunciados

O `room.html` oferece o botão `#edit-id-btn`, com título de ajuste de nome/PIN, e contém `#custom-id-modal`. O fluxo de entrada Room não vincula esse botão aos ajustes. O clique real foi executado com o coordenador da sala e **o modal permaneceu invisível**. Na sonda de controle, em que a voz funcionou nos dois sentidos, a assertion do botão falhou independentemente do problema N03.

Código: [room.html:881](C:/Users/Diogo/SeeMyGame/room.html:881); composição em [room-session.js:793](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:793).

Correção recomendada: vincular abertura, cancelamento e aplicação dos ajustes ao runtime Room, com política clara para o coordenador e atualização das informações de convite. Testar o clique do botão na página real, não apenas helpers legados de `app.js`.

### N05 — P2: renderizações da voz acumulam referências a controles removidos

`renderVoiceParticipants` recria os cartões e registra os handlers dos controles individuais com `this.listen`. Cada registro acrescenta uma closure a `_cleanupFns`, que mantém referência ao elemento. Apagar o conteúdo da lista não remove essas closures; elas só são liberadas quando o controlador inteiro é destruído.

Com dois participantes, **200 mudanças de fala local elevaram `_cleanupFns` de 11 para 411**, enquanto continuavam visíveis apenas dois cartões. Os 400 novos callbacks retêm controles das renderizações descartadas. Em sessões longas, as mudanças de fala e estado podem manter uma quantidade crescente de DOM fora da árvore visível.

Código: [voice.js:151](C:/Users/Diogo/SeeMyGame/js/discord-ui/voice.js:151), [voice.js:161](C:/Users/Diogo/SeeMyGame/js/discord-ui/voice.js:161), [discord-ui.js:169](C:/Users/Diogo/SeeMyGame/js/discord-ui.js:169).

Correção recomendada: usar delegação de eventos na lista ou um escopo de listeners por renderização, descartado antes de recriar os cartões. Preservar os valores de volume/mute durante a atualização.

Evidência comum de N01/N02/N05: [sondas isoladas](C:/Users/Diogo/SeeMyGame/docs/revisao-2026-10-04-probes.test.js), `docs/revisao-2026-10-04-probes.log`. **Três assertions de comportamento correto falharam; um controle positivo passou.** Essas sondas ficam fora do glob padrão de testes, com configuração explícita, para preservar a distinção entre a suíte existente e os cenários descobertos nesta análise.

## Estado dos achados anteriores

Referências: [auditoria original](C:/Users/Diogo/SeeMyGame/docs/analise-completa-codigo-2026-10-02.md), [correções das sete pendências](C:/Users/Diogo/SeeMyGame/docs/correcao-pendencias-2026-10-03.md), [revisão de controles/desktop–web](C:/Users/Diogo/SeeMyGame/docs/nova-analise-desktop-web-2026-10-03.md).

“Corrigido” abaixo se refere ao cenário original, no checkout avaliado. Os defeitos novos não devem ser confundidos com a reabertura de um caso antigo de causa diferente.

| ID | Estado | Evidência atual |
|---|---|---|
| A01 — microfone enviado a peer estranho | Corrigido | Guardas de autorização das chamadas do Viewer; regressão passou. |
| A02 — cascata de conexões Room | Corrigido | Reserva de conexões/admissão; E2E com três peers e entrada tardia passou. |
| A03 — mídia duplicada no handshake | Corrigido | Chamada PeerJS em `new` continua preservada; regressões de handshake passaram. N02 trata o receiver do plugin nativo, outro caminho. |
| A04 — mídia mantida ao fechar dados | Corrigido | Encerramento da chamada ativa no Streamer e regressão passaram. |
| A05 — update inválido de lousa | Corrigido | Validação antes de persistir, confirmada por regressão. |
| A06 — tela vazando após falha do microfone | Corrigido | Rollback das tracks de captura; teste de falha passou. |
| A07 — parar compartilhamento não limpa Streamer | Corrigido | Listener de `ended` chama encerramento; regressão passou. |
| A08 — fallback repete ID ocupado | Corrigido | Peer antigo destruído e ID aleatório no retry; regressão passou. |
| A09 — botão Co-op sem callback | Corrigido | Callback do cartão vinculado; teste passou. Não foi teste de hardware Companion. |
| A10 — autoria/papel falsificados no chat | Corrigido | Identidade autorizada e relay confiável; regressões e chat real em dois Viewers passaram. |
| A11 — imagem grande/full sync da lousa | Corrigido | Snapshot em staging, substituição completa e ordem de camadas; E2E de PNG grande passou. |
| A12 — mesmo nome expulsa participante ativo | Corrigido | Identificação por sessão em vez de nome; regressão passou. |
| A13 — OpenRelay estático em produção HTTPS | Corrigido | Fallback HTTPS restrito a STUN; regressão passou. |
| A14 — servidor expõe internos/bypass Windows | Corrigido | Normalização de separadores, bloqueio de ocultos/ADS e allowlist; regressões passaram. |
| A15 — URI inválida derruba servidor | Corrigido | Tratamento 400 e servidor permanece disponível; regressão passou. |
| S1 — reassembly sem limite de recursos | Corrigido | Inteiros, separação por peer, orçamento agregado e TTL; regressões passaram. |
| S2 — undo ilimitado | Corrigido | Drag/resize usam `saveUndoState` comum com cota; regressões passaram. |
| S3 — chamadas de voz Room sem acompanhamento | Corrigido | Chamadas estão no mapa e são fechadas ao sair. N03 é falta de envio do microfone ao entrar depois, não ausência do mapa. |
| S4 — thread de fanout após falha do áudio | Corrigido por inspeção | Aquisição de sockets precede spawn; rollback para thread de vídeo presente. Rust compila e 45 testes passaram; não foi injetada uma falha real de spawn. |
| S5 — tentativas ilimitadas de PIN | Corrigido | Cooldown preservado após desconectar e orçamento contra rotação de IDs; regressões passaram. |

| Família de 03/10 | Estado atual |
|---|---|
| Controles consultando singleton em vez da sessão | Corrigido; testes de dock/painel/atalhos e faixas reais passaram. |
| Estado remoto de mute/deafen/PTT | Corrigido; regressões e E2E de controles passaram. |
| “Conectando...”, nome/contador e convites | Corrigido; E2E de reconexão/título/contador e regressões de convites passaram. N04 é o botão separado de ajustes. |
| Declaração fixa de D3D11/1280×720 no relatório E2E | Corrigido; código usa backend observado e perfil atual. |

## Pendência anterior de desempenho web

Foi repetido o caminho **Chrome → Chrome com `getDisplayMedia` real**, perfil balanced/H.264 e requisito de pelo menos 45 FPS. O transporte e a reprodução funcionaram (`functionalPassed=true`), mas a mediana decodificada foi **3,74 FPS**, abaixo do requisito; `performancePassed=false` e o runner saiu com erro.

As amostras registraram resolução entregue de 1788×1080, fonte com cerca de 56 callbacks/s e encoder `MediaFoundationVideoEncodeAccelerator (AMDh264Encoder)`. Uma amostra de saída enviava 3 FPS, sem perda de pacotes no receptor e com `qualityLimitationReason=none`. Isso não estabelece a causa única da queda; a hipótese de banda observada ontem não explica todas as amostras de hoje.

O teste foi local, com ambos os navegadores na mesma CPU/GPU, sem coleta de recursos do sistema nem medição óptica. O resultado **mantém a pendência aberta**; não prova uma regressão nova de código em relação aos ~20 FPS de ontem, pois as condições físicas/carga não foram isoladas.

Artefato: `output/playwright/2026-10-04T20-38-01-095Z-5b4b9f/report.json`; log `docs/revisao-2026-10-04-web-quality.log`.

## Validação executada nesta revisão

| Execução | Resultado |
|---|---|
| `npm run verify` com FFmpeg funcional via `FFMPEG_BIN` | **Passou: 109 arquivos / 1.080 testes**; módulos, HTML, CSS, smoke ESM e dist também passaram. |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib` | **45 aprovados / zero falhas / dois benchmarks ignorados** pela configuração original. |
| `npm run test:e2e:room-controls` | Passou: mic/fone, saída real, propagação remota, controles em ambas as pontas, cabeçalho/contador/reconexão. |
| `npm run test:e2e:sessions` | Passou: PIN, vídeo/chat, autoria no relay, três peers/late join e full sync da lousa. |
| Sondas RTC/IPC/UI com assertions de comportamento correto | **Três falhas confirmadas (N01/N02/N05), um controle positivo aprovado**. |
| Sonda Room em dois navegadores, entrada do menor ID primeiro | **N03 reproduzido**: participante tardio sem sender de mic. Botão Sala também permaneceu inativo. |
| Sonda Room com ordem inversa | Áudio enviado pelos dois; **assertion N04 falhou** independentemente. |
| Web–web real com mínimo de 45 FPS | **Falhou na cadência; transporte/reprodução passaram**. |
| Scripts preexistentes de diagnóstico em alteração | `node --check` e parsing PowerShell passaram; nenhuma tarefa agendada ou regra de firewall foi criada por esta revisão. |

O E2E desktop–web completo de 03/10 foi consultado como evidência histórica; não foi apresentado como uma nova execução física nesta tarefa. As sondas de negociação nativa usam mocks de IPC/RTC. Os testes de voz da página usam microfone sintético, PeerJS e PeerConnections reais. Não foi feito deploy, push nem alteração de configuração global do FFmpeg.

## Reprodução

```powershell
# Sondas complementares: atualmente devem falhar nos três defeitos registrados.
npm exec -- vitest run --config docs/revisao-2026-10-04-probes.config.mjs

# Falha N03, com evidência de N04 coletada antes da assertion.
node docs/revisao-2026-10-04-room-probes.mjs

# Controle positivo da voz; assertion de N04 falha separadamente.
node docs/revisao-2026-10-04-room-probes.mjs --normal-order

# Pendência de FPS, com captura real da janela de teste.
node tools/e2e/run.mjs --sender web --channel chrome --preset balanced --codec h264 --seconds 12 --min-fps 45 --optical-hz 0 --no-system-metrics
```

Logs adicionais: `docs/revisao-2026-10-04-verify.log`, `docs/revisao-2026-10-04-rust.log`, `docs/revisao-2026-10-04-controls.log`, `docs/revisao-2026-10-04-sessions.log`. Os logs `.log` e os artefatos `output/` ficam ignorados pelo Git; os scripts e este relatório ficam disponíveis como documentos de reprodução da revisão.
