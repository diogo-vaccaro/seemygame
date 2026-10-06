# Transmissão entre duas instâncias desktop — 2026-10-05

## Reavaliação do carregamento permanente em sala real

O relato posterior mostrou que corrigir o congelamento do decode não bastava.
Os logs dessa tentativa tinham captura/prévia local funcionando e nenhuma
ponte remota criada. Reproduzido com dois executáveis release, sala pública
de diagnóstico separada, CDN/PeerJS normais e CSP ativo, o console revelou:

```text
DIRECT_STREAM_OFFER: invalid args `iceServers` for command
`create_native_viewer_peer`: invalid type: map, expected a string
```

Evidência anterior à correção:
`output/playwright/desktop-stream-repro-2026-10-05/production-1791242736013/report.json`.
O host apresentava 847 frames locais, mas o receptor tinha zero frames e
uma conexão no estado `new`. A oferta chegava ao host; a validação IPC
rejeitava a lista antes de executar o comando Rust. O congelamento de decode
descrito abaixo é outro defeito, reproduzido em condições diferentes.

Na modularização, `NativeMediaPlugin` passou a fornecer objetos `RTCIceServer`
de `getPeerConfig()`, enquanto Rust continuou recebendo `Option<Vec<String>>`.
O fluxo legado convertia esses objetos para URIs. Os E2E com sinalização
local forneciam `iceServers: []`, ocultando essa incompatibilidade.

A conversão agora fica na fronteira IPC, em `js/desktop/ice-servers.js`,
usada tanto por `createNativeViewerPeer` quanto por `startNativeViewer`:
preserva strings existentes, expande arrays de URLs e inclui credenciais
TURN escapadas em URIs GStreamer. Não altera os objetos usados pelos
RTCPeerConnection do navegador. Duas regressões com a configuração padrão
STUN/TURN e credenciais especiais falharam antes da correção e passaram depois.

O runner aceita `--production-signaling`: mantém a configuração pública,
não intercepta a API TURN e não desativa CSP nas páginas Tauri. O modo local
continua disponível para experimentos controlados; passar apenas nele não
homologa o contrato ICE usado em salas normais. As salas desse modo são
exclusivas do teste e não entram na sala da pessoa.

### Confirmação após corrigir o contrato ICE

- E2E `2026-10-05T23-30-55-230Z-23e0c6`: dois Tauri release, H.264 com
  áudio do sistema, preset Dinâmico, mesma pasta solicitada e isolamento
  secundário comprovado; sinalização pública e CSP ativo. Passou em 15 s:
  mediana de decode 60,29 FPS, p10 59,01 FPS, 1.044 frames apresentados,
  14 avanços em 15 amostras e zero pausas diagnosticadas. Um peer GStreamer
  direto e nenhuma chamada de vídeo PeerJS.
- Repetição equivalente à abertura manual, sem flags de desempenho,
  sem substituir CDN/configuração ICE/API TURN e sem bypass CSP:
  `desktop-stream-repro-2026-10-05/production-1791243165831/report.json`.
  Sala pública própria, ambas as admissões aguardadas; o receptor passou
  de zero frames/conexão `new` antes da correção para 797 frames e
  `connected`. Capturas `app-0.png`/`app-1.png` comprovam a recepção.
- Suíte atual: 130 arquivos / 1.275 testes aprovados. Release recompilado
  às 20:29:53 e debug às 20:32:08 (horário local em 2026-10-05).

Para repetir a rodada formal, abra o agente em um terminal:

```powershell
node tools/e2e/viewer-agent.mjs --runtime tauri --exe src-tauri/target/release/seemygame.exe --browser-port 19443 --control-port 19444 --max-minutes 15 --desktop-profile output/playwright/production-ice-test/common --ready-file output/playwright/production-ice-test/ready.json --no-system-metrics
```

E execute em outro:

```powershell
$receiverReady = Get-Content output/playwright/production-ice-test/ready.json -Raw | ConvertFrom-Json
node tools/e2e/run.mjs --exe src-tauri/target/release/seemygame.exe --seconds 15 --channel chrome --preset balanced --codec h264 --viewer-endpoint $receiverReady.controlEndpoint --allow-same-machine-remote --optical-hz 0 --no-system-metrics --desktop-profile output/playwright/production-ice-test/common --native-audio system --min-fps 30 --expect-profile-isolation --production-signaling
Invoke-RestMethod -Method Post -Uri ($receiverReady.controlEndpoint + '/shutdown')
```

