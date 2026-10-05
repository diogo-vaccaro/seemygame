# WGC/DXGI: opções avançadas e planejamento de homologação

## Entrega no código

- Campo **Método de captura** com Automático, WGC e DXGI, separado de **API gráfica** D3D11/D3D12. Preferência persistida em `seemygame_capture_method`.
- Automático resolve para WGC tanto em janela quanto em monitor. A escolha explícita na interface prevalece sobre o override de ambiente; clientes internos sem o novo argumento continuam usando a configuração do worker.
- DXGI é permitido somente para monitor inteiro. O seletor modular bloqueia janelas e o Rust recusa uma combinação inválida antes de iniciar o worker. Nenhuma fonte é convertida de janela para monitor.
- O método ativo é devolvido em `capture_api` / `captureApi` no estado nativo e escrito no log do worker. O fallback existente D3D12 → D3D11 conserva o método de aquisição e a fonte; não há fallback automático de DXGI → WGC nesta entrega.
- A alteração vale no próximo início. Mudanças de bitrate/áudio preservam o método ativo, e o comando Rust recusa trocar esse método durante a sessão.
- O navegador continua escolhendo internamente seu mecanismo através de `getDisplayMedia`; o campo fica desabilitado na web.

## Hipótese a comprovar

DXGI pode manter melhor cadência sob disputa gráfica do que WGC para o mesmo monitor. O estudo anterior de componentes mostrou aproximadamente 60 FPS em DXGI e 22–23 FPS em WGC sob carga sintética. Isso não comprova 60 imagens diferentes nem menor idade visual no espectador. A comparação decisiva deve usar **monitor WGC contra o mesmo monitor DXGI**, sem misturar captura de janela, políticas de fila ou motores de recepção diferentes.

## Validação desta entrega

- 50 testes JavaScript passaram em seis arquivos selecionados: opções, seletor modular, provider, wrappers desktop, seletor legado e qualificação comparativa E2E.
- Suíte Rust: 61 testes passaram; três benchmarks reais permaneceram ignorados. O teste antigo que previa DXGI → WGC silencioso em uma janela foi atualizado para exigir rejeição explícita.
- `cargo check --lib`, grafo de módulos, páginas geradas, sintaxe do harness, importação ESM e build de distribuição foram verificados.
- Estes resultados comprovam seleção/validação e preparação do diagnóstico. Não representam uma nova rodada de desempenho em duas máquinas. Nenhum executável release ou instalador foi reconstruído nesta entrega.

## Etapa 1 — Segurança e funcionamento das opções

Regressões: persistência independente de D3D11/D3D12; argumento IPC chega ao worker; Automático mantém WGC; DXGI+janela falha sem capturar o monitor; método retornado corresponde ao pipeline; alterações pendentes não vazam em mudanças ao vivo. Validar também as páginas geradas e `cargo check --lib`, pois os comandos Tauri ficam fora de `cfg(test)`.

Teste manual no app: iniciar monitor com WGC e DXGI; parar/reiniciar; conferir log/estado; abrir uma janela por cima do monitor; confirmar escopo de captura; conferir que a janela específica está indisponível em DXGI. Testar resolução, resize e fechamento da fonte sem manter sessão órfã.

## Etapa 2 — Comparação causal mínima em duas máquinas

Primeiro fixar **D3D11, H.264/NVENC, 720p60, 7,5 Mbps, fila bounded, sem áudio/replay/prévia**, receptor Chrome no notebook e uma única rota ICE observada. Fonte sintética com contador de sequência/tempo, sessão/CRC e tamanho real registrado. Transmissor e receptor precisam do mesmo snapshot de diagnóstico, hashes de fonte/binário registrados; não basta atualizar o HTML em um executável antigo.

Usar três pares de 60 segundos por condição, com warm-up excluído e ordens alternadas WGC→DXGI / DXGI→WGC. Não compilar nem rodar Vitest durante a coleta. Fazer preflight CPU/GPU e informar execuções não qualificadas. Manter carga gráfica intencional durante a medição; não rejeitar um teste somente por a GPU estar saturada pela própria carga planejada.

| Condição | Comparação | Pergunta |
| --- | --- | --- |
| Sem carga sintética | Monitor WGC × monitor DXGI | A alternativa não prejudica o baseline? |
| Carga gráfica controlada | Monitor WGC × monitor DXGI | Captura mais imagens novas sem aumentar idade/cauda? |
| Recuperação de carga | Carga ligada e depois desligada | Filas drenam, a cadência recupera e a sessão permanece estável? |

O harness `compare-capture-renderer.mjs` agora oferece `monitor-wgc`/`monitor-dxgi` sob carga e `monitor-idle-wgc`/`monitor-idle-dxgi` sem carga. A comparação DXGI usa monitor WGC como baseline; janela WGC não é mais seu controle. O aquecimento mínimo de três segundos após a primeira mídia é registrado e excluído da amostragem, que começa após a calibração e reset dos contadores. Confirmar relógios/geometry guards antes de interpretar resultados.

Exemplo de rodada sob carga, após preparar ambos os snapshots e verificar rota/firewall:

