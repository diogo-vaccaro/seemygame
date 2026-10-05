# WGC × DXGI: conteúdo, desempenho e calibração do observador

## Estado mais recente — controle do instrumento em 5/10

A fonte correta já foi comprovada nos dez caminhos locais com marcador óptico avançando e geometria interna/externa 1920 × 1080. A descoberta posterior mais importante foi **viés de idade no observador WGC configurado a 8 Hz**. Um controle local, sem encoder, WebRTC, notebook ou rede, mostrou idade mediana de 131–132 ms. Logo, números absolutos da matriz com esse observador não representam somente atraso da transmissão.

No mesmo probe, variando apenas a taxa solicitada do observador:

| Observador solicitado | Taxa observada | Idade mediana local | Leituras por repetição |
| --- | ---: | ---: | ---: |
| 8 Hz | 8 Hz | 131 ms | 120 |
| 30 Hz | 30 Hz | 42 e 45 ms | 450 |
| 60 Hz | 54,7–54,9 Hz | 11 e 12 ms | 821–823 |

Relatórios: [8 Hz](../output/playwright/observer-calibration-2026-10-05T11-49-28-905Z/report.json), [30 Hz](../output/playwright/observer-calibration-2026-10-05T11-50-01-889Z/report.json), [60 Hz](../output/playwright/observer-calibration-2026-10-05T11-50-51-680Z/report.json). O [controle anterior de três repetições a 8 Hz](../output/playwright/observer-calibration-2026-10-05T11-46-13-043Z/report.json) reproduziu 131, 132 e 132 ms. Todos passaram no controle de proveniência e relógios. A chegada ao readback ficou perto de 1,5–1,6 ms nas três taxas; ela não explica a mudança de aproximadamente 120 ms na idade óptica.

Esse experimento comprova efeito da configuração do instrumento **neste controle**, não atraso fixo universal de WGC. Ele inclui fonte/composição/observação local; não reproduz GPU/compositor/janela do notebook e não autoriza subtrair 131 ms de outro relatório. Tampouco demonstra escaneamento físico do painel. O observador permanece diagnóstico, com seu custo e taxa efetiva registrados. A nova comparação usa 60 Hz explicitamente e avalia a pressão de recursos no receptor.

O padrão de captura do aplicativo continua WGC. Nenhuma troca automática baseada somente em FPS decodificado foi feita. As seções abaixo preservam o histórico das falhas e correções; seus estados pendentes antigos não substituem esta atualização.

## Comparativo concluído com configuração de observador a 60 Hz

[Relatório bruto](../output/playwright/compare-2026-10-05T11-53-07-416Z-845a96/report.json) e [resumo de análise](../output/playwright/compare-2026-10-05T11-53-07-416Z-845a96/analysis-summary.json). Foram oito casos de 30 segundos: WGC/DXGI no mesmo monitor, com e sem carga, em duas ordens. Esta é uma revalidação do instrumento e comparação exploratória; não substitui a homologação planejada de três pares longos em jogos reais.

| Condição | WGC: FPS / idade p50 | DXGI: FPS / idade p50 | Delta DXGI − WGC / erro combinado |
| --- | --- | --- | --- |
| Sob carga, primeira ordem | 41,8 / 136 ms | 59,8 / 142 ms | +6 ms / ±17,3 ms |
| Sob carga, ordem inversa | 41,3 / 134 ms | 60,0 / 144 ms | +10 ms / ±18,6 ms |
| Sem carga, primeira ordem | 54,9 / 69 ms | 59,3 / 78 ms | +9 ms / ±17,2 ms |
| Sem carga, ordem inversa | 54,8 / 65 ms | 58,9 / 79 ms | +14 ms / ±17,5 ms |

