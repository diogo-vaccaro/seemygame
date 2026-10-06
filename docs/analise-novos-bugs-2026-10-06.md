# Nova auditoria — 6 de outubro de 2026

**Atualização:** os quatro achados abaixo foram corrigidos e receberam testes de regressão. Consulte a [validação das correções](C:/Users/Diogo/SeeMyGame/docs/correcao-novos-bugs-2026-10-06.md). Este documento e o script original preservam a evidência do comportamento anterior à correção.

Foram confirmados **quatro bugs adicionais**, com reprodução em dois contextos isolados do Chrome e chamadas PeerJS/WebRTC reais. O código de produção não foi alterado nesta auditoria. As correções locais anteriores foram preservadas.

Base Git: `a5890521fee84ca969cc7262deaee88696330123`, acrescida das alterações ainda não commitadas existentes no início da revisão. Os achados abaixo referem-se a esse estado de trabalho, não apenas ao commit.

| ID | Prioridade | Falha confirmada |
| --- | --- | --- |
| B01 | P1 | Trocar PTT por VAD reativa o microfone enquanto o usuário permanece ensurdecido. |
| B02 | P1 | Reconexão do canal de dados deixa a transmissão em “Carregando”, embora a chamada de vídeo permaneça ativa. |
| B03 | P2 | Permissão tardia para um canal removido mantém o microfone ativo no lobby com controles desabilitados. |
| B04 | P2 | Desfazer uma mudança de cor apaga o objeto em vez de restaurar sua aparência. |

## B01 — Mudança de modo remove o mute imposto por ensurdecer

Localização: [mixer.js:50](C:/Users/Diogo/SeeMyGame/js/voice/mixer.js:50), especialmente linhas 56–57.

Reprodução pela interface: dois usuários entram em `voice-1`; o convidado abre as configurações de voz, seleciona PTT, silencia o fone e volta para VAD. Antes da última ação, `isDeafened=true`, `isMuted=true` e as trilhas de microfone estão desabilitadas. Depois, `isDeafened` continua `true`, mas `isMuted=false` e tanto a trilha capturada quanto a processada ficam `enabled=true`, `readyState=live`.

`setVoiceMode('vad')` chama `setMuted(false)` incondicionalmente. Isso desfaz o mute automático de `setDeafened(true)` sem uma ação explícita de reativação do microfone. As chamadas de voz já estavam conectadas antes da troca. A evidência comprova a reativação das trilhas; o ensaio usa microfone sintético e não é uma avaliação de áudio ouvido em um dispositivo físico.

Correção sugerida: separar o estado de mute solicitado pelo usuário do bloqueio de transmissão imposto pelo modo PTT e por ensurdecer. Trocar o modo não deve cancelar o bloqueio de ensurdecer. Cobrir também mute manual antes da troca de modo.

## B02 — Vídeo perde a ligação com a interface após reconectar os dados

Localização: [room-session.js:276](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:276) e [room-session.js:516](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:516).

Reprodução: o coordenador compartilha a tela; o convidado recebe vídeo com largura de 640 pixels e quadros decodificados. Fecha-se somente sua `coordinatorConn`, mantendo a chamada de mídia. A reconexão automática admite novamente o mesmo peer. O cartão da transmissão retorna como placeholder, sem elemento `<video>`.

O teste encontrou a chamada de mídia ainda em `connected`, trilha remota `live` e tráfego RTP crescente: **126.538 → 173.809 bytes recebidos**, durante 1,5 segundo de observação, sem vídeo no cartão. A captura local também continuava ativa. Portanto, o desaparecimento não foi causado por interrupção da captura ou ausência de mídia.

`memberLeft` remove o cartão, mas o caminho PeerJS de tela conserva `remoteStreams` e `screenCalls`. No retorno do membro, o placeholder dispara `REQUEST_STREAM`; `sendRoomStream` retorna ao encontrar a chamada antiga no mapa. O evento `stream` dessa chamada já ocorreu e não reconstrói o cartão. O plugin nativo tem tratamento próprio de saída de membros; este achado foi reproduzido no caminho de captura web.

Correção sugerida: alinhar a vida útil dos cartões e das chamadas de tela à saída/reentrada do membro. Encerrar e remover as chamadas antigas em ambos os lados ou restaurar explicitamente o cartão a partir de um stream ainda válido. Validar recuperação automática e retomada do replay remoto.

## B03 — Canal desaparece enquanto a permissão está pendente

Localização: [room-session.js:550](C:/Users/Diogo/SeeMyGame/js/session/room-session.js:550), com participação de [voice-channels.js:48](C:/Users/Diogo/SeeMyGame/js/room/voice-channels.js:48).

