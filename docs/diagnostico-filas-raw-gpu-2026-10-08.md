# Diagnóstico dirigido de filas raw e processamento GPU — 08/10/2026

## Parecer

Há progresso na identificação dos mecanismos, mas os stutters não estão resolvidos. O estudo anterior isolou a distorção do relógio RTP na ponte. Esta rodada localizou acúmulo e bloqueio propagado nas filas antes da codificação, associado à lentidão observada na conversão e no encoder sob carga. A alternativa de descartar frames antigos melhora a idade interna do vídeo, mas regrediu o FPS remoto sem ganho consistente de latência. **Não promover `latest` a padrão.**

## Implementação e validação

- Sonda de captura em build release, com prioridade CPU HIGH e classe GPU 4 aplicadas e verificadas em todas as oito medições.
- Medição de cadência em 12 pontos, incluindo entrada/saída das filas, conversão, interop e encoder; preservado o pareamento por running-time de cada frame.
- Fonte/carga fixa com canvas 1920×1080, independente da saída 1280×720; filas `bounded`/`latest` em ordem alternada.
- Correção do carregamento das DLLs GStreamer no executável de testes: a primeira tentativa terminou com código Windows 3221225781, sem iniciar o pipeline. Essa tentativa não é evidência de falha da transmissão.
- E2E com `--native-raw-queue bounded|latest`, propagação explícita do ambiente e verificação das duas filas raw pelos argumentos reais do worker. Uma solicitação sem evidência correspondente invalida a rodada.
- 18 testes JS aprovados, incluindo três novos testes de evidência de fila; seis testes Rust aprovados sobre pareamento, políticas de fila e normalização de PTS.

## Sonda interna: oito medições de 20 segundos

Captura D3D12/WGC → conversão para NV12 em 720p → interop D3D11 → NVENC H.264/4500 kbps → RTP/fakesink. Sem receptor, áudio, replay ou prévia. Fonte permaneceu em aproximadamente 60 FPS. Os tempos são diferenças de chegada aos pads, **incluem agendamento, esperas e backpressure**, e não representam tempo puro de execução na GPU.

| Carga | Repetição | Fila | FPS codificado | Fila captura p50 ms | Conversão p50 ms | Encode p50 ms | Captura→codificado p50 ms | GPU p95 % | Recursos |
|---|---:|---|---:|---:|---:|---:|---:|---:|---|
| off | 1 | bounded | 60.03 | 0.02 | 0.12 | 0.98 | 1.27 | 3.85 | clear |
| off | 1 | latest | 60.02 | 0.02 | 0.13 | 0.96 | 1.27 | 3.85 | clear |
| gpu-unlimited | 1 | bounded | 40.20 | 84.69 | 22.59 | 23.49 | 135.60 | 96.76 | unqualified |
| gpu-unlimited | 1 | latest | 37.74 | 6.22 | 22.67 | 23.72 | 59.53 | 96.71 | clear |
| gpu-unlimited | 2 | latest | 36.64 | 6.73 | 22.96 | 23.88 | 61.49 | 97.65 | clear |
| gpu-unlimited | 2 | bounded | 37.89 | 88.71 | 22.82 | 23.60 | 137.74 | 97.30 | clear |
| off | 2 | latest | 60.00 | 0.02 | 0.13 | 0.97 | 1.27 | 3.83 | clear |
| off | 2 | bounded | 60.04 | 0.02 | 0.13 | 0.96 | 1.27 | 3.84 | clear |

A primeira medição `bounded` com carga excedeu o orçamento de CPU externa e está segregada; não sustenta sozinha uma comparação controlada. As outras sete medições passaram na qualificação de recursos. O conjunto tem oito entregas funcionais, mas não aprovação de 60 FPS sob carga.

Na repetição controlada sob carga:

- `bounded`: captura ~38 FPS; espera entre entrada/saída da fila de captura p50 88,7 ms, p95 134,6 ms; percurso captura→codificado p50 137,7 ms.
- `latest`: captura ~60 FPS; encode ~36,6 FPS; fila p50 6,7 ms, p95 15,5 ms; percurso captura→codificado p50 61,5 ms.
- Conversão e encode continuam em aproximadamente 23 ms de mediana cada, com p95 próximo de 45–46 ms. A política de descarte não remove esse custo.
- Interop ficou em aproximadamente 0,12 ms de mediana e abaixo de 0,8 ms no p95 das medições com carga; não foi o maior trecho observado.
- A fila junto ao encoder teve p50 ~0,02 ms. O acúmulo dominante medido está na fila de captura.

A captura volta a ~60 FPS quando a fila passa a descartar frames antigos. Isso evidencia que sua queda com `bounded` não pode ser atribuída exclusivamente à capacidade da WGC: há bloqueio propagado de etapas posteriores. Não demonstra que toda irregularidade da captura foi eliminada.

