# Ajustes independentes de transmissão — 08/10/2026

Implementados na sala e na página do transmissor, substituindo o seletor visível que combinava resolução e FPS.

## Opções

| Campo | Opções | Comportamento |
|---|---|---|
| Resolução | 720p / 1080p | Independente de FPS e bitrate; pode ser alterada ao vivo. |
| Taxa de quadros | 30 / 60 / 120 FPS | 120 FPS é experimental; o diagnóstico confirma a entrega efetiva. |
| Bitrate máximo | 0,5–50 Mbps, passos de 0,25 Mbps | Persistido; trocar resolução/FPS não o sobrescreve. Adaptação pode usar menos que o teto solicitado. |
| Objetivo | Compartilhamento / fluidez; Latência mínima experimental | Controle de filas raw na captura nativa. Aplicado ao reiniciar a transmissão. |

Compartilhamento mantém `bounded`: até três buffers raw com limite de conteúdo de mídia de 50 ms, sem descarte explícito. Não garante ausência de stutters ou limite absoluto de latência.

Latência mínima usa `latest`: um buffer raw, descartando os mais antigos. Pode reduzir retenção local, mas também diminuir FPS/aumentar engasgos. A comparação anterior **não demonstrou ganho consistente de latência remota**; a ajuda explicita isso. Este seletor não altera o relógio RTP, codec, encoder, API gráfica, resolução, FPS nem bitrate. Não modifica filas de áudio ou pacotes comprimidos.

No navegador, o seletor de objetivo fica desabilitado com explicação: a API de captura não oferece o controle equivalente de filas raw. Os três controles de qualidade continuam disponíveis. Não foi implementada uma promessa de modo web de baixa latência via esse seletor.

## Integração

- `templates/video-settings/default.html`: painel único reutilizado nas duas páginas, campos acessíveis, explicações e ajuda por foco/hover.
- `js/streaming/video-settings.js`: leitura validada, persistência e integração com o adaptador interno de presets usado pelos runners antigos.
- `js/capture/settings.js` e `js/streaming/settings-controller.js`: alterações ao vivo de resolução/FPS/bitrate; modo pendente não substitui a fila nativa ativa nas demais reconfigurações.
- `js/capture.js`, `js/desktop/capture.js`, `src-tauri/src/capture/commands.rs`: passagem de `rawVideoQueue` até o worker. Rust valida `bounded|latest`; na reconfiguração, valida antes de retirar o worker ativo.
- `tools/e2e/run.mjs`: os experimentos de fila agora selecionam também a opção na interface; FPS 30/60/120 solicitado pelo harness passa pelo novo seletor.

## Evidência

- Suíte JS: **160 arquivos / 1.529 testes aprovados**, incluindo nove casos novos de controles, persistência, descarte, alterações ao vivo e interface→IPC.
- `cargo check --locked --offline --lib`: aprovado.
- `cargo build --release --locked --offline`: aprovado. Executável atualizado em `src-tauri/target/release/seemygame.exe`.
- HTML, grafo de módulos, CSS, imports sem efeitos colaterais e build dist: aprovados.
- E2E web: dois participantes Chrome, WebRTC real; alteração ativa para 720p30 preservando 7,5 Mbps, resolução confirmada no receptor, mudanças de bitrate/adaptação e retorno para 1080p. Layout em 380 px e tooltip via teclado/Escape aprovados.
- E2E nativo: app release→Chrome, ambos os modos, 720p30/4,5 Mbps; fila e framerate/bitrate confirmados nos argumentos reais do GStreamer; recepção 1280×720 e envio direto nativo confirmados.

O smoke nativo teve oito intervalos por modo, sem áudio/replay/carga de jogo, na mesma máquina. Valida funcionalidade e propagação das opções; **não homologa latência mínima, estabilidade sob carga, áudio/replay ou 120 FPS**. Não comparar seu FPS/latência com benchmarks de duas máquinas.

### Artefatos

- [E2E web e layout](../output/playwright/room-quality-1791459904859/report.json)
- [Painel amplo](../output/playwright/room-quality-1791459904859/settings-wide.png)
- [Painel mobile](../output/playwright/room-quality-1791459904859/settings-mobile.png)
- [Smoke dos dois modos nativos](../output/playwright/transmission-settings-1791459726299-b74bd9/report.json)
- [Diagnóstico anterior das filas](diagnostico-filas-raw-gpu-2026-10-08.md)

```powershell
npx vitest run tests/video-settings.test.js
node tests/e2e-room-quality.mjs
node tools/e2e/transmission-settings-smoke.mjs
```

Sem commit/push nesta solicitação.
