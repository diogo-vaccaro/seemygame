# Correção dos três novos achados — 09/10/2026

As correções locais da rodada anterior foram preservadas. Referência: [novos achados](novos-achados-2026-10-09.md).

## Alterações

- **F01 — publicação:** RoomPublisher acompanha os heartbeats pendentes. stop invalida a geração atual, cancela o intervalo e aguarda esses pedidos antes de excluir a sala. Uma chamada start antiga não pode recriar o timer; um novo start aguarda a exclusão anterior para evitar que ela remova a publicação nova. A regressão também cobre heartbeat periódico pendente e reinício concorrente.
- **F02 — notas:** NOTE_SYNC exige a identidade do coordenador obtida do RoomManager, consultada dinamicamente. Snapshots de outros participantes e versões inválidas são ignorados; o host não recebe snapshots remotos. Uma mudança legítima de coordenador estabelece uma nova referência de versão. A edição colaborativa por NOTE_UPDATE permanece disponível.
- **F03 — relay:** updateTelemetry promove um peer reconhecido como LAN para direto e atualiza os conjuntos de filhos dos dois pais. Ao voltar para WAN com a cota ocupada, ele é delegado novamente. onRouteChange conecta essa reconciliação à integração de mídia: informa o upstream ao espectador, interrompe o relay anterior e inicia a conexão direta ou solicita o novo encaminhamento. O recebimento aceita a troca legítima de upstream e protege a nova chamada de eventos de fechamento da chamada antiga. Mensagens de alteração de upstream/encaminhamento exigem que o remetente seja o host indicado.

## Validação

| Verificação | Resultado | Evidência |
| --- | --- | --- |
| Regressões novas + suítes existentes de notas, relay, diretório e LAN | 66 testes aprovados antes da adição do teste de sinalização | [Log](../output/fixes-2026-10-09-targeted.log) |
| Integração de sinalização, chamadas duplicadas, PIN e canais | 57 testes aprovados | [Log](../output/fixes-2026-10-09-integration.log) |
| npm run verify — execução final | 1.642 testes / 170 arquivos aprovados; módulos, HTML, CSS, smoke ESM e build aprovados | [Log](../output/fixes-2026-10-09-verify-final.log) |
| Revalidação dos três cenários originais | Todos corrigidos | [Resultado](../output/fixes-2026-10-09-probes.json), [script](fixes-2026-10-09-probes.mjs) |
| E2E diretório protegido | Aprovado, inclusive despublicação ao fechar o host | [Evidência](../output/playwright/rooms-directory-adversarial-1791549712054/evidence.json) |
| E2E ferramentas prioritárias | Aprovado, inclusive notas bidirecionais, layouts e reações | [Evidência](../output/playwright/prioritized-tools-1791549749392/evidence.json) |
| git diff --check | Sem erros | Há avisos de conversão LF/CRLF do Git no Windows |

A revalidação registra publicador inativo sem timer e zero salas após parar durante o POST; peer LAN direto sob o host; e host/convidados na revisão legítima 2 após rejeição do snapshot forjado. O ataque às notas foi enviado por DataChannel real entre três participantes admitidos.

Os 16 testes novos estão em `tests/oct09-fixes-regression.test.js`. O teste existente de notas passou a fornecer a identidade de transporte do coordenador.

A primeira execução completa detectou uma regressão introduzida na checagem de chamadas duplicadas e um timeout de teste de DOM. A checagem foi corrigida, os testes afetados foram executados novamente e a execução final completa passou. O log final acima é o resultado válido da implementação entregue.

Limites: Chrome com sinalização local e dispositivos sintéticos. A corrida de publicação usa transporte controlado com handler real. A árvore e seus sinais de troca são validados por regressões instrumentadas; não foi homologada uma migração de mídia entre máquinas físicas LAN/WAN. Não foram executados E2E pela janela Tauri nem Redis de produção. Não houve alterações no código Rust.
