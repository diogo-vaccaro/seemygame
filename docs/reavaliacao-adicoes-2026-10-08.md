# Reavaliação das adições — 08/10/2026

Snapshot: HEAD `942ff1f`; checkout inicialmente limpo. Escopo: commits desde `1b14d6e`, com diretório de salas, publicação/heartbeat, UI de descoberta, perfis e adaptação LAN e correções dos quatro achados anteriores. Nenhum arquivo de implementação foi alterado nesta avaliação.

## Resultado

Os quatro achados anteriores foram corrigidos e passaram na reprodução E2E: snapshot do bloco de notas para entrada tardia, Shift+Digit1 físico, atualização dos layouts ao criar/remover transmissões e rejeição de chamada de áudio de Viewer somente-leitura que omite metadata.role.

Evidência: [probe dos achados anteriores](../output/playwright/additions-audit-1791506746358/report.json), status `all-bugs-fixed`.

Foram confirmados quatro novos bugs abaixo. Os testes existentes passaram, mas não exercitam essas variantes.

## Novos achados

### N01 — P1 — Omitir a chave permite modificar e excluir salas de terceiros

Locais: `api/rooms.js:373` (atualização), `api/rooms.js:190–197` e `208–212` (exclusão).

A verificação da chave só ocorre quando o solicitante envia uma chave não vazia. Uma sala criada com secretKey proprietário rejeita uma chave incorreta com 403, mas aceita POST sem secretKey, alterando título, jogo e flags. DELETE sem secret também remove o registro. IDs são públicos no GET, portanto o conhecimento do ID não comprova propriedade. O impacto é sobre o diretório; não foi demonstrado acesso à sala protegida por PIN.

Reprodução isolada com handler real: criar `audit-protected`, tentar chave errada (403), sobrescrever sem chave (200 e título alterado), excluir sem chave (`deleted=true`, listagem vazia).

Correção indicada: exigir igualdade com a chave registrada para qualquer mutação de registros protegidos, inclusive quando a chave recebida está ausente; aplicar a mesma regra a POST, DELETE e beacon. Para Redis, autorização e mutação devem ser atômicas para evitar disputas concorrentes.

### N02 — P2 — Redis indisponível produz falso sucesso e não ativa fallback

Locais: `api/rooms.js:110–115`, `127–129`.

kvCommand converte erro HTTP ou exceção em null. saveRoomToStorage não verifica o retorno de SET/ZADD e retorna true, impedindo que o fluxo alcance o armazenamento em memória. A API confirma publicação, mas a sala não aparece. GET também retorna lista vazia diante da indisponibilidade, ocultando a falha.

Reprodução com fetch substituído somente no processo de teste, retornando HTTP 503 para o Redis: POST responde 200/ok=true; GET retorna count=0; desligar a configuração KV confirma que tampouco houve gravação no fallback. Nenhum serviço externo foi acessado.

Correção indicada: distinguir falha de infraestrutura de ausência de registro e só confirmar gravações bem-sucedidas; retornar erro explícito ou implementar uma política consistente de fallback.

### N03 — P2 — Mesh Guard reduz estado interno sem aplicar o limite ao sender

Local: `js/streaming/adaptation.js:31–36`.

setTargetBitrate modifica currentBitrateBps antes que seja capturado o valor de comparação; não emite onBitrateChange. Com rede saudável, processSample não muda novamente o valor e nenhuma escrita de parâmetros é agendada. O teto fica apenas no controlador.

Reprodução com createQualityController real e sender instrumentado: alvo inicial 8 Mbps, três espectadores, um LAN e amostra WAN saudável. Controlador passa para 6 Mbps; sender continua com maxBitrate=8 Mbps; setParameters é chamado zero vezes. O teste LAN existente verifica somente o estado interno e usa um PC sem getSenders, deixando essa divergência sem cobertura.

Correção indicada: propagar mudanças de alvo ao sender mesmo quando processSample não altera o bitrate; testar o parâmetro efetivamente aplicado e transições de topologia.

### N04 — P2 — Diretório conta o anfitrião duas vezes

Locais: `js/session/room-session.js:267` e `1082`.

RoomManager.members já inclui o usuário local (`js/room.js:125`). Somar mais um infla a contagem publicada. E2E complementar com host e convidado realmente admitidos e heartbeat explícito: actualMembers=2, publisherMembers=3; GET do diretório anuncia 3/8.

O E2E adversarial existente passa porque verifica a listagem antes do heartbeat refletir a admissão: o valor previamente publicado de dois não comprova atualização correta dos dois participantes.

Correção indicada: usar members.size diretamente nas duas rotas e validar a contagem após admissão, saída e heartbeat.

Evidências dos novos achados:

- [N01–N03: reproduções isoladas](../output/revalidation-2026-10-08-probes.json), [script](revalidation-2026-10-08-probes.mjs).
- [N04: WebRTC e diretório real](../output/revalidation-2026-10-08-member-count.json), [script](revalidation-2026-10-08-member-count.mjs).

Os scripts afirmam o comportamento defeituoso: exit code zero comprova reprodução, não correção.

## Validações concluídas

| Validação | Resultado | Evidência |
| --- | --- | --- |
| npm run verify | 168 arquivos e 1.610 testes aprovados; módulos, HTML, CSS, smoke ESM e build aprovados | [Log](../output/revalidation-2026-10-08-verify.log) |
| E2E diretório | 7 grupos aprovados | [Evidência](../output/playwright/rooms-directory-e2e-1791506673455/evidence.json) |
| E2E diretório adversarial | 6 grupos aprovados | [Evidência](../output/playwright/rooms-directory-adversarial-1791506688723/evidence.json) |
| E2E ferramentas prioritárias | 6 grupos aprovados | [Evidência](../output/playwright/prioritized-tools-1791506701747/evidence.json) |
| E2E qualidade de transmissão | 7 verificações aprovadas | [Relatório](../output/playwright/room-quality-1791506825672/report.json) |
| Revalidação dos quatro achados anteriores | Todos corrigidos no cenário reproduzido | [Relatório](../output/playwright/additions-audit-1791506746358/report.json) |
| git diff --check | Sem erros | Checkout sem alterações de implementação |

E2E: Chrome, contextos isolados, PeerJS/WebRTC real e sinalização local, dispositivos sintéticos. Falha Redis e sender do N03 foram instrumentados em processo isolado. Não foi executado E2E pela janela Tauri, teste físico entre máquinas LAN/WAN ou homologação de produção Redis/Vercel. Não foi repetida a suíte Rust, pois esses commits não alteram código Rust.

Foram adicionados somente este relatório e dois scripts de reprodução em docs; logs e evidências ficam em output.
