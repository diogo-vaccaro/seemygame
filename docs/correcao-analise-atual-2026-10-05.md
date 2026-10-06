# Correção da análise atual — 05/10/2026

Correções dos achados N01–N05 da [análise sobre a base a589052](C:/Users/Diogo/SeeMyGame/docs/analise-codigo-atual-2026-10-05.md). As reproduções históricas foram preservadas; os novos testes esperam o comportamento corrigido.

| Achado | Mudança | Verificação |
| --- | --- | --- |
| N01 — Troca de canal desmuta | A troca preserva mute/deafen antes da captura e negociação do novo canal. PTT é liberado e a entrada continua silenciosa até pressionar a tecla novamente. | Faixas de áudio brutas/processadas desabilitadas, liberação da captura anterior e estados locais preservados; cliques reais no Chrome. |
| N02 — Oferta anterior à presença | Ofertas autorizadas aguardam presença no mesmo canal por até cinco segundos. Ofertas sem resposta têm prazo, com no máximo duas novas tentativas. Mudança de canal, saída, revogação e descarte cancelam chamadas e timers. | Presença atrasada por seis segundos; recuperação automática com RTP bidirecional. Regressões de timeout, isolamento, limitação de tentativas e cancelamento. |
| N03 — Catálogo após reload | Um `ROOM_SYNC_ALL` de uma nova conexão válida do coordenador pode reiniciar a revisão. Na mesma conexão, revisões antigas continuam rejeitadas. Se o canal local deixar de existir, o membro retorna ao lobby e encerra chamadas/captura. | Reload real: catálogos convergem para revisão zero, convidado no lobby e faixas antigas encerradas; nova entrada em canal existente funciona. |
| N04 — Presença após reconectar | A readmissão envia mute/deafen/fala. A admissão atualiza esses campos também quando o registro do participante já existe. Fala só é restaurada em canal conhecido e com mic desmutado. | Reconexão real mantém mic/fone mutados nos estados locais e remotos. Testes de readmissão com registro existente/novo e canal inválido. |
| N05 — Seletor do E2E | O trecho Streamer/Viewer voltou a usar `#toggle-whiteboard-btn`. O seletor do dock continua específico do Room. | Suíte original das correções anteriores passa sem adaptação temporária. |

## Reconexão adicional corrigida durante a validação

A reexecução revelou dois caminhos que impediam a recuperação após reload:

- `ROOM_MEMBER_LEFT` podia remover o coordenador do mapa antes do evento de fechamento. O guard desse evento então ignorava a conexão e não agendava recuperação. O listener de saída agora também encerra a referência do coordenador e agenda a reconexão.
- Uma oferta de dados enviada enquanto o anfitrião ainda estava na tela de entrada podia ficar pendente, sem `open`, `close` ou `error`. O novo controlador aplica prazo de cinco segundos, mantém uma tentativa por vez e limita a sequência a quinze tentativas. Erro/fechamento duplicados e eventos de tentativas antigas não criam timers extras; o descarte encerra o trabalho pendente.

O E2E aguarda uma oferta real de reconexão ser enviada **antes** de o anfitrião voltar a registrar seu ID. A primeira oferta permanece sem resposta; a segunda recupera a sala. Isso reproduz o cenário que antes dependia da velocidade do reload.

[Reprodução anterior com timeout](C:/Users/Diogo/SeeMyGame/output/playwright/current-voice-fixes-1791251343690/report.json) e [recuperação aprovada](C:/Users/Diogo/SeeMyGame/output/playwright/current-voice-fixes-1791251583534/report.json).

## Testes e evidências

- **27 novas regressões unitárias**, em [current-voice-fixes.test.js](C:/Users/Diogo/SeeMyGame/tests/current-voice-fixes.test.js) e [coordinator-reconnect.test.js](C:/Users/Diogo/SeeMyGame/tests/coordinator-reconnect.test.js).
- **60 testes focados aprovados**, cobrindo as novas regressões e voz/canais/mídia/correções anteriores. [Log](C:/Users/Diogo/SeeMyGame/output/current-fixes-focused.log).
- **Cinco checks novos E2E aprovados**, incluindo os quatro bugs, a espera do anfitrião e uma nova negociação após o restart. [JSON](C:/Users/Diogo/SeeMyGame/output/playwright/current-voice-fixes-1791251583534/report.json).
- **12 checks de canais aprovados**: lobby, chat, RTP, soundboard, isolamento, transmissão e navegação. [JSON](C:/Users/Diogo/SeeMyGame/output/playwright/room-channels-1791251047495/report.json).
- **1.311 testes em 133 arquivos aprovados** sobre a versão final. `npm run verify` também aprovou módulos, HTML, CSS, smoke ESM e build de distribuição. [Log](C:/Users/Diogo/SeeMyGame/output/current-fixes-verify.log).
- **Oito checks do E2E original das correções anteriores aprovados**, com zero erros de página e sem adaptação temporária do seletor. [JSON](C:/Users/Diogo/SeeMyGame/output/playwright/third-audit-fixes-1791251645267/report.json), [log](C:/Users/Diogo/SeeMyGame/output/current-fixes-previous-e2e.log).
- `git diff --check` aprovado.

Reexecução:

```powershell
npm run test:e2e:voice-fixes
node tests/e2e-third-audit-fixes.mjs
npm run test:e2e:room-channels
node node_modules/vitest/vitest.mjs run tests/current-voice-fixes.test.js tests/coordinator-reconnect.test.js --configLoader native
npm run verify
```

Os scripts `docs/current-review-probes.mjs` e seus JSONs descrevem o comportamento anterior e afirmam a existência dos bugs. Para verificar a correção, usar os testes acima. O wrapper histórico de seletor aceita também a versão já corrigida do teste original.

## Limites

E2E em Chrome na mesma máquina, com contextos isolados, tela/mic sintéticos e sinalização PeerJS/WebRTC reais. O atraso de presença e a volta do anfitrião são controlados. Não houve nova execução Desktop–Web em janela Tauri, uso de dispositivos físicos ou outra máquina/NAT nesta correção. Nenhum arquivo Rust foi alterado.
