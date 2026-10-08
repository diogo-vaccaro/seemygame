# Validação do benchmark corrigido — 8 de outubro de 2026

Matriz principal e três controles de instrumentação encerrados: 39 recepções funcionais. As correções desta entrega são no harness e no diagnóstico; os stutters de transmissão ainda exigem correções específicas.

## Correções aplicadas

- Calibração da janela física também no transmissor Web: o teste deixou de comparar 1152×720 com 1280×720, ou 1898×1080 com 1920×1080.
- Fonte e carga sintética fixas em 1920×1080 a 60 FPS, independentemente da resolução transmitida. A resolução de saída é uma variável separada.
- Três repetições, com rotação da ordem de D3D11, D3D12 e Web e inversão da ordem das condições na segunda repetição.
- Janela solicitada de 75 intervalos por caso; qualificação considera a duração e os intervalos efetivamente coletados, em vez de aceitar amostras de poucos segundos.
- Aprovação funcional, qualificação de qualidade e validade da latência são avaliações separadas. Uma transmissão recebida pode falhar em fluidez; uma calibração rejeitada não fornece uma latência válida.
- Congelamento dos hashes do executável e do harness durante o estudo; relatórios separados por execução; preservação dos erros e dos artefatos de origem.
- Correção do leitor de prontidão SSH para JSON formatado e JSONL. Limpeza restrita aos processos e tarefas criados pelo teste.

## Protocolo

```powershell
node tools/e2e/comprehensive-matrix-goal.mjs --repeat 3 --seconds 75
```

36 casos: três caminhos H.264, duas resoluções, duas condições de carga e três repetições. Transmissor no desktop e receptor Chrome no notebook, com perfis isolados. Áudio e replay desligados; nativo sem prévia. Bitrate solicitado: 4500 kbps em 720p e 7500 kbps em 1080p. Leitura óptica a 8 Hz, com calibração antes, durante e depois da janela.

O desktop utiliza uma RTX 3070; o notebook tem Ryzen 7 5800H e o receptor Chrome 154.0.8037.98. A evidência do pipeline confirma captura WGC/D3D12, conversão D3D12 e interop para `D3D11Memory` antes de `nvd3d11h264enc`. Portanto, o nome D3D12 neste estudo identifica o caminho de captura/conversão; não representa um encoder H.264 inteiramente D3D12.

A qualificação de 60 FPS exige percentil 10 de decode e apresentação de pelo menos 54 FPS, visibilidade e perfil corretos, além de ausência de pausas consecutivas acima de aproximadamente 66,7 ms. Uma reprovação próxima de um limiar deve ser lida com os valores efetivos, não transformada automaticamente em uma descrição de transmissão inutilizável.

O nome `gpu-unlimited` identifica a carga WebGL sintética; não certifica saturação de 100%. O uso efetivo de CPU/GPU deve ser consultado nas amostras. Tampouco reproduz todos os jogos.

Artefatos: [master-report.json](../output/playwright/focused-benchmark-2026-10-08T01-43-51-307Z-22ecce/master-report.json) e [benchmark-report.md](../output/playwright/focused-benchmark-2026-10-08T01-43-51-307Z-22ecce/benchmark-report.md).

## Resultados da matriz principal

36/36 casos receberam vídeo e tiveram duração suficiente para avaliação: janelas estáveis de aproximadamente 81–85 segundos. Nenhum passou integralmente pelo critério de qualidade de 60 FPS. 34/36 latências foram qualificadas; os casos 13 e 17 foram excluídos da análise de latência porque o envelope da calibração excedeu 10 ms. Seus FPS permanecem disponíveis. Não houve alteração dos hashes dos 307 arquivos comparados entre os casos.

Os valores abaixo são **medianas das estatísticas de três execuções**, e não percentis de uma distribuição conjunta. A coluna de apresentação é a mediana dos percentis 10 de FPS apresentado de cada execução; não deve ser confundida com FPS mediano.

| Carga | Saída | Pipeline | FPS decode mediano | Apresentação p10 | Latência p50 ms | Latências válidas | Maior pausa ms |
|---|---|---|---:|---:|---:|---:|---:|
| Sem carga | 720p | D3D11/NVENC | 54,83 | 47,0 | 59 | 3/3 | 1679,4 |
| Sem carga | 720p | D3D12/NVENC | 60,01 | 53,9 | 81 | 3/3 | 2034,1 |
| Sem carga | 720p | Web | 52,83 | 46,0 | 87 | 3/3 | 142,0 |
| Sem carga | 1080p | D3D11/NVENC | 54,77 | 47,0 | 60 | 3/3 | 264,9 |
| Sem carga | 1080p | D3D12/NVENC | 60,04 | 54,0 | 83 | 3/3 | 490,5 |
| Sem carga | 1080p | Web | 52,93 | 46,0 | 92 | 3/3 | 249,7 |
| Com carga | 720p | D3D11/NVENC | 23,74 | 19,9 | 162 | 3/3 | 1359,8 |
| Com carga | 720p | D3D12/NVENC | 57,81 | 23,0 | 191 | 3/3 | 615,6 |
| Com carga | 720p | Web | 16,91 | 14,0 | 247 | 2/3 | 192,3 |
| Com carga | 1080p | D3D11/NVENC | 23,66 | 20,0 | 165 | 3/3 | 1077,0 |
| Com carga | 1080p | D3D12/NVENC | 57,54 | 24,0 | 195 | 2/3 | 528,6 |
| Com carga | 1080p | Web | 16,10 | 14,0 | 267 | 3/3 | 142,9 |

