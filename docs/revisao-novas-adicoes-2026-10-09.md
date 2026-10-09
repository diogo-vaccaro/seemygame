# Revisão das novas adições — 09/10/2026

Referência: HEAD `d24c295`, comparado com `8ab70c3`, último commit avaliado nesta conversa. Seis commits novos, checkout inicialmente limpo. Não foram modificados arquivos da implementação nem sincronizados remotos nesta revisão.

As correções recentes melhoram autorização atômica do diretório, propagação de falhas Redis, contagem de membros, adaptação de bitrate, ciclo de publicação, autoridade de snapshots e reconciliação da árvore. Os cenários originais corrigidos foram reexecutados com sucesso. Foram encontradas três pendências adicionais.

## R01 — P2 — POST atrasado pode republicar sala após despublicação no unload

Local: `js/directory/room-publisher.js:127–150`.

`stop()` aguarda heartbeats antes do DELETE, mas `_handleUnload()` chama diretamente `unpublishSync()`. O beacon/DELETE não participa desse ordenamento. Quando uma publicação já enviada chega ao servidor depois da exclusão, a sala reaparece até o TTL ou uma limpeza posterior. Uma página fechada não garante a execução de continuations JavaScript necessárias para outro DELETE.

Reprodução controlada com o handler real em memória: reter POST, executar `_handleUnload()`, processar beacon de exclusão, confirmar diretório vazio e liberar POST. Resultado: `roomsAfterLatePost=1`. O objeto ainda apresentou `active=true` e timer, mas isso não é prova de vazamento de timer após destruir uma aba: a evidência relevante é a republicação no servidor. O E2E de fechamento normal passou; ele não força essa ordem adversa.

Correção sugerida: distinguir gerações de publicação no servidor e invalidar uma geração encerrada, para impedir que heartbeats atrasados a recriem. Invalidação apenas no cliente não desfaz pedidos já recebidos pelo servidor.

## R02 — P2 — NOTE_UPDATE contorna a autoridade do snapshot nos convidados

Local: `js/room/notepad.js:166–170`.

`NOTE_SYNC` agora confere coordenador e versão, mas o ramo `NOTE_UPDATE` continua substituindo o texto de um convidado sem passar pela revisão do coordenador. A sala envia mensagens por conexões distintas: uma edição antiga de outro membro pode chegar depois de um snapshot mais recente do host e sobrescrever esse texto sem incrementar a versão. Sem outro snapshot, os participantes ficam divergentes.

Reprodução em Chrome, três participantes admitidos e DataChannel real: todos recebem a nota do host; um convidado envia `NOTE_UPDATE` diretamente ao terceiro. Host mantém `Authoritative note`; terceiro passa a `Non-authoritative stale edit`. O host não recebe essa mensagem seletiva, e portanto não envia snapshot corretivo. A reprodução demonstra que a guarda do snapshot não torna as atualizações autoritativas.

Correção sugerida: convidados enviam propostas ao coordenador; somente o coordenador aplica `NOTE_UPDATE` e publica `NOTE_SYNC`. Outros convidados mantêm seu texto remoto pela revisão oficial. A edição local pode continuar otimista, com reconciliação explícita.

## R03 — P2 — Migração de mídia LAN/relay não está integrada à página atual de sala

Local: `js/session/room-session.js:229–232`; fluxo de envio em `sendRoomStream()`, linha 650.

O commit de migração instala `onRouteChange` em `js/app/capture-session.js`, runtime de compatibilidade. A página atual monta `createRoomSession()` por `js/entries/room-entry.js` e cria outro `RelayManager`, sem esse callback. `sendRoomStream()` inicia uma chamada direta por membro e não usa o resultado de `registerViewer()` para delegar mídia. A topologia do manager pode mudar sem substituir as chamadas desse fluxo.

Confirmação no navegador da sala real: `typeof roomState.relayManager.onRouteChange === 'function'` retorna falso. Inspeção do envio confirma a ausência da delegação. Isso é uma lacuna de integração, não uma falha na transição unitária do RelayManager, que passou nos probes originais. Não foi ensaiada migração de mídia em rede física.

Correção sugerida: conectar alocação, reconciliação, sinalização e recebimento à factory de sessão usada pela página, incluindo cobertura de chamadas efetivamente substituídas.

## Validação desta revisão

- Módulos: 193 módulos autorais / 475 imports e exports validados.
- HTML, CSS e smoke ESM aprovados (187 módulos sem efeitos de inicialização).
- Suíte completa: 1.641 aprovados / 1 falha de ambiente, entre 1.642 testes de 170 arquivos. Falha: conexão localhost bloqueada (`EACCES`) no teste A14/A15.
- Reexecução do arquivo afetado com acesso localhost: 16/16 aprovados. Todos os casos da suíte foram aprovados entre a execução completa e essa reexecução; não houve uma segunda execução integral.
- `npm run build:dist`: aprovado, executado separadamente porque a primeira sequência `verify` parou no teste bloqueado.
- `node docs/fixes-2026-10-09-probes.mjs`: aprovado; cenários originais de publicação, snapshots e topologia corrigidos, sem erros nas páginas.
- `node tests/e2e-prioritized-tools.mjs`: aprovado, seis grupos de ferramentas.
- `node tests/e2e-rooms-directory-adversarial.mjs`: aprovado, incluindo PIN, renderização, contagem de membros e fechamento normal.
- [Novos probes](review-additions-2026-10-09-probes.mjs): três pendências reproduzidas, sem erros JavaScript nas páginas. Saída zero confirma a reprodução das pendências, não sua correção.
- [Resultado dos probes](../output/review-additions-2026-10-09-probes.json).

Limites: Chrome com sinalização local e mídia sintética; corrida do unload com transporte controlado e handler real em memória. Redis de produção, Tauri e migração de mídia entre máquinas LAN/WAN não foram homologados. Nenhum código Rust mudou nos seis commits avaliados.
