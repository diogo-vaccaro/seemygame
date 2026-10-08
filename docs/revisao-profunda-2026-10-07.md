# Revisão profunda — 7 de outubro de 2026

## Escopo

Segunda rodada após a verificação extensa, com foco em operações assíncronas sobrepostas, cancelamento, descarte de recursos, reconexão e caminhos de erro da mídia nativa. Foram examinados os serviços de captura, ponte WebRTC, plugins, replay, transporte e sincronização da sala. A validação global inclui o grafo dos 188 módulos autorais, imports ESM, HTML, CSS, toda a suíte JavaScript, Rust, Companion Python e quatro suítes de navegador.

As alterações locais anteriores e os trabalhos concorrentes no projeto foram preservados. Este relatório descreve apenas as correções adicionais desta rodada. Nenhum commit, publicação ou deploy foi realizado.

## Bugs reproduzidos e corrigidos

| Área | Falha e correção |
| --- | --- |
| Captura | Duas chamadas concorrentes a `stop()` podiam permitir que uma conclusão tardia apagasse a nova captura. O manager compartilha a operação de parada pendente e verifica a identidade da transição. |
| Captura nativa | O provider limpava seus campos após aguardar IPC, sobrescrevendo uma captura iniciada nesse intervalo. Agora libera a propriedade dos recursos antes de aguardar e encerra apenas a sessão capturada pela operação. |
| Captura nativa | Uma ponte instalada depois da construção do provider era usada no início, mas não no encerramento. A ponte usada passa a acompanhar o resultado e a sessão. |
| Reconfiguração | O resultado atrasado de uma reconfiguração substituía os dados da sessão seguinte. Resultados obsoletos são ignorados, e opções externas não substituem o ID da sessão ativa. |
| Plugins | Promises de callbacks de limpeza eram descartadas, permitindo que `disposeAsync()` terminasse antes de fechar os recursos. A base e as subclasses propagam as operações pendentes. |
| Plugins | Uma limpeza que chamava `destroy()` recursivamente repetia a destruição até esgotar a pilha. O plugin libera seu estado antes dos callbacks. O input do laser mantém o contexto da inscrição para enviar a parada durante o descarte. |
| Replay nativo | A falha atrasada de um início antigo sobrescrevia o estado de uma tentativa nova bem-sucedida. O erro só é publicado pela geração atual. |
| Clipping | O plugin e o registro não retornavam a operação de parada dos recorders, deixando o encerramento nativo fora da espera da sessão. Agora a parada é aguardável. |
| Replay | Acesso ao próprio getter `localStorage` lançava fora do bloco protegido. Leituras e gravações opcionais ficam inteiramente dentro do tratamento de erro. |
| Replay | Falha assíncrona de início não aparecia no estado do registro e uma nova tentativa na mesma fonte era tratada como sucesso sem reiniciar. O resultado publica o erro para a interface, verifica a identidade do recorder e permite nova tentativa. |
| Sala | Um snapshot completo mantinha membros antigos e suas permissões após reconexão. O roster é validado e membros ausentes são removidos; suas conexões mesh e pendentes são fechadas. |
| Sala | Mudança de transmissão ativa para inativa no snapshot não emitia o evento de encerramento. Agora cartões e consumidores recebem `streamUnpublished`. |
| Admissão | Outro participante podia forjar avisos de PIN, convite inválido ou rejeição. Somente a conexão atual do coordenador pode emitir esses avisos ou confirmar a entrada. |
| Reconexão | Uma exceção síncrona ao abrir a conexão interrompia o ciclo de tentativas. O erro é contido e a próxima tentativa limitada é agendada. |
| Ponte WebRTC nativa | Falha ao instalar o listener ou inicializar um transceiver deixava a conexão aberta. A inicialização fica dentro do tratamento comum que libera os recursos. |
| Ponte WebRTC nativa | Cancelamento durante a instalação assíncrona do listener deixava uma assinatura tardia ativa e continuava a negociação. A assinatura tardia é removida e as etapas verificam cancelamento. |
| Ponte WebRTC nativa | Cancelamento durante a confirmação do primeiro frame mantinha o vídeo oculto, listeners e timers até o timeout. Um sinal de cancelamento remove esses recursos imediatamente e interrompe a espera pelas trilhas. |
| Transmissão nativa | Falha ao anunciar a transmissão retornava sucesso ou deixava a negociação presa após uma exceção de envio. O retorno reflete o envio e o estado é liberado para nova tentativa. |
| Transmissão nativa | Uma resposta SDP sem transporte aberto deixava o peer nativo e o estado de envio ativos. A falha de entrega fecha o peer da negociação correspondente; erros de negociação também liberam o estado. |
| Recepção nativa | Falha em `addTransceiver()` ocorria antes do tratamento de erro e vazava o receiver. A inicialização integra o mesmo bloco de limpeza usado pela negociação. |
| Eventos desktop | Uma falha de assinatura IPC deixava callbacks transformados registrados no Tauri. Ambos os listeners de captura agora removem o callback quando a assinatura falha. |