```powershell
node tools/e2e/compare-capture-renderer.mjs --public-stun --allow-private-receiver-udp-from 192.168.15.4 --seconds 60 --repeat 3 --cases monitor-idle-wgc,monitor-idle-dxgi,monitor-wgc,monitor-dxgi --observer-fps 60
```

Essa linha usa a política anteriormente autorizada de STUN público e regra UDP temporária restrita no notebook. Confirmar que o IP do desktop e perfil Private continuam corretos e verificar a remoção da regra/tarefa no final. SSH é controle, não prova da rota do vídeo.

## Etapa 3 — Jogos reais e matriz ampliada

Somente após o par mínimo, repetir em um jogo já instalado, sem alterar resolução/renderização/configuração do jogo entre os pares. Usar cena ou benchmark reproduzível; registrar frametime do jogo e utilização por motor da GPU. Comparar FPS livre e limitado separadamente. Um efeito em carga sintética não será apresentado como ganho confirmado em todos os jogos.

Expandir uma variável por vez:

1. 720p60 → 1080p60 mantendo captura, encoder, bitrate adequado e fonte iguais dentro de cada par.
2. D3D11 → D3D12 com H.264/NVENC. DXGI existe nos dois plugins do GStreamer, mas cada caminho precisa de execução própria; suporte documental não equivale a homologação.
3. Fila bounded → latest com o método fixo. Contabilizar descarte e idade; não inferir vantagem do método de captura quando a fila também mudou.
4. Áudio ligado, depois replay e prévia: verificar continuidade de áudio, sincronia A/V e caudas de vídeo. Não mudar todos juntos.
5. Receptor desktop/web mantendo o transmissor fixo. Registrar o motor de recepção real; uma WebView desktop não prova uso do renderer Direct3D dedicado.

## Métricas e decisão

- **Fonte:** FPS produzido, contador óptico único, pausas, resolução interna/CSS/DPI e visibilidade.
- **Captura/conversão/encode:** frames por etapa, descarte/duplicação, tempo em fila, idade por sequência quando correlacionável; codec/encoder/método/backend efetivos.
- **Rede:** rota e protocolo selecionados, RTT, bitrate, perda, NACK/PLI e jitter. Relógios calibrados antes/depois, erro máximo ≤10 ms; rejeitar com causa explícita quando exceder.
- **Receptor:** decode FPS, imagens únicas observadas, callbacks de apresentação, intervalos p50/p95/p99, congelamentos e idade visual p50/p90/p99. A observação WGC do receptor inclui seu próprio atraso e não é scanout físico.
- **Recursos:** CPU total e por processo, GPU 3D/Copy/Video Encode/Decode, memória e carga externa; frametime do jogo para detectar se a transmissão prejudicou a partida.
- **Estatística:** comparar deltas por par e dispersão entre repetições. Não tratar callbacks como imagens únicas, somar médias de etapas para explicar uma mediana final ou declarar p99 robusto com poucas dezenas de amostras.

Considerar mudar o Automático para DXGI **somente em monitor** se a vantagem em imagens novas/pausas sob carga se repetir além da incerteza de medição, sem regressão consistente no baseline, áudio, recuperação ou frametime do jogo. Se o resultado depender do driver/hardware, manter seleção manual e WGC automático. Janelas permanecem WGC. Não prometer latência de 40–50 ms nem prioridade de GPU com base apenas no método de captura.

## Referências de suporte

### Resultado da primeira execução

A rodada de 4–5/10 foi interrompida: DXGI entregou vídeo preto apesar de aproximadamente 60 FPS decodificados, e a preparação posterior de monitor WGC não garantiu presença da fonte sintética. O instrumento agora exige marcadores distintos antes de medir. Veja [diagnóstico e evidências](diagnostico-homologacao-wgc-dxgi-2026-10-05.md). A matriz longa permanece pendente da validação de conteúdo; não há homologação para mudar o padrão.

Atualização em 5/10: a fonte correta passou nos dez caminhos locais com os monitores acesos. Corrigiram-se a ordem dos snapshots e a janela de análise. O controle do observador sem transmissão revelou medianas de 131 ms a 8 Hz, 42–45 ms a 30 Hz e 11–12 ms a 60 Hz no desktop. Uma matriz exploratória de oito casos de 30 segundos a 60 Hz solicitados concluiu: DXGI manteve cerca de 60 FPS sob carga contra cerca de 42 FPS WGC, sem diferença de latência além do erro dos relógios. A taxa óptica real no notebook ficou em cerca de 3,7 Hz; a calibração remota e a atribuição/qualificação dos processos do receptor são pendências anteriores à homologação longa. O padrão permanece WGC. O diagnóstico vinculado acima contém os relatórios e limitações; as pendências de conteúdo descritas no histórico anterior já foram resolvidas.

- [Microsoft Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [Microsoft DXGI Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)
- [GStreamer d3d11screencapturesrc](https://gstreamer.freedesktop.org/documentation/d3d11/d3d11screencapturesrc.html)
- [GStreamer d3d12screencapturesrc](https://gstreamer.freedesktop.org/documentation/d3d12/d3d12screencapturesrc.html)