Todos os casos passaram em conteúdo, resolução 720p, continuidade, proveniência, relógios e controle de CPU externa **do transmissor**. A GPU 3D do transmissor ficou em p95 de aproximadamente 91–93% sob carga e 3,5–3,8% sem carga. A fonte produziu aproximadamente 58 FPS sob carga e 60 FPS sem carga. DXGI entregou cerca de 18–19 FPS decodificados adicionais sob carga, repetindo o efeito nas duas ordens. Como a fonte produz menos de 60 FPS, o contador DXGI de cerca de 60 inclui repetição/cadência; não comprova 60 imagens novas ou ausência de engasgos.

**Nenhuma vantagem de latência de DXGI foi demonstrada:** todos os deltas ficaram dentro da incerteza combinada. A diferença de idade visual entre carga e baseline persistiu nos dois métodos. O encode mediano permaneceu perto de 1,2 ms e o decode remoto perto de 0,8 ms; não há evidência aqui de saturação desses estágios como explicação suficiente. A fonte mede demora entre submissão e disponibilidade de consultas GPU sob carga, mas essa métrica inclui polling e não identifica sozinha onde o frame fica retido. Não somar essas médias para decompor a mediana final.

O notebook recebeu a configuração de 60 Hz no script próprio do probe, mas **a taxa efetiva do observador ficou em apenas 3,6–3,9 leituras/s**, com zero rejeições. Isso difere do controle local de 54,7–54,9 leituras/s. Não transferir a calibração do desktop para o notebook nem afirmar que o instrumento remoto mede scanout físico. A imagem observada é amostrada esparsamente; p99 com 108–116 leituras é exploratório.

Há uma limitação adicional de recursos: a classificação do coletor marcou CPU externa p95 de aproximadamente 10,0–10,8% no receptor em três casos. Chrome foi o principal processo dessa categoria. Como a evidência normalizada não conserva toda a ancestralidade/identidade dos processos, não foi possível provar retrospectivamente se eram abas externas ou algum processo do navegador diagnóstico sem ancestral vivo. **O status `valid` atual aplica o guard automático ao transmissor; não significa controle estrito de CPU externa das duas máquinas.** O receptor apresentou CPU total p95 de 7,3–35,5% e GPU até 10,9%, sem prova de saturação total; isso não elimina interferência pontual. A atribuição de processos e qualificação do receptor precisam ser melhoradas antes de uma homologação definitiva.

Os deltas de freeze/perda/NACK do resumo usam a primeira e última amostra da timeline, deixando de fora o primeiro intervalo. Houve de zero a três freezes nesse trecho, conforme o caso; o segundo WGC sob carga teve cauda de idade p99 373 ms e máximo 462 ms, cinco perdas e oito NACKs. Essa coexistência é uma pista para correlacionar eventos, não prova que Wi-Fi explica toda a cauda. O runner agora preserva também o baseline completo do navegador para permitir deltas de todo o período nas próximas execuções.

A limpeza final confirmou zero tarefas, regras e processos próprios no notebook e zero processos locais próprios: [verificação](../output/playwright/compare-2026-10-05T11-53-07-416Z-845a96/cleanup-verification.json). A restauração da solicitação temporária de energia foi confirmada (`restored:true`, `exited:true`). Não houve commit/push nem mudança do método automático do aplicativo.

## Decisão e próximos controles

1. Manter WGC como automático e DXGI como opção avançada de monitor. A vantagem observada de cadência torna DXGI promissor para carga gráfica, mas não homologa recuperação, áudio, D3D12 ou todos os jogos.
2. Calibrar o observador **no notebook**, contra uma fonte local sem transmissão, e comparar com timestamps de apresentação do vídeo. Registrar caps efetivos e explicar a taxa observada de aproximadamente 3,7 Hz. Separar captura fresca de leitura óptica: capturar com cadência alta e descartar amostras antes do download pode permitir amostragem leve sem reintroduzir retenção; essa alternativa ainda não foi implementada/testada.
3. Registrar identidade e início dos processos próprios do receptor; aplicar a qualificação de recursos às duas máquinas, evitando classificar por nome ou apenas por PID. Preservar árvore/identidade mínima sem exportar comandos privados.
4. Só então repetir três pares de 60 segundos e um jogo real, acompanhando imagens novas, apresentação, frametime do jogo e recuperação ativo → repouso → ativo. Expandir D3D12, 1080p, áudio e replay uma variável por vez.

