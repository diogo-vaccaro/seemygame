# Diagnóstico causal da latência sob carga GPU — 04/10/2026

Os novos testes reproduziram o aumento de latência **sem encoder, rede ou decoder WebRTC**. O principal sinal é acúmulo de trabalho no caminho gráfico compartilhado pela fonte, captura e apresentação. Limitar o trabalho GPU em voo na fonte sintética recuperou grande parte da latência, mantendo sua taxa de submissão acima de 60 FPS. Isso localiza melhor o problema; ainda não identifica qual fila ou contexto do driver/DWM concentra a espera em um jogo real.

## O que foi implementado

- Sondas Rust apenas para testes, correlacionando o mesmo quadro por PTS normalizado pelo segmento GStreamer. Medem captura→entrada do encoder, entrada→saída do encoder, travessia das duas filas, conversão e interop. Guardam evidência por quadro e preservam ausências como `null`.
- Leitura de idade do PTS usando o relógio do próprio pipeline. Essa idade não é a idade óptica do conteúdo: um buffer recém-capturado pode conter uma imagem antiga da janela.
- Carga GPU offscreen: o shader pesado continua executando, mas a cena capturada permanece igual. Isso reduz a confusão entre contenção GPU e complexidade de compressão.
- Medição CPU-submissão→disponibilidade observada de query GPU, separada do tempo GPU da query. É uma observação com atraso de polling em rAF, não uma medição exata de espera ou scanout.
- Controle `gpu-bounded`: até dois lotes de trabalho em voo, usando fences não bloqueantes, sem impor 60 FPS. Controle `gpu-flush`: submissão explícita dos comandos, sem limitar os lotes em voo. Controle `gpu-capped`: fonte de carga limitada a 60 FPS.
- Microbenchmark Chrome com `getDisplayMedia→video` e com H264/WebRTC local. O primeiro remove encode/transporte/decode WebRTC da hipótese.
- Validação que rejeita relatórios sem amostras ópticas suficientes ou sem correlação por quadro suficiente. Correção do detector para considerar a largura real da fonte, incluindo escalas fracionárias introduzidas pelas bordas da janela.
- Exportação JSON/Markdown e integração dos perfis ao E2E e à matriz existentes.

## Resultados principais

Foram consolidados **34 casos válidos**: 8 sondas nativas, 16 microbenchmarks de captura/browser, 6 controles de submissão e 4 E2E do aplicativo. Houve duas repetições com ordem invertida. Pilotos e execuções sem leitura óptica válida foram excluídos da consolidação.

Os números abaixo são **faixas das medianas de cada execução**, não percentis calculados sobre uma mistura de execuções.

| Caminho | Carga livre: p50 | Dois lotes em voo: p50 | Evidência complementar |
| --- | --- | --- | --- |
| Chrome, captura→video, sem WebRTC | 95–100 ms | 44–46 ms | O atraso aparece sem encode/rede/decode WebRTC |
| Chrome, H264/WebRTC local | 115–116 ms | 66–68 ms | Encode fica aproximadamente 4,9–5,2 ms entre condições |
| Aplicativo nativo→Chrome, E2E | 139–144 ms | 67–72 ms | Decode aproximadamente 60 FPS nas quatro execuções |

No E2E nativo, o p99 caiu de **182–200 para 92–94 ms**. Decode ficou entre aproximadamente 0,57 e 0,61 ms; jitter, entre 8,0 e 8,2 ms. Esses componentes não cresceram proporcionalmente à latência óptica. O FPS alto, sozinho, não certifica que a imagem é recente nem que seu conteúdo foi atualizado em cada apresentação.

Na sonda nativa, a mediana do percurso saída da captura→vídeo codificado foi aproximadamente **1,96 ms sem carga** e **4,71–4,74 ms com carga livre**. A mediana entrada→saída do encoder ficou em aproximadamente 1,60 e 4,38–4,41 ms, respectivamente. A fila anterior ao encoder apresentou p95 em torno de **0,02 ms**; a fila de captura, também centésimos de milissegundo. Foram correlacionados **5.800 quadros completos**, sem evicção por limite de memória, com decomposição consistente dentro do mesmo quadro. Esse ensaio não encontrou acúmulo grande nas filas medidas depois da captura.

Nos microbenchmarks iniciais, o tempo até observar a conclusão GPU ficou em torno de **94–95 ms** com carga livre e **16 ms** com dois lotes em voo. A fonte de carga continuou submetendo cerca de 108–111 lotes/s no controle, contra 109–112 lotes/s com carga livre. No E2E nativo, essa mesma observação caiu de aproximadamente **110 para 18,3 ms**, com taxa de submissão próxima de 96 lotes/s em ambas as condições.

O controle adicional com `gl.flush()` sozinho apresentou **109 ms** de mediana nas duas repetições, contra **102–109 ms** sem controle e **48 ms** com dois lotes em voo. Portanto, nesse experimento, antecipar a submissão sem limitar trabalho pendente não recuperou a latência. Ocorreram picos pontuais de CPU externa em processos Chrome nesse controle; a mediana de CPU externa permaneceu próxima de 1–2%. Isso limita uma atribuição exclusiva ao mecanismo de fila.

## O que está confirmado e o que ainda é hipótese

**Confirmado neste ambiente:** o caminho sem WebRTC é suficiente para reproduzir a piora; a intervenção no trabalho GPU da fonte reduz a idade óptica; o E2E nativo mantém cerca de 60 FPS mesmo quando apresenta imagem muito mais antiga; as filas GStreamer medidas após captura não acumularam dezenas de milissegundos; o encode nativo observado acrescentou poucos milissegundos sob carga.

