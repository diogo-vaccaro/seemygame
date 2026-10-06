# Análise do código atual — 05/10/2026

Base revisada: `a5890521fee84ca969cc7262deaee88696330123` (`feat(room): add silent lobby and isolated voice channels`). O repositório estava limpo no início. Esta revisão acrescenta documentação e scripts de reprodução; não altera a aplicação nem os testes existentes.

Resultado: **quatro bugs de funcionamento reproduzidos e uma regressão na suíte E2E**. Os sete achados C01–C07 da terceira análise permanecem corrigidos nos cenários reexecutados. Os novos problemas concentram-se na troca de canal e na sincronização de voz durante atrasos e reconexão.

## Achados

### N01 — [P1] Trocar de canal reativa um microfone mutado manualmente

Local: [room-session.js:565](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:565). Causa complementar: `VoiceManager.leaveVoice()` em `js/voice/capture.js` redefine `isMuted=false` no modo VAD e `isDeafened=false`; `joinVoice()` habilita as novas faixas com esses valores.

Reprodução com cliques reais: dois participantes em `voice-2`; o convidado muta o mic e silencia o fone, mantendo ambos os estados após reconexão. Ao clicar em um canal personalizado, a aplicação chama `leaveRoomVoice()` e captura novamente o microfone. O convidado passa de `muted=true/deafened=true` para `false/false`, com faixa de áudio **viva e habilitada** e conexão WebRTC estabelecida. Nenhum clique de desmutar foi realizado.

Impacto: uma ação de navegação permite transmitir áudio que o usuário havia silenciado. O cenário confirmado usa VAD, modo padrão; PTT tem outra regra de inicialização.

Correção recomendada: preservar as escolhas de mute/deafen na troca entre canais e aplicá-las às faixas antes de negociar mídia. Liberar PTT ao trocar de canal continua necessário. Acrescentar regressão que verifique as faixas, e não apenas os ícones.

### N02 — [P1] Oferta de voz anterior à presença deixa participantes sem áudio

Locais: [session-handlers.js:207](C:/Users/Diogo/SeeMyGame/js/protocol/session-handlers.js:207) e [session-handlers.js:94](C:/Users/Diogo/SeeMyGame/js/protocol/session-handlers.js:94).

As ofertas PeerJS e a presença da sala usam transportes distintos. Se a oferta chegar primeiro, `answerVoiceCall()` fecha a chamada porque o catálogo local ainda mostra o remetente no lobby. Apenas o peer com ID menor inicia chamadas, e `connectVoiceTo()` não substitui uma chamada pendente existente. Não há negociação de confirmação de presença nem recuperação com prazo limitado para essa chamada.

Reprodução: atrasar somente a entrega de `ROOM_MEMBER_STATE_UPDATE` do convidado; o anfitrião entra em `voice-1`, depois o convidado entra. A oferta real chega e é rejeitada. Entregar todas as mensagens atrasadas deixa ambos os mapas de membros no mesmo canal, mas nenhum lado recebe stream remoto após cinco segundos; o convidado mantém uma chamada `open=false`, conexão `new`. O controle positivo, com entrega normal em `voice-2`, recebeu bytes RTP de áudio nos dois sentidos.

Impacto: a sala indica que ambos entraram no canal, mas a conversa não funciona. O atraso é controlado no teste; sinalização e mídia são reais.

Correção recomendada: coordenar a criação da chamada com a presença confirmada ou adiar ofertas até validar essa presença, com prazo e cancelamento. Remover chamadas rejeitadas/pendentes e permitir nova tentativa limitada. Preservar a autorização e o isolamento entre canais.

### N03 — [P2] Recarregar o anfitrião deixa canais fantasmas nos convidados

Local: [voice-channels.js:37](C:/Users/Diogo/SeeMyGame/js/room/voice-channels.js:37); integração: `ROOM_SYNC_ALL` em `js/room/message-handlers.js`.

O coordenador recriado começa com dois canais e revisão zero. O convidado reconectado conserva a revisão anterior e rejeita o catálogo novo por considerá-lo antigo. A revisão não identifica a instância do coordenador. O estado local também não sai de um canal que deixou de existir no catálogo oficial.

Reprodução: criar um terceiro canal, colocar os dois participantes nele e recarregar a página do anfitrião. Após a readmissão, o anfitrião tem revisão `0`, dois canais e convidado no lobby; o convidado tem revisão `1`, três canais e continua `inVoice=true` no canal personalizado. Não há chamada ativa entre eles. O reload e a reconexão são reais, sem interceptar mensagens neste cenário.

Correção recomendada: vincular a revisão à instância do coordenador ou restabelecer o catálogo autoritativo durante a readmissão. Reconciliar a presença local; se o canal não existir, encerrar a voz e retornar ao lobby. Isso não exige persistir canais após um reload, mas exige convergir para o mesmo catálogo.

### N04 — [P2] Reconexão perde a indicação remota de mic e fone mutados

Local: [room-session.js:446](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:446). Causas complementares: `ROOM_JOIN_REQUEST` inicializa flags ausentes como `false`; [room-voice-state.js:11](C:/Users/Diogo/SeeMyGame/js/session/room-voice-state.js:11) só publica quando o estado local muda.

