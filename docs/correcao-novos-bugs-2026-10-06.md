# Correção dos quatro bugs da auditoria de 6 de outubro

Esta rodada corrige os achados B01–B04 sobre a base `a589052`. As reproduções e auditorias anteriores permanecem como histórico. Não houve mudança em Rust nesta rodada.

## Mudanças

- **B01 — Microfone, PTT e fone silenciado:** o mute manual agora é separado dos bloqueios de PTT e ensurdecer. Trocar de modo não remove o mute manual nem reativa o microfone ensurdecido. A captura inicial também aplica os três bloqueios. Ensurdecer limpa as teclas PTT mantidas pressionadas; restaurar a audição exige uma nova pressão da tecla no modo PTT. O botão de mic continua respeitando o estado apresentado e não contorna esse bloqueio. [Mixer](C:/Users/Diogo/SeeMyGame/js/voice/mixer.js:15), [captura](C:/Users/Diogo/SeeMyGame/js/voice/capture.js:80), [teclas](C:/Users/Diogo/SeeMyGame/js/discord-ui/voice.js:47).
- **B02 — Vídeo após reconectar:** a saída de um membro encerra suas chamadas PeerJS de tela nos dois sentidos, remove os registros e libera as trilhas remotas. A readmissão negocia chamadas novas e os eventos de recebimento restauram o cartão e o replay. Chamadas substituídas, falhas de mídia e encerramento da sessão também liberam os recursos; eventos atrasados de uma chamada antiga não apagam sua substituta. A captura local continua durante a reconexão. [Ciclo de vida](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:284), [liberação de mídia](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:521).
- **B03 — Permissão tardia para canal removido:** a sessão guarda o destino de uma entrada pendente. Atualizar o catálogo cancela a captura se esse destino desaparecer. Após a resposta assíncrona, a atribuição do canal é verificada novamente; falha encerra a voz e libera as trilhas. O cancelamento antigo não pode interromper uma entrada posterior válida. [Catálogo](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:183), [entrada](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:575).
- **B04 — Histórico da lousa:** mudanças de cor, espessura e preenchimento em objetos selecionados usam `updateElement`, salvando o estado anterior e invalidando o refazer anterior. Selecionar o mesmo estilo ou escolher um estilo para desenhos futuros não consome histórico. [Documento](C:/Users/Diogo/SeeMyGame/js/whiteboard/document.js:62).

## Validação

- `npm run verify`: **1.332 testes em 134 arquivos**, módulos, HTML, CSS, smoke ESM e build aprovados. [Log completo](C:/Users/Diogo/SeeMyGame/output/new-bug-fixes-verify.log).
- **21 novas regressões unitárias:** combinações de mute/fone/PTT, teclas mantidas pressionadas, chamadas nos dois sentidos, eventos atrasados, descarte da sessão, remoção de canal com permissão pendente, entrada posterior válida e undo/redo de estilos. [Testes](C:/Users/Diogo/SeeMyGame/tests/new-bug-fixes.test.js).
- **5 verificações E2E novas aprovadas:** os quatro achados e a preservação do mute manual ao alternar modos. [Relatório](C:/Users/Diogo/SeeMyGame/output/playwright/new-bug-fixes-1791257157434/report.json).
- **25 verificações E2E anteriores aprovadas:** voz/reconexão (5), saída/replay/PTT/lousa (8) e canais de voz (12). [Voz](C:/Users/Diogo/SeeMyGame/output/playwright/current-voice-fixes-1791257009039/report.json), [auditoria anterior](C:/Users/Diogo/SeeMyGame/output/playwright/third-audit-fixes-1791257191349/report.json), [canais](C:/Users/Diogo/SeeMyGame/output/playwright/room-channels-1791257062063/report.json).

Na reprodução final de vídeo, os dois usuários transmitiam simultaneamente. Após reconectar o canal de dados, as chamadas antigas estavam fechadas e os vídeos de ambos reapareceram com o replay remoto ativo. No convidado, os quadros decodificados avançaram de **83 para 128** e os bytes RTP de **103.007 para 150.278**. No teste da permissão tardia, o convidado permaneceu no lobby com `isInVoice=false`, sem trilhas de microfone, e a trilha concedida tardiamente foi encerrada. O undo restaurou o retângulo branco nas duas telas e o redo reaplicou o vermelho.

Para executar as novas verificações: `npx vitest run tests/new-bug-fixes.test.js` e `npm run test:e2e:new-bug-fixes`. [Runner E2E](C:/Users/Diogo/SeeMyGame/tests/e2e-new-bug-fixes.mjs).

Os E2E usaram dois contextos isolados do Chrome, PeerJS/WebRTC reais, sinalização local, captura por canvas e microfone sintético. Não houve novo ensaio com janela Tauri, dispositivos físicos, duas máquinas ou NAT de produção nesta rodada.
