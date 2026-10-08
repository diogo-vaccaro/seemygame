# Verificação extensa — 7 de outubro de 2026

## Escopo e resultado

Mapeamento e validação do grafo completo de módulos autorais, HTML gerado, CSS e imports sem efeitos de inicialização. Revisão de código focada em ciclo de vida, mensagens, admissão, armazenamento, voz, gravação e endpoint TURN. Execução de toda a suíte JavaScript, da biblioteca Rust e dos testes Python, além de fluxos reais no navegador com sinalização local.

As alterações locais que já existiam no início da revisão foram preservadas. Este relatório descreve as correções acrescentadas nesta rodada, sem atribuir a ela os trabalhos anteriores de controles, anotações, enquetes e outras ferramentas da sala.

## Correções acrescentadas

| Área | Bug e comportamento corrigido |
| --- | --- |
| Eventos | Uma emissão recursiva podia consumir um listener `once` e a emissão externa executá-lo novamente. A remoção passa a identificar a inscrição exata, antes da chamada. |
| Inscrições | Desinscrever um callback registrado mais de uma vez podia remover outra inscrição. As funções de desinscrição do barramento e dispatcher agora removem a entrada que criaram. |
| Mensagens | Um handler que removia sua própria inscrição alterava o array em uso e fazia o próximo handler ser pulado. O despacho usa uma cópia estável. |
| Plugins | Registro com nome repetido podia perder a referência ao proprietário de recursos. Uma instância diferente com o mesmo nome é rejeitada. |
| Plugins | `initAll` podia repetir a inicialização de um plugin já pertencente ao manager. Instâncias ativas são ignoradas. |
| Plugins | Encerramento individual assíncrono podia produzir rejeição não tratada. O manager retorna e contém a Promise, emitindo o erro no barramento. |
| Plugins | Encerramento recursivo durante um callback podia repetir milhares de destruições até esgotar a pilha. O conjunto de plugins é retirado do manager antes dos callbacks. |
| Armazenamento | Falhas de acesso a preferências interrompiam serviços de voz, nomes de participantes, montagem da sala, cartões de vídeo, replay e conexão do Companion. Leituras opcionais agora têm fallback. |
| Identidade | `sessionStorage` indisponível impedia gerar a identidade de sessão. Um ID pode ser gerado mesmo quando não é possível persistir. |
| PIN | Persistência indisponível fazia operações de PIN do Streamer lançarem erro. A regra de admissão em memória continua operante. |
| Voz | O elemento silencioso que mantinha o decoder remoto ativo permanecia no DOM depois de sair da voz. Agora é pausado, desvinculado e removido. |
| Voz | Fontes e analisadores VAD remotos não tinham dono explícito para desconexão. São registrados e liberados ao remover o participante ou sair da chamada. |
| Voz | Reiniciar o VAD local podia deixar a análise anterior e seu timer vivos. A análise anterior é encerrada antes de instalar a nova. |
| Replay | Remover trilha sem mixer alterava a topologia do MediaRecorder ativo; remover vídeo com mixer nem atualizava a topologia isolada. O recorder agora é reconstruído a partir do stream atual. |
| Replay | Uma falha ao recriar o encoder deixava o estado indicando gravação ativa. A reconstrução usa o caminho comum de início, que limpa os recursos e registra a falha. Eventos do recorder anterior são descartados. |
| TURN | Credenciais estáticas e JSON ignoravam a autenticação aplicada ao provedor privado. Todas as fontes privadas exigem o token configurado em produção. |
| TURN | Cache HTTP compartilhado podia reutilizar respostas com credenciais sem executar as verificações da função. As respostas usam `private, no-store`. |
| TURN | O fallback da API em produção entregava credenciais embutidas, contrariando o fallback STUN do cliente e o contrato documentado. Agora entrega somente STUN público quando não há uma fonte privada disponível. |
| Admissão | Atualização de membro existente executava `.trim()` em nomes sem validar o tipo. Um nome malformado é ignorado. |

## Evidências de validação

| Verificação | Resultado |
| --- | --- |
| Grafo de módulos | 188 módulos autorais; 468 imports/exports validados. |
| Importação ESM | 182 módulos importados sem iniciar rede, áudio, timers ou listeners de página. |
| HTML e CSS | Parciais HTML consistentes; imports CSS resolvidos na ordem da cascata. |
| JavaScript completo | **1.481 testes aprovados, zero falhas, 151 arquivos de teste**; execução com dois workers e acesso ao servidor local. |
| Rust completo | **67 aprovados, zero falhas, 3 ignorados**; inclui pipelines GStreamer, WebRTC e replay H.264/Opus por RTP local. |
| Companion Python | **10 aprovados**, com drivers sintéticos e sem injeção de entradas no Windows. |
| E2E de sessões | PIN rejeitado/aceito; vídeo decodificado; chat e identidade preservada no relay; três membros na sala; entrada tardia; snapshot grande de lousa e ordem de camadas. |
| E2E de lousa | Abertura, desenho, fechamento e reabertura em Room e Streamer. |
| E2E de ferramentas da sala | Enquete para participante tardio, identidade de voto, autorização do encerramento, anotações em duas transmissões, remoção automática, descarte PiP e limpeza da sessão. |
| E2E de controles | Quatro participantes, inputs isolados, checklist sincronizado, quatro modelos WebGL, layout móvel, retomada do Co-op e encerramento na sala. |
| Build | `dist` gerado com sucesso. |
| Diff | `git diff --check` sem erros de whitespace. |

Novas regressões: `tests/extensive-audit-2026-10-07.test.js` e `tests/audit-replay-topology.test.js` (17 casos no total). Os testes reproduziram os problemas de eventos, plugins, armazenamento, TURN e topologia do replay antes das respectivas correções.

Logs e dados completos ficam em `output/audit-2026-10-07-complete-vitest.json`, `output/audit-2026-10-07-complete-vitest.log`, `output/audit-2026-10-07-native-final.log`, `output/audit-2026-10-07-sessions.log`, `output/audit-2026-10-07-whiteboard.log`, `output/audit-2026-10-07-room-tools.log` e `output/audit-2026-10-07-controller-lab.log`.

## Limites e configuração

Os E2E usam captura, microfones e gamepads sintéticos; a mídia e os DataChannels WebRTC são reais. O cenário de Document PiP usa uma janela simulada. A aprovação local não substitui ensaios com jogos, microfones e controles físicos, captura em Windows limpo ou TURN entre redes distintas. Os três testes Rust ignorados não foram executados.

No sandbox houve bloqueio de rede em `127.0.0.1` e de tráfego RTP local, além de uma rodada com timeout na inicialização de workers. As validações finais foram concluídas com acesso local permitido e dois workers JavaScript. Não foram removidas as verificações que inicialmente falharam.

Em produção, fontes TURN privadas — inclusive `TURN_SERVERS_JSON` e `TURN_USERNAME`/`TURN_PASSWORD` — precisam de `TURN_ACCESS_TOKEN` e do token correspondente no cliente, conforme o contrato existente no README. Sem fonte privada, o fallback público contém somente STUN.
