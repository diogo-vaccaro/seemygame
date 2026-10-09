# Novos achados — 09/10/2026

Revisão do HEAD `942ff1f` com as correções locais autorizadas na rodada anterior já presentes. Essas alterações foram preservadas. A análise procurou falhas adicionais em publicação assíncrona, autoridade de mensagens de notas e atualização da topologia LAN.

Foram reproduzidos três novos defeitos. Nenhuma implementação foi modificada nesta rodada.

## F01 — P2 — Publicação pendente recria sala encerrada e deixa timer ativo

Local: `js/directory/room-publisher.js:56–60`, em conjunto com `stop():147–170`.

start aguarda o primeiro heartbeat e depois cria o timer incondicionalmente. stop marca o publicador inativo, remove o timer existente e envia DELETE, mas não aguarda nem invalida o POST pendente. Se o POST chegar depois do DELETE, ele registra novamente a sala já encerrada. Quando start retoma, também recria o intervalo, mesmo com isActive=false.

Reprodução: fetch foi controlado para reter somente o POST; DELETE foi processado pelo handler real primeiro, com lista vazia. Depois de liberar o POST, o handler real publicou a sala. O estado final foi `active=false`, `timerAfterStop=true`, `roomsAfterStop=1`. A listagem pode permanecer até o TTL de 90 segundos, pois o publicador está inativo.

Correção indicada: controlar a geração das operações start/stop, criar o timer somente para uma execução ainda vigente e garantir limpeza após a conclusão de publicações pendentes. Cancelar somente a espera do cliente não garante que um POST já recebido pelo servidor seja desfeito.

## F02 — P2 — Participante pode forjar snapshot e travar a sincronização das notas

Local: `js/room/notepad.js:180–187`; integração em `js/room/room-tools.js:115–117`.

NOTE_SYNC aceita qualquer origem e confia na versão recebida. O parâmetro senderPeerId é recebido pela integração, mas não é usado para conferir que o snapshot veio do coordenador. Uma versão futura forjada faz snapshots legítimos de versões menores serem descartados.

Reprodução E2E com três clientes Chrome realmente admitidos na mesma sala e DataChannels PeerJS/WebRTC reais: host escreve a nota original; um convidado envia diretamente ao terceiro participante `NOTE_SYNC` com texto forjado, versão 1000000 e autor declarado Host. Depois, o host escreve a próxima revisão legítima. Host e convidado ficam na versão 2; o terceiro mantém texto forjado e versão 1000000. Não houve erro JavaScript nas páginas.

O participante já possui direito de editar via NOTE_UPDATE. O defeito adicional é assumir a autoridade de snapshot e interromper as atualizações do host para outro cliente.

Correção indicada: verificar o coordenador pela identidade do transporte, rejeitar NOTE_SYNC de outras origens e validar o domínio de versões antes de alterar o estado. Atualizar o coordenador confiável quando o papel da sala mudar.

## F03 — P2 — Reclassificar um peer como LAN não remove o relay

Local: `js/relay.js:202–213`.

registerViewer aplica a exceção LAN somente na alocação inicial. updateTelemetry altera isLan e emite notificação de topologia, mas preserva role, parentPeerId e os conjuntos children. Portanto, reconhecer depois uma rota LAN não promove o peer para conexão direta. O callback da integração em `js/app/capture-session.js:177–180` apenas registra a topologia no console.

Reprodução com RelayManager real: cota de um direto; primeiro peer WAN direto; segundo peer registrado antes de conhecer a rota é delegado ao WAN. Após telemetria explícita `isLan=true`, `isRelay=false`, `rtt=2`, ele mantém `role=relay`, `parent=wan`. Como controle positivo, um terceiro peer registrado já como LAN recebe `role=direct`, `parentPeerId=host`.

Correção indicada: reconciliar a árvore quando a classificação mudar, atualizar relações pai/filho e acionar a sinalização e substituição das conexões necessárias. A notificação de topologia isolada não altera a rota de mídia.

## Evidências e verificações

- [Script de reprodução](audit-2026-10-09-probes.mjs).
- [Resultado das três reproduções](../output/audit-2026-10-09-probes.json), status `three-new-defects-reproduced`, sem erros nas páginas.
- [Log das reproduções](../output/audit-2026-10-09-probes.log).
- [Testes relacionados](../output/audit-2026-10-09-targeted.log): 67 testes aprovados em cinco arquivos, incluindo regressões da rodada anterior, notas, diretório, relay e LAN.
- `git diff --check`: sem erros.

Os probes afirmam os comportamentos defeituosos; exit code zero comprova a reprodução e não a correção. Uma tentativa inicial usou uma versão fora do domínio de inteiros aceito pelo PeerJS e falhou na serialização; a execução final usa 1000000 e confirma o problema pela conexão real.

Limites: corrida de publicação reproduzida com transporte controlado e handler real em memória; autoridade de notas reproduzida em Chrome com sinalização local; reclassificação LAN reproduzida no gerenciador real, sem uma rede física entre máquinas. Não foram executados E2E Tauri ou Redis de produção. A suíte completa de 1.626 testes já havia passado na rodada de correções anterior; nesta rodada foram executadas somente as 67 verificações relacionadas e os novos probes.

Arquivos adicionados nesta rodada: este relatório e `docs/audit-2026-10-09-probes.mjs`. As quatro correções locais anteriores permanecem intactas.
