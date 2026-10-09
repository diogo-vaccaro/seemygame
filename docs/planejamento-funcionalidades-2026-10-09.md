# Plano de implementação das próximas funcionalidades

Data: 09/10/2026. Base: código local do SeeMyGame, HEAD `d24c295`, incluindo as correções locais de publicação, notas e relay descritas em [correção das pendências](correcao-pendencias-sala-2026-10-09.md). Este documento propõe trabalho futuro; não representa funcionalidades implementadas nem autorização para publicação.

## 1. Recomendação e premissas

Implementar primeiro snippets, checklist e fila de fala visual. Em seguida, qualidade automática no navegador e Watch Together para vídeos gravados. Essas entregas aproveitam a sala atual e permitem avaliar uso real antes de construir uma plataforma persistente.

Construir contas, autorização e banco durável antes de grupos permanentes, workshop comunitário e insígnias. Implementar o bot Discord em duas etapas: comando explícito para criar convite e, depois, automação por canal de voz. O mapa pode aproveitar o diretório existente, mas sua prioridade deve depender de haver salas públicas suficientes para tornar descoberta útil.

Tratar transcrição local completa e qualidade por tile no desktop como frentes de investigação e homologação próprias: competem por CPU/GPU com captura e codificação, e não são simples extensões de UI.

Premissas de produto:

- A sala continua funcionando sem conta para sessões casuais. Conta passa a ser exigida para propriedade de grupos, publicação comunitária e conquistas persistentes.
- Ferramentas de sala são temporárias por padrão. Exportação é explícita; persistência em grupo depende de uma ação autorizada e de política de retenção.
- Espectador somente-leitura pode ver ferramentas permitidas, mas não editar, comandar reprodução ou pedir a palavra. Para interagir, precisa ingressar como participante.
- O host coordena o estado temporário. Não adicionar eleição automática de novo host ao primeiro pacote; quando o coordenador sair, interromper escritas e explicar a situação. Migração futura exige protocolo e admissão próprios.
- Orçamentos abaixo são estimativas de dias úteis de uma pessoa experiente, incluindo testes e revisão técnica. São intervalos de planejamento, não datas prometidas. Infraestrutura, homologação física e mudanças de escopo podem ampliá-los.

## 2. O que já existe e como reutilizar

| Base atual | Uso no plano | Limite que deve ser respeitado |
| --- | --- | --- |
| Factories de sessão, plugins e descarte de recursos | Criar cada ferramenta como instância pertencente à sessão | Não criar estado global nem inicializar serviços ao importar módulos |
| Admissão, PIN, identidade da conexão e envelopes P2P | Validar mensagens de ferramentas antes de alterar estado | Nome exibido e `senderPeerId` informado pelo payload não substituem a conexão autenticada |
| Notepad e snapshots oficiais do coordenador | Referência para proposta → confirmação → snapshot | Não copiar cegamente o singleton existente ou aceitar atualização direta de outro convidado |
| Grade, foco, cinema e relay de mídia do navegador | Medir demanda de resolução e propagá-la pela árvore | Relay integrado recentemente precisa permanecer coberto por regressões |
| ABR, perfis manuais e mutações serializadas de sender | Integrar política de qualidade por tile | A serialização evita corrida de escrita, mas não resolve conflito de políticas sozinha |
| Voz e streams separados por participante | Fila de fala e identificação de locutor | Receber um stream não concede autorização para gravar ou transcrever sua voz |
| Diretório público com publicação temporária | Mapa e descoberta | TTL de presença e Redis/memória atuais não constituem banco de usuários ou grupos |
| Tema claro/escuro | Primeiro catálogo de temas oficiais | Ainda falta um contrato de tokens para temas comunitários |
| Vitest e harness E2E WebRTC | Testar concorrência, autorização e mídia real | Chrome local com mídia sintética não substitui Tauri e redes físicas |

A sala atualmente limita membros a 16 e mensagens a 256 KiB. As novas ferramentas devem usar limites menores por entidade e snapshots paginados quando necessário, sem aumentar indiscriminadamente o teto do transporte.

## 3. Fundação comum das ferramentas de sala

### Contrato proposto

Criar um serviço de estado compartilhado por sessão em `js/room/tools/` e plugins de integração em `js/plugins/`. Os nomes de arquivos, mensagens e endpoints neste plano são propostas; devem ser ajustados às convenções do protocolo durante a implementação.

Fluxo de alteração:

1. Participante envia proposta ao coordenador com `feature`, `opId`, `entityId`, `baseRevision` e payload validado.
2. Coordenador obtém o autor pela conexão admitida, verifica capacidades, tamanho e frequência, e aplica a operação.
3. Coordenador publica confirmação com `revision` crescente e identidade oficial do autor. Operações repetidas recebem o mesmo resultado.
4. Cliente confirma a edição otimista. Se a revisão-base estiver obsoleta, recebe conflito ou snapshot e preserva seu rascunho.
5. Entrada tardia e reconexão solicitam snapshot. Lacunas de revisão interrompem aplicação incremental até ressincronização.

