# Relatório de Benchmark Rigoroso Multivariável E2E

> **Retificação (07/10/2026):** este documento foi gerado pelo runner anterior. Os 32 sucessos funcionais tinham apenas 3–4 segundos de evidência estável e qualificação insuficiente; os 12 casos Web falharam por geometria, antes da amostragem. As declarações de vencedor estatístico, isolamento da GPU e recomendação definitiva não são sustentadas por esta rodada. Consulte [a revalidação](revalidacao-benchmark-d3d12-web-2026-10-07.md). Os dados históricos abaixo são preservados; o runner corrigido gera relatórios por execução, sem sobrescrever esta evidência.

**Data:** 07/10/2026, 00:32:39
**Topologia:** Duas Máquinas Reais — Emissor Desktop (NVIDIA RTX 3070) $\to$ Receptor Notebook (AMD Ryzen 7 5800H / Tailscale)
**Escopo:** Avaliação cruzada de Codecs (H.264, HEVC, AV1), Encoders (NVENC, MF, CPU, Auto), APIs de Captura (D3D12, D3D11, Web), Resoluções (720p/1080p), Taxas de FPS (30/60/120) sob Carga Leve e Carga de FPS Ilimitado.

## 1. Critério de Rigor e Decisão

> **Regra Metodológica:** Uma configuração só é declarada vencedora caso apresente ganho estatisticamente conclusivo ($ge 5\%$ em FPS sustentado ou $ge 20\%$ em redução de frametime p95) sem regredir a outra métrica. Diferenças menores ou compensações mútuas (ex: maior FPS porém maior jitter/pausa) são obrigatoriamente classificadas como **Empate Técnico / Sem Vencedor Conclusivo**.

## 2. Resumo Comparativo por Condição

### 720P @ 30 FPS — Carga Leve

**Veredito:** `D3D12 + NVENC (H.264) (Único testado com sucesso)`
**Justificativa:** Não há competidor válido nesta condição específica.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **29.4** | 29.27 | 52.9 | 71.2 | 28.8% | 5.1% | APROVADO |

### 720P @ 60 FPS — Carga Leve

**Veredito:** `VENCEDOR: D3D12 + NVENC (H.264)`
**Justificativa:** Ganho conclusivo de FPS (+9.9%) sem piora de frametime.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **59.93** | 59.58 | 34.9 | 36.2 | 15.8% | 9.7% | APROVADO |
| D3D11 + CPU Software (H.264) | **54.54** | 54.48 | 35.2 | 36 | 16.1% | 9.8% | APROVADO |
| D3D11 + HEVC (Media Foundation) | **54.38** | 54.26 | 35.3 | 36.1 | 11.2% | 13.9% | APROVADO |
| D3D11 + NVENC (H.264) | **55.35** | 53.95 | 35.4 | 53.3 | 16.9% | 9.5% | APROVADO |
| D3D11 + HEVC (Auto/NVENC) | **54.26** | 54.11 | 35.4 | 36.3 | 10.4% | 13.8% | APROVADO |
| D3D11 + Media Foundation (H.264) | **41.14** | 27.47 | 159.1 | 510.5 | 15.8% | 9.7% | APROVADO |

### 720P @ 120 FPS — Carga Leve

**Veredito:** `D3D12 + NVENC (H.264) (Único testado com sucesso)`
**Justificativa:** Não há competidor válido nesta condição específica.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **113.44** | 98.3 | 18.1 | 194 | 19.7% | 17.9% | APROVADO |

### 1080P @ 30 FPS — Carga Leve

**Veredito:** `D3D12 + NVENC (H.264) (Único testado com sucesso)`
**Justificativa:** Não há competidor válido nesta condição específica.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **30.09** | 29.76 | 70.1 | 70.8 | 20.3% | 8.8% | APROVADO |

### 1080P @ 60 FPS — Carga Leve

**Veredito:** `VENCEDOR: D3D12 + NVENC (H.264)`
**Justificativa:** Ganho conclusivo de FPS (+10.8%) sem piora de frametime.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **60.27** | 59.68 | 35.2 | 36.1 | 15.5% | 17.8% | APROVADO |
| D3D11 + Media Foundation (H.264) | **54.4** | 54.1 | 35.2 | 36.3 | 10.9% | 16.9% | APROVADO |
| D3D11 + NVENC (H.264) | **55.48** | 54.88 | 35.5 | 36.2 | 12% | 16.2% | APROVADO |
| D3D11 + HEVC (Auto/NVENC) | **54.91** | 54.17 | 35.6 | 35.9 | 11.4% | 26.2% | APROVADO |
| D3D11 + HEVC (Media Foundation) | **55.52** | 52.22 | 35.9 | 52.6 | 16.8% | 26.2% | APROVADO |
| D3D11 + CPU Software (H.264) | **55.27** | 54.81 | 36 | 53.3 | 15.6% | 17.3% | APROVADO |