Essa validação é funcional e curta, na mesma máquina. Não mede latência
glass-to-glass nem comprova travessia por TURN entre redes: anunciar
servidores e concluir negociação não prova seleção de um candidato relay.
O endpoint TURN retornou 401 nessa máquina; o fallback estático permitiu
a conexão local. A investigação não tratou provisionamento TURN como
resolvido por esta correção. Todos os processos de teste foram encerrados.

## Código e reprodução

Checkout limpo em `main`, sincronizado por fast-forward de `eeeca1a` para
`origin/main` em `1e9b6b1`. Frontend e executável release recompilados. As
correções desta investigação foram validadas localmente antes da publicação.

Testes com dois executáveis Tauri reais, fonte sintética dedicada, H.264,
perfil Dinâmico, NVENC/D3D12 automático, receptor WebView2 visível. Os dois
participantes entraram na mesma sala com sinalização local isolada e
autorização mútua. Envio direto GStreamer: zero chamadas de vídeo PeerJS e
um peer nativo remoto. Não foi usado o normalizador SDP diagnóstico.

## Evidências anteriores à correção

| Execução em `output/playwright/` | Condição | FPS mediano / p10 decodificado | Evidência |
| --- | --- | --- | --- |
| `2026-10-05T22-25-35-741Z-4507e7` | Perfis separados, sem áudio | 60,05 / 59,23 | Recepção contínua |
| `2026-10-05T22-30-22-585Z-13f049` | Mesmo perfil, áudio do sistema | 0 / 0 | Até 6,54 s sem avanço nas amostras de apresentação |
| `2026-10-05T22-33-45-067Z-afb877` | Perfis separados, áudio do sistema | 59,27 / 57,21 | 1.007 frames apresentados, zero pausas diagnosticadas |
| `2026-10-05T22-36-59-802Z-907f73` | Mesmo perfil, sem áudio | 0 / 0 | Até 8,79 s sem avanço nas amostras de apresentação |
| `2026-10-05T22-39-05-477Z-a10203` | Mesmo perfil, decode acelerado desativado | 60,16 / 59,15 | 1.030 frames apresentados, zero pausas diagnosticadas |

Os dois testes com perfil compartilhado recebem quadros/pacotes, mas os
contadores de decodificação e apresentação deixam de avançar. Há pedidos
PLI crescentes, sem perda RTP correspondente. Captura e saída da ponte
continuam próximas de 60 FPS. Portanto, a interrupção observada está depois
da chegada do vídeo ao receptor. Áudio não é requisito para reproduzi-la.

A mudança de perfil e a desativação do decode acelerado eliminam a falha
nas rodadas observadas. Isso identifica uma interação com o ambiente
WebView2 compartilhado e o caminho de decode acelerado. Ainda não prova
qual componente interno, driver ou versão do Chromium causa a interação.
Não se trata de comprovação de falha genérica do H.264 ou da rede.

Segundo a [documentação Microsoft](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder),
WebViews com a mesma pasta de dados compartilham os processos do navegador.
Perfis diferentes separam esses ambientes e consomem memória/disco adicionais.

A hipótese inicial de payload H.264 abaixo de 96 não se confirmou: nesta
WebView2, a oferta começa em H.264 PT 102, packetization-mode 1. A seleção
de payload continua sendo uma oportunidade separada de hardening.

## Correção

`src-tauri/src/instance_profile.rs` reserva um slot por perfil usando um
objeto nomeado do Windows, mantido durante toda a vida do processo. O slot
principal mantém o perfil atual; instâncias adicionais usam diretórios
persistentes distintos. Slots livres podem ser reutilizados após o
encerramento. Não se copia SQLite/localStorage de um perfil aberto, não se
apagam dados e não se desativa a GPU de todos os usuários.

Cada instância adicional tem suas próprias preferências, identidade local
e aceite inicial. Fechar a primeira não transfere o perfil da segunda.
É necessário abrir ambos os executáveis atualizados: um executável antigo
não participa da reserva de slots. Perfis explicitamente fornecidos pelo
E2E também são isolados quando duas instâncias solicitam a mesma pasta.

O override `WEBVIEW2_USER_DATA_FOLDER` é definido antes da criação da
WebView. A primeira tentativa usando apenas `WindowConfig.data_directory`
não funcionou na dependência instalada: `tauri-runtime 2.11.3`, em
`WebviewAttributes::from`, não copia esse campo. A abertura normal das duas
instâncias reprovou essa tentativa e passou após o uso do override. Sem
override explícito, a base acompanha `LOCALAPPDATA/<identifier>`, como o
perfil padrão do Tauri; diretórios secundários incluem o identifier.

