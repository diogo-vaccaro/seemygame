# Revalidação do benchmark D3D12, NVENC e Web — 2026-10-07

## Parecer

A rodada favorece WGC/D3D12 + NVENC/H.264 em FPS decodificado entre as configurações nativas comparadas. Não demonstra uma configuração definitiva, imunidade a GPU saturada, vantagem sobre Web ou benefício causal da prioridade alta. Em 1080p/60 sob carga, o D3D12 não sustentou 60 FPS.

Esta revisão inspecionou os artefatos existentes e o código do instrumento. Não executou novos testes de carga nem alterou a aplicação.

## Evidências e escopo

- Consolidado: `output/playwright/goal-benchmark-2026-10-07T02-49-37-822Z-dd18a7/master-report.json`.
- Documento gerado: `docs/benchmark-codecs-encoders-apis-2026-10-07.md`.
- 44 casos: 32 sucessos funcionais nativos e 12 falhas Web. Todos os 32 sucessos têm qualificação `insufficient-evidence`, com 3–4 amostras e 2.991,5–4.000,7 ms de janela estável.
- Uma execução por configuração, em ordem fixa, sem repetições ou intervalos de confiança.
- Desktop emissor e notebook receptor Chrome, via Tailscale. Carga sintética WebGL2; não é uma sessão de jogo real.
- Captura nativa de janela WGC com `--native-without-preview`. Não representa uma comparação WGC versus DXGI, nem necessariamente o custo completo da prévia normal da aplicação.
- Sem áudio; amostragem óptica desativada (`opticalHz: 0`), `glassToGlassLatency: null`. O receptor declara `physicalPresentation: false`: contadores de decodificação/apresentação não comprovam atualização física do monitor.

## Resultados nativos relevantes

Mesma família de codec/encoder, alvo 60 FPS e carga `gpu-unlimited`:

| Captura / encoder | Resolução | FPS decodificado mediano | Frametime p95 | Pausa máxima |
|---|---:|---:|---:|---:|
| D3D12 / NVENC H.264 | 720p | 60,11 | 35,8 ms | 88,7 ms |
| D3D11 / NVENC H.264 | 720p | 53,30 | 34,9 ms | 36,2 ms |
| D3D12 / NVENC H.264 | 1080p | 42,54 | 53,6 ms | 70,9 ms |
| D3D11 / NVENC H.264 | 1080p | 23,15 | 88,9 ms | 89,2 ms |

Artefatos individuais, respectivamente:

1. `output/playwright/2026-10-07T03-12-23-977Z-c644cc/report.json`.
2. `output/playwright/2026-10-07T03-14-32-643Z-71243c/report.json`.
3. `output/playwright/2026-10-07T03-23-05-875Z-900c1d/report.json`.
4. `output/playwright/2026-10-07T03-25-18-767Z-bcdf1e/report.json`.

O ganho em FPS é promissor. Entretanto, a maior pausa em 720p impede afirmar superioridade uniforme de fluidez. Em 1080p há melhoria substancial em relação ao D3D11, mas queda de aproximadamente 29% em relação ao alvo de 60 FPS. A prioridade alta já é solicitada nesse caminho; não há um teste adicional que demonstre recuperar os 60 FPS ao ativá-la.

O p10 do contador de apresentação na qualificação do D3D12 foi aproximadamente 44,8 em 720p e 28,0 em 1080p. Esse contador tem limitações próprias e não mede scanout físico, mas reforça que FPS decodificado sozinho não basta para homologar fluidez.

## Problemas que invalidam conclusões mais fortes

### 1. As falhas Web são de perfil de captura

Os 12 casos falharam com `Web capture did not apply the requested test profile`, em `tools/e2e/run.mjs:1055`, antes da amostragem de desempenho. As dimensões finais capturadas foram 1152×720 para o alvo 1280×720 e 1898×1080 para 1920×1080, com FPS solicitado aplicado. Houve falhas mesmo sem carga.

Em pelo menos um artefato, o registro inicial `testProfile.captureSettings` contém 1280×720, enquanto o `webCapture.settings` posterior contém 1152×720. É necessário investigar mudança de geometria da janela e o momento da leitura; não basta chamar isso de incapacidade do navegador sob carga ou ignorar o erro.

### 2. A duração da execução é diferente da janela medida

`tools/e2e/comprehensive-matrix-goal.mjs:150` usa `durationSec = 10`. `tools/e2e/run.mjs:533` reserva cinco intervalos para aquecimento e dois para encerramento. Os aproximadamente 60 segundos da coluna de duração incluem inicialização e preparação; não correspondem a 60 segundos de desempenho estável.

### 3. A carga não é equivalente entre resoluções

A fonte usa a mesma resolução da transmissão. O shader offscreen com 16 passes também muda de tamanho, alterando simultaneamente o custo do jogo simulado e o da captura.