**Causa mais provável:** contenção e acúmulo no caminho gráfico antes da entrega de uma imagem recente, incluindo submissão da fonte, scheduling e composição. O receptor compartilha a GPU, portanto sua apresentação também pode contribuir. Não podemos apontar exclusivamente WGC, DWM, uma fila de hardware ou o compositor do receptor com esses dados.

**Ainda não demonstrado:** que toda a diferença vem da fonte; que a prioridade GPU do worker falhou; que um jogo terá o mesmo ganho; que CPU, áudio, replay ou rede real não causarão outros stutters; que o problema da aplicação já foi corrigido. A intervenção foi feita no gerador de carga do teste, não na aplicação ou no jogo do usuário.

## Limites de comparação

- Fonte, transmissor e receptor compartilham esta máquina. Não se trata de um benchmark isolado do transmissor.
- As intervenções mudam a utilização GPU além da profundidade de trabalho pendente. Não houve experimento com utilização GPU exatamente igual entre tratamentos.
- A sonda nativa usa o construtor real de pipeline, mas roda em processo de teste com prioridade normal, sem WebRTC, áudio, replay ou receptor. A captura WGC bruta ficou em 1944×1093, convertida para 1920×1080 antes do encoder; o Chrome entregou 1920×1080. Esses ensaios localizam etapas, sem sustentar um comparativo absoluto justo entre APIs de captura.
- O E2E usa release com frontend congelado e adaptador diagnóstico sem preview local. Os bytes codificados percorrem o worker/bridge/WebRTC reais; isso não homologa todo o fluxo da UI de produção.
- Foram 12 segundos de coleta por microbenchmark e 70 intervalos por E2E, incluindo exclusões de warmup/cooldown. Duas repetições estabelecem uma tendência reproduzida, sem representar p99 de longo prazo.
- A leitura óptica roda a 8 Hz e tem custo registrado. Ela não detecta todas as repetições do conteúdo entre frames. Os tempos usam apresentação estimada do compositor, sem medir a iluminação física do monitor.
- As queries pendentes têm limite de 8 amostras e não contam todos os lotes GPU em voo. Tempos de query e de pads podem incluir scheduling/esperas; não são tempos puros de execução de cada componente.
- Não se subtraem medianas de execuções distintas para atribuir um número exato de milissegundos a uma etapa.

## Próximo teste com maior valor

Reproduzir com um jogo real e um receptor em outra máquina, mantendo o mesmo encoder, resolução, áudio/replay desativados e coleta de recursos. Comparar jogo livre, limite de FPS e mecanismo de baixa latência do jogo/driver, quando disponível. Coletar GPU/ETW com GPUView/WPA/PresentMon para relacionar submissão, scheduling e apresentação aos intervalos de aumento da idade óptica. O rastreamento deve ser curto e ter controle sem tracing, pois também acrescenta sobrecarga.

Isso distingue atraso já presente na fonte de atraso introduzido pela captura ou pelo receptor. Só depois faz sentido alterar filas, prioridades ou encoder no produto. Em paralelo, falta um ensaio CPU isolado, sem a carga GPU, para verificar starvation de threads e cores ocupados.

## Como repetir

```powershell
# Sondas nativas, sem transporte ou receptor:
node tools/e2e/native-capture-stages.mjs --capture d3d12 --backend nvenc --width 1920 --height 1080 --bitrate 7500 --fps 60 --seconds 12 --repeat 2 --workload-profiles off,gpu-unlimited,gpu-bounded,gpu-capped --workload-scene offscreen --workload-passes 16 --position 0,0

# Captura local e WebRTC H264 local; requer os dois monitores usados neste estudo:
node tools/e2e/browser-capture-stages.mjs --seconds 12 --repeat 2 --profiles off,gpu-unlimited,gpu-bounded,gpu-capped --modes raw,webrtc --workload-scene offscreen --workload-passes 16

# Controle de submissão, sem encode:
node tools/e2e/browser-capture-stages.mjs --seconds 12 --repeat 2 --profiles gpu-unlimited,gpu-flush,gpu-bounded --modes raw --workload-scene offscreen --workload-passes 16
```

Para repetir o E2E do aplicativo, usar `local-media-matrix.mjs` com `--cases native-h264-nvenc-d3d12`, `--source-workload gpu-unlimited` ou `gpu-bounded`, `--workload-scene offscreen` e `--workload-passes 16`. O binário e o frontend servido precisam corresponder. Nesta rodada, o executável release foi mantido intacto e o frontend foi copiado do snapshot já validado para um novo snapshot de testes.

Validação: **53 testes JS aprovados**, **3 testes Rust aprovados**, 34 casos consolidados válidos, 4 E2E com qualificação de cadência aprovada. Os hashes dos dois executáveis release permaneceram iguais aos valores anteriores. As sondas Rust novas são compiladas apenas em `cfg(test)`.

## Artefatos

- [Resumo numérico consolidado](G:/SeeMyGame/output/playwright/causal-load-study-2026-10-04/summary.json)
- [Tabelas por execução e referências dos relatórios brutos](G:/SeeMyGame/output/playwright/causal-load-study-2026-10-04/measurements.md)
- [Driver da comparação E2E nativa](G:/SeeMyGame/output/playwright/causal-load-study-2026-10-04/run-e2e.mjs)
- [Sonda Rust por quadro](G:/SeeMyGame/src-tauri/src/media/frame_journey_probe.rs)
- [Sonda de captura do navegador](G:/SeeMyGame/tools/e2e/browser-capture-stages.mjs)
