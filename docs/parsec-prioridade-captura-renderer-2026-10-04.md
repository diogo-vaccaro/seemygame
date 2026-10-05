# Parsec, prioridade GPU, captura e receptor — 04/10/2026

Concluímos as três comparações propostas. Os microbenchmarks de prioridade/captura tiveram **10 execuções válidas de 20 segundos**, mais quatro válidas para a intervenção nas filas. A comparação entre receptores no desktop → notebook teve **sete execuções qualificadas e uma rejeitada** por incerteza de relógio. Sob carga, o receptor Direct3D diagnóstico apresentou mediana de idade visual 38–39 ms menor que o Chrome nas duas ordens. É evidência exploratória: a carga de CPU externa variou e não permite atribuir isoladamente a diferença ao renderer.

O resultado mais promissor é **DXGI para captura de monitor**. Prioridade GPU alta por processo foi efetivamente aplicada pelo Windows, mas não recuperou o desempenho do D3D12 neste ensaio. Também identificamos espera significativa na fila de frames crus do D3D12, motivando uma intervenção diagnóstica adicional descrita abaixo.

## O que aprendemos com Parsec e Moonlight/Sunshine

O [artigo de arquitetura do Parsec](https://parsec.app/blog/description-of-parsec-technology-b2738dcc3842) descreve captura via Desktop Duplication, conversão/encode por hardware, transporte UDP e decode/renderização dedicados. É uma referência arquitetural antiga, não prova de todas as opções das versões atuais.

A [documentação atual das opções do Parsec](https://support.parsec.app/hc/en-us/articles/32381443626516-All-Advanced-Configuration-Options) informa que Windows usa D3D11 como renderer padrão, com decode por hardware. O modo `client_zero_copy` é opt-in, desativado por padrão e específico de D3D11. VSync troca latência por ausência de tearing; a configuração de maior qualidade ativa multipass. Portanto, não devemos presumir que toda execução do Parsec seja zero-copy nem comparar seus números sem registrar essas configurações.

O [guia de diagnóstico do Parsec](https://support.parsec.app/hc/en-us/articles/32381352822804-Troubleshooting-Lag-Latency-and-Quality-Issues) reconhece efeitos de rede, drivers, carga e diferença de refresh entre máquinas. Encode/decode do HUD não abrangem todo o atraso percebido. Uma transmissão pode ter codec rápido e imagem antiga.

O [código do Sunshine](https://github.com/LizardByte/Sunshine/blob/master/src/platform/windows/display_base.cpp) é mais auditável para prioridade: usa classe GPU do processo, prioridade do contexto DXGI e limite de frames em renderização. Há tratamento específico de HAGS/NVIDIA e restrições à prioridade realtime. Testamos **classe HIGH**, sem realtime, sem mudar HAGS ou configurações globais do driver.

São mecanismos distintos: [prioridade GPU por processo](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/d3dkmthk/nf-d3dkmthk-d3dkmtsetprocessschedulingpriorityclass), [prioridade do contexto DXGI](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgidevice-setgputhreadpriority) e [limite de frames do próprio device](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgidevice1-setmaximumframelatency). Ajustar nosso device não limita as filas de um jogo de outro processo. Esta rodada não testou prioridade por contexto/device ou command queue D3D12.

## Condições e instrumento

- Janela Chrome sintética exclusiva, retângulo externo/canvas configurados para 1920×1080, produção CPU alvo de 60 FPS. Os microbenchmarks anteriores não certificam a dimensão útil do conteúdo; na comparação entre receptores registramos também a geometria CSS real.
- Shader GPU offscreen: 96 iterações × 16 passes, submissão sem limite; cena capturada igual entre condições.
- Saída 1280×720, 60 FPS solicitados, H.264/NVENC, 7,5 Mbps.
- Mesmo `build_pipeline` da aplicação; host diagnóstico Rust em processo, compilação test/debug. Não é execução do `.exe` release completo.
- CPU HIGH em todas as condições; GPU NORMAL=2 ou HIGH=4 consultada novamente no Windows. Retornos e classe efetiva registrados.
- Sem áudio, replay, preview ou receptor concorrente. RTP da captura termina em UDP loopback; nenhuma conexão WebRTC é criada neste microbenchmark.
- Captura de monitor somente após verificar que o retângulo externo da janela sintética cobre integralmente seu monitor. Isso não certifica ausência de bordas/interface do Chrome na imagem.
- Mesma configuração de encode/API D3D11 na comparação WGC janela × WGC monitor × DXGI monitor.
- Correlação por quadro usando PTS normalizado, tempos nas entradas/saídas das etapas e contador de frames codificados. CPU/GPU do sistema e processos externos coletados por intervalo.

**Limite essencial:** os milissegundos desta tabela começam na **saída da captura**, não na geração do marcador nem no painel do espectador. Não medem glass-to-glass, idade visual, scanout ou frames únicos da imagem. FPS codificado também não certifica ausência de duplicação do conteúdo. Tempos de encode são duração de parede, incluindo espera/scheduling/fences; não são utilização isolada do motor NVENC.

## Comparação 1 — prioridade GPU por processo

| D3D12/WGC, H.264/NVENC | FPS codificado, duas ordens | Captura→codificado p50 | Fila da captura p50 |
| --- | --- | --- | --- |
| GPU NORMAL, CPU HIGH | 39,30–39,65 | 135,28–136,02 ms | 83,60–85,22 ms |
| GPU HIGH, CPU HIGH | 39,60–40,50 | 135,18–135,51 ms | 81,38–85,47 ms |

GPU HIGH foi confirmada como classe 4 em ambas as execuções. A diferença de FPS não é consistente nas duas ordens, e o atraso permanece praticamente igual. **Não foi demonstrada vantagem relevante dessa intervenção.** Isso não prova que toda prioridade GPU seja inútil: não testamos a prioridade dos devices/queues, e trabalho já submetido, disponibilidade das texturas e composição continuam limitando o pipeline.

Neste caso, a fila de captura é um ponto concreto de espera. Conversão D3D12 teve p50 de aproximadamente 22,6–22,8 ms; encode, 23,5–23,7 ms. As medianas não devem ser somadas como decomposição exata da mediana total; as correlações individuais estão no JSON.

## Comparação 2 — WGC janela × WGC monitor × DXGI monitor

| Captura D3D11, mesmo encode | FPS codificado, duas ordens | Captura→codificado p50 | p99 |
| --- | --- | --- | --- |
| Janela WGC | 22,55–22,70 | 21,63–21,67 ms | 42,71–43,47 ms |
| Monitor WGC | 22,50–22,65 | 21,75–21,84 ms | 44,27–44,63 ms |
| Monitor DXGI | 60,00–60,04 | 11,99–12,09 ms | 31,74–36,91 ms |

Mudar apenas janela para monitor mantendo WGC não recuperou a cadência. **DXGI recuperou 60 FPS nas duas ordens**, com menor percurso após captura. É a melhor alternativa observada para captura de monitor neste microbenchmark, ainda pendente de validação óptica da idade/duplicação do conteúdo e E2E sob jogo real.

O motor 3D apresentou p95 aproximadamente 93–100% entre os casos; VideoEncode ficou aproximadamente 1,4–3,6%. Esses contadores favorecem a hipótese de espera pelo caminho gráfico/texturas em vez de saturação do motor de encode, mas não identificam a fila de hardware nem certificam a causa. CPU, carga externa e fontes completas estão no relatório.

Não se deve substituir captura de janela por monitor silenciosamente: DXGI implica compartilhar o monitor inteiro. A recomendação é oferecer/experimentar DXGI quando o usuário escolhe monitor, mantendo a semântica de isolamento das janelas.

## Intervenção adicional — fila de frames crus

Uma segunda bateria compara o D3D12 original com filas anteriores ao encoder de um frame, `leaky=downstream`, descartando conteúdo antigo. A alteração existe somente no probe (`SMG_COMPARE_RAW_QUEUE=latest`), não no pipeline de produção. Nenhuma fila de RTP ou H.264 comprimido foi configurada para descarte arbitrário.

As **quatro execuções foram válidas**, com duas ordens. Os resultados são faixas das medianas por execução, sem misturar distribuições de rodadas diferentes:

| D3D12, GPU NORMAL | FPS codificado | Captura→codificado p50 | p99 | Fila de captura p50 |
| --- | --- | --- | --- | --- |
| Filas originais | 38,95–39,40 | 135,07–136,64 ms | 204,51–216,96 ms | 83,20–87,99 ms |
| Um frame, descartar antigos | 37,30–37,50 | 60,01–60,48 ms | 104,11–104,59 ms | 6,06–7,07 ms |

Reduzimos a mediana do percurso após captura em **74,6–76,6 ms** nas duas ordens, com pequena perda de throughput. Isso é evidência causal de que a retenção nas filas participa do atraso deste pipeline sob carga. Não demonstra redução igual no glass-to-glass, frescor da imagem anterior à captura nem comportamento com áudio/jogo/replay. A fila de encoder e a de captura foram alteradas conjuntamente; este teste não estima seus efeitos individuais. Precisamos homologar a intervenção antes de mudar produção.

## Comparação 3 — Chrome × receptor nativo, desktop → notebook

Construímos um receptor diagnóstico `webrtcbin → d3d11h264dec → D3D11Memory → fila de um frame → d3d11videosink`. O callback [`present`](https://gstreamer.freedesktop.org/documentation/d3d11/d3d11videosink.html) ocorre antes da chamada de apresentação do swapchain: conta submissões, não scanout físico. Um observador WGC comum aos dois receptores lê o marcador com sessão/CRC e registra o timestamp antes do readback, com calibração de relógios. A idade visual inclui a captura do observador; não equivale a uma medição física no painel.

Comparamos **implementações completas de recepção**, incluindo motores WebRTC, buffers e decoders diferentes, mantendo o transmissor nativo WGC/D3D11/NVENC H.264. Não é comparação de captura nativa com `getDisplayMedia`, nem isolamento do renderer. A ponte nativa utilizada encaminha/reempacota RTP comprimido, sem recodificação de vídeo nesse caminho.

O código já contém um subsistema `src-tauri/src/native_viewer/`, mas a busca no frontend encontrou wrappers e testes, sem chamada de `startNativeViewer` no fluxo ativo. Assim, comparar Tauri com Chrome no E2E usual não certifica comparação de renderização nativa.

### Problemas do instrumento corrigidos

1. **ICE e topologia:** GStreamer não resolveu o endereço mDNS do Chrome; o perfil diagnóstico passou a expor IPs reais. Candidatos exclusivamente STUN não estabeleceram mídia. A política explícita LAN + STUN permitiu selecionar a mesma rota UDP nos dois receptores: desktop `192.168.15.4` ↔ notebook visto como `192.168.15.16` através do NAT da rede `192.168.0.x`. Tailscale/SSH foi apenas controle; não transportou vídeo. A autorização explícita para STUN público foi recebida e o driver continua sem habilitá-lo implicitamente.
2. **Firewall e caminho do executável:** executar uma cópia nova do probe em cada pasta de resultado acionava bloqueios do Windows. No desktop, executamos o artefato Cargo canônico, arquivando uma cópia e verificando o hash. No notebook, com autorização do usuário, uma regra temporária permitiu somente UDP de entrada, perfil Private, executável exato e IP remoto `192.168.15.4`. Houve remoção normal e tarefa de expiração de segurança. A verificação final encontrou zero regras e zero tarefas diagnósticas remanescentes; não desativamos regras existentes.
3. **Prontidão do receptor:** aguardar o primeiro decode não assegurava que a janela Direct3D existisse. O teste agora aguarda mais de duas submissões de apresentação antes de localizar e observar a janela.
4. **Leitura óptica:** o leitor procurava a origem horizontal de dois em dois pixels. Três amostras rejeitadas tinham marcador íntegro começando em `x=5`. Passamos a procurar cada pixel, mantendo CRC e sessão estritos. Um fixture derivado desse caso virou teste de regressão. A rodada final teve **zero rejeições ópticas e zero falhas de proveniência** nos oito casos. As execuções anteriores continuam arquivadas com seus erros; não foram misturadas ao resultado final.
5. **Geometria:** `document.fullscreenElement` não provou fullscreen físico. Registramos viewport/CSS **1904×985**, canvas interno 1920×1080 e janela externa 1920×1080; há interface do Chrome na imagem. Essa geometria permaneceu igual antes/depois da medição e entre os pares. A saída recebida foi **1280×720** durante todo o intervalo, validada nos dois receptores.
6. **Qualificação:** exigimos recepção contínua, rota UDP conhecida e equivalente, geometria estável, prioridade consultada no SO, proveniência óptica e relógios válidos. Rota com protocolo ausente não qualifica. O coletor CPU/GPU rodou nos dois tipos de receptor; no nativo, sem lançar um navegador adicional.

### Resultado principal sob carga

Relatório: `output/playwright/compare-2026-10-04T19-34-38-819Z-1e68e1/report.json`. Foram oito casos de 15 segundos, com duas ordens invertidas, áudio/replay/preview desligados. O shader de carga foi o mesmo entre os pares. A fonte produziu aproximadamente 58–59 FPS durante os casos sob carga.

| Repetição | Receptor | FPS decodificado | Idade visual p50 | p90 | Leituras válidas | Incerteza de relógio |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Chrome | 25,54 | 180 ms | 223 ms | 53 | ±9,09 ms |
| 1 | Direct3D diagnóstico | 27,46 | 141 ms | 169 ms | 54 | ±8,79 ms |
| 2 | Direct3D diagnóstico | 23,88 | 153 ms | 184 ms | 58 | ±9,84 ms |
| 2 | Chrome | 23,96 | 191 ms | 227 ms | 55 | ±9,06 ms |

Diferenças pareadas, Direct3D menos Chrome: **−39 ms** na primeira ordem e **−38 ms** na segunda. São maiores que as incertezas combinadas dos relógios, respectivamente ±17,87 e ±18,90 ms. Isso apoia investigar o receptor dedicado. Não demonstra que somente trocar o renderer produza esse ganho em produção.

O FPS permaneceu próximo entre os receptores, sobretudo na segunda ordem. A fonte produziu quase 60 FPS, mas apenas cerca de 24–27 FPS chegaram decodificados sob carga. Assim, melhorar a recepção não resolve a perda de cadência no caminho de envio/captura WGC. Os estudos de componentes continuam apontando DXGI e filas de frames crus como intervenções mais diretamente relacionadas ao gargalo sob carga.

### Baseline e carga externa: por que não declarar vitória definitiva

Os baselines sem shader tiveram aproximadamente 54–55 FPS. Idades p50 registradas foram Chrome 71/73 ms e Direct3D 33/32 ms. **O primeiro baseline Chrome não qualificou:** a incerteza foi ±10,078 ms, acima do orçamento fixo de 10 ms; não arredondamos para aprová-lo. Restou somente um par idle qualificado, insuficiente para conclusão repetida.

| Caso sob carga | CPU desktop p50 / p95 | GPU mais ocupada desktop p95 | CPU notebook p50 / p95 |
| --- | --- | --- | --- |
| Chrome, repetição 1 | 15,16% / 20,82% | 79,69% | 10,56% / 22,45% |
| Direct3D, repetição 1 | 10,42% / 30,96% | 77,39% | 8,62% / 14,55% |
| Direct3D, repetição 2 | 9,43% / 53,84% | 100,00% | 6,97% / 13,43% |
| Chrome, repetição 2 | 8,83% / 12,23% | 99,44% | 14,71% / 27,67% |

A pressão gráfica foi semelhante dentro de cada par, mas não igual entre repetições. Processos Chrome externos contribuíram para picos de CPU nos casos nativos. O último baseline Chrome teve CPU do sistema p95 de **91,36%**, com um `node.exe` consumindo 72,58% em uma amostra. Houve validação Vitest concorrente no período, uma possível contribuição desse processo; seu vínculo exato ao PID não foi certificado. Essa concorrência é um erro metodológico que deve ser evitado nas próximas rodadas. Não encerramos processos do usuário para artificialmente limpar resultados.

Portanto, preservamos a qualificação técnica dos sete casos e sinalizamos a **limitação de controle de carga**, sem inventar uma correção estatística nem descartar seletivamente dados. A diferença de idade foi repetida, mas a atribuição causal ao receptor permanece aberta. Há apenas 15–16 amostras de recursos por caso; p95 pode se aproximar de um pico isolado. No notebook, a classificação de processos externos pode incluir o probe nativo iniciado por tarefa separada.

Cada caso teve 53–60 leituras ópticas. O p99 coincide com o máximo e não sustenta estimativa robusta de cauda populacional. FPS decodificado, chamadas `present` e frames únicos observados são medidas distintas. Não atribuímos a diferença entre estudos antigos e novos exclusivamente à correção do leitor: a pressão gráfica também mudou.

Uma opção de recentralizar conservadoramente a união dos envelopes de relógio foi adicionada e testada separadamente. **Não foi usada nesta rodada**, não é o padrão e não foi aplicada retroativamente para aprovar o baseline rejeitado. Mantém o orçamento de erro e exige usar o offset retornado.

## Próximas ações com melhor relação esforço/evidência

1. Homologar DXGI monitor com contador óptico de frames únicos e E2E em duas máquinas, mantendo codec/bitrate/FPS/resolução, rota ICE e condições iguais. Registrar perdas, RTT, jitter e CPU/GPU.
2. Homologar a política de descartar frames crus antigos com áudio ligado/desligado, replay e recuperação de carga. Usar leitura óptica para confirmar menor idade visual e contabilizar o descarte; não prometer ganho final igual ao microbenchmark.
3. Repetir Chrome × Direct3D por 60 segundos, em janela de menor carga externa, sem builds/testes simultâneos. Pré-definir limites de pressão CPU/GPU e registrar casos não conformes; aumentar repetições invertidas e amostras para análise de cauda. Manter rota/viewport/resolução iguais e depois homologar o receptor no fluxo real do aplicativo.
4. Somente depois testar prioridade no device/contexto e queue D3D12, medindo efeitos no jogo e na composição. A classe HIGH isolada não justifica uma alteração de produção nesta rodada.

## Artefatos e reprodução

- Comparações de componentes: `output/playwright/components-2026-10-04T17-50-16-908Z-de09e4/report.json`.
- Intervenção nas filas: `output/playwright/components-2026-10-04T17-57-51-321Z-1edb2f/report.json`.
- Pilotos de transporte: diretórios `output/playwright/compare-*`; erros e leituras insuficientes preservados, sem consolidação como sucesso.
- Comparação final entre receptores: `output/playwright/compare-2026-10-04T19-34-38-819Z-1e68e1/report.json`; consolidação em `output/playwright/renderer-analysis-2026-10-04/summary.json` e `summary.csv`, com CPU p50/p95, carga externa, rota e limitações explícitas.
- Fixture de regressão óptica: `tests/fixtures/e2e-optical-odd-origin-row.bgra`. Amostras diagnósticas originais em `output/playwright/compare-2026-10-04T19-27-06-540Z-417fef/`; esse modo salva no máximo três recortes e é marcado `debug-only`, sem uso como benchmark.
- Ferramentas: `tools/e2e/compare-capture-components.mjs`, `tools/e2e/compare-capture-renderer.mjs`, `src-tauri/src/media/transport_comparison_probe.rs`.
- Binários diagnósticos arquivados e hashes do código/binário registrados por estudo. A segunda bateria tem snapshot das fontes com hashes correspondentes; a primeira tem snapshot parcial, pois dois arquivos diagnósticos evoluíram antes do arquivamento. As versões diferentes não foram substituídas silenciosamente.
- Consolidação: `output/playwright/capture-component-analysis-2026-10-04/summary.json`, **14 execuções válidas e 10.407 frames correlacionados**.
- Validação da rodada comparativa: **50 testes Rust passaram**, 3 diagnósticos reais permaneceram ignorados na suíte comum; **31 testes frontend/telemetria passaram** nos cinco arquivos selecionados. Na preparação dos commits, incluindo a configuração de filas e os guards de recursos, passaram **53 testes Rust e 110 testes JavaScript em 14 arquivos selecionados**, além de `cargo check --lib`. A suíte frontend inteira não é declarada aprovada por essa seleção.
- Tarefas e regra temporária removidas: `output/renderer-remote-cleanup-verification.json`. Branch local permanece `main`; não houve commit, deploy ou alteração dos executáveis release, cujos hashes foram conferidos. As mudanças desta rodada são no diagnóstico/testes, não homologação de comportamento novo em produção.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib --no-run
node tools/e2e/compare-capture-components.mjs --seconds 20 --repeat 2 --exe <artefato-de-teste-app_lib.exe>
node tools/e2e/compare-capture-components.mjs --seconds 20 --repeat 2 --cases priority-normal,d12-latest --exe <artefato-de-teste-app_lib.exe>
node tools/e2e/compare-capture-renderer.mjs --public-stun --allow-private-receiver-udp-from 192.168.15.4 --seconds 15 --repeat 2 --cases baseline-browser,baseline-native,window-wgc,native-receiver
```

O artefato é o executável de testes retornado pelo Cargo, não `seemygame.exe`. O último comando reproduz a política de rede explicitamente autorizada nesta sessão: STUN público e regra UDP temporária restrita. Os IPs e o perfil de firewall precisam corresponder ao ambiente; não ampliar permissões para contornar falhas.