Os CLIs de comparativo e calibração passaram a solicitar 60 Hz por padrão; 8 e 30 Hz continuam disponíveis explicitamente para controles. A taxa solicitada é registrada e não será confundida com a efetivamente observada. A mudança é do instrumento E2E, não do FPS da transmissão.

## Histórico do parecer inicial

**Atualização às 10:40–10:41 UTC de 5/10:** com o usuário presente e os dois monitores confirmados fisicamente acesos, a nova tentativa produziu conteúdo em todos os dez caminhos locais. DXGI voltou a entregar imagem em D3D11, memória de sistema, conversão, roundtrip H.264/NVENC e D3D12. Isso demonstra recuperação da captura e reforça a associação com o estado da saída; não homologa desempenho nem isola o efeito do comando de despertar de eventual atividade local do usuário. O PNG DXGI inspecionado contém o Codex, não a fonte sintética: a validação de fonte continua pendente para o benchmark.

A comparação ainda **não homologa DXGI** e não sustenta mudar o método automático de WGC para DXGI. A principal descoberta foi vídeo preto com aproximadamente 60 frames decodificados por segundo. Esse contador mede processamento de frames, não conteúdo útil ou imagens novas.

A matriz de três pares de 60 segundos foi interrompida para investigar essa falha. Não existe um ranking válido de latência WGC × DXGI nesta rodada. Os relatórios e imagens foram preservados; execuções incompletas não serão tratadas como sucesso.

### Informação posterior do usuário: ambos os monitores estavam em repouso

Em 5/10, o usuário confirmou que ambos os monitores estavam em repouso durante a rodada. Esse estado passa a ser a hipótese prioritária para DXGI preto e para uma imagem de monitor WGC que não acompanha a fonte. Não há confirmação experimental de causalidade: ainda falta repetir a mesma captura após despertar os monitores e confirmar imagem física atual. Não atribuir esses resultados a defeito do driver/plugin, nem à performance normal de DXGI com saída ativa.