Associar revisões a `roomEpoch`, para que revisões de outra sessão da mesma sala não sejam aceitas. Manter deduplicação limitada em memória, prazos de confirmação e retries limitados. Não reenviar indefinidamente operações depois de descarte da sessão.

No MVP, estado é ordenado pelo coordenador. CRDT só entra se edição simultânea livre ou trabalho offline se tornarem requisitos medidos. Para snippets, usar edição com responsável temporário e rascunho local; para tarefas, operações por campo e revisão; para mãos, fila exclusivamente ordenada pelo host.

### Capacidades e limites

Definir capacidades explícitas, por exemplo `tools.read`, `snippets.edit`, `tasks.edit`, `hands.request`, `hands.manage`, `watch.control` e `transcript.share`. O coordenador valida propostas e os receptores validam a autoridade dos snapshots. A UI apresenta as mesmas capacidades, mas a proteção permanece no protocolo.

Separar concessão de fala, permissão de editar e permissão de operar mídia. Um moderador de voz não precisa administrar temas ou grupos.

Definir limites iniciais configuráveis: snippets até 64 KiB cada e orçamento agregado de 128 KiB; tarefas até 100 por sala; títulos até 160 caracteres; descrições até 2 KiB; transcrição distribuída incrementalmente e sem snapshot ilimitado. Reservar espaço para envelopes e testar o tamanho serializado antes de transmitir. Paginar snapshots maiores e dar prioridade a mensagens de admissão e controle de mídia.

### Entregáveis de fundação

- Serviço de propostas, revisão, confirmação, ressincronização e capacidades, sem impor uma reescrita geral do protocolo existente.
- Negociação de versões/capacidades: cliente antigo ignora ferramentas desconhecidas sem perder chat, voz ou vídeo.
- Flags independentes por recurso, métricas de rejeição/conflito e limpeza de listeners, timers, workers e DOM.
- Painel de ferramentas com estado vazio, aviso de perda de conexão e navegação por teclado; templates editados na origem e páginas geradas pelo build.
- Testes de dois convidados concorrentes, entrada tardia, duplicatas, payload malformado, cliente somente-leitura e saída durante operação pendente.

Estimativa: **5–8 dias**. Concluir e homologar as correções locais existentes antes de promover as primeiras novas funcionalidades.

## 4. Snippets de código

**Valor:** compartilhar configurações, binds e pequenos scripts sem misturá-los ao chat. Prioridade alta; risco moderado.

**MVP:** lista de snippets com título, linguagem, conteúdo, autor e revisão; copiar, baixar como texto e excluir conforme permissão. Highlight carregado sob demanda, preservando modo texto se a dependência falhar. Não executar código nem HTML.

**Colaboração:** qualquer participante autorizado cria um snippet; um editor por snippet mantém uma licença temporária concedida pelo coordenador. A licença expira se o editor sair ou perder heartbeat. Outro usuário solicita edição ou duplica o snippet. Ao perder a licença, o rascunho fica recuperável localmente e não sobrescreve a revisão oficial.

**Modelo:** `{ id, title, language, content, authorPeerId, revision, editorPeerId, leaseExpiresAt }`. Duração da licença usa referência do coordenador; reconexão exige nova validação. Não usar relógio arbitrário do cliente para decidir propriedade.

**Implementação:** `js/room/tools/snippets.js`, plugin, UI em `js/ui/room-tools/` e testes. Validar linguagem em allowlist; renderizar conteúdo como texto; imports/exports com tamanho e encoding controlados. Escolher biblioteca de editor após protótipo de peso, acessibilidade e compatibilidade com CSP/Tauri.

**Aceite:** dois participantes veem a mesma revisão; disputa de edição não apaga texto; saída libera licença; entrada tardia recebe todos os snippets dentro do orçamento; código malicioso é exibido literalmente; espectador não escreve.

**Evolução:** editor com busca e numeração de linhas, histórico limitado e edição simultânea com CRDT, se houver demanda. Não incluir execução de scripts no roadmap inicial.

Estimativa do MVP: **4–7 dias**, após a fundação.

## 5. Checklist colaborativo

**Valor:** organizar objetivos, etapas de configuração e tarefas de co-op. Prioridade alta; risco baixo a moderado.

**MVP:** criar tarefa, editar título, atribuir a participante, prioridade baixa/normal/alta, marcar concluída e excluir; filtros por responsável e pendentes. Evitar kanban completo inicialmente.