## E2E

O runner aceita `--desktop-profile` dentro de `output/playwright` e
`--native-audio none|system|process`. O viewer aceita a mesma pasta de
teste. O isolamento é feito pelo produto, não pelo harness, no teste da
correção. `--software-video-decode` no viewer é somente um controle
diagnóstico; não é a configuração recomendada para produção.

`--desktop-cdp-port` permite identificar duas WebViews no mesmo navegador
para reproduzir a arquitetura anterior com um binário anterior à correção.
Nesse caso, é preciso usar argumentos WebView2 idênticos e identificar o
receptor pelo target CDP, em vez de escolher arbitrariamente a primeira aba.

Além de receber o primeiro frame, o resultado agora exige continuidade de
apresentação durante a amostragem: três segundos observados sem avanço
reprovam o teste. Áudio/currentTime avançando não satisfaz essa verificação.
Aplicado retrospectivamente, esse critério reprova ambos os casos de
congelamento da tabela, inclusive o falso positivo que antes dizia `passed`.

## Limites

Rodadas funcionais curtas de 12–15 segundos, na mesma CPU/GPU, com fonte
sintética. A latência óptica foi desativada. Não certificam estabilidade
prolongada, vídeo protegido, jogos, rede remota, todos os codecs ou o
instalador distribuído. O CSP é contornado somente nas páginas isoladas do
harness para permitir a sinalização HTTP/WebSocket local; o CSP da produção
não foi relaxado. Rodadas interrompidas por identificação/estado incorreto
do harness não foram usadas para concluir causa de falha do produto.

## Validação da correção

| Execução | Condição | FPS mediano / p10 | Resultado |
| --- | --- | --- | --- |
| `2026-10-05T22-47-15-632Z-5fe8da` | Mesma pasta solicitada, isolamento pelo produto, sem áudio | 60,30 / 59,23 | Zero pausas; frames avançam em todos os intervalos |
| `2026-10-05T22-51-44-997Z-aa8ccc` | Mesma pasta solicitada, isolamento pelo produto, áudio do sistema | 59,82 / 59,55 | Zero pausas; 1.010 frames apresentados; isolamento secundário confirmado pelo log |
| `2026-10-05T23-00-54-452Z-b8ec2e` | Código final, mesma pasta solicitada, áudio do sistema | 60,13 / 59,07 | Zero pausas; 1.030 frames apresentados; 14 avanços em 15 amostras; isolamento comprovado |

A rodada com áudio recebeu 799 pacotes Opus, 761.280 amostras e zero perda
RTP. Isso comprova transporte e atividade da trilha; não é avaliação de
audibilidade/fidelidade nem sincronismo labial com marcador sonoro.

`output/playwright/desktop-stream-repro-2026-10-05/default-profile-smoke.json`
confirma abertura de duas instâncias sem fornecer pasta de teste: a
primeira preserva o perfil normal, a segunda usa
`LOCALAPPDATA/com.seemygame.app-instances/instance-2`. Ambas abrem
`lobby.html` em processos WebView2 acessíveis por portas CDP distintas. Esse
smoke não entra em salas nem modifica preferências da pessoa.

Na rodada final, a captura e o envio permaneceram nativos: um peer direto
GStreamer e zero chamadas de vídeo PeerJS. O receptor também era um
executável Tauri; o nome histórico `webInbound` no JSON designa as métricas
do `RTCPeerConnection` da WebView2, não um receptor Chrome externo.

Os dois testes Rust de perfis passaram, incluindo reserva simultânea de
slots e reutilização somente depois da liberação. Os testes JavaScript de
isolamento/continuidade verificam também evidência de startup, ausência de
frames, reset do contador e congelamento após o primeiro frame.

Suíte final: `npm test -- --run --maxWorkers=2`, 130 arquivos e 1.273 testes
aprovados. Uma rodada concorrente com a compilação Rust teve dois timeouts
de hooks de inicialização em `app.test.js`/`review-app-integration.test.js`;
a repetição sem compilação concorrente passou. Não foram aumentados os
timeouts nem alteradas essas asserções. Build release e `git diff --check`
passaram; permanecem avisos do linker Windows sobre a biblioteca gerada.
O executável debug também foi recompilado com o código final; a validação
de transmissão descrita acima utilizou release. Todos os processos de
aplicativo e helpers criados para esses testes foram encerrados.
