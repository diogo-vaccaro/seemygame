# Correção das pendências da sala — 09/10/2026

Referência: [revisão anterior](revisao-novas-adicoes-2026-10-09.md), HEAD de origem `d24c295`. Os arquivos da revisão anterior foram preservados. As alterações permanecem locais, sem commit, push ou deploy.

## Alterações

- **R01 — Publicação encerrada:** cada início do RoomPublisher recebe um `publicationId`. Heartbeats carregam esse identificador e o instante de envio; exclusão normal e beacon carregam a mesma geração. API em memória e scripts Lua atômicos Redis registram a geração encerrada durante 180 segundos. POSTs dessa geração são recusados, inclusive quando a exclusão chegou antes do primeiro POST. Pedidos com mais de 90 segundos são rejeitados; Redis também verifica o prazo no instante da escrita, evitando que uma chamada atrasada ultrapasse a duração da marca de encerramento. Exclusões antigas não apagam uma publicação nova. O unload invalida a geração local e para o timer; beacon recusado usa fallback keepalive.
- **R02 — Notas:** participantes não coordenadores ignoram `NOTE_UPDATE` recebido. O coordenador continua aceitando propostas e distribuindo `NOTE_SYNC` com versão oficial; convidados mantêm edição local otimista e recebem a confirmação autoritativa. A guarda existente de identidade/versão do snapshot permanece.
- **R03 — Relay na sessão atual:** novo `RoomRelayTransport` pertence à factory de sessão da sala. Integra alocação de upstream, delegação de chamadas, sinalização autenticada, encaminhamento por origem/destino, promoção LAN, retorno WAN e failover. A identidade da origem é preservada em cartões, gravação e streams, mesmo quando a chamada chega por outro participante. Pedidos de encaminhamento aguardam o stream quando necessário. Conexões e timers são descartados com a sessão. A rota de quem recebe por relay é reavaliada pelos stats da conexão de dados admitida com a origem, pois nesse momento não há vídeo direto para medir.

O provider nativo mantém seu transporte direto existente; a árvore integrada cobre mídia PeerJS do navegador. A cota padrão atual da sala continua sendo oito conexões diretas. O E2E reduz essa cota para uma para exercitar a árvore com três participantes.

## Validação

- Novas regressões: 11 casos em [room-additions-final-fixes.test.js](../tests/room-additions-final-fixes.test.js), cobrindo POST tardio, reinício, exclusão antiga, propriedade, beacon recusado, autoridade das notas e ciclo de mídia relay.
- `npm run verify`: aprovado, **1.653 testes / 171 arquivos**, módulos, HTML, CSS, smoke ESM e build. A execução anterior detectou ausência de descarte das trilhas antigas na troca de chamada; o descarte foi corrigido e a execução completa seguinte passou.
- Após reforçar também o prazo de escrita no script Redis, as quatro suítes de diretório/regressões foram reexecutadas: **57 testes aprovados**.
- `node docs/final-room-additions-fixes-probes.mjs`: três correções confirmadas; zero salas após POST atrasado, notas iguais e callback de rota instalado na página atual. [Resultado](../output/final-room-additions-fixes-probes.json).
- `node tests/e2e-prioritized-tools.mjs`: aprovado, incluindo edição bidirecional de notas, layout, replay e reações.
- `node tests/e2e-rooms-directory-adversarial.mjs`: aprovado, incluindo PIN, contagem de membros e despublicação no fechamento.
- [Novo E2E de migração](../tests/e2e-room-relay-migration.mjs): aprovado com vídeo e DataChannels WebRTC reais. Exercita WAN por relay → LAN direto → WAN por relay → saída do relay com fallback direto. A última execução ocorreu após corrigir o descarte das trilhas antigas.

Limites: Chrome local e mídia sintética; a classificação LAN/WAN é controlada no novo E2E para forçar transições. O transporte e a recepção de vídeo são reais. Não houve homologação Tauri, Redis de produção ou redes físicas distintas. Nenhum código Rust foi alterado. Clientes com relógio fora da tolerância do servidor podem ter heartbeats versionados recusados; o protocolo permite até 30 segundos de avanço e exige envio dentro de 90 segundos.

O script da revisão anterior conserva as asserções que reproduziam defeitos e deixa de passar com as correções. Para revalidar o comportamento correto, use `docs/final-room-additions-fixes-probes.mjs`.