### 1080P @ 120 FPS — Carga Leve

**Veredito:** `D3D12 + NVENC (H.264) (Único testado com sucesso)`
**Justificativa:** Não há competidor válido nesta condição específica.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **117.29** | 94.98 | 35 | 229.3 | 19.8% | 22.9% | APROVADO |

### 720P @ 30 FPS — Carga de FPS Ilimitado

**Veredito:** `D3D12 + NVENC (H.264) (Único testado com sucesso)`
**Justificativa:** Não há competidor válido nesta condição específica.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **30.35** | 29.86 | 53.1 | 54 | 13.9% | 5.3% | APROVADO |

### 720P @ 60 FPS — Carga de FPS Ilimitado

**Veredito:** `VENCEDOR: D3D12 + NVENC (H.264)`
**Justificativa:** Ganho conclusivo de FPS (+12.8%) sem piora de frametime.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **60.11** | 59.56 | 35.8 | 88.7 | 29.6% | 10.1% | APROVADO |
| D3D11 + NVENC (H.264) | **53.3** | 52.36 | 34.9 | 36.2 | 12.3% | 9.5% | APROVADO |
| D3D11 + Media Foundation (H.264) | **53.17** | 52.86 | 35.5 | 52.7 | 17.8% | 8.6% | APROVADO |
| D3D11 + HEVC (Media Foundation) | **54.54** | 53.09 | 35.9 | 52 | 12.7% | 13.7% | APROVADO |
| D3D11 + HEVC (Auto/NVENC) | **52.09** | 51.56 | 35.6 | 53.5 | 11% | 13.5% | APROVADO |
| D3D11 + CPU Software (H.264) | **50.58** | 50.3 | 35.8 | 36 | 11.2% | 9% | APROVADO |

### 720P @ 120 FPS — Carga de FPS Ilimitado

**Veredito:** `D3D12 + NVENC (H.264) (Único testado com sucesso)`
**Justificativa:** Não há competidor válido nesta condição específica.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **120.08** | 118.43 | 18.5 | 35.2 | 14.2% | 18.4% | APROVADO |

### 1080P @ 30 FPS — Carga de FPS Ilimitado

**Veredito:** `D3D12 + NVENC (H.264) (Único testado com sucesso)`
**Justificativa:** Não há competidor válido nesta condição específica.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **18.84** | 17.02 | 106.8 | 106.8 | 19.9% | 5.4% | APROVADO |

### 1080P @ 60 FPS — Carga de FPS Ilimitado

**Veredito:** `VENCEDOR: D3D12 + NVENC (H.264)`
**Justificativa:** Ganho conclusivo de FPS (+68.3%) sem piora de frametime.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **42.54** | 41 | 53.6 | 70.9 | 12.3% | 12.5% | APROVADO |
| D3D11 + HEVC (Media Foundation) | **25.28** | 24.66 | 71.4 | 71.5 | 9.7% | 12.3% | APROVADO |
| D3D11 + HEVC (Auto/NVENC) | **23.34** | 22.25 | 70.8 | 86.9 | 13.6% | 11.2% | APROVADO |
| D3D11 + Media Foundation (H.264) | **23.37** | 22.96 | 71.1 | 106.3 | 11.8% | 6.6% | APROVADO |
| D3D11 + NVENC (H.264) | **23.15** | 21.61 | 88.9 | 89.2 | 12.3% | 7.2% | APROVADO |
| D3D11 + CPU Software (H.264) | **17.8** | 16.65 | 105.9 | 105.9 | 10% | 5.6% | APROVADO |

### 1080P @ 120 FPS — Carga de FPS Ilimitado

**Veredito:** `D3D12 + NVENC (H.264) (Único testado com sucesso)`
**Justificativa:** Não há competidor válido nesta condição específica.

