# Evidências de captura e encode

Escopo: componentes, sem receptor remoto, áudio, replay, preview ou WebRTC. FPS codificado não comprova cadência visual. Rodadas não qualificadas são exploratórias. Não atribuir ganhos de fila, prioridade ou API sem comparação controlada.

| Relatório | Caso | Status | Backend | Captura | Fila real | GPU efetiva | Resolução | FPS encoded | Captura→encode p50 ms | Fila p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| output/playwright/components-2026-10-06T04-44-33-429Z-2ae13e/report.json | wgc-latest | resource-pressure-unqualified | d3d11 | window-wgc | latest | 2 | 1280×720 | 42.504 | 1.298 | 0.025 |
| output/playwright/components-2026-10-06T04-44-33-429Z-2ae13e/report.json | monitor-dxgi | resource-pressure-unqualified | d3d11 | monitor-dxgi | bounded | 2 | 1280×720 | 60.000 | 1.618 | 0.023 |
| output/playwright/components-2026-10-06T04-48-26-938Z-24132e/report.json | wgc-latest | resource-pressure-unqualified | d3d11 | window-wgc | latest | 2 | 1280×720 | 42.900 | 1.293 | 0.025 |
| output/playwright/components-2026-10-06T04-48-26-938Z-24132e/report.json | monitor-dxgi | resource-pressure-unqualified | d3d11 | monitor-dxgi | bounded | 2 | 1280×720 | 60.094 | 1.591 | 0.023 |
| output/playwright/components-2026-10-06T04-49-41-530Z-284749/report.json | d12-latest | valid | d3d12 | window-wgc | latest | 2 | 1280×720 | 60.100 | 4.033 | 0.022 |
