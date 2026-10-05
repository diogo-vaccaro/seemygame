# Correção da terceira análise — 05/10/2026

Os sete achados C01–C07 da [terceira análise](terceira-analise-profunda-2026-10-05.md) foram corrigidos sobre a base `eeeca1a`. Os artefatos anteriores foram preservados.

| Achado | Correção | Validação |
| --- | --- | --- |
| C01 — Saída da sala | O botão usa o encerramento completo do runtime e navega para `index.html`. A captura é associada à sessão imediatamente após receber a tela, incluindo o período de permissão pendente do microfone. | Chrome: navegação real, sessão descartada e faixas encerradas antes da navegação. Regressões de saída com captura ativa, permissão de tela e permissão de microfone pendentes. |
| C02 — Replay remoto | A parada local emite `stream:stopped` com `sourceId=local-me`; os gravadores remotos continuam ativos. | Chrome com duas transmissões: replay remoto preservado, vídeo remoto decodificado e faixa viva. |
| C03 — PTT | A UI atual vincula Caps Lock e Ctrl direito ao VoiceManager da sessão. A última soltura, blur, página oculta e desmontagem liberam o microfone. Campos editáveis e participantes ensurdecidos são respeitados. Trocar o modo não conserva ativação antiga. | Teclas reais no Chrome; regressões de duas teclas simultâneas, perda de foco, visibilidade, descarte, campos editáveis e troca de modo. |
| C04 — Relay de histórico | Snapshots recebidos são retransmitidos aos outros Viewers somente após validação e montagem completa. Snapshots grandes mantêm imagens em chunks e ordem de camadas. Room não retransmite pela malha. | Chrome: desfazer/refazer e imagem PNG de 353.030 caracteres através do host. Testes de atomicidade, exclusão do remetente e rejeição de snapshot inválido. |
| C05 — Autoria dos cursores | O host preserva a identidade obtida da conexão. O Viewer aceita identidade encaminhada somente pelo host autorizado e com marca de relay correspondente. | Chrome: cursores distintos do host e Viewer. Regressão contra falsificação direta de autor. |
| C06 — Projeção do cursor | Cursores usam zoom e pan da lousa destinatária; posições fora do viewport são ocultadas. | Contexto real de canvas no Chrome e teste controlado: posição esperada e observada `(600, 450)`. |
| C07 — Imagens pendentes | Importações são invalidadas ao limpar, substituir o documento, desfazer/refazer ou descartar. Decodificações pendentes resolvem sem inserção e sem publicação. O processamento inicial do arquivo também verifica a geração. Picker, drop e paste usam esse fluxo. | Chrome: PNG realmente decodificado com callback tardio não reaparece nem chega ao outro cliente. Regressões de limpeza, substituição, descarte e processamento pendente do arquivo. |

## Verificações concluídas

- **1.262 testes JavaScript aprovados em 128 arquivos**, incluindo **19 novas regressões**. `npm run verify` aprovou também módulos, HTML, CSS, smoke ESM e build de distribuição. [Log](../output/third-fixes-verify.log).
- **Oito checks E2E da terceira análise aprovados**, cobrindo os sete achados e a extensão de snapshot grande, com zero erros de página. [JSON](../output/playwright/third-audit-fixes-1791233764503/report.json), [início após sair](../output/playwright/third-audit-fixes-1791233764503/after-exit.png).
- Controles de mic/fone, presença e reconexão aprovados. [Log](../output/third-fixes-controls.log).
- Ambas as ordens de entrada na voz, RTP bidirecional, listeners e ajustes de sala aprovados. [Log](../output/third-fixes-room-findings.log).
- PIN, vídeo, chat relay, entrada tardia e snapshot grande em Room aprovados. [Log](../output/third-fixes-sessions.log).
- Fórmulas e edição matemática aprovadas. [Log](../output/third-fixes-math.log).
- Lousa com três clientes: desenho, imagem, redimensionamento, zoom/pan e retorno à sala aprovados. [Log](../output/third-fixes-whiteboard.log).
- `git diff --check` aprovado.

A validação de snapshots agora rejeita elementos inválidos antes de aplicar/retransmitir o documento. Um fixture antigo de `WHITEBOARD_SYNC`, que declarava uma linha sem pontos ou coordenadas, foi atualizado para uma linha válida; a expectativa de aplicação do snapshot foi mantida.

## Reexecução

```powershell
node node_modules/vitest/vitest.mjs run tests/third-audit-regression.test.js tests/room-media-regressions.test.js --configLoader native
node tests/e2e-third-audit-fixes.mjs
npm run verify
```

As reproduções originais em `docs/audit-2026-10-05-*.mjs` e seus JSONs registram o estado anterior. Para verificar o comportamento corrigido, use os testes acima.

## Limites

Os E2E foram executados no Chrome, na mesma máquina, com captura de tela sintética, microfone falso e sinalização PeerJS/WebRTC reais. A corrida de imagem controla a entrega do callback de um PNG realmente decodificado. A proteção durante permissões pendentes usa mídia controlada nos testes unitários.

Não houve reexecução Desktop–Web em uma janela Tauri, uso de gamepad físico ou benchmark de FPS nesta etapa. Nenhum arquivo Rust foi alterado. A parada nativa reutiliza a rotina existente; os testes de captura nativa deste módulo usam IPC controlado.