Nos resumos de recursos de toda a coleta, o p95 do engine GPU mais ocupado ficou em aproximadamente 10–11% nos dois casos 720p e 97–98% nos dois casos 1080p. Esses resumos não são exclusivamente da janela estável e requerem correlação temporal, mas o rótulo `gpu-unlimited` sozinho não comprova GPU saturada em 720p. O loop é dirigido por `requestAnimationFrame`, sujeito à cadência do ambiente, não um jogo com submissão realmente ilimitada.

Há também processos externos consumindo CPU. A ordem fixa dos casos não controla essa variação nem efeitos térmicos. A próxima comparação deve manter a carga independente da resolução transmitida.

### 4. D3D12 não concede prioridade automaticamente

`src-tauri/src/media/platform.rs:86` solicita prioridade alta de CPU e prioridade de processo GPU, verificando o retorno desta última. O código esclarece que isso não garante prioridade por dispositivo/fila nem FPS sob saturação. A configuração não é exclusiva do D3D12. A matriz não compara prioridade normal contra alta nem consolida os logs de aplicação efetiva como fator experimental.

A Microsoft distingue prioridades normal, alta e global realtime de filas D3D12. A última exige privilégios e suporte de hardware/driver. Escolher a API D3D12 não demonstra que uma fila realtime foi criada. [Documentação Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ne-d3d12-d3d12_command_queue_priority).

Também é excessivo afirmar que o navegador não possui agendamento de hardware assíncrono. A página não dispõe de uma opção em `getDisplayMedia` para exigir prioridade GPU; isso não caracteriza toda a implementação nativa do navegador ou garante que o caminho Rust vencerá a disputa por recursos. [Especificação da API de captura, em elaboração](https://www.w3.org/TR/screen-capture/).

### 5. O caminho H.264 ainda faz interop D3D12 → D3D11

`src-tauri/src/media/pipeline.rs:108` adiciona `d3d12download` com saída `D3D11Memory`, seguida do mesmo encoder NVENC D3D11. Isso não comprova uma cópia por CPU: a negociação especifica memória D3D11. Também não prova ausência de cópias, sincronização ou contenção. Atribuir a vantagem exclusivamente a zero-copy ou isolamento da GPU requer evidência adicional.

### 6. O gerador do relatório declara mais do que calcula

`analyzeBenchmarkResults`, em `tools/e2e/comprehensive-matrix-goal.mjs`, classifica vencedores por limiares de FPS/frametime. Não calcula significância estatística, não exige qualificação suficiente e não considera a pausa máxima no critério, embora o texto prometa evitar regressão de pausas/jitter. As recomendações finais nas linhas 414–416 são texto fixo, inclusive sobre Web e latência, sem resultados válidos dessas variáveis nesta rodada.

Há ainda um problema operacional: a limpeza remota na linha 31 encerra processos `node` e `chrome` de forma ampla. Antes de reutilizar o runner, a limpeza deve ficar limitada aos processos e tarefas criados pela execução.

## Conclusão substituta recomendada

> Nesta máquina e nesta rodada sintética, WGC/D3D12 + NVENC/H.264 apresentou maior FPS decodificado que WGC/D3D11 + o mesmo encoder. 720p/60 é uma candidata inicial promissora, ainda sem homologação de estabilidade prolongada. Em 1080p/60 sob carga, o resultado foi 42,5 FPS, portanto não houve manutenção do alvo de 60 FPS. Não foi demonstrado que D3D12 elimina travamentos ou que a prioridade alta explica o ganho. A comparação com Web ficou inconclusiva devido a falhas de geometria da captura. Limitar FPS do jogo é uma mitigação prática quando libera recursos, mas esta rodada não determina um limite universal de 60/120 FPS ou V-Sync.

## Próxima rodada focada

1. Corrigir e testar a estabilidade da geometria Web, registrando dimensão da fonte, captura e vídeo recebido durante todo o teste. Manter a validação de perfil.
2. Separar aprovação funcional, qualificação de desempenho e conclusão comparativa. Remover recomendações fixas e incluir regressões de pausas no critério.
3. Fixar a carga em uma resolução independente da transmissão. Confirmar pressão real de GPU/CPU na janela estável e registrar processos externos, temperatura e clocks quando disponíveis.
4. Comparar apenas D3D11/NVENC/H.264, D3D12/NVENC/H.264 e Web/H.264 inicialmente: 720p/60 e 1080p/60, com pelo menos 60 segundos estáveis e 3–5 repetições em ordem alternada/randomizada. Preservar bitrate, fonte, receptor, áudio, replay e estado da prévia.
5. Fazer um experimento separado de prioridade normal/alta, verificando valores efetivos. Confirmar depois em jogo real, com e sem limite de FPS, incluindo custo de manter a experiência normal da aplicação.
6. Reativar medição óptica de baixa sobrecarga com calibração de relógios e incerteza explícita. Relatar latência p50/p95/p99, FPS apresentado, pausas, descartes e a linha do tempo dos estágios. Frametime não substitui latência glass-to-glass.

Não é necessário repetir a matriz inteira antes de resolver a captura Web e o critério de qualificação. Essas correções têm maior valor diagnóstico que acrescentar novos codecs à matriz atual.
