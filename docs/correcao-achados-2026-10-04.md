# Correção dos achados A01–A16

Os 14 bugs reproduzidos e os dois riscos Rust da [análise](G:/SeeMyGame/docs/analise-completa-codigo-2026-10-04.md) foram corrigidos no código. As alterações que já estavam no workspace foram preservadas.

## O que mudou

| Achados | Correção |
|---|---|
| A01–A03 | Troca de microfone usa geração de captura, descarta respostas canceladas, encerra o microfone anterior, reconstrói o ganho e substitui o áudio nas chamadas abertas. O listener é removido no descarte. |
| A04, A11 | Room distingue comandos do host e do jogador; fornece cartão, conexão e modal de aprovação. Os cartões Room, Viewer e nativos têm ação Co-op específica para o peer exibido. |
| A05 | Estado de voz direto fica vinculado à conexão de origem. Retransmissão de outro participante exige host confiável e marcação explícita de relay. |
| A06 | Reset inclui o slot, preserva os gamepads na perda de visibilidade e libera apenas recursos daquele jogador. Teclas compartilhadas continuam retidas pelos demais slots. |
| A07 | Cliques de mouse obedecem à capacidade anunciada pelo host. |
| A08–A10 | Callbacks verificam a conexão/chamada atual. Recursos substituídos são fechados e eventos antigos não removem cartões, admissão, replay ou estatísticas da conexão nova. A recepção Room também protege eventos de stream antigos. |
| A12 | “Clipar” encaminha o ID do cartão ao editor, inclusive nos cartões locais. Não exporta a fonte global de outro participante. |
| A13 | Fullscreen promove o palco contendo vídeo e canvas, destaca o cartão escolhido e restaura as classes na saída. O laser permanece visível e transmissível. |
| A14 | Rust reserva um ticket por negociação, revalida captura/estado/geração antes de instalar a ponte e mantém ICE separado por negociação. Create, ICE, close e eventos da ponte carregam o identificador. Cancelamentos antigos não fecham pontes novas; cancelamento anterior à criação também impede reativação. |
| A15 | Fechamento de janela respeita seu label. `native-player` libera somente o viewer; `main` libera a sessão inteira. O viewer cancela inicializações pendentes e solta o mutex antes de destruir o pipeline/fechar a janela. |
| A16 | Cartões têm descarte de listeners e timers, limpam `srcObject` e são removidos ao descartar a sessão. Reconstrução do cartão também encerra os recursos anteriores. |

A validação no navegador identificou ainda notificações interceptando cliques nos controles; o contêiner de notificações agora deixa os eventos passarem. O teste usa clique real para liberar Co-op, pois o botão ativo possui animação contínua.

## Validação

- **1.174 testes JavaScript passaram**, em 122 arquivos. Foram adicionadas 22 verificações de regressão, incluindo troca concorrente de microfone, relay legítimo de voz, reset por slot e reconexão nativa.
- **58 testes Rust passaram; três continuaram ignorados.** Cinco testes novos cobrem substituição/cancelamento de negociação, troca de captura, fechamento anterior à criação e isolamento de janelas.
- `cargo check --locked --offline --lib` passou para os comandos efetivamente compilados no aplicativo.
- Chrome com duas sessões Room, PeerJS real e captura sintética confirmou pedido, aprovação e liberação de Co-op; canvas dentro do fullscreen; laser desenhado em fullscreen e recebido pelo outro membro. Sem erros de página.
- Verificações de módulos, HTML, CSS e importação ESM passaram. Build `dist/` gerado.

Os caminhos de geração/janelas nativas têm testes de lógica e compilação, além dos testes existentes de mídia GStreamer. **Não foi feita uma sessão interativa do Tauri com GPU/janelas reais nem teste de NAT entre máquinas.** Essa cobertura continua necessária para validar o comportamento no hardware do usuário.

## Reexecutar

```powershell
node node_modules/vitest/vitest.mjs run --configLoader native
npm run test:e2e:audit-fixes
node tests/e2e-tactical-tools.mjs
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib
npm run native:smoke
npm run build:dist
```

Os comandos antigos `docs/audit-2026-10-04-browser.mjs` e `docs/audit-2026-10-04.config.mjs` também apontam para as verificações de comportamento corrigido. O relatório da auditoria conserva os achados originais para rastreabilidade.

Testes: [regressões JavaScript](G:/SeeMyGame/tests/audit-2026-10-04-regression.test.js), [negociação nativa](G:/SeeMyGame/tests/native-media-plugin.test.js), [fluxo Chrome](G:/SeeMyGame/tests/e2e-audit-fixes.mjs), [tickets Rust](G:/SeeMyGame/src-tauri/src/capture/negotiation.rs), [janelas Rust](G:/SeeMyGame/src-tauri/src/window_lifecycle.rs).

Evidências locais: [Chrome](G:/SeeMyGame/output/playwright/audit-fixes-2026-10-04/evidence.json), [laser fullscreen](G:/SeeMyGame/output/playwright/audit-fixes-2026-10-04/fullscreen.png), [JavaScript](G:/SeeMyGame/output/fix-audit-2026-10-04-vitest-final.log), [Rust](G:/SeeMyGame/output/fix-audit-2026-10-04-rust-test-final.log), [compilação nativa](G:/SeeMyGame/output/fix-audit-2026-10-04-rust-check-final.log).

Não houve commit, push ou deploy nesta correção.