`max-size-time=50000000` é limite de conteúdo de mídia, não um SLA de 50 ms de permanência de cada frame. A medida sink→src também inclui espera de admissão quando a fila bloqueia. A documentação descreve tanto esse bloqueio quanto o descarte de buffers antigos com `leaky=downstream`. [GStreamer queue](https://gstreamer.freedesktop.org/documentation/coreelements/queue.html).

**Geometria e equivalência:** o canvas da sonda é 1920×1080, mas os caps reais da captura foram BGRA/D3D12Memory em **1944×1093**, devido à janela/bordas do navegador; saída NV12/D3D11Memory em 1280×720. A calibração do navegador não comprova caps WGC idênticos. Esses valores foram constantes entre políticas nesta sonda. O motor 3D chegou a ~97% no p95, enquanto o E2E ficou em ~70–74%. Portanto, não transferir os tempos absolutos entre as duas topologias nem somá-los para explicar a latência remota. O próximo protocolo deve validar caps WGC diretamente.

## E2E desktop → notebook Chrome: ABAB + controle

Mesmo executável release em todas as cinco rodadas; SHA-256 `f5c097c1126b3b6eccc30ff2d823108779a25d28984747b974030998403f8458`. D3D12/WGC, NVENC H.264, 720p60/4500 kbps, fonte/carga 1080p, áudio/replay/prévia desligados, amostragem óptica 8 Hz, relógios calibrados. Relógio da ponte fixo em **`rtp` experimental**; a única alternativa solicitada foi a política das filas raw. Duas repetições por política com carga; uma medição `latest` sem carga. Não é ensaio de significância estatística.

| Rodada | Carga | Fila | FPS decodificado mediano | Apresentação p10 FPS | Frametime p95 ms | Pausa máxima ms | Latência p50 ms | Incerteza ±ms | Perdas Δ / NACK Δ |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | gpu-unlimited | bounded | 58.75 | 43.98 | 52.50 | 334.30 | 229 | 8.15 | 5 / 5 |
| 2 | gpu-unlimited | latest | 44.67 | 36.99 | 54.00 | 210.10 | 220 | 8.00 | 0 / 0 |
| 3 | gpu-unlimited | bounded | 57.89 | 42.00 | 54.30 | 139.00 | 218 | 7.40 | 0 / 0 |
| 4 | gpu-unlimited | latest | 45.39 | 38.04 | 53.80 | 825.90 | 219 | 7.60 | 4 / 8 |
| 5 | off | latest | 60.00 | 53.98 | 34.60 | 191.50 | 76 | 8.50 | 0 / 0 |

As cinco rodadas passaram funcionalmente; modo RTP e política de fila foram comprovados, e as cinco medições de latência passaram na validação de relógios. **Nenhuma passou no critério completo de qualidade de apresentação/pausas.** O controle sem carga entregou ~60 FPS decodificados e p50 76 ms, mas apresentou pausa de 191,5 ms; não omitir essa falha.

Sob carga, `bounded` entregou 57,9–58,8 FPS contra 44,7–45,4 FPS com `latest`. As medianas de latência 218–229 ms e 219–220 ms se sobrepõem entre repetições e dentro dos envelopes de relógio: **não há ganho remoto consistente demonstrado**. A apresentação p10 também regrediu com `latest`. A fila com descarte remove conteúdo atrasado, porém os frames descartados ampliam os intervalos do relógio de mídia: o p95 de passo RTP subiu de ~23 ms para ~50 ms. O ritmo de entrega continuou irregular. Não confundir menos frames antigos com transmissão mais lisa.

Houve perda/NACK nas rodadas 1 e 4. A pausa máxima de 825,9 ms na rodada 4 é evidência de degradação, mas não prova causalmente que a política `latest` produziu a pausa. Recuperação de rede/decoder precisa ser separada de stalls sem perda. Ausência de PLI tampouco comprova ausência de recuperação por NACK.

## Decisão e próximo experimento

1. Manter a política de produção `bounded`; `latest` continua alternativa explícita de diagnóstico. Não descartar pacotes comprimidos/RTP para imitar descarte de frames raw.
2. Manter o relógio RTP corrigido como experimento até validar áudio, replay e recuperação. Esta rodada mantém esse modo fixo e não reavalia sua promoção.
3. Registrar uma janela ETW curta sob carga, correlacionada com os pads, para separar espera CPU, espera em fences/filas GPU e execução efetiva de conversão/encode. WPR/WPA já estão instalados e o perfil GPU está disponível; foi consultado apenas o status, sem iniciar gravação ou alterar sessões existentes. Prioridade CPU HIGH/GPU 4 foi respeitada no readback da sonda, mas isso não garantiu FPS sob saturação.
4. Caso a captura consiga alimentar o pipeline mas a política de um frame descarte demais, comparar **dois frames raw com descarte do mais antigo**, alterando uma fila por vez. É hipótese a testar, não correção comprovada nem nova configuração padrão.
5. Separar eventos sem perda de eventos com NACK; usar janela temporal alinhada, sem somar médias de etapas de intervalos diferentes. Validar caps físicos WGC diretamente, e só depois ampliar para áudio/replay e outros codecs/resoluções.

Esta rodada restringiu as hipóteses: distorção RTP é um mecanismo comprovado anteriormente; retenção/backpressure raw foi localizado agora; o maior custo local observado está nos trechos de conversão/encoder sob carga. Atribuir isso especificamente ao scheduler GPU, a fences ou à capacidade do NVENC ainda exige a próxima coleta. Não há promessa de latência mínima universal ou de D3D12 imune a stutters.

## Reprodução e artefatos

```powershell
node tools/e2e/native-capture-stages.mjs --seconds 20 --repeat 2 --capture d3d12 --workload-profiles off,gpu-unlimited --raw-queues bounded,latest --width 1280 --height 720
node tools/e2e/raw-queue-ab.mjs
```

- [Sonda interna](../output/playwright/capture-stages-2026-10-08T11-02-51-487Z-6ef885/report.json)
- [Comparação E2E](../output/playwright/raw-queue-ab-2026-10-08T11-09-16-273Z-27e37b/report.json)
- [Análise consolidada](../output/playwright/raw-queue-ab-2026-10-08T11-09-16-273Z-27e37b/analysis.json)
- [Diagnóstico anterior do relógio RTP](diagnostico-relogio-rtp-2026-10-08.md)

Hashes da sonda foram conferidos após a execução; o E2E verificou o executável e os helpers congelados a cada caso. Alterações desta rodada são de diagnóstico/testes, sem promoção de padrões, commit ou push.