O D3D12 tem uma vantagem repetível de FPS decodificado sob esta carga. Contudo, aproximadamente 58 FPS de decode não se convertem em 58 FPS uniformemente apresentados: há uma diferença relevante de cadência no receptor. A latência nativa D3D12 também supera a D3D11 neste cenário. Isso exige diagnóstico de pacing e apresentação, não uma declaração de vitória baseada apenas em decode.

O percentil 95 do motor de GPU mais ocupado fica, em mediana entre execuções, em aproximadamente 72–75% sob carga. O teste comprova contenção com esta carga sintética, **não saturação de 100%, prioridade garantida ou imunidade a stutters em jogos**. As pausas maiores devem ser interpretadas com perda e feedback de rede; não são uma medida isolada de estabilidade da API de captura.

A [análise detalhada](../output/playwright/focused-benchmark-2026-10-08T01-43-51-307Z-22ecce/detailed-analysis.json) preserva faixas entre repetições, recursos e correlações de pausas. A correção de dois rótulos de erro manteve [cópia do relatório original](../output/playwright/focused-benchmark-2026-10-08T01-43-51-307Z-22ecce/master-report.original.json), hash e histórico em `postProcessing`; os valores medidos não foram modificados.

## Validação automatizada

Seis arquivos e 26 testes aprovados, cobrindo planejamento, ausência de evidência, regressões de pausa, diagnóstico de calibração, prontidão SSH, geometria, perfil e carga sintética. Build frontend e build Rust release concluídos. A validação E2E de geometria confirmou 1280×720 e 1920×1080 efetivos no Web após a calibração física.

```powershell
npx vitest run tests/e2e-benchmark-study.test.js tests/e2e-benchmark-outcome.test.js tests/e2e-ssh-messages.test.js tests/e2e-capture-geometry.test.js tests/e2e-stream-profile.test.js tests/e2e-game-workload.test.js
```

## Controles sem leitura óptica

Mantidos receptor, fonte/carga, perfil e calibrações; somente a leitura óptica foi desativada. Estes são controles exploratórios de uma execução por condição, sem latência visual e sem força estatística equivalente às três repetições principais.

```powershell
node tools/e2e/comprehensive-matrix-goal.mjs --repeat 1 --seconds 75 --pipelines d3d12-nvenc-h264 --resolutions 720p --workloads off,gpu-unlimited --optical-hz 0
node tools/e2e/comprehensive-matrix-goal.mjs --repeat 1 --seconds 75 --pipelines web-chrome-h264 --resolutions 720p --workloads gpu-unlimited --optical-hz 0
```

| Pipeline / carga | Leitura óptica | FPS decode mediano | Apresentação p10 | Frametime p95 ms | Maior pausa ms |
|---|---:|---:|---:|---:|---:|
| D3D12 / sem carga | 8 Hz, mediana de 3 runs | 60,01 | 53,9 | 35,2 | 2034,1 (pior run) |
| D3D12 / sem carga | 0 Hz, 1 run | 60,09 | 51,1 | 35,5 | 43,6 |
| D3D12 / com carga | 8 Hz, mediana de 3 runs | 57,81 | 23,0 | 106,2 | 615,6 (pior run) |
| D3D12 / com carga | 0 Hz, 1 run | 57,59 | 23,0 | 105,1 | 126,0 |
| Web / com carga | 8 Hz, mediana de 3 runs | 16,91 | 14,0 | 124,5 | 192,3 (pior run) |
| Web / com carga | 0 Hz, 1 run | 16,42 | 14,0 | 125,4 | 141,6 |

A diferença entre decode e apresentação persiste sem leitura óptica. O controle não sustenta que o leitor seja sua causa principal. Tampouco se deve atribuir a melhora das pausas máximas à remoção do leitor: os piores episódios principais coincidem com sinais de recuperação de rede, e uma execução adicional não controla perdas sem fio.

Artefatos dos controles: [D3D12](../output/playwright/focused-benchmark-2026-10-08T03-15-35-707Z-0160a5/master-report.json) e [Web](../output/playwright/focused-benchmark-2026-10-08T03-21-26-521Z-7af230/master-report.json). O Web também continua limitado, com apresentação p10 de 14 FPS sem leitura óptica. Os três controles recebem vídeo, mas reprovam os critérios de fluidez; nenhum produz uma latência visual.

