# Implementação das Funcionalidades da Sala — 09/10/2026

Referência: [Planejamento de Funcionalidades](planejamento-funcionalidades-2026-10-09.md) e [Correção das Pendências](correcao-pendencias-sala-2026-10-09.md).

## Resumo das Entregas

Em conformidade com a recomendação da Seção 1 e Seção 16 do planejamento, foi implementada a suíte completa de ferramentas colaborativas em tempo real da sala, qualidade automática de vídeo por tile no navegador, watch together, transcrição e temas oficiais.

### 1. Fundação Comum das Ferramentas da Sala (`js/room/tools/shared-tools-service.js`)
- **Protocolo de Proposta e Confirmação:** Ciclo estrito `TOOL_PROPOSAL` → Validação no Coordenador → `TOOL_CONFIRM` com incremento de `revision`.
- **Autoridade e Admissão:** Identidade do autor validada a partir da conexão P2P admitida (`conn.peer`), impedindo falsificação de autoria.
- **Proteção Somente-Leitura:** Espectadores com `readonly-viewer` têm acesso restrito a leitura (`tools.read`); propostas de escrita, concessão de fala ou controle de mídia são sumariamente recusadas com `readonly_not_permitted`.
- **Deduplicação Idempotente:** Janela LRU de `opId`s processados; operações retransmitidas recebem a mesma confirmação sem reexecução.
- **Detecção de Conflitos e Resolução:** Rejeição `TOOL_REJECT` em concorrência estrita sobre revisões obsoletas, retornando o snapshot atual para reconciliação e preservando o rascunho local do cliente.
- **Isolamento por Sessão (`roomEpoch`):** Mensagens com epoch divergente são descartadas para evitar interferência entre sessões da mesma sala.
- **Resiliência a Desconexão:** Se o coordenador desconectar, as escritas são pausadas com aviso descritivo.

### 2. Snippets de Código Colaborativo (`js/room/tools/snippets.js` & `js/ui/room-tools/snippets-modal.js`)
- **Modelo:** `{ id, title, language, content, authorPeerId, revision, editorPeerId, leaseExpiresAt, updatedAt }`.
- **Licença de Edição (Lease):** Um editor por snippet com licença temporária (30s) concedida e renovada pelo coordenador; liberação automática ao salvar, cancelar ou desconectar o editor.
- **Preservação de Rascunho Local:** O editor nunca perde seu trabalho local em caso de expiração ou conflito.
- **Segurança contra XSS:** Renderização estritamente textual sem execução de código ou injeção de HTML. Allowlist de linguagens (`javascript`, `typescript`, `python`, `rust`, `html`, `css`, `json`, `bash`, `sql`, `markdown`, `plaintext`).
- **Orçamento e Utilitários:** Limite de 64 KiB por snippet e 128 KiB agregado; botões de cópia para clipboard e exportação em arquivo.

### 3. Checklist Colaborativo (`js/room/tools/tasks.js` & `js/ui/room-tools/tasks-modal.js`)
- **Modelo:** `{ id, title, description, assigneePeerId, priority, completed, order, createdBy, revision, updatedAt }`.
- **Operações Atômicas:** Criação, edição de campos com mesclagem não-conflitante, conclusão idempotente, reordenação e exclusão.
- **Proteção contra Ressurreição (Tombstones):** Registro em memória de tarefas excluídas impede que operações atrasadas na rede recriem tarefas.
- **Filtros Locais:** Filtros por status (todas, pendentes, concluídas) e responsável (todas, minhas) operam exclusivamente no cliente sem mutação de estado compartilhado.
- **Limites e Tolerância:** Até 100 tarefas, títulos até 160 caracteres, descrições até 2 KiB; sinalização de responsável desconectado como `(Indisponível)`.

### 4. Levantar a Mão e Fila de Fala (`js/room/tools/hands.js` & `js/ui/room-tools/hands-modal.js`)
- **Modelo:** `{ queue: [{ peerId, displayName, sequence, requestedAt }], currentSpeakerPeerId, currentSpeakerName, revision, policy: 'open'|'moderated' }`.
- **Sequência Oficial:** Ordem na fila atribuída monotonicamente pelo coordenador, sem dependência de relógios locais dos clientes. Uma única entrada por participante na fila.
- **Controle de Moderação:** Somente o host pode conceder vez, revogar vez, avançar orador ou alterar a política.
- **Modo Moderado de Áudio:** Política de sala em que ouvintes silenciam nós de reprodução de quem não possui a vez (`isPeerAudible`). A concessão de vez nunca liga remotamente o microfone sem consentimento e ação local do participante.
- **Limpeza Automática:** Saída ou desconexão do participante remove seu pedido da fila e revoga sua fala se for o orador ativo.

