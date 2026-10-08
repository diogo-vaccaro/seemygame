# Diagnóstico dirigido do relógio RTP nativo

Estudo E2E concluído: cinco recepções funcionais e cinco latências válidas. O padrão de produção permanece `arrival`; o modo `rtp` é um protótipo explicitamente selecionado pelo harness.

## Hipótese e prova isolada

O handoff interno recebe RTP do worker, desfaz seu empacotamento e empacota novamente para WebRTC. `udpsrc do-timestamp=true` fornece o tempo de chegada local. Sem reconstrução do relógio RTP, esses PTS podem alterar o relógio de mídia do segundo payloader. Não é equivalente a uma segunda codificação.

O teste `depay_repay_video_clock_can_reconstruct_original_rtp_ticks` gera seis frames H.264 válidos, incluindo SPS/PPS. Seus timestamps RTP avançam em 1500 ticks a 90 kHz (16,67 ms), enquanto os PTS seguem 0, 1, 33, 34, 66 e 67 ms. No caminho atual, os timestamps de saída alternam entre intervalos de 1 e 32 ms. Com `rtpjitterbuffer latency=0 mode=none` antes do depay, os intervalos originais são reconstruídos, com tolerância de três centésimos de milissegundo para arredondamento.

Essa prova confirma o mecanismo de transformação de relógio no fluxo sintético. Não demonstra sozinha que ele seja responsável por todos os stutters, nem que o protótipo reduza a latência real.

## Instrumentação

`RtpCounters` exporta uma janela limitada a 256 pares de markers de vídeo: distribuição do intervalo RTP, intervalo de chegada e diferença entre ambos. SSRC e wrap são tratados; markers fora da ordem não entram na distribuição. São observações locais, sem decode, leitura de pixels, payload exportado ou certificação de instante de captura/saída da NIC.

As três etapas são worker-handoff, bridge-input e bridge-output. O modo efetivamente ativo é exportado pela ponte. O harness bloqueia o estudo se o modo observado não corresponder ao solicitado.

## Protocolo E2E

```powershell
node tools/e2e/rtp-clock-ab.mjs
```

Mesmo release, D3D12/WGC + NVENC/H.264, 720p60, orçamento de 4500 kbps, fonte/carga 1920×1080, carga WebGL de 16 passes, desktop transmitindo e Chrome do notebook recebendo. Replay, áudio e prévia nativa desligados. 75 intervalos por caso, leitura óptica a 8 Hz com calibração dos relógios. Ordem sob carga: arrival → rtp → arrival → rtp, seguida de rtp sem carga. Executável e arquivos principais do harness têm hashes congelados.

Artefato: [report.json](../output/playwright/rtp-clock-ab-2026-10-08T10-34-18-953Z-316014/report.json).

## Validação anterior ao E2E

- Cinco testes do contador RTP aprovados, incluindo wrap, troca de SSRC, rajadas e limite de histórico.
- 14 testes da ponte aprovados, incluindo reconstrução de relógio com H.264 real, negociação e áudio.
- 15 testes do harness aprovados em três arquivos.
- Builds frontend e Rust release concluídos.

O teste inicial com um payload arbitrário semelhante a IDR não produziu saída válida e foi substituído por uma fixture H.264 codificada com SPS/PPS. Esse erro de fixture não foi tratado como evidência sobre o produto.

## Critérios e limitações

Avaliar cadência apresentada, frametime, pausas, idade óptica da imagem, perdas/NACK/PLI e carga efetiva. FPS decodificado alto não basta. A comparação tem apenas duas execuções sob carga por modo, rede sem fio e ausência de certificação de scanout físico. Não homologará sincronização A/V, replay, outros codecs ou outras GPUs. A reconstrução não deve virar padrão sem avaliar essas condições e eventuais regressões de latência.

## Resultados E2E

O mesmo executável foi utilizado nos cinco casos, SHA-256 `f5c097c1126b3b6eccc30ff2d823108779a25d28984747b974030998403f8458`. Os modos observados na ponte corresponderam aos solicitados. As quatro execuções sob carga ficaram entre 73,9% e 76,4% de GPU no percentil 95 do motor mais ocupado; não se trata de certificação de saturação de 100%.

