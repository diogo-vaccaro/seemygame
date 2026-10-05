# Correção da segunda análise profunda

Data: 05/10/2026. Foram aplicadas correções aos **22 achados B01–B22** da [segunda análise](segunda-analise-profunda-2026-10-04.md). As alterações estão locais, sem commit ou publicação. As alterações já existentes no workspace foram preservadas.

## Alterações por achado

| ID | Comportamento corrigido | Código principal | Validação |
| --- | --- | --- | --- |
| B01 | Capturas antigas verificam a geração antes de fallback e tratamento de erro; não desativam uma entrada de voz mais recente. | `js/voice/capture.js` | Regressão de duas entradas concorrentes |
| B02 | `customStream` entrega a saída processada pelo ganho de áudio. | `js/voice/capture.js` | Contrato de retorno e testes de voz |
| B03 | Conexões simultâneas do Viewer compartilham a inicialização e usam o peer retornado; cancelar a sessão libera essa inicialização para a próxima. | `js/session/viewer-session.js` | Concorrência e cancelamento/reentrada |
| B04 | PIN e autenticação são associados ao host correto; aceitar outro host não fecha o desafio pendente. | `js/session/viewer-session.js` | Dois hosts com respostas intercaladas |
| B05 | Conexões duplicadas são rejeitadas; handlers verificam a identidade da conexão antes de alterar o membro. A malha usa iniciador determinístico. | `js/room/admission.js`, `js/session/room-session.js` | Duplicata fechada com membro original ativo; Chrome com múltiplos membros |
| B06 | Room, Streamer e Viewer verificam stream, estado de voz e sessão depois da captura antes de anunciar entrada. | `js/session/*-session.js` | Saída durante permissão pendente |
| B07 | Solturas de teclado/mouse são acompanhadas na janela; blur e desmontagem liberam somente comandos rastreados. | `js/coop/input.js` | Soltura fora do card e em campo editável |
| B08 | Desconectar o gamepad envia estado neutro e limpa a deduplicação; trocar o dispositivo força atualização completa. | `js/coop/input.js` | Desconexão depois de botão/analógico pressionado |
| B09 | Aprovação nativa antiga não desconecta slot que já ganhou outro ocupante. | `js/coop/host.js` | IPC assíncrono controlado |
| B10 | O socket do Companion é registrado antes de abrir; callbacks antigos não alteram a conexão atual. | `js/coop/transport.js` | Inicializações repetidas antes de `open` |
| B11 | Mouse usa a área efetiva da imagem, considerando `object-fit`, em vez de incluir barras pretas. | `js/coop/input.js`, `js/ui/video-geometry.js` | Geometria de vídeo 16:9 em área quadrada |
| B12 | Ping e laser transmitem fonte canônica e coordenadas relativas ao vídeo. A projeção acompanha layouts e fullscreen, ocultando fontes indisponíveis. | `js/ping-input.js`, `js/ping.js`, `js/ui/video-geometry.js` | Regressão de projeção e Chrome com duas transmissões e fullscreen |
| B13 | Apenas o cliente autenticado que possui a sessão pode limpar inputs ao desconectar; cliente inválido não interfere no proprietário. | `tools/coop-agent.py` | Dois clientes com autenticação intercalada |
| B14 | Reset de gamepads funciona sem PyAutoGUI e informa falhas de reset. | `tools/coop-agent.py` | Instalação só com gamepad e driver que falha |
| B15 | Reset individual libera botões do mouse do slot e preserva botões ainda usados por outro slot. | `tools/coop-agent.py` | Mouse individual e propriedade compartilhada |
| B16 | Botões e atalhos de desfazer/refazer usam snapshots em lotes e chunks de imagens. | `js/whiteboard-ui.js` | Snapshot de 300 mil caracteres pelo transporte real de `RoomManager`, sem exceder 256 KiB |
| B17 | Caneta divide traços longos em segmentos conectados de tamanho válido; o desenho permanece ao soltar. | `js/whiteboard/input.js` | Traço acima de 2.000 pontos |
| B18 | Mudanças no documento descartam imagens decodificadas sem uso e invalidam callbacks antigos; histórico pode recarregar a imagem. | `js/whiteboard/document.js`, `js/whiteboard/renderer.js` | 60 imagens adicionadas/removidas e histórico preservado |
| B19 | Cliente respeita capacidades de teclado; host rejeita teclado/mouse de slots só para gamepad. Mouse requer suporte do Companion. | `js/coop/input.js`, `js/coop/host.js` | Slot 2 rejeitado e regressões de roteamento |
| B20 | Validação explícita preserva slot 0 do Party Mode no envio nativo. | `js/coop/transport.js` | Report nativo destinado ao slot 0 |
| B21 | Erro de saúde, ausência de worker e falha crítica de rollback retiram também o replay, acionando sua liberação. | `src-tauri/src/capture/commands.rs` | Revisão dos caminhos e compilação de produção |
| B22 | Exclusão é preparada temporariamente e publicada apenas após sucesso; rejeição e rollback conservam o estado anterior. | `src-tauri/src/capture/commands.rs` | Revisão de retornos/rollback e compilação de produção |