### 5. Watch Together (`js/room/tools/watch-together.js` & `js/ui/room-tools/watch-modal.js`)
- **Modelo:** `{ mediaId, provider: 'youtube'|'mp4', resource, positionSeconds, paused, controllerPeerId, roomClockAnchor, revision }`.
- **Adaptadores:** YouTube gravado (IFrame API seguro) e MP4 remoto via HTTPS (`<video>`).
- **Sincronização de Reprodução:** Posição calculada com base no tempo decorrido desde `roomClockAnchor`; compensação de desvio mantendo sincronia sob meta de 500 ms em rede estável.
- **Proteção contra Loop:** Eventos locais disparados por sincronização remota não geram novos comandos no DataChannel.
- **Delegação:** Host pode delegar o controle de reprodução a outro participante; espectadores acompanham passivamente.

### 6. Qualidade Automática por Tamanho do Tile (`js/streaming/tile-quality.js`)
- **Medição Contínua:** `ResizeObserver` e `IntersectionObserver` monitoram área e visibilidade dos tiles de vídeo.
- **Perfis Discretos:** `small` (<=360p / 30fps), `medium` (<=720p / 30fps), `focus` (<=1080p / 60fps) e `hidden` (reduzido/suspenso).
- **Histerese:** Subida imediata em foco; redução com atraso seguro de 2 a 5 segundos e debounce de redimensionamento para evitar oscilações.
- **Agregação de Relay:** Nós que retransmitem solicitam ao upstream a maior qualidade demandada entre o consumo local e os clientes descendentes ativos.

### 7. Transcrição de Chamada e Legendas (`js/room/tools/transcript.js` & `js/ui/room-tools/transcript-modal.js`)
- **Consentimento Obrigatório:** Requer autorização explícita do usuário antes de conectar ao microfone.
- **Web Speech API Local:** Cada participante transcreve a própria fala; identificação atribuída pela conexão P2P admitida.
- **Legendas ao Vivo:** Overlay flutuante e histórico na janela de ferramentas.
- **Exportação Canônica:** Exportação formatada para `.srt`, `.vtt` e `.txt` com cálculo preciso de tempos e atribuição de locutor.

### 8. Catálogo de Temas Oficiais (`js/theme.js` & `css/theme-tokens.css`)
- **Temas Oficiais:** Dark (padrão), Light, Cyberpunk (alto contraste neon), Midnight Blue, Forest Green e Sunset.
- **Tokens de Superfície e Contraste:** Preservação estrita de visibilidade de foco, botões de escape, saída e mute em todos os temas.

### 9. Arquitetura de Plugins e UI da Sala (`js/plugins/room-tools-plugin.js` & `js/room/room-tools.js`)
- **Composição de Sessão:** `RoomToolsPlugin` integrado em `session-composition.js` para sessões de sala.
- **Menu da Sala:** Itens adicionados ao dock menu de ferramentas da sala (Snippets, Checklist, Fila de Fala, Watch Together, Legendas).
- **Acessibilidade:** Modais com atributos ARIA (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`), navegação por teclado e fechamento unificado por Escape.

---

## Validação e Testes

- **`tests/room-tools-foundation.test.js`**: 9 testes aprovados (propostas, idempotência, deduplicação por `opId`, `readonly_not_permitted`, conflito de revisão, `roomEpoch`, status offline, resync de snapshot).
- **`tests/room-snippets.test.js`**: 7 testes aprovados (criação, allowlist de linguagens, lease exclusivo, preservação de rascunho local, limites de tamanho, duplicação, limpeza por desconexão).
- **`tests/room-tasks.test.js`**: 7 testes aprovados (criação, edição atômica por campo, conclusão idempotente, tombstones contra ressurreição, filtros locais, responsável desconectado, limite de 100 tarefas).
- **`tests/room-hands.test.js`**: 7 testes aprovados (sequência ordenada pelo host, deduplicação de pedidos, cancelamento, concessão e revogação pelo host, bloqueio de auto-concessão por convidado, audibilidade no modo moderado, limpeza por desconexão).
- **`tests/room-watch-together.test.js`**: 6 testes aprovados (parse de URLs YouTube/MP4, carga e ancoragem de relógio, comandos de play/pause/seek, delegação de controle, recusa de comandos não autorizados, cálculo de posição estimada).
- **`tests/tile-quality.test.js`**: 4 testes aprovados (classificação de dimensões, histerese na redução, subida rápida em foco, agregação de relay upstream).
- **`tests/room-transcript.test.js`**: 5 testes aprovados (exigência de consentimento, distribuição de segmentos, formatação SRT, formatação WebVTT, bloqueio de somente-leitura).
- **`tests/room-themes.test.js`**: 2 testes aprovados (validação de tokens no CSS e allowlist no script de bootstrap).
- **`tests/room-tools-plugin.test.js`**: 2 testes aprovados (ciclo de vida e despacho de mensagens P2P pelo `MessageDispatcher`).
- **Verificações de Integridade:**
  - `node tools/check-modules.mjs`: 209 módulos autorais, 502 imports/exports validados.
  - `node tools/smoke-esm.mjs`: 203 módulos importados sem efeitos colaterais.
  - `node tools/split-css.mjs`: 5 arquivos CSS validados na ordem da cascata.
  - `node tools/build-html.mjs --check`: partials HTML validados.