**Modelo:** `{ id, title, description, assigneePeerId, priority, completed, order, createdBy, revision }`. Identidade temporária é `peerId`; a saída de um participante mantém a tarefa e mostra responsável indisponível. Em grupo permanente, migrar explicitamente a atribuição para `userId` quando houver vínculo confirmado.

**Concorrência:** operações `create`, `setField`, `complete`, `delete` e `reorder` confirmadas pelo coordenador. Mudanças em campos distintos podem ser mescladas; alteração do mesmo campo sobre revisão obsoleta retorna conflito. Exclusão usa tombstone limitada para impedir que uma operação atrasada recrie a tarefa.

**Implementação:** `js/room/tools/tasks.js`, plugin e painel. Eventos agregados de conclusão podem alimentar uma futura integração com grupos, mas não gerar insígnias confiáveis a partir de declarações P2P.

**Aceite:** conclusão simultânea é idempotente; edição tardia não ressuscita tarefa excluída; responsável desconectado fica visível; filtros não alteram estado compartilhado; snapshots e somente-leitura são verificados com três participantes.

**Evolução:** templates de checklist, datas e persistência em grupo. Datas e notificações exigem discussão de produto separada.

Estimativa: **5–8 dias**.

## 6. Levantar a mão e fila de fala

**Valor:** útil em salas moderadas; menor benefício em grupos pequenos. Prioridade alta para o indicador visual e média para moderação efetiva de áudio.

**MVP visual:** pedir a palavra, cancelar pedido, fila ordenada pelo coordenador, conceder/revogar vez e avançar para o próximo. Indicador no cartão e ação acessível por teclado. Uma entrada por participante, sem repetição de notificações.

**Modelo:** `{ queue: [{ peerId, sequence }], currentSpeakerPeerId, revision, policy }`. Ordem vem de sequência oficial, não de timestamps enviados pelos convidados. Saída remove pedido e encerra a vez do participante.

**Etapa moderada:** opção explícita de sala que autoriza voz apenas ao host/moderadores e ao participante com a vez. Implementar bloqueio no mixer/playback de cada receptor e nos encaminhamentos pertinentes; ocultar botão ou mutar apenas o cliente emissor não garante moderação. Concessão nunca liga remotamente um microfone sem ação/consentimento local. A versão visual deve ser rotulada sem prometer bloqueio de voz.

**Implementação:** manager em `js/room/tools/hands.js`; integrar capacidades e `room-voice-state`, UI dos participantes e política de reprodução de voz. Reavaliar permissões em reconexão e troca de função.

**Aceite:** pedidos simultâneos convergem para a mesma ordem; convidado não concede vez a si próprio; saída e revogação atualizam todos; microfone desligado continua desligado ao receber a vez. Para etapa moderada, voz sem vez não chega à saída audível do cliente oficial, inclusive no caminho relay.

**Limite:** clientes modificados não oferecem garantias absolutas de silêncio sobre mídia já recebida; endurecimento pode exigir impedir envio/encaminhamento a destinos não autorizados. Documentar o modelo de ameaça antes de tratar a sala como ambiente confidencial.

Estimativas: visual **3–5 dias**; moderação de áudio **mais 5–8 dias**.

## 7. Watch Together

**Valor:** assistir vídeos, replays e tutoriais em conjunto. Prioridade média/alta; risco de compatibilidade entre provedores.

**MVP:** YouTube gravado e URL HTTPS de MP4 acessível por todos. Host controla carregar, play, pause e seek; pode delegar controle. Volume e mute são locais. Espectador somente-leitura acompanha sem emitir comandos.

**Arquitetura:** adaptadores `load`, `play`, `pause`, `seek`, `getTime`, `getCapabilities` e `destroy`; controller em `js/room/tools/watch-together.js`. Cada participante baixa a mídia do provedor, enquanto o DataChannel distribui somente estado e comandos. Um arquivo local do host não fica acessível aos outros por compartilhar `blob:`; transferência P2P/upload é uma entrega adicional.

**Estado:** `{ mediaId, provider, resource, positionSeconds, paused, controllerPeerId, roomClockAnchor, revision }`. O coordenador serializa os comandos; controlador delegado faz propostas. Trocar mídia invalida eventos e promises do player anterior por geração.

**Sincronização:** estimar diferença de relógio com troca de mensagens e RTT; anunciar posição vinculada ao relógio de sala; emitir ressincronização periódica e ao entrar/reconectar. Corrigir desvios grandes por seek e pequenos por ajuste de velocidade somente onde a API permitir. Proteger contra loops em que seek remoto produz novo comando local.

**Meta inicial de laboratório:** em MP4/YouTube gravado, mídia já carregada, sem anúncios e rede estável, manter desvio entre participantes abaixo de 500 ms após estabilização. Medir p95 e tempo de recuperação. Não aplicar a meta a buffering, anúncios, autoplay bloqueado ou transmissões ao vivo.

