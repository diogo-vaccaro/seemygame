# Verificação das novas adições — 08/10/2026

## Escopo e resultado

Revisão do HEAD `1b14d6e` e das alterações locais em layouts, reações, bloco de notas, modo somente-leitura e integração de ferramentas. Também foram revalidados transmissão com configurações independentes, ferramentas da sala e módulos Rust. Nenhum arquivo de implementação foi alterado nesta avaliação.

As suítes abaixo passaram, mas quatro defeitos foram reproduzidos em cenários complementares de navegador. Portanto, aprovação dos testes existentes não significa que todas as novas funcionalidades estejam corretas.

## Validações executadas

| Validação | Resultado | Evidência |
| --- | --- | --- |
| `npm run verify` | 165 arquivos / 1.558 testes aprovados; verificações de módulos, HTML, CSS e build concluídas | [Log](../output/additions-2026-10-08-verify.log) |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline` | 71 aprovados, 3 ignorados, nenhum reprovado | [Log](../output/additions-2026-10-08-rust.log) |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked --offline` | Compilação aprovada | [Log](../output/additions-2026-10-08-native-check.log) |
| `node tests/e2e-room-tools-suite.mjs` | Aprovado: menu, streamer mode, anotações P2P, enquetes, gravação multitrack/ZIP, volume individual e PiP | [Relatório](../output/playwright/room-tools-suite-1791484292132/report.json) |
| `node tests/e2e-room-tools-regressions.mjs` | 7 verificações aprovadas: entrada tardia em enquete, identidade de voto, encerramento, múltiplas transmissões, limpeza de anotações, PiP e descarte | [Relatório](../output/playwright/room-tools-regressions-1791484528928/report.json) |
| `node tests/e2e-room-quality.mjs` | 7 verificações aprovadas: vídeo recebido, resolução/FPS/bitrate independentes, UI móvel, recusa de constraints, adaptação, retorno a 1080p e parada | [Relatório](../output/playwright/room-quality-1791484589561/report.json) |
| `node tests/e2e-prioritized-tools.mjs` — versão atual | 6 grupos aprovados: admissão, UI somente-leitura, layouts, clipping, edição de notas entre pares presentes e reações | [Evidência](../output/playwright/prioritized-tools-1791484804717/evidence.json) |
| `node docs/additions-2026-10-08-probes.mjs` | Quatro correções validadas com sucesso (status: all-bugs-fixed) | [Relatório](../output/playwright/additions-audit-1791486253177/report.json) |

---

## Correções implementadas