## Evidências que orientam a investigação

Há pausas longas que coincidem com perda RTP, sem interrupção equivalente no worker. Por exemplo, no D3D11/720p/sem carga/repetição 3, o intervalo 70 registra fonte a 60 FPS, worker a 54,49 FPS, receptor a 6,80 FPS, 121 pacotes perdidos, três NACK, um PLI e pausa de 1679,4 ms. No intervalo seguinte há mais 105 pacotes perdidos. Isso localiza o problema desse episódio depois do worker; não identifica sozinho o responsável entre transporte, recuperação e receptor.

No D3D12/720p/com carga/repetição 1, há intervalos de apresentação de aproximadamente 104–108 ms sem perda RTP observada, embora o FPS médio de decode permaneça próximo de 58. Essa é uma investigação distinta: regularidade do handoff, timestamps, entrega em rajadas e apresentação. Média de FPS não demonstra cadência uniforme.

No Web/1080p/com carga/repetição 3, a fonte mantém mediana de 58 FPS, mas o outbound observado fica em torno de 16 FPS. O navegador declara `qualityLimitationReason=none` nos 68 intervalos estáveis; uma amostra registra encode de 5,39 ms com `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`. Isso não comprova que toda a demora esteja no encoder, nem que não exista contenção: faltam a cadência real da trilha capturada e tempos de fila antes do encode. Os 60 FPS em `getSettings()` representam o perfil da trilha, não uma contagem de quadros efetivamente produzidos.

## Hipóteses de código ainda não comprovadas

O vídeo nativo passa por `udpsrc do-timestamp=true → depay → pay → webrtcbin`, enquanto o áudio possui um jitterbuffer explícito. A documentação do [rtpjitterbuffer](https://gstreamer.freedesktop.org/documentation/rtpmanager/rtpjitterbuffer.html) descreve a reconstrução de PTS a partir do timestamp RTP. A propriedade [perfect-rtptime](https://gstreamer.freedesktop.org/documentation/rtplib/gstrtpbasepayload.html) é documentada como limitada a áudio; ativá-la no payloader de vídeo não comprova preservação do relógio original.

Isso justifica comparar os deltas dos timestamps RTP de entrada e saída com os intervalos de chegada, antes de alterar o pipeline. Não demonstra que adicionar um jitterbuffer seja automaticamente a melhor correção: ele também acrescenta latência.

Outra hipótese é a propagação de feedback de recuperação até o encoder, que está em um worker separado por UDP. Medir PLI/NACK, retransmissões e chegada do próximo IDR é mais informativo que reduzir o GOP sem evidência.

## Limitações

O medidor óptico compara a produção da marca na fonte com metadados de apresentação do navegador; não certifica scanout físico. Leituras de pixels têm custo mensurável e exigem controle sem leitura óptica. A rede sem fio do notebook pode introduzir perdas. Prioridade alta versus normal não é uma variável deste estudo. Nenhum destes dados autoriza prometer imunidade a stutters ou uma configuração universal definitiva.

## Próximas correções e experimentos dirigidos

1. **Regularidade do relógio RTP nativo:** medir, por frame, timestamp RTP e intervalo de chegada antes e depois de depay/pay. Comparar a variação do relógio original com a saída da ponte. Só então prototipar preservação/reconstrução de timestamps e comparar apresentação, filas e latência. Critério: reduzir frametime/pausas sem apenas aumentar buffering ou manter alto o contador de decode.
2. **Recuperação após perda:** verificar negociação e uso efetivo de RTX/NACK, registrar PLI e o tempo até o próximo IDR. Introduzir perda controlada no caminho de teste e observar a propagação do pedido ao encoder separado por UDP. Critério: recuperação previsível e curta, sem depender de um próximo keyframe periódico. Zero perda líquida não substitui esse teste.
3. **Origem da queda de FPS no Web:** coletar cadência efetiva da trilha e tracing de captura, conversão e envio ao encoder. Comparar com outbound e com a fonte de 60 FPS. Critério: identificar a primeira etapa que cai para aproximadamente 17 FPS. `getSettings().frameRate` e `qualityLimitationReason=none` não bastam.
4. **Apresentação do receptor:** usar o probe local já existente para isolar rAF/compositor e reprodução de vídeo, com leitura óptica desligada e sem mídia de rede. Separar limitações do receptor das irregularidades do sender e do relógio RTP.

A recomendação provisória é D3D12/NVENC para preservar FPS de decode sob esta carga, com seleção manual e fallback. Não há base para escrever que D3D12 garante prioridade, impede travamentos ou que 1080p fica estável apenas por elevar a prioridade do processo. A comparação 720p versus 1080p também inclui mudança de bitrate, portanto não é uma estimativa isolada do custo de resolução.
