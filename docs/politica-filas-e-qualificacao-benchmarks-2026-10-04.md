# Filas de vídeo e qualificação dos benchmarks — 04/10/2026

O pipeline real agora tem uma política explícita para suas duas filas de vídeo cru, antes do encoder. O padrão permanece `bounded`: três frames, limite temporal de 50 ms e bloqueio quando a fila enche. A opção `latest` guarda um frame e descarta o mais antigo quando necessário, sem limite temporal adicional. Não altera codec, API de captura, backend automático, áudio ou filas RTP comprimidas.

O experimento anterior reduziu a mediana após captura em aproximadamente 75 ms no D3D12 sob carga. Esse resultado não certifica ganho E2E equivalente nem compatibilidade com áudio/replay. Por isso `latest` continua uma opção de homologação, não o novo padrão.

Para iniciar o aplicativo com a opção, definir a variável no mesmo terminal antes de executar o aplicativo:

```powershell
$env:SEEMYGAME_NATIVE_RAW_QUEUE = 'latest'
# iniciar o SeeMyGame neste terminal
```

Para voltar ao comportamento atual, usar `bounded` ou remover essa variável do processo. Valores desconhecidos são rejeitados. Não há persistência global nem ajuste automático por FPS. A configuração é preservada pelo clone usado em restart de áudio/fallback e registrada no log do worker.

O probe usa `RawVideoQueuePolicy` e o mesmo `build_pipeline` da produção. `SMG_COMPARE_RAW_QUEUE=latest` seleciona essa política diretamente; não há mais substituição textual de tamanhos ou inclusão posterior de `leaky`. Os drivers registram hashes de `config.rs`, `pipeline.rs` e do guard de recursos.

## Proteção contra carga externa

`compare-capture-components.mjs` e `compare-capture-renderer.mjs` amostram recursos antes de abrir a fonte/carga sintética. A verificação espera até 15 segundos por cinco amostras novas e requer ao menos três leituras válidas de CPU total, CPU externa e GPU. Falta de contadores não significa uso zero.

Orçamentos iniciais, explícitos no relatório:

| Verificação | Limite |
| --- | --- |
| CPU total p95 | 85% |
| CPU de processos externos p95 | 10% |
| GPU mais ocupada p95, apenas antes do teste | 90% |
| Ferramentas externas potencialmente concorrentes | 2% de CPU por processo |

CPU é normalizada para a máquina inteira. `node`, `cargo`, `rustc`, `link`, `clippy-driver`, `msbuild`, `cmake`, `ninja` e `vitest` com atividade acima do limiar são sinalizados; um Node ativo também pode ser aplicação do usuário, portanto isso não certifica que seja um teste. Não coletamos linhas de comando nem encerramos processos externos.

Uma verificação inicial reprovada bloqueia o teste por padrão, preservando os motivos no JSON. Durante a medição, a carga GPU deliberada não reprova o caso. CPU excessiva ou ferramentas concorrentes preservam métricas e resultado técnico, mas mudam o status para `resource-pressure-unqualified`, excluindo o caso do ranking. Estes orçamentos são critérios metodológicos configuráveis, não limites universais do hardware.

Opções dos dois drivers:

```text
--max-external-cpu 10
--max-system-cpu 85
--max-preflight-gpu 90
--allow-resource-pressure
```

A última opção permite investigar um ambiente ocupado. Não transforma um caso reprovado em evidência qualificada; inclusive uma falha inicial continua marcada mesmo se a medição posterior estiver calma. Para estudos deliberados de carga CPU, definir antecipadamente um orçamento adequado e registrar a escolha.

O guard obrigatório atua no transmissor local. Recursos do notebook continuam registrados como contexto: o processo do receptor nativo, iniciado em tarefa separada, pode ser classificado como externo, impedindo aplicar o mesmo orçamento externo de maneira justa sem corrigir essa atribuição. A coleta tem resolução aproximada de um segundo e pode não detectar picos curtos ou processos protegidos. Nenhum mecanismo impede absolutamente que outro programa comece trabalho após a verificação inicial.

## Verificação e próximos ensaios

Testes de regressão verificam que somente as duas filas cruas mudam, que o restante do caminho codificado/áudio é idêntico, que políticas inválidas são rejeitadas e que carga/falta de contadores/overrides não produzem falsos casos válidos. D3D11/D3D12, 30/60/120 FPS e os encoders/codecs disponíveis estão cobertos na construção do pipeline.

Ainda dependem de novas rodadas: tornar `latest` padrão, mudar a preferência automática D3D12, escolher DXGI automaticamente e ativar o renderer nativo no fluxo de produção. Não foram alterados nesta entrega. Não é deploy: o push publica fontes; executáveis precisam de um build posterior para incorporar a configuração.