## Validação realizada

- **1.201 testes JavaScript aprovados em 124 arquivos**, incluindo 18 novas regressões da segunda análise. [Log](../output/deep-fixes-vitest-final.log).
- **10 testes Python aprovados**, incluindo cinco novos casos de autenticação, gamepad e mouse. Drivers falsos evitam injeção de inputs no sistema operacional. [Log](../output/deep-fixes-python.log).
- **61 testes Rust aprovados e três ignorados**. `cargo check --locked --offline --lib` também passou, incluindo os comandos compilados fora de `cfg(test)`. [Testes](../output/deep-fixes-rust-tests.log), [compilação](../output/deep-fixes-rust-check.log).
- Chrome com sinalização PeerJS real e duas transmissões sintéticas: ping na fonte correta em layouts diferentes e laser sobre essa fonte em fullscreen. Ambos tiveram **desvio medido de zero pixels**, sem erros de página. [Evidência](../output/playwright/deep-audit-fixes-2026-10-05/evidence.json), [ping recebido](../output/playwright/deep-audit-fixes-2026-10-05/recipient.png), [laser em fullscreen](../output/playwright/deep-audit-fixes-2026-10-05/laser-fullscreen.png).
- Cenários Chrome anteriores de Co-op/fullscreen, ping/alerta/laser em Room e Streamer/Viewer, relay e encerramento de laser passaram. [Co-op/fullscreen](../output/deep-fixes-previous-browser.log), [ferramentas](../output/deep-fixes-tactical.log).
- Lousa em três clientes reais: desenho, transferência e reconstrução de imagem, redimensionamento, zoom/pan e retorno à sala passaram. [Log](../output/deep-fixes-whiteboard.log).
- Verificações de módulos, HTML, CSS e imports ESM passaram; distribuição gerada em `dist`. `git diff --check` passou.

## Limites

As correções B09/B20 foram verificadas com IPC controlado. Não houve teste com ViGEm e gamepad físicos. B21/B22 tiveram os caminhos de produção revisados e compilados, mas não houve injeção de falhas em uma sessão Tauri com captura WGC/DXGI e replay ativos. Os testes Rust existentes não executam esses comandos sob `cfg(not(test))`; portanto, o resultado da suíte não comprova a recuperação dessas falhas em hardware real.

## Reexecutar regressões

Na raiz do projeto:

```powershell
node node_modules/vitest/vitest.mjs run --configLoader native
python -m unittest discover -s tests -p '*companion.py' -v
cargo check --manifest-path src-tauri/Cargo.toml --locked --offline --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib
node tests/e2e-deep-audit-fixes.mjs
node tests/e2e-audit-fixes.mjs
node tests/e2e-tactical-tools.mjs
node tests/e2e-whiteboard-multi-client.mjs
```

Os antigos probes em `docs/deep-audit-2026-10-04.*` encaminham para as regressões atualizadas. Os testes JavaScript agora integram a suíte padrão.