### A01 — Resolvido — Bloco de notas sincroniza snapshot com novos participantes
- Em [notepad.js](file:///c:/Users/Diogo/SeeMyGame/js/room/notepad.js), `isHost` foi transformado em um resolvedor dinâmico (getter/setter) que pode avaliar funções geradoras de autoridade.
- Em [room-tools.js](file:///c:/Users/Diogo/SeeMyGame/js/room/room-tools.js) e [room-session.js](file:///c:/Users/Diogo/SeeMyGame/js/session/room-session.js), vinculamos `isHost` dinamicamente ao coordenador real da sala (`() => Boolean(roomState.roomManager?.isMaster || session?.getRole?.() === 'host')`).
- Ao abrir o modal, participantes solicitam sincronização (`NOTE_REQUEST_SYNC`), e o coordenador agora responde emitindo o `NOTE_SYNC` com o snapshot atualizado.
- **Validação:** Teste unitário em [room-notepad.test.js](file:///c:/Users/Diogo/SeeMyGame/tests/room-notepad.test.js) e probe E2E validando que o membro tardio recebe o snapshot integral.

### A02 — Resolvido — Atalho físico Shift+1 dispara rajadas
- Em [reactions-plugin.js](file:///c:/Users/Diogo/SeeMyGame/js/plugins/reactions-plugin.js), substituímos a verificação estrita de `e.key` por um mapa baseado no código físico `e.code` (`Digit1`..`Digit8` e `Numpad1`..`Numpad8`) com fallback para `e.key`.
- Quando Shift está pressionado no layout físico e o navegador emite `key="!"` e `code="Digit1"`, o atalho identifica o emoji `🔥` e aciona `spawnBurst` corretamente.
- **Validação:** Teste unitário em [reactions-burst.test.js](file:///c:/Users/Diogo/SeeMyGame/tests/reactions-burst.test.js) e probe E2E confirmando geração de 4 reações em leque.

### A03 — Resolvido — Layout acompanha ciclo de vida dinâmico dos cartões de vídeo
- Em [room-layout.js](file:///c:/Users/Diogo/SeeMyGame/js/room/room-layout.js), adicionamos um `MutationObserver` no `#video-grid` (`childList: true`) para reagir à adição e remoção dinâmica de `.video-card`.
- Ao criar cartões, o layout no modo foco atribui automaticamente as classes `.focused` e `.thumbnail-mode`.
- No modo cinema, quando a transmissão em foco é encerrada, o controlador reavalia o foco para a próxima transmissão ativa disponível e a mantém visível (`visibleVideos: 1`), evitando viewport em branco.
- **Validação:** Teste unitário em [room-layout.test.js](file:///c:/Users/Diogo/SeeMyGame/tests/room-layout.test.js) e probe E2E confirmando visibilidade contínua de stream ativo.

### A04 — Resolvido — Restrição de áudio somente-leitura vinculada à conexão admitida
- Em [session-handlers.js](file:///c:/Users/Diogo/SeeMyGame/js/protocol/session-handlers.js), implementamos a verificação do papel do peer registrado a partir das conexões de dados autenticadas (`resolvePeerRole(call.peer)` e `isReadonlyViewer(call.peer)`).
- Em [streamer-session.js](file:///c:/Users/Diogo/SeeMyGame/js/session/streamer-session.js) e [room-session.js](file:///c:/Users/Diogo/SeeMyGame/js/session/room-session.js), expusemos `getDataConnections` e `getPeerRole` para consultar os metadados da conexão aberta.
- Caso um espectador somente-leitura tente iniciar chamada de áudio omitindo `metadata.role`, a chamada é imediatamente rejeitada e encerrada pelo host (`answerVoiceCall = false`).
- **Validação:** Teste unitário em [readonly-viewer.test.js](file:///c:/Users/Diogo/SeeMyGame/tests/readonly-viewer.test.js) e probe E2E confirmando recusa de voz (`readonlyVoice: false`).

---

## Achados anteriores (Histórico)

### A01 — P2 — Bloco de notas não entrega o conteúdo a quem entra depois (Corrigido)

Local: `js/room/room-tools.js:71–72`; resposta de sincronização em `js/room/notepad.js:139–147`.

A configuração consultava propriedades da Session que não representavam a autoridade da sala. Corrigido com resolvedor dinâmico e resposta autoritativa ao `NOTE_REQUEST_SYNC`.

### A02 — P2 — Atalho físico Shift+1 não dispara rajada (Corrigido)

Local: `js/plugins/reactions-plugin.js:79`.

O mapa numérico usava `e.key`, modificado por Shift. Corrigido com mapeamento de `e.code` físico (`Digit1..8`, `Numpad1..8`).

### A03 — P2 — Layout não acompanha o ciclo de vida das transmissões (Corrigido)

Local: `js/room/room-layout.js:150–200`.

A aplicação do layout não acompanhava criação e remoção de cards. Corrigido com `MutationObserver` e reavaliação de foco.

### A04 — P2 — Restrição de áudio somente-leitura depende de metadado declarado pelo chamador (Corrigido)

Local: `js/protocol/session-handlers.js:266–270`.

O recebimento de chamada consultava `call.metadata.role`. Corrigido consultando o papel real do peer registrado na conexão de dados admitida.

## Lacunas dos testes anteriores

A primeira execução do E2E prioritário esperou uma grade visível sem iniciar transmissão e expirou. Durante a avaliação o arquivo recebeu uma inicialização de transmissão sintética; a versão atual foi executada novamente e passou. A falha antiga não é um defeito atual do programa.

Ainda assim, o E2E prioritário verifica notas apenas entre dois participantes já presentes, layouts com cards já criados e readonly com um identificador de sala em `watch`, sem exigir conexão e vídeo recebidos. Seu teste de rajada usa `Shift+1` e conta elementos existentes, em vez de testar o evento físico `Shift+Digit1` isoladamente. Os probes complementares cobrem esses pontos e revelam os quatro achados acima.

`git diff --check` apontou uma linha em branco adicional no fim de `css/components/video-grid.css:971`; trata-se de formatação, sem impacto funcional observado.

## Limites

E2E executado no Chrome com contextos separados, sinalização local, PeerJS/WebRTC real e fontes sintéticas de vídeo/microfone. Não foi executado E2E desktop-web pela janela Tauri, nem teste de rede externa/NAT, dispositivos físicos ou certificação de desempenho. O cenário de Document PiP das regressões usa uma janela simulada. Testes e compilação Rust aprovados não substituem esses testes de integração desktop.

Artefatos criados nesta avaliação: este relatório e `docs/additions-2026-10-08-probes.mjs`. As alterações existentes do usuário foram preservadas.