| Pipeline / Configuração | Decoded FPS Mediano | Decoded FPS p10 | Frametime p95 (ms) | Pausa Máx (ms) | CPU Receptor p95 | GPU Video p95 | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | **95.11** | 92.7 | 35.6 | 52.9 | 11.7% | 22.6% | APROVADO |

## 3. Tabela Completa de Amostras Brutas

| Pipeline | Resolução | FPS Alvo | Carga | Decoded FPS | Frametime p95 | Pausa Máx | CPU RX | GPU RX | Duração |
|---|:---:|:---:|---|:---:|:---:|:---:|:---:|:---:|:---:|
| D3D12 + NVENC (H.264) | 720p | 30 | Leve | 29.4 | 52.9 ms | 71.2 ms | 28.8% | 5.1% | 67.3s |
| D3D12 + NVENC (H.264) | 720p | 60 | Leve | 59.93 | 34.9 ms | 36.2 ms | 15.8% | 9.7% | 59.9s |
| D3D12 + NVENC (H.264) | 720p | 120 | Leve | 113.44 | 18.1 ms | 194 ms | 19.7% | 17.9% | 59.6s |
| D3D11 + NVENC (H.264) | 720p | 60 | Leve | 55.35 | 35.4 ms | 53.3 ms | 16.9% | 9.5% | 58.6s |
| D3D11 + Media Foundation (H.264) | 720p | 60 | Leve | 41.14 | 159.1 ms | 510.5 ms | 15.8% | 9.7% | 59.8s |
| D3D11 + CPU Software (H.264) | 720p | 60 | Leve | 54.54 | 35.2 ms | 36 ms | 16.1% | 9.8% | 58.1s |
| D3D11 + HEVC (Auto/NVENC) | 720p | 60 | Leve | 54.26 | 35.4 ms | 36.3 ms | 10.4% | 13.8% | 59.0s |
| D3D11 + HEVC (Media Foundation) | 720p | 60 | Leve | 54.38 | 35.3 ms | 36.1 ms | 11.2% | 13.9% | 58.8s |
| Web Capture + H.264 | 720p | 30 | Leve | - | - | - | - | - | 34.1s |
| Web Capture + H.264 | 720p | 60 | Leve | - | - | - | - | - | 35.5s |
| Web Capture + AV1 | 720p | 60 | Leve | - | - | - | - | - | 36.0s |
| D3D12 + NVENC (H.264) | 1080p | 30 | Leve | 30.09 | 70.1 ms | 70.8 ms | 20.3% | 8.8% | 58.8s |
| D3D12 + NVENC (H.264) | 1080p | 60 | Leve | 60.27 | 35.2 ms | 36.1 ms | 15.5% | 17.8% | 58.1s |
| D3D12 + NVENC (H.264) | 1080p | 120 | Leve | 117.29 | 35 ms | 229.3 ms | 19.8% | 22.9% | 59.7s |
| D3D11 + NVENC (H.264) | 1080p | 60 | Leve | 55.48 | 35.5 ms | 36.2 ms | 12% | 16.2% | 60.0s |
| D3D11 + Media Foundation (H.264) | 1080p | 60 | Leve | 54.4 | 35.2 ms | 36.3 ms | 10.9% | 16.9% | 59.8s |
| D3D11 + CPU Software (H.264) | 1080p | 60 | Leve | 55.27 | 36 ms | 53.3 ms | 15.6% | 17.3% | 58.9s |
| D3D11 + HEVC (Auto/NVENC) | 1080p | 60 | Leve | 54.91 | 35.6 ms | 35.9 ms | 11.4% | 26.2% | 60.6s |
| D3D11 + HEVC (Media Foundation) | 1080p | 60 | Leve | 55.52 | 35.9 ms | 52.6 ms | 16.8% | 26.2% | 60.5s |
| Web Capture + H.264 | 1080p | 30 | Leve | - | - | - | - | - | 33.2s |
| Web Capture + H.264 | 1080p | 60 | Leve | - | - | - | - | - | 35.5s |
| Web Capture + AV1 | 1080p | 60 | Leve | - | - | - | - | - | 34.0s |
| D3D12 + NVENC (H.264) | 720p | 30 | FPS Ilimitado | 30.35 | 53.1 ms | 54 ms | 13.9% | 5.3% | 59.3s |
| D3D12 + NVENC (H.264) | 720p | 60 | FPS Ilimitado | 60.11 | 35.8 ms | 88.7 ms | 29.6% | 10.1% | 59.6s |
| D3D12 + NVENC (H.264) | 720p | 120 | FPS Ilimitado | 120.08 | 18.5 ms | 35.2 ms | 14.2% | 18.4% | 58.4s |
| D3D11 + NVENC (H.264) | 720p | 60 | FPS Ilimitado | 53.3 | 34.9 ms | 36.2 ms | 12.3% | 9.5% | 58.9s |
| D3D11 + Media Foundation (H.264) | 720p | 60 | FPS Ilimitado | 53.17 | 35.5 ms | 52.7 ms | 17.8% | 8.6% | 60.3s |
| D3D11 + CPU Software (H.264) | 720p | 60 | FPS Ilimitado | 50.58 | 35.8 ms | 36 ms | 11.2% | 9% | 58.9s |
| D3D11 + HEVC (Auto/NVENC) | 720p | 60 | FPS Ilimitado | 52.09 | 35.6 ms | 53.5 ms | 11% | 13.5% | 60.9s |
| D3D11 + HEVC (Media Foundation) | 720p | 60 | FPS Ilimitado | 54.54 | 35.9 ms | 52 ms | 12.7% | 13.7% | 61.2s |
| Web Capture + H.264 | 720p | 30 | FPS Ilimitado | - | - | - | - | - | 34.4s |
| Web Capture + H.264 | 720p | 60 | FPS Ilimitado | - | - | - | - | - | 33.9s |
| Web Capture + AV1 | 720p | 60 | FPS Ilimitado | - | - | - | - | - | 34.3s |
| D3D12 + NVENC (H.264) | 1080p | 30 | FPS Ilimitado | 18.84 | 106.8 ms | 106.8 ms | 19.9% | 5.4% | 61.8s |
| D3D12 + NVENC (H.264) | 1080p | 60 | FPS Ilimitado | 42.54 | 53.6 ms | 70.9 ms | 12.3% | 12.5% | 60.7s |
| D3D12 + NVENC (H.264) | 1080p | 120 | FPS Ilimitado | 95.11 | 35.6 ms | 52.9 ms | 11.7% | 22.6% | 61.3s |
| D3D11 + NVENC (H.264) | 1080p | 60 | FPS Ilimitado | 23.15 | 88.9 ms | 89.2 ms | 12.3% | 7.2% | 60.8s |
| D3D11 + Media Foundation (H.264) | 1080p | 60 | FPS Ilimitado | 23.37 | 71.1 ms | 106.3 ms | 11.8% | 6.6% | 61.1s |
| D3D11 + CPU Software (H.264) | 1080p | 60 | FPS Ilimitado | 17.8 | 105.9 ms | 105.9 ms | 10% | 5.6% | 60.8s |
| D3D11 + HEVC (Auto/NVENC) | 1080p | 60 | FPS Ilimitado | 23.34 | 70.8 ms | 86.9 ms | 13.6% | 11.2% | 61.4s |
| D3D11 + HEVC (Media Foundation) | 1080p | 60 | FPS Ilimitado | 25.28 | 71.4 ms | 71.5 ms | 9.7% | 12.3% | 61.4s |
| Web Capture + H.264 | 1080p | 30 | FPS Ilimitado | - | - | - | - | - | 36.0s |
| Web Capture + H.264 | 1080p | 60 | FPS Ilimitado | - | - | - | - | - | 35.9s |
| Web Capture + AV1 | 1080p | 60 | FPS Ilimitado | - | - | - | - | - | 34.4s |

## 4. Conclusões e Recomendações Técnicas

- **Comportamento sob Carga de FPS Ilimitado:** O pipeline com aceleração direta em hardware e zero-copy (D3D12/D3D11 + NVENC) isola a codificação da saturação do jogo, mantendo a cadência enquanto pipelines que dependem de leitura de CPU ou Web sofrem contenção.
- **Codecs (H.264 vs HEVC vs AV1):** H.264 mantém a maior compatibilidade e consistência de frametime no ecossistema WebRTC atual. HEVC e AV1 oferecem maior eficiência de compressão, mas exigem decodificação dedicada no receptor para evitar pausas no compositor.
- **Taxas de Quadros (30 vs 60 vs 120 FPS):** 60 FPS permanece como o ponto ideal (sweet spot) de fluidez e latência. 30 FPS não reduz a latência proporcionalmente e aumenta o frametime p95. 120 FPS decodifica com sucesso (~119 FPS), mas é limitado pela taxa de atualização do monitor do receptor (60 Hz).