## Regressões

Foram acrescentados 26 casos em `tests/deeper-audit-lifecycle.test.js`, `tests/deeper-audit-room.test.js`, `tests/deeper-audit-native-bridge.test.js`, `tests/deeper-audit-desktop-events.test.js` e `tests/native-media-plugin.test.js`. Os cenários que demonstram os bugs falharam antes das respectivas correções e passaram depois delas. A suíte completa também identificou a regressão no envio da parada do laser, corrigida e revalidada pelo teste existente em `tests/tactical-tools-session.test.js`.

## Validação

| Verificação | Resultado |
| --- | --- |
| Módulos | 188 módulos e 468 imports/exports validados. |
| Imports ESM | 182 módulos importados sem iniciar rede, áudio, timers ou listeners de página. |
| HTML/CSS | Parciais consistentes e imports CSS resolvidos. |
| JavaScript | 1.507 testes aprovados em 155 arquivos, zero falhas e zero pendentes. Resultado completo em `output/deeper-audit-2026-10-07-vitest-final.json`. |
| Rust | 67 aprovados, zero falhas, 3 ignorados. |
| Companion Python | 10 aprovados, com drivers sintéticos. |
| Sessões E2E | PIN, vídeo decodificado, chat por DataChannel, identidade no relay, sala com três peers, entrada tardia e snapshot de lousa aprovados. |
| Lousa E2E | Abrir, desenhar, fechar e reabrir em Room e Streamer aprovados. |
| Ferramentas da sala E2E | Enquete, identidade de voto, autorização de encerramento, anotações em duas transmissões, remoção automática, PiP e descarte aprovados. |
| Controles E2E | Quatro participantes, inputs isolados, checklist, quatro modelos WebGL, layout móvel, retomada do Co-op e fluxo Room aprovados. |
| Build | `dist` gerado com sucesso. |
| Diff | `git diff --check` sem erros de whitespace. |

Logs desta rodada: `output/deeper-audit-2026-10-07-vitest-final.log`, `output/deeper-audit-2026-10-07-rust.log`, `output/deeper-audit-2026-10-07-python.log`, `output/deeper-audit-2026-10-07-sessions.log`, `output/deeper-audit-2026-10-07-whiteboard.log`, `output/deeper-audit-2026-10-07-room-tools.log`, `output/deeper-audit-2026-10-07-controller-lab.log` e `output/deeper-audit-2026-10-07-build.log`.

## Limites

Os testes de navegador usam mídia e gamepads sintéticos sobre WebRTC real. Document PiP usa uma janela simulada. A validação não substitui testes com jogos, microfones e controles físicos, instalações Windows distintas, todos os encoders/GPU nem TURN entre redes diferentes. Os três testes Rust ignorados permanecem sem execução. A revisão e os testes confirmam as correções descritas, sem garantir ausência de qualquer outro bug.