O pedido de readmissão envia `voiceChannelId` e transmissão, mas omite `isMuted`, `isDeafened` e `isSpeaking`. O membro local já conserva os valores corretos, então o sincronizador não identifica mudança que force sua republicação.

Reprodução: convidado com mic/fone mutados em `voice-2`; fechar sua conexão de dados com o coordenador e aguardar a recuperação automática. O convidado conserva `muted=true/deafened=true`; o anfitrião passa a observar `false/false`. O canal de voz foi corretamente preservado. Com o participante mutado, nenhuma transição de fala repara incidentalmente a presença.

Impacto confirmado: presença e indicação de disponibilidade incorretas para os demais participantes. Este achado **não** significa que a reconexão desmutou a captura local; isso ocorre no cenário separado N01.

Correção recomendada: enviar o estado completo na readmissão ou republicá-lo incondicionalmente após a sincronização do coordenador. Testar reconexão com ambos os controles ativados.

### N05 — [P2] O E2E das correções anteriores usa um botão inexistente

Local: [e2e-third-audit-fixes.mjs:132](C:/Users/Diogo/SeeMyGame/tests/e2e-third-audit-fixes.mjs:132).

A mudança do lobby substituiu `#toggle-whiteboard-btn` por `#dock-whiteboard-btn` também no trecho que abre a lousa em **Streamer/Viewer**. Essas páginas mantêm `#toggle-whiteboard-btn`; o botão do dock pertence ao Room. A execução original falhou com timeout nessa linha e não verificou relay de histórico, autoria/projeção de cursores ou snapshot grande.

Uma cópia temporária alterou apenas esse seletor no trecho Streamer/Viewer, preservando todas as asserções. Os oito checks passaram. O arquivo original permanece intacto e continua precisando dessa correção.

## Validações

| Verificação | Resultado |
| --- | --- |
| `npm run verify` | 1.284 testes em 131 arquivos aprovados; módulos, HTML, CSS, smoke ESM e build aprovados. |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib` | 63 aprovados, 3 ignorados, zero falhas. |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline --lib` | Compilação da biblioteca de produção aprovada. |
| `tests/e2e-room-channels.mjs` | 12 checks aprovados: lobby, áudio entre canais, soundboard, entrada tardia, troca, controles de viewport e transmissão. |
| `tests/e2e-room-findings.mjs` | Ambas as ordens de entrada, RTP bidirecional, listeners e ajustes de Room aprovados. |
| E2E da terceira análise, original | Falhou no seletor descrito em N05, após os checks iniciais aprovados. |
| E2E da terceira análise, adaptação de seletor | Oito checks aprovados, zero erros de página. |
| Novas reproduções | N01–N04 reproduzidos; JSON com estados antes/depois e controle positivo de RTP. |

Logs: [verify](C:/Users/Diogo/SeeMyGame/output/current-audit-verify.log), [Rust testes](C:/Users/Diogo/SeeMyGame/output/current-audit-rust.log), [Rust check](C:/Users/Diogo/SeeMyGame/output/current-audit-rust-check.log), [E2E original](C:/Users/Diogo/SeeMyGame/output/current-audit-previous-fixes.log), [E2E adaptado](C:/Users/Diogo/SeeMyGame/output/current-audit-previous-fixes-adapted.log).

Evidências: [N01–N04](C:/Users/Diogo/SeeMyGame/output/playwright/current-review-1791250022510/report.json), [correções C01–C07](C:/Users/Diogo/SeeMyGame/output/playwright/third-audit-fixes-1791249961172/report.json), [canais](C:/Users/Diogo/SeeMyGame/output/playwright/room-channels-1791249626435/report.json).

Reexecução:

```powershell
node docs/current-review-probes.mjs
node docs/current-review-previous-fixes.mjs
node tests/e2e-room-channels.mjs
node tests/e2e-room-findings.mjs
```

`current-review-probes.mjs` afirma o comportamento defeituoso observado e termina com `status=bugs-reproduced`. Um exit code zero nesse script confirma a reprodução, não a correção. Após corrigir a aplicação, converter os cenários em testes que esperem o comportamento correto.

## Escopo e limites

Revisão de sessão, admissão/presença, negociação de voz, catálogo, UI/controles, políticas de soundboard, replay/lousa e alterações recentes de ICE/perfis nativos. A compilação Rust inclui o caminho de produção; os testes JavaScript verificam também a normalização ICE. Nenhum novo bug nativo foi confirmado nesta etapa.

E2E em Chrome, na mesma máquina, com contextos separados, microfone e tela sintéticos, sinalização PeerJS e WebRTC reais. N02 controla a ordem de entrega da presença. N01 verifica faixas habilitadas e conexão, sem afirmar gravação ou audição física. A revisão não reexecutou Desktop–Web ou Desktop–Desktop em janelas Tauri, nem validou outra máquina, NAT/TURN externo, microfone/fone físicos ou desempenho de jogos. Testes aprovados não excluem os cenários novos, que estavam ausentes da suíte.