**Provedores e etapas:**

| Provedor | Entrega | Restrição |
| --- | --- | --- |
| YouTube gravado | MVP com IFrame API | Autoplay, anúncios, conteúdo bloqueado e limitações do embed podem interromper acompanhamento |
| MP4 remoto | MVP via elemento `video` | URL, codec, disponibilidade e possibilidade de seek precisam funcionar em todos os clientes |
| Twitch VOD | Segunda etapa | API permite seek em VOD e exige configuração de domínio do embed |
| Twitch ao vivo | Co-visualização posterior | Seek/getCurrentTime não oferecem a mesma semântica de VOD; não prometer sincronização temporal exata |
| Kick ao vivo | Embed posterior | Guia oficial documenta incorporação; controle fino só será anunciado se houver API documentada e homologada |
| Arquivo local | Entrega separada | Requer distribuição, controle de tamanho, progresso, cancelamento e política de armazenamento |

As capacidades vêm dos adaptadores. Desabilitar ações não suportadas em vez de simular controle lendo DOM de iframe externo. Fontes: [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference), [Twitch embeds](https://dev.twitch.tv/docs/embed/video-and-clips/) e [Kick embed](https://help.kick.com/en/articles/8010826-how-to-embed-your-kick-livestream).

**Aceite:** comandos concorrentes, entrada tardia, reconexão, player com erro, autoplay bloqueado, mídia trocada durante load e controle revogado. Validar sincronização com MP4 de fixture em E2E; validar integrações externas em homologação separada, sem depender delas para toda a CI.

Estimativa: MVP **10–16 dias**; demais provedores e arquivo local ficam fora desse intervalo.

## 8. Qualidade automática pelo tamanho do tile

**Valor:** reduzir tráfego e decodificação na grade, mantendo detalhes na tela em foco. Prioridade alta pelo alinhamento com streaming P2P; risco técnico alto se interferir com ABR e relay.

**MVP navegador:** medir área visível com `ResizeObserver`, visibilidade com `IntersectionObserver`, foco/cinema e visibilidade da página. O receptor anuncia demanda discreta e limitada por stream; o emissor decide o perfil dentro de seus tetos e capacidade de rede.

Perfis iniciais para experimento, com valores ajustados por benchmark:

| Situação | Limite inicial solicitado | Observação |
| --- | --- | --- |
| Tile pequeno | Até 360p/15–30 fps | Priorizar redução de tráfego |
| Tile médio | Até 720p/30 fps | Legibilidade intermediária |
| Foco/cinema | Até 1080p/60 fps | Respeita captura, preset, encoder e rede |
| Fora da tela/aba oculta | Perfil reduzido | Preservar áudio; não suspender uma fonte necessária ao relay ou gravação |

Não são garantias de resolução/fps entregue. Considerar pixel ratio com teto e manter limite configurável pelo host. Conservar proporção original, sem converter ultrawide ou fontes pequenas artificialmente para 1080p.

**Política única:** combinar teto manual do host, perfil solicitado, ABR, limite WAN/mesh e capacidade do encoder em um controlador. `mutateVideoSender` continua serializando a aplicação, mas todos os escritores de qualidade passam a consultar a mesma decisão. Não reduzir a captura global com `applyConstraints` porque um único destinatário tem tile pequeno.

**Histerese:** subida rápida ao focar, redução após estabilidade de 2–5 segundos, classes com limiares separados e debounce de resize. Mensagens com geração e TTL; demanda ausente volta a perfil seguro. Convidado não pode pedir bitrate ilimitado ou operar sender de outra origem.

**Relay:** a demanda enviada ao upstream é a maior qualidade necessária entre consumo local, gravação e descendentes ativos. Não reduzir o upstream apenas porque o próprio relay usa tile pequeno. Testar renegociação, migração LAN/WAN, saída de relay e aplicação de novos perfis durante troca de chamada.

**Implementação:** demanda em `js/ui/` e protocolo; controlador em `js/streaming/`; aplicação em `js/webrtc/sender.js` pela API serializada. WebRTC prevê `scaleResolutionDownBy` e `maxFramerate`, sujeitos ao comportamento efetivo do browser/encoder. Referência: [especificação WebRTC](https://www.w3.org/TR/webrtc/).

**Desktop:** primeiro investigar a pipeline nativa que compartilha captura/codificação e envia RTP. Não assumir que `setParameters` do browser reduz um RTP já codificado. Comparar múltiplos perfis de encoder, camadas negociadas e reaproveitamento de perfis entre destinatários; medir número de sessões de hardware, CPU/GPU, memória e latência. Manter opção desligada no nativo até provar benefício e fallback.

**Aceite:** dois receptores, um em foco e outro pequeno, recebem perfis independentes no caminho navegador; foco restaura qualidade sem reiniciar captura; resize contínuo não causa oscilação; ABR vence quando rede piora; relay conserva qualidade pedida por descendente. Comparar tráfego, dropped frames e latência com baseline, em 1/4/8 espectadores e diferentes resoluções.

Estimativas: navegador **10–16 dias**; investigação nativa **3–5 dias**; implementação nativa preliminar **16–30 dias adicionais**, a reestimar depois da investigação.

## 9. Transcrição de chamada e legendas

**Valor:** acessibilidade, registro de estratégias e exportação de legendas. Prioridade média; risco alto de desempenho, privacidade e compatibilidade.

**Entrega A — navegador:** cada participante que optar por transcrição usa o próprio microfone e compartilha somente segmentos finais de sua fala. Identificação de locutor vem da conexão admitida, não de diarização do áudio misturado. Detectar suporte por navegador e idioma; oferecer exportação de texto/SRT/VTT dos segmentos autorizados.

Web Speech não deve ser anunciado como offline universal: processamento local tem disponibilidade limitada e depende de suporte e instalação de idioma. Se o provider usar serviço remoto, informar isso antes de ativar e permitir recusa. Referência: [SpeechRecognition.processLocally](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally).

**Entrega B — desktop local:** integrar provider Whisper local em worker/processo separado. Selecionar e baixar modelo explicitamente, com tamanho, progresso, verificação de integridade e opção de remoção. Avaliar PT-BR e inglês em hardware mínimo e recomendado. Preferir tracks individuais autorizadas; uma mistura única dificulta identificar locutor, especialmente em fala sobreposta. Referência técnica: [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

**Arquitetura:** interface de provider `start`, `stop`, `capabilities`, `onPartial`, `onFinal`, `dispose`; processamento por origem, fila limitada, detecção de voz e chunks com sobreposição controlada. Voz da call é separada de som do jogo/Watch Together. Não anexar um segundo consumidor ao microfone sem respeitar seu proprietário e o ciclo de vida da sessão.

**Modelo:** `{ segmentId, speakerId, startMs, endMs, text, revision, final, provider }`. Tempos relativos ao relógio da sala; alterações finais do mesmo segmento substituem revisão anterior. Nome exibido é snapshot de apresentação, sem mudar autoria quando alguém troca de nome.

**Consentimento:** estado visível de transcrição, adesão por participante, parada imediata e distinção entre transcrever, distribuir texto, exportar e persistir. Falas de quem não aderiu não entram no provider de transcrição. No MVP, manter buffer temporário e exportação local; armazenamento em grupo é uma etapa posterior.

**Exportação:** ordenar cues por tempo, validar início/fim, dividir textos longos, incluir locutor como prefixo em SRT e formato apropriado no VTT. Explicitar o ponto zero; sincronizar com replay exige mapear o início da gravação e não faz parte automaticamente do primeiro exportador.

**Aceite:** teste com áudio conhecido para medir WER, atraso e atribuição por origem; sotaques, ruído, silêncio e duas falas simultâneas. Exportadores têm fixtures determinísticas. Cancelamento durante download/inferência libera recursos; saída não produz texto tardio; áudio não autorizado não chega ao provider. Streaming não pode sofrer regressão material no benchmark; estabelecer teto após medir baseline e permitir pausar transcrição sob sobrecarga.

Estimativas: entrega A **5–9 dias**; investigação de modelo/hardware **3–5 dias**; entrega B **15–25 dias adicionais**. Treinamento de modelos e diarização avançada ficam fora do escopo inicial.

## 10. Fundação da plataforma permanente

Necessária para grupos, publicação comunitária e insígnias. A API atual do diretório permanece responsável por presença efêmera.

**Proposta:** serviço de identidade e sessão autenticada, banco relacional durável e armazenamento de objetos para assets. PostgreSQL é uma opção inicial de modelagem; selecionar fornecedor por custo, backup, disponibilidade e operação. Redis pode continuar como cache/presença e controle de frequência.

**Tabelas iniciais:** `users`, `external_identities`, `groups`, `group_memberships`, `group_invites`, `group_sessions`, `group_artifacts`, `themes`, `theme_versions`, `theme_votes`, `badge_definitions`, `user_badges` e `audit_events`. Criar somente as tabelas necessárias a cada entrega, com migrações e constraints de unicidade.

`userId` persistente é diferente de `peerId`, nome e sessão do cliente. Vincular conta e participação mediante prova de sessão autenticada e admissão, sem aceitar `userId` arbitrário enviado no DataChannel. No login web, revisar cookies/sessões e proteção das operações; no Tauri, definir fluxo de retorno de autenticação próprio.

**Autorização:** papéis owner/admin/member e acesso privado/público por recurso; convites com token opaco, hash no banco, prazo e revogação. O diretório nunca expõe `roomKey`, PIN, token de dono ou convite privado.

**Operação:** limites por usuário/grupo, trilha de moderação, backups com teste de restauração, exclusão de conta e dados, orçamento de banco/storage/egress e retenção definida. Não persistir automaticamente chat, áudio, transcrição e snapshots apenas por ingressar em grupo.

**Aceite:** acesso entre grupos isolado, convite revogado recusado, vínculo conta/peer não falsificável, migração repetível, restauração comprovada e compatibilidade com salas anônimas existentes.

Estimativa: **15–25 dias**, antes das funcionalidades persistentes. OAuth Discord, se escolhido para o primeiro login, não elimina a necessidade de autorização interna.

## 11. Grupos permanentes

**Valor:** maior potencial de retenção e base para comunidades. Prioridade alta dentro do bloco de plataforma; esforço alto.

**MVP:** host autenticado converte a sala em grupo privado; confirma nome e participantes convidados. Os demais recebem convite e aceitam; presença em sala não cria associação permanente silenciosa. Grupo tem página estável, membros, papéis, links de sessão e últimos artefatos explicitamente salvos.

**Separação:** `groupId` identifica o hub e `roomId` identifica a sessão temporária. Grupo permanece quando todos saem; vídeo, voz e coordenador P2P não ficam ativos sem participantes. Criar nova sessão exige um host ativo, salvo se no futuro existir coordenador servidor.

**Persistência:** salvar versões de checklist/snippets/notas por ação explícita. Registrar quem salvou e revisão de origem. Reabrir cria estado inicial da nova sessão; alterações não escrevem automaticamente sobre o histórico compartilhado. Histórico inicial é de sessões e artefatos, sem promessa de chat/áudio gravado.

**Implementação:** serviço de grupos e endpoints propostos `POST /api/groups`, `POST /api/groups/:id/invites`, `POST /api/groups/:id/sessions` e `POST /api/groups/:id/artifacts`; UI de hub, convite e conversão. Propriedade não depende de o host continuar conectado; transferência exige ação autorizada no backend.

**Aceite:** converter duas vezes a mesma operação é idempotente; convidado que não aceita não vira membro; link vazado não concede administração; grupo sobrevive ao fim da sala; expulsão revoga acesso persistente e é aplicada à admissão das próximas sessões. Revogação durante uma sessão exige também propagação à sala ativa; definir esse contrato antes do lançamento.

Estimativa: **15–25 dias**, após a fundação da plataforma.

## 12. Bot Discord

**Valor:** reduzir atrito para abrir sala com amigos. Prioridade média; automação exige operação contínua.

**Entrega A:** instalar bot em servidor autorizado e disponibilizar `/seemygame criar` para gerar convite privado vinculado ao servidor/canal permitido. Responder com link e instrução de que o primeiro host precisa abrir a sala. Usar permissões mínimas e validar quem pode criar/configurar.

**Entrega B:** observar mudanças de voz nos canais habilitados; quando houver limiar configurado de participantes, reservar uma sessão e anunciar convite no canal de texto associado ou atualizar status onde houver suporte/permissão. Ao esvaziar, retirar presença e encerrar reserva conforme prazo. Configuração por servidor: opt-in, canais, limiar, cooldown e papel autorizado.

**Arquitetura:** worker Node separado com Gateway, heartbeat, reconnect/resume, idempotência por servidor/canal e credenciais só no servidor. O Gateway usa conexão persistente; não colocá-lo dentro de uma função serverless que encerra por requisição. O intent de voz pertinente é `GUILD_VOICE_STATES`. O bot só observa servidores/canais em que foi instalado e autorizado, não todos os amigos de uma conta. Fonte: [Discord Gateway](https://docs.discord.com/developers/events/gateway).

**Sala privada:** backend cria reserva e convite com expiração; primeiro humano autorizado assume a coordenação ao abrir a página. A existência do link não equivale a stream ativo nem a uma sala P2P hospedada pelo bot. Não incluir bot entrando em áudio ou retransmitindo voz no MVP.

**Ciclo:** impedir duplicação em eventos simultâneos; debounce de entrada/saída rápida; permitir reutilização enquanto a sessão existir; expirar convites antigos; separar reserva, sala ativa e encerrada. O link nunca deve conter credencial administrativa publicada em canal.

**Aceite:** eventos duplicados criam um único convite; canal não habilitado não produz ação; restart não duplica sala; bot removido/permissão perdida interrompe automação; canal vazio aplica política; invite expirado é recusado. Testar worker com fixtures de Gateway e homologar em servidor de teste.

Estimativas: comando **4–7 dias** após serviço de convites; automação **mais 8–14 dias**, incluindo observabilidade e recuperação.

## 13. Mapa-múndi de salas

**Valor:** descoberta regional; benefício depende do volume de salas públicas. Prioridade baixa/média. Não vender proximidade como garantia de 5–15 ms.

**MVP:** mapa de regiões aproximadas, clusters, filtros por jogo/vaga/região e lista equivalente acessível. Localização é opt-in do publicador, arredondada à região/cidade ou centroide; não expor IP, endereço ou GPS preciso. Salas privadas ficam fora.

**Arquitetura:** aproveitar publicações/expiração do diretório; acrescentar localização pública aproximada validada, consulta por área e agregação de clusters no servidor quando volume exigir. Engine de mapa carregado somente nessa página; escolher biblioteca/provedor de tiles depois de validar licença, atribuição, tráfego e custo.

**Latência:** exibir RTT somente se medido em conexão autorizada e com instante/proveniência. Distância é um filtro inicial, não estimativa exata: ISP, rota, TURN e congestionamento mudam o resultado. Não abrir conexões para todas as salas do mapa. Se houver sondagem antes de entrar, exigir suporte opt-in do host, token curto e limites por origem e sala. RTT não representa latência total de vídeo.

**Aceite:** sem coordenadas exatas em API/DOM; sala encerrada desaparece; clusters e lista usam o mesmo conjunto; filtro/bounds não revelam sala privada; teste com grande fixture de publicações; falha de tiles mantém lista funcional.

Estimativa: **5–9 dias**, sem incluir infraestrutura de sondagem de RTT. Pode ser entregue antes de grupos, usando o diretório existente.

## 14. Workshop de temas

**Valor:** personalização e participação comunitária. Prioridade média/baixa; depende de identidade e moderação para conteúdo público.

**Entrega A:** 3–5 temas oficiais baseados em tokens de cor, superfície, borda, tipografia e espaçamento; preview e aplicação local. Tema sugerido pelo host pode ser aceito pelo participante, sem remover sua preferência de acessibilidade.

**Entrega B:** publicar, versionar, votar, denunciar e aplicar temas comunitários. Só versões aprovadas entram no catálogo público. Uma votação por usuário/tema; editar cria nova versão sem trocar silenciosamente o conteúdo já aprovado.

**Modelo:** `{ id, ownerUserId, version, name, tokens, assets, moderationStatus }`. Schema allowlist e limites para valores/arquivos. Não aceitar JavaScript, HTML ou CSS arbitrário. Imagens precisam de tipo/tamanho/dimensões validados; evitar SVG ativo, fontes e URLs remotas não aprovadas que executem conteúdo ou rastreiem usuários.

**Arquitetura:** evoluir `js/theme.js` para aplicação de tokens com fallback, mantendo claro/escuro; assets em object storage; APIs de catálogo, versões e votos com autorização. Contraste mínimo, foco visível e controles críticos preservados em qualquer tema. Previews usam o mesmo renderer validado do produto.

**Aceite:** tema inválido não altera UI; fallback recupera layout; tema não pode ocultar controles de saída/mute/consentimento; contraste e zoom testados; revogação interrompe novas aplicações; votos duplicados e autoria falsa recusados; trocar tema não recria player nem captura.

Estimativas: temas oficiais **3–5 dias**; workshop comunitário **mais 10–18 dias**, após a plataforma permanente.

## 15. Insígnias

**Valor:** reconhecimento e identidade comunitária; prioridade média/baixa. Começar por reconhecimento verificável, sem transformar atividade casual em competição.

**MVP:** catálogo pequeno, perfil/cartão com insígnias e concessão auditada. Early Adopter por data persistida de cadastro, Bug Hunter por contribuição revisada e insígnias manuais de comunidade são candidatos melhores que contar minutos de co-op autodeclarados.

**Modelo:** definição `{ id, name, description, icon, ruleVersion }`; concessão `{ userId, badgeId, grantedAt, evidenceRef, grantedBy, revokedAt }`, com unicidade/idempotência conforme a regra. Usuário decide visibilidade quando adequado.

**Autoridade:** backend concede/revoga. Mensagem P2P, tempo de sala informado pelo cliente ou tarefa marcada não prova conquista. Player 2 Veteran e Tactical Master exigem definir evidência verificável, tolerância a fraude e finalidade antes de automatizar. Vincular conta/peer só mostra o perfil correto; não comprova a atividade.

**Aceite:** repetição de evento não concede duas vezes; cliente não cria sua própria insígnia; regra versionada preserva evidência; revogação atualiza perfil; nome/ícone não quebra cards; visitante sem conta continua usando a sala.

Estimativa: **5–9 dias**, após identidade/perfis; regras avançadas de atividade ficam fora.

## 16. Sequência de entrega e estimativas

| Etapa | Entrega | Dependências / condição para avançar |
| --- | --- | --- |
| 0 | Homologar correções locais e fundação de ferramentas | Admissão, autoridade e descarte estáveis |
| 1 | Snippets → checklist → mãos visuais | Contrato compartilhado testado; não depender de contas |
| 2 | Qualidade por tile no navegador → Watch Together MVP | Benchmark de mídia e comportamento de relay preservados |
| 3 | Transcrição web experimental; temas oficiais; mapa conforme demanda | Capacidades/consentimento, tokens e diretório suficiente |
| 4 | Identidade + banco + grupos | Operação, autorização e persistência durável homologadas |
| 5 | Discord por comando → automação; workshop comunitário; insígnias | Convites, identidade, moderação e evidências definidos |
| 6 | Transcrição local desktop e qualidade nativa por tile | Investigação técnica, orçamento de hardware e homologação física |

As etapas 3 e 4 podem trocar de ordem se retenção/comunidade for prioridade comercial. Se foco for desempenho em PCs mais fracos, antecipar a investigação da etapa 6, mantendo implementação condicionada ao resultado. Não promover todas as ferramentas em um único PR.

**Primeiro pacote recomendado:** fundação + snippets + checklist + mãos visuais: **17–28 dias úteis de esforço**, antes de margem de integração. Reservar **25–35%** de contingência: aproximadamente **22–38 dias úteis** para uma pessoa, dependendo das regressões e revisão. Homologação adicional das correções anteriores não foi reestimada aqui.

**Segundo pacote:** qualidade por tile web + Watch Together MVP: **20–32 dias úteis**, antes de contingência. Não inclui desktop, Twitch/Kick, arquivo local ou diarização.

**Plataforma:** identidade + grupos: **30–50 dias úteis**, antes de contingência. Discord, workshop e insígnias são entregas posteriores independentes; compartilhar a fundação não elimina seus testes e operação.

Evitar somar todas as versões avançadas como prazo fechado: transcrição e encoder nativo têm decisões de arquitetura pendentes. Após cada investigação, atualizar as estimativas com protótipo, benchmark e escopo escolhido.

## 17. Testes, rollout e definição de pronto

Cada funcionalidade deve ter um PR com comportamento documentado, flag independente, testes de autorização e ciclo de vida, E2E do fluxo principal e plano de reversão. APIs persistentes incluem migração, logs sem segredos e validação de acesso entre usuários/grupos.

Verificação comum: `npm run verify`; E2E de sessões, sala e diretório quando afetados; novos cenários aproveitam `tools/e2e/harness/`. Para templates, executar `npm run build:html` e verificar fontes/saídas. Para Rust/IPC, seguir checks e testes nativos de [arquitetura e colaboração](arquitetura-e-colaboracao.md) e homologar Windows/Tauri.

Matriz obrigatória de sala: host + dois participantes, cliente somente-leitura, cliente antigo, entrada tardia, reconexão, peer removido, comando duplicado, comando atrasado, host encerrado e sessão descartada durante promessa pendente. Para mídia: caminho direto/relay, migração LAN/WAN, aba oculta, foco, gravação ativa e rede degradada.

Liberar primeiro internamente, depois a um grupo pequeno com opt-in e só então por padrão. Medir adoção por sala e conclusão das ações, erros de protocolo, ressincronizações, tráfego, CPU/GPU e latência de mídia. Logs/telemetria não incluem conteúdo de snippets, falas ou convites privados.

Definição de pronto: escopo e limites visíveis ao usuário; autorização aplicada no transporte/backend; estado convergente nos cenários escolhidos; recursos liberados ao sair; build/testes aprovados; homologação correspondente à plataforma anunciada; rollback disponível. Uma flag desativada precisa deixar chat, vídeo, voz e entrada na sala funcionando.

## 18. Decisões a fechar no início de cada frente

| Decisão | Padrão recomendado neste plano |
| --- | --- |
| Snippets simultâneos ou editor único? | Editor único por snippet + rascunho recuperável; CRDT depois |
| Mãos apenas visuais ou controle de áudio? | Visual primeiro; modo moderado explicitamente separado |
| Watch Together inclui live no MVP? | Vídeos gravados primeiro; live como co-visualização |
| Transcrição pode usar serviço remoto? | Só com indicação e adesão explícitas; opção local separada |
| Grupo salva todo histórico automaticamente? | Apenas artefatos escolhidos; retenção explícita |
| Discord cria mídia ativa sem host? | Reserva/convite; primeiro humano inicia coordenação |
| Localização pública precisa? | Região aproximada opt-in; lista como fallback |
| Workshop aceita CSS arbitrário? | Tokens e assets validados |
| Insígnias por eventos autodeclarados? | Evidência de backend ou concessão revisada |
| Tile pode superar qualidade definida pelo host? | Nunca; demanda limitada por host, rede e encoder |

Esses padrões permitem iniciar os primeiros pacotes sem bloquear planejamento em escolhas de fornecedor ou funcionalidades avançadas.