| Ordem | Relógio | Carga | Decode mediano FPS | Apresentação p10 FPS | Frametime p95 ms | Maior pausa ms | Latência p50 ms | Qualificação |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 1 | arrival | GPU | 57,54 | 22,02 | 104,8 | 177,3 | 187 | falhou |
| 2 | rtp | GPU | 58,01 | 42,00 | 53,1 | 177,4 | 213 | falhou |
| 3 | arrival | GPU | 57,88 | 22,97 | 106,3 | 297,1 | 187 | falhou |
| 4 | rtp | GPU | 58,48 | 42,97 | 52,8 | 88,0 | 217 | falhou |
| 5 | rtp | sem carga | 60,06 | 54,01 | 34,8 | 36,2 | 78 | passou |

**A transformação de relógio foi observada no produto, não apenas no teste isolado.** Nos casos `arrival`, o intervalo RTP mediano de entrada era 16,67 ms; na saída, 0,84 ms. O p95 de saída era cerca de 70 ms, acompanhando as rajadas de chegada. Nos casos `rtp`, entrada e saída mantiveram mediana de 16,67 ms e p95 de aproximadamente 23,3–23,5 ms.

A média das duas estatísticas de apresentação p10 passa de 22,5 para 42,5 FPS; o frametime p95 cai de aproximadamente 105,6 para 53,0 ms. Esses números não são FPS mediano de apresentação nem percentis de uma distribuição conjunta. A melhora se repetiu quando alternamos o modo, com FPS de decode e pressão de GPU próximos. Isso sustenta a transformação de relógio como uma causa relevante de irregularidade da apresentação nesta condição.

O custo observado é uma latência p50 de 213/217 ms, contra 187/187 ms: diferença descritiva de 28 ms entre médias dos p50. A incerteza individual dos relógios fica entre ±7,1 e ±8,8 ms nas quatro execuções sob carga. Não é uma promessa de efeito idêntico em qualquer rede ou máquina.

No primeiro par, a mediana dos intervalos de jitter buffer observado no receptor aumentou de aproximadamente 8 para 33 ms, e o alvo observado de 16 para 45 ms. Essa mudança acompanha o aumento da idade óptica do frame; não se trata de uma decomposição causal exata da latência em componentes somáveis.

## O problema restante foi localizado antes da ponte

O intervalo de chegada p95 no worker-handoff permanece em aproximadamente 70–71 ms nos quatro casos sob carga, embora o relógio RTP da mídia seja próximo de 16,67 ms. A reconstrução conserva o relógio, mas não transforma uma entrega em rajadas em uma entrega regular. A fila observada após o payloader tem mediana de nível zero e não explica, sozinha, essas rajadas já presentes no handoff.

Assim, há duas camadas de irregularidade: a produção/entrega antes do UDP local e sua incorporação ao relógio da mídia pela ponte. A segunda tem prova isolada e intervenção E2E com melhora repetida. A primeira permanece e impede homologar 60 FPS uniformes sob carga. Não foi identificado ainda qual estágio entre captura, filas raw, conversão, interop, encoder e agendamento provoca as rajadas.

## Alteração disponível e próximo experimento

O protótipo pode ser repetido com:

```powershell
node tools/e2e/comprehensive-matrix-goal.mjs --repeat 1 --seconds 75 --pipelines d3d12-nvenc-h264 --resolutions 720p --workloads gpu-unlimited --native-rtp-clock rtp
```

`--native-rtp-clock arrival` seleciona o caminho atual. A variável interna `SEEMYGAME_NATIVE_VIDEO_RTP_CLOCK` é limitada a esses dois valores; o harness a define apenas nos seus processos filhos. A seleção não foi adicionada à interface do usuário, nem adotada automaticamente como padrão.

O próximo experimento deve correlacionar os probes de PTS/frame journey já existentes com o handoff RTP, usando a mesma fonte sintética, para identificar a primeira etapa que forma rajadas. Depois, testar isoladamente a política raw `bounded` versus `latest` já existente; a segunda descarta apenas frames não codificados e pode reduzir idade ao custo de FPS. Não descartar pacotes RTP comprimidos como se fossem frames independentes.

Antes de promover a reconstrução a padrão: testar áudio sintético com sincronização A/V, entrada tardia/recovery e replay, e decidir se o ganho de fluidez com o custo de latência observado atende ao produto. A passagem do caso sem carga pelo limiar atual não substitui essa homologação nem demonstra 60 FPS de scanout físico.