Reprodução: cria-se um canal personalizado; o convidado solicita entrada e sua resposta real de `getUserMedia` é retida para simular permissão pendente. O coordenador recarrega a página e volta à sala, reiniciando o catálogo. Após confirmar que o canal deixou de existir no catálogo do convidado, libera-se a resposta do microfone.

Resultado: `voiceChannelId=null`, `isInVoice=true`, trilhas de áudio `live` e habilitadas, botões de mic e fone desabilitados. A captura fica ativa em um estado apresentado como lobby. Não foi constatada transmissão de áudio a outro participante nesse cenário.

O canal é validado antes do `await`, mas não depois. `setLocalVoiceChannel(channelId)` retorna `false` para o ID removido e esse retorno é ignorado. A remoção do catálogo só emite `voiceChannelRemoved` para um canal já atribuído; durante a permissão pendente, o canal local ainda é `null`, então o mecanismo de cancelamento existente não é acionado.

Correção sugerida: revalidar o canal depois da captura assíncrona e liberar as trilhas em caso de falha. Tratar também a remoção de um canal cuja entrada esteja pendente. Manter a proteção existente contra sair/trocar de canal antes de conceder permissão.

## B04 — Alterações de aparência não entram no histórico da lousa

Localização: [document.js:62](C:/Users/Diogo/SeeMyGame/js/whiteboard/document.js:62). A inspeção encontrou o mesmo padrão em `setStrokeWidth` e `setFill`; a reprodução E2E exercitou a cor.

Reprodução apenas com mouse e botões: desenhar um retângulo branco, selecionar, clicar na cor vermelha e clicar em “Desfazer”. A mudança de cor foi recebida pelo segundo usuário. A profundidade do histórico permaneceu em **1** antes e depois da mudança. Ao desfazer, o retângulo foi removido nas duas telas.

Os setters modificam o objeto selecionado diretamente, renderizam e propagam `onElementUpdated`, mas não salvam o estado anterior nem invalidam a pilha de refazer. O undo disponível corresponde à criação do objeto. Alterações de documento por estilo devem seguir a mesma disciplina de histórico das demais edições, sem criar entradas ao simplesmente escolher um estilo para desenhos futuros.

## Validação e evidências

- `npm run verify`: módulos, HTML, CSS, smoke ESM, **1.311 testes em 133 arquivos** e build aprovados. [Log](C:/Users/Diogo/SeeMyGame/output/audit-2026-10-06-verify.log).
- Regressões E2E anteriores de voz: **5 verificações aprovadas**, incluindo presença atrasada, reconexão, preservação de mute/fone, reinício do coordenador e voz utilizável após reinício. [Relatório](C:/Users/Diogo/SeeMyGame/output/playwright/current-voice-fixes-1791256130383/report.json).
- Regressões E2E da terceira auditoria: **8 verificações aprovadas** de saída, replay, PTT e lousa. [Relatório](C:/Users/Diogo/SeeMyGame/output/playwright/third-audit-fixes-1791256226939/report.json).
- **4 reproduções adicionais confirmadas**, sem erros JavaScript de página: [relatório com estados e métricas](C:/Users/Diogo/SeeMyGame/output/playwright/audit-2026-10-06-1791256186359/report.json).
- [Script reproduzível](C:/Users/Diogo/SeeMyGame/docs/audit-2026-10-06-browser.mjs): `node docs/audit-2026-10-06-browser.mjs`. Suas asserções confirmam o comportamento defeituoso atual; `bugs-reproduced` não significa que os bugs estejam corrigidos.

Capturas: [troca de modo](C:/Users/Diogo/SeeMyGame/output/playwright/audit-2026-10-06-1791256186359/mode-after.png), [vídeo após reconectar](C:/Users/Diogo/SeeMyGame/output/playwright/audit-2026-10-06-1791256186359/video-after-reconnect.png), [permissão tardia](C:/Users/Diogo/SeeMyGame/output/playwright/audit-2026-10-06-1791256186359/pending-permission-after.png), [lousa após desfazer](C:/Users/Diogo/SeeMyGame/output/playwright/audit-2026-10-06-1791256186359/style-undo-after.png).

Limites: a reprodução usou Chrome, captura por canvas, microfones sintéticos e sinalização local. A revisão também inspecionou ciclo de vida de sessão, captura, replay, catálogo de voz e integração de mídia nativa; a inspeção não certifica ausência de outras falhas. Não foram executados novos E2E com janela Tauri, duas máquinas, dispositivos físicos ou redes/NAT de produção nesta rodada.