Desktop Duplication captura uma saída de vídeo, não garante renderização útil com qualquer combinação de painel apagado, energia e driver. A documentação do produto de acesso remoto [Reemo](https://support.reemo.io/en/support/solutions/articles/206000053404-common-errors) registra monitor desligado/ausente entre as causas de falha de inicialização Desktop Duplication. Isso é evidência de uma limitação possível, não uma regra universal de que o painel físico sempre precisa emitir luz.

A chamada temporária [`SetThreadExecutionState`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate) solicitou manter sistema/display ativos, mas o teste não comprovou que as saídas físicas realmente voltaram a apresentar conteúdo. A próxima execução deve começar com confirmação visual de saída ativa, seguida de marcador óptico avançando. Manter a solicitação de energia durante o teste pode prevenir repouso automático; ela não substitui essa validação.

Às 09:49 UTC de 5/10, a pedido do usuário, foi tentado despertar explicitamente via `WM_SYSCOMMAND / SC_MONITORPOWER`, parâmetro -1, usando `SendMessageTimeout` com timeout e pedido temporário de manter sistema/display ativos. O Windows aceitou a mensagem, mas isso não certifica o estado físico dos painéis. A nova execução [capture-content-2026-10-05T09-49-57-402Z](../output/playwright/capture-content-2026-10-05T09-49-57-402Z/report.json) continuou com DXGI preto nos cinco caminhos, enquanto os controles WGC/GDI apresentaram imagem. A solicitação de energia anterior foi restaurada com sucesso: [registro da tentativa](../output/playwright/wake-monitor-2026-10-05/wake-request.json) e [restauração](../output/playwright/wake-monitor-2026-10-05/restoration.json). Não declarar o repouso como causa confirmada nem descartada sem validar visualmente que o monitor realmente despertou.

Na segunda tentativa, às 10:40 UTC, o Windows novamente aceitou `SC_MONITORPOWER -1`, e o usuário confirmou explicitamente: **os dois monitores mostram imagem**. O [smoke local completo](../output/playwright/capture-content-2026-10-05T10-40-49-638Z/report.json) encerrou com código 0, dez casos com conteúdo e zero imagens pretas. O status é `completed-content-review-required`, e não benchmark aprovado: a imagem DXGI D3D11 revisada mostra conteúdo atual do Codex em vez do marcador sintético. A [solicitação](../output/playwright/wake-monitor-2026-10-05T10-40-45-562Z/wake-request.json) foi temporária e a [restauração](../output/playwright/wake-monitor-2026-10-05T10-40-45-562Z/restoration.json) foi confirmada. Nenhuma configuração permanente de energia foi alterada. Próximo controle: manter saída ativa e comprovar o marcador avançando no monitor efetivamente capturado antes do E2E longo.

## Condições da primeira execução

- Desktop → Chrome no notebook; SSH usado para controle. Rota observada do vídeo: UDP entre 192.168.15.4 e 192.168.15.16. Notebook em Wi-Fi.
- Mesmo monitor e fonte sintética dentro do par sob carga, D3D11, H.264/NVENC, 1280 × 720 a 60 FPS, 7,5 Mbps, sem áudio, replay ou prévia.
- Artefato Rust de testes reconstruído antes da coleta; SHA-256 do executável conferido no notebook e fontes relevantes arquivadas no relatório. Não foi reconstruído um instalador ou executável release do aplicativo.
- Fonte com janela externa 1920 × 1080, área interna de Chrome 1904 × 985 e DPR 1. Fullscreen DOM não comprova ausência de barra do navegador/taskbar; esses tamanhos estão registrados e não serão chamados de fonte interna 1080p perfeita.
- Observador óptico WGC no receptor a 8 Hz. Sua idade visual inclui o atraso da própria observação; não mede scanout físico do painel.

## Primeira coleta longa

Relatório: [compare-2026-10-05T02-31-02-903Z-00f563/report.json](../output/playwright/compare-2026-10-05T02-31-02-903Z-00f563/report.json).

| Caso sob carga gráfica | FPS decodificado | Evidência óptica | Situação |
| --- | ---: | --- | --- |
| Monitor WGC | 41,8 | 221 leituras válidas; idade p50 129 ms, p90 155 ms, p99 185 ms; incerteza dos relógios ±9,93 ms | Mídia válida, comparação controlada desqualificada por carga externa |
| Monitor DXGI | 60,0 | Zero leituras válidas, 227 rejeitadas; imagem preta | Sem evidência de transmissão útil; latência indisponível |

No WGC, CPU externa p95 foi 10,16%, acima do limite pré-definido de 10%. Esse critério não foi afrouxado. GPU 3D próxima de 100% era carga intencional da cena; não é, por si só, razão de desqualificação. Os resultados WGC acima são observações dessa execução e não uma estimativa isolada do método.

O caso seguinte, WGC sem carga, foi interrompido antes de persistir toda a evidência final. Não usar resultados parciais dele. O relatório foi corrigido de `running` para `interrupted`, preservando as métricas dos casos concluídos. A verificação posterior encontrou zero tarefas e zero regras de firewall remanescentes dessa rodada: [cleanup-verification.json](../output/playwright/compare-2026-10-05T02-31-02-903Z-00f563/cleanup-verification.json).

## Isolamento local da imagem preta

Ferramenta: [capture-content-smoke.mjs](../tools/e2e/capture-content-smoke.mjs). É diagnóstico de conteúdo com readback e PNG, deliberadamente inadequado para medir desempenho. Utiliza GStreamer CLI e os plugins de captura; não é o fluxo completo do aplicativo Tauri.

Execução completa: [capture-content-2026-10-05T02-48-04-979Z/report.json](../output/playwright/capture-content-2026-10-05T02-48-04-979Z/report.json).

| Caminho local | Conteúdo observado |
| --- | --- |
| WGC/D3D11 → BGRA → download → PNG | Imagem presente |
| WGC/D3D11 → conversão NV12 720p → PNG | Imagem presente |
| WGC/D3D11 → H.264/NVENC → decode local → PNG | Imagem presente |
| DXGI/D3D11 → BGRA → download → PNG | Preto |
| DXGI/D3D11 → conversão NV12 720p → PNG | Preto |
| DXGI/D3D11 → H.264/NVENC → decode local → PNG | Preto |
| DXGI/D3D11 → memória de sistema → PNG | Preto |
| DXGI/D3D12 → BGRA → download → PNG | Preto |
| WGC/D3D12 → BGRA → download → PNG | Imagem presente |
| GDI → memória de sistema → PNG, controle diagnóstico | Imagem presente |

Os frames DXGI amostrados têm luminância média zero e 0% de pixels não pretos; os controles WGC/GDI têm imagem. Como a falha se reproduz sem encode, transporte ou notebook, esses componentes não explicam a imagem preta dessa reprodução. Isso não identifica sozinho se a origem é estado da saída, interação com o driver, seleção de monitor ou comportamento do plugin Desktop Duplication.

Uma solicitação temporária de manter sistema/tela ativos via `SetThreadExecutionState` foi aplicada, repetiu-se o teste e o resultado permaneceu preto. A solicitação foi restaurada ao final. Não houve mudança permanente de política de energia, driver, registro ou HAGS. Estação/desktop consultados eram WinSta0/Default, com sessão de console ativa; isso não comprova que o painel físico estava ligado.

Mais tarde, o inventário do Windows mostrou dois monitores 1920 × 1080, um em (0,0) e outro em (-1920,0), e um handle de monitor diferente da coleta inicial. A topologia/saída efetiva precisa ser registrada novamente em cada repetição. Não comparar handles entre sessões como identidades permanentes.

## Falha adicional na preparação do benchmark de monitor

### Preparação corrigida em 5/10

O harness passou a usar uma única janela Chrome com perfil próprio, em vez de criar outra janela/contexto após o lançamento. Os bounds da janela são ajustados pelo protocolo do navegador para fullscreen, e a emulação de foco é desabilitada. O Chrome usa seu sandbox normal nessa janela; isso também removeu a barra de alerta que reduzia a área útil. O helper de automação Windows foi tentado, mas não iniciou (`failed to write kernel assets`); essa preparação não depende dele.

O novo [smoke com validação óptica](../output/playwright/capture-content-2026-10-05T10-55-03-528Z/report.json) passou nos dez caminhos. Os PNGs passaram a exigir CRC/sessão e sequência/timestamp presentes no log da fonte, em vez de somente verificar pixels não pretos. A geometria registrada foi 1920 × 1080 tanto internamente quanto externamente, DPR 1. Assim, o teste comprovou captura da fonte correta em WGC/DXGI, incluindo conversão, roundtrip H.264/NVENC, memória de sistema e captura D3D12. Estes readbacks/PNGs continuam sendo smoke de funcionamento, não medições de latência.

O E2E comparativo também mantém uma solicitação temporária `ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED` durante o estudo. Um processo próprio segura a solicitação enquanto o stdin do runner estiver aberto e restaura o estado na mesma thread ao encerrar; a chamada não certifica sozinha que um painel físico está aceso. O teste de iniciar/parar verificou `applied:true`, `restored:true` e saída normal. O snapshot de cada rodada inclui os helpers. Antes da nova medição, o probe foi reconstruído a partir do código atual e 41 regressões passaram em três arquivos.

O [primeiro par curto com fonte correta](../output/playwright/compare-2026-10-05T10-58-55-984Z-a3b180/report.json) teve 11 marcadores distintos no aquecimento de cada caso, zero rejeições nesse aquecimento, resolução 720p e rota UDP LAN observada. Em dez segundos de coleta, WGC apresentou 54,7 FPS, 39 leituras, idade p50 67 ms e incerteza ±10,17 ms; DXGI apresentou 59,9 FPS, 38 leituras, idade p50 76 ms e incerteza ±9,13 ms. **O par não é controlado/qualificado**: CPU externa p95 foi 16,1% e 24,1%, respectivamente, por processos Chrome fora da árvore do E2E. Além disso, o envelope WGC excedeu o limite de ±10 ms. Esses números são dados exploratórios, não demonstram vantagem de latência de um método. A restauração da solicitação de energia foi confirmada no relatório.

Para a próxima execução, a validação usa o centro da união dos intervalos causais antes/depois e corrige a idade óptica com esse mesmo centro. Todos os offsets admitidos pelos checkpoints são preservados; o limite continua ±10 ms, incluindo a margem óptica de 1 ms. Um envelope realmente largo ou uma mudança de relógio continua invalidando o teste. Trinta testes passaram em quatro arquivos de relógio, qualificação e conteúdo. O usuário autorizou prosseguir após pausar abas pesadas; o preflight seguinte registrou CPU total p95 5,17%, externa 3,91% e GPU 0,35%.

As execuções curtas WGC posteriores receberam imagem da janela do Codex, sem marcador sintético válido. A fonte podia continuar produzindo frames e estar `visible` no DOM sem ser o conteúdo presente na imagem capturada do monitor. Também é necessário distinguir conteúdo atualmente visível de uma imagem antiga da composição.

- [Execução curta inicial](../output/playwright/compare-2026-10-05T02-53-58-016Z-ba20ed/report.json): zero leituras válidas, 11 rejeições; medição longa não iniciada.
- [Execução com fonte recolocada em primeiro plano após preparação remota](../output/playwright/compare-2026-10-05T02-56-56-087Z-e8e518/report.json): zero leituras válidas, 12 rejeições; também interrompida antes de medir.

Uma execução DXGI independente validou a rejeição: [compare-2026-10-05T02-58-52-483Z-2d2ba7/report.json](../output/playwright/compare-2026-10-05T02-58-52-483Z-2d2ba7/report.json). O Chrome reportou 1280 × 720, 326 frames decodificados, 60 FPS e zero perda de pacotes; o screenshot permaneceu preto. O guard encontrou zero marcadores válidos e 11 rejeições, encerrou com código 1 e não registrou nenhum intervalo na timeline. Esses counters foram coletados no aquecimento, não constituem benchmark de desempenho.

Recolocar a fonte em primeiro plano via Playwright não foi suficiente nesse ambiente. Essa inconsistência precisa ser resolvida antes de executar outra matriz longa. Não se trata de comprovação de latência ruim de WGC, nem prova que todos os casos anteriores capturaram a fonte errada: o caso sob carga inicial teve 221 marcadores válidos com proveniência verificada.

## Correções do instrumento

- Antes de calibrar/resetar/iniciar a coleta, exigir ao menos três amostras ópticas válidas **e três marcadores distintos** de sequência/timestamp. Um frame congelado com CRC válido também é recusado. O decoder óptico já verifica a sessão e o CRC.
- Quando essa condição falha, preservar evidência óptica, contadores de recepção, geometria e screenshots da fonte/receptor. Mensagem de falha não atribui automaticamente a ausência de marcador a vídeo preto, pois pode ser fonte errada ou problema do observador.
- `--fail-fast` encerra a rodada na primeira falha e executa a limpeza existente. SIGINT passa a sinalizar interrupção para que o loop chegue à limpeza, em vez de simplesmente abandonar o relatório.
- O smoke local retorna código de saída não zero quando encontra falha ou conteúdo preto, permitindo detecção por automação.
- 16 testes passaram nos dois arquivos de regressão de transporte/qualificação. Quatro casos novos verificam vídeo preto apesar de contadores, frame congelado, avanço com rollover e evidência ausente/malformada.

A verificação final por SSH encontrou zero tarefas, regras de firewall e processos próprios remanescentes nos quatro estudos: [cleanup-verification.json](../output/playwright/compare-2026-10-05T02-58-52-483Z-2d2ba7/cleanup-verification.json). Sintaxe dos scripts e `git diff --check` dos arquivos de regressão/harness passaram. Não houve commit/push nesta rodada.

Essas mudanças corrigem falsos sucessos do benchmark; não corrigem o driver ou a captura DXGI na aplicação. Não adicionar fallback automático baseado apenas em imagem escura: um jogo pode legitimamente mostrar uma tela preta.

## Próximos passos, em ordem

1. Despertar os monitores, cujo repouso foi confirmado pelo usuário; verificar qual saída o Chrome realmente ocupa e qual saída cada plugin captura. Registrar nome da saída, posição, adapter/LUID, handle e imagem atual. Revalidar o marcador durante preparação e medição. Em seguida, testar a transição ativo → repouso → ativo separadamente para comprovar causalidade e recuperação.
2. Repetir somente smoke de conteúdo para WGC e DXGI na mesma saída, sem carga, com imagem comprovadamente atual. Se DXGI seguir preto, coletar log específico do plugin e comparar adapter/saída antes de considerar versão de GStreamer ou driver.
3. Obter um teste curto com WGC válido e DXGI válido. Exigir conteúdo avançando, resolução correta, proveniência, relógios, continuidade e limpeza. Uma condição que falha nessa etapa não entra no benchmark longo.
4. Retomar três pares de 60 segundos sem carga e sob carga, com ordens alternadas, CPU externa controlada e a mesma rota de vídeo. Depois estudar recuperação, D3D12, resolução, áudio e jogos reais, variando uma condição por vez.

O padrão automático continua WGC. A vantagem de DXGI só poderá ser discutida depois de transmitir imagens úteis e atuais nas condições comparadas.

## Matriz após pausar as abas pesadas

Na [rodada interrompida de 11:05 UTC](../output/playwright/compare-2026-10-05T11-05-31-881Z-ae4f50/report.json), os cinco casos concluídos passaram no controle de recursos. Os monitores estavam acesos e a fonte correta foi comprovada por marcadores avançando. O par sob carga teve WGC 41,5 FPS / idade p50 132 ms e DXGI 59,3 FPS / 143 ms. A diferença de 11 ms na idade ficou dentro da soma das incertezas de relógio (19,4 ms); esse par não demonstra vantagem de latência. A fonte produziu cerca de 58 FPS, portanto 59,3 FPS decodificados não significam 59,3 imagens novas por segundo.

O primeiro DXGI sem carga terminou com duas amostras sem proveniência. A investigação encontrou uma corrida no instrumento: o log completo da fonte era obtido **antes** da última coleta óptica do receptor. Os frames 6267 e 6293 foram produzidos depois do snapshot, cujo último frame era 6265, e indevidamente ficaram sem referência no log. O estudo foi interrompido; os números concluídos e a classificação original foram preservados, sem requalificação retroativa. O segundo DXGI sem carga passou, mas apresentou idade máxima de 665 ms; isso exige investigação de caudas, não atribuição automática ao método de captura.

Correção: congelar a evidência do receptor antes de copiar o log completo da fonte; registrar o contador leve da fonte no término para calcular seu FPS sem acrescentar o tempo dos RPCs; analisar somente leituras ópticas cujo horário, corrigido pelo offset central calibrado, caia no período medido. As amostras brutas permanecem no relatório, com contagens anteriores/posteriores ao período e de evidências malformadas. Frames sem proveniência **dentro** do período continuam invalidando a rodada. A posição de amostras junto às bordas compartilha a incerteza de relógio documentada.

Quarenta e três testes passaram em seis arquivos. Quatro regressões novas cobrem a corrida entre snapshots, exclusão de amostras após o término sem ocultar erros dentro do período, rollover de sequência/timestamp e evidência malformada. A verificação pós-interrupção encontrou zero tarefas/regras remotas e zero processos locais próprios remanescentes. Não houve confirmação de restauração enviada pelo helper nessa interrupção; o processo que segurava a solicitação temporária de energia já havia saído. A nova matriz usa o instrumento corrigido.
