# Correção dos achados da auditoria — 06/10/2026

## Alterações

| Achado | Correção | Evidência |
| --- | --- | --- |
| R1: controles sem evento | Restaurado change com SessionContext real; removido handler duplicado de perfil do streamer | Unitários de binding e E2E de sala |
| R2: adaptação reinicia worker | Preferência removida do bind de reconfiguração da captura nativa; ajuda explica o escopo do navegador | Teste de provider sem reconfigure por adaptação |
| R3: perda de escala | Função única calcula escala por largura/altura reais; aceita/recusa de constraints e mudanças de bitrate não desfazem o perfil | Unitários ultrawide/portrait e E2E 1080p→720p→1080p |
| R4: falso positivo no smoke | Verifica todas as amostras estáveis, duas dimensões, codec, preferência, decode e apresentação; JSON com hashes, timeout, ICE ordenado e cleanup | Testes contra amostras divergentes; cinco casos reais de componente |
| R5: atribuição errada | Documentos reescritos; tabela gerada dos JSONs; runner exige configuração efetiva coincidente e prioridade aplicada; novos casos DXGI normal/Latest/HIGH | Unitários de tabela/qualificação e tabela histórica auditável |
| R6: Auto sem recuperação WGC | Estado separa método solicitado/ativo; fallback limitado ao mesmo monitor, sem loops e preservando escolha explícita e portas | Quatro testes novos de falha determinística; compilação normal Tauri |
| R7: preferência perdida no fallback | Remoção progressiva de networkPriority e priority, preservando adaptação; preferência não aplicada aparece no HUD/exportação | Unitários de rejeição seletiva e diagnóstico |

Também foram removidos new-pref sem efeito no modo drop-only e a função de prioridade do host sem chamadas. Os logs do worker registram se a prioridade CPU foi aplicada e Set/Get/classe GPU efetiva. O padrão Bounded foi mantido até homologar Latest com áudio, replay, recuperação e apresentação remota; Latest continua disponível explicitamente para experimentos.

## Revalidação funcional

- Unitários Rust: **67 aprovados / 3 probes de hardware ignorados / 0 falhas**.
- Compilação normal: cargo check da biblioteca aprovado, incluindo comandos Tauri excluídos da compilação de testes.
- E2E de qualidade: **5 verificações aprovadas**. Fonte sintética 1080p recusa constraints; o receptor recebe 720p após seleção, mantém escala ao mudar bitrate/adaptação e volta a 1080p na mesma conexão.
- E2E de lobby/canais: **12 verificações aprovadas**, incluindo mídia real WebRTC, áudio fake, isolamento de voz, soundboard, saída e transmissão.
- Smoke web de componente: **5/5 casos aprovados** na versão com emissão manual de frames. Todas as dimensões e preferências foram validadas; cadência decodificada steady ficou aproximadamente em 60 FPS.
- Suíte completa JavaScript final: **134 arquivos / 1.311 testes aprovados**; módulos, HTML, CSS, smoke ESM e build de assets também aprovados. Log: output/audit-corrections-verify.log.
- Revisão final: proteção contra dupla escala quando o encoder nativo já redimensiona a saída e a track da bridge ainda expõe dimensões antigas. A distinção usa session.provider, pois o BrowserCaptureProvider também possui sessão; um teste com esse provedor real confirma constraints, escala e ausência de reconfiguração nativa.
- Executável release recompilado em src-tauri/target/release/seemygame.exe; não foi gerado instalador.

## Evidências

| Execução | Caminho |
| --- | --- |
| E2E de qualidade final | output/playwright/room-quality-1791293238856/report.json |
| E2E de canais | output/playwright/room-channels-1791292130950/report.json |
| Smoke com segundo limitador, dois casos reprovados | output/playwright/web-resolution-2026-10-06T13-09-51-203Z-864e71/report.json |
| Smoke corrigido, cinco casos aprovados | output/playwright/web-resolution-2026-10-06T13-12-39-392Z-1b6b3d/report.json |
| Tabela histórica gerada | docs/evidencias-captura-componentes-2026-10-06.md |

O primeiro smoke foi preservado. Ele desenhava perto de 60 FPS, mas entregou aproximadamente 52–54 FPS em dois casos. Após trocar captureStream(60) por captureStream(0) com requestFrame explícito por desenho, os cinco casos passaram com o mesmo critério. Isso aponta para interferência do relógio adicional do canvas no fixture; não comprova ganho equivalente em getDisplayMedia, WGC ou DXGI.

## Limites e uso

As correções funcionais e de metodologia foram verificadas. Os E2Es usam fontes sintéticas e Chrome na mesma máquina. Os testes de recuperação simulam falha de runtime; não provocam falha real de driver. Não há nesta entrega uma nova homologação de desempenho sob jogo pesado com áudio/replay e duas máquinas.

No caminho nativo, a resolução é aplicada no encoder Rust. O sender JS da bridge mantém escala 1 durante a troca de worker, evitando uma segunda redução enquanto os metadados da track ainda correspondem à resolução anterior. Na captura web, a escala continua sendo calculada pelas dimensões reais da track.

Para repetir a integração: npm run test:e2e:room-quality e npm run test:e2e:room-channels. Para o componente: node tools/e2e/verify-web-resolution-fps.mjs. Os testes encerram somente seus recursos isolados.

Não foi feito commit ou push nesta etapa.
