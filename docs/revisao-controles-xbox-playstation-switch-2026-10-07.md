# Revisão dos controles Xbox, PlayStation e Switch

Revisão em 7 de outubro de 2026, sobre o commit `eac2c6b`.

O fluxo básico da sala de controles funciona. A revisão inicial reproduziu
as três falhas abaixo; todas foram corrigidas posteriormente neste workspace.

## Correções e validação

- A seleção física pertence à sessão e acompanha o jogador do laboratório ao
  Co-op e ao calibrador individual. Ao desconectar, os inputs são neutralizados
  uma vez, sem trocar silenciosamente para outro controle. A reconexão retoma
  o controle escolhido. O polling também aguarda as capacidades do host.
- O calibrador envia a identidade do dispositivo ao visualizador, permitindo
  trocar automaticamente entre os modelos Xbox, PlayStation e Switch.
- A animação respeita o curso menor do Guide Xbox e dos botões +/- Switch,
  mantendo as peças visíveis nos modelos procedural e GLB.

Validação: 165 testes existentes e seis novos testes de regressão passaram.
O E2E visual cobre 12 cenários com WebGL real, com zero peças encobertas.
O E2E de Controller Lab passou com quatro participantes via WebRTC, inputs
isolados, layout móvel, fechamento e retomada do Co-op. Grafo de módulos,
smoke de imports ESM e build de `dist` passaram. A validação de hardware
físico e a recompilação do executável release não foram feitas nesta etapa.

## Evidência da revisão inicial

## P1 — O controle escolhido no laboratório não acompanha o jogador até a partida

O seletor grava o índice apenas na variável local `selectedIndex` de
`js/controller-lab/index.js:59`. Ao sair do laboratório, o Co-op lê
`gamepads[targetIndex] || gamepads[0]` em `js/coop/input.js:274`, sem receber
esse índice. O argumento da função também recebe o timestamp do callback de
`requestAnimationFrame`, em vez de representar uma seleção persistente.

Reprodução com dois controles simulados: Xbox no índice 0 pressionando A e
DualSense no índice 1 pressionando Circle. O laboratório selecionou e exibiu
DualSense/índice 1. Após fechar e receber autorização para jogar, a mensagem
`INPUT_GAMEPAD` veio do Xbox/índice 0: botão 0 ativo, botão 1 inativo.

Impacto: testar e confirmar um controle não garante que esse controle opere
a partida. Persistir a seleção no controlador da sessão, usá-la no polling
e separar o callback de RAF do parâmetro de índice. A desconexão do controle
selecionado precisa ter comportamento explícito, com neutralização dos inputs.

## P2 — O calibrador individual não troca o modelo para Xbox ou Switch

Em `js/coop/tester-controller.js:338`, `viewer3D.updateInputs` recebe eixos,
botões e conexão, mas não recebe `device` nem `id`. A detecção automática do
modelo em `js/gamepad-3d-viewer/mapping.js:19` depende dessas informações.

Reprodução executando o calibrador real com um gamepad Xbox simulado:
a amostra enviada ao visualizador contém os inputs, mas nenhum identificador.
O visualizador inicia com o modelo PlayStation e não tem como reconhecer Xbox
ou Switch nesse caminho. A sala de controles com amigos recebe o identificador
e renderiza os três modelos corretamente.

Impacto: o nome e os botões podem identificar um Xbox/Switch enquanto o modelo
3D mostra PlayStation. Encaminhar a identidade física e verificar a troca ao
selecionar outro controle, inclusive no fallback XInput.

## P2 — Alguns botões desaparecem na câmera ao serem pressionados

A mesma profundidade de pressão `PRESS_DEPTH = 0.08`, em
`js/gamepad-3d-viewer/mapping.js:125`, é aplicada aos três modelos. As alturas
iniciais dos botões de sistema dos modelos novos não mantêm folga suficiente:

- Xbox: `Button_Guide`, criado em `js/gamepad-model-builder.js:409`.
- Switch: `Button_Back` e `Button_Start` (−/+), criados nas linhas 524 e 531.

Reprodução em WebGL real, tanto nos modelos procedurais quanto nos GLBs:
os botões aparecem em repouso e ficam obstruídos pela geometria na câmera
padrão quando pressionados. A captura visual confirma o desaparecimento,
e os raycasts da câmera identificam as mesmas peças. O PlayStation passou
nos mesmos estados.

Impacto: a visualização perde o feedback justamente ao pressionar o botão.
Ajustar altura, curso ou limite por peça e repetir a validação visual para
GLB e procedural, com todos os modelos.

## O que passou

- 165 testes focados em modelos, animação, montagem, calibrador,
  Controller Lab, Co-op e roteamento de inputs.
- E2E Streamer/Viewer: quatro participantes, convite e aceite explícitos,
  inputs isolados, checklist e Pronto sincronizados, WebGL sem fallback,
  layout móvel sem overflow e fechamento sem perder a conexão.
- E2E Room: convite via mesh, nomes, input remoto e encerramento.
- Rótulos principais sincronizados: Xbox A/B/X/Y; PlayStation ✕/○/□/△;
  Switch B/A/Y/X, respeitando as posições do mapeamento standard.
- Pausa e retomada do Co-op ao entrar/sair do laboratório.
- Duas reproduções isoladas confirmaram a perda da identidade no calibrador
  e a divergência entre o controle selecionado e o utilizado pelo Co-op.

Os testes existentes passam porque não verificam a continuidade da seleção
física na partida nem a visibilidade dos botões de sistema dos modelos novos
sob pressão. O teste visual anterior exercita principalmente PlayStation.

## Limites

Gamepads foram simulados via `navigator.getGamepads`. WebRTC, DataChannels,
GLB e WebGL foram reais. Não houve homologação de hardware físico,
USB/Bluetooth, vibração, ViGEm ou entrega de comandos em um jogo nativo.

A normalização do laboratório limita os botões a 17. Botões extras como
Capture do Switch e Share do Xbox possuem geometria, mas não são animados
pelo mapeamento atual. Isso é uma limitação do escopo atual da visualização.

## Evidências locais

Os arquivos abaixo ficam em `output/`, ignorado pelo Git:

- `output/playwright/gamepad-audit-2026-10-07/selection.json` — seleção e input enviados.
- `output/playwright/gamepad-audit-2026-10-07/repro.test.js` — reproduções dos dois problemas de integração.
- `output/playwright/gamepad-audit-2026-10-07/surfaces.json` — raycasts dos três modelos, GLB/procedural e repouso/pressionado.
- `output/playwright/gamepad-audit-2026-10-07/after.png` — comparação visual.
- `output/playwright/gamepad-audit-2026-10-07/network/report.json` — fluxo de rede aprovado.
- `output/playwright/gamepad-audit-2026-10-07/network/labels.json` — rótulos por modelo.

![Modelos no fluxo com quatro participantes](../output/playwright/gamepad-audit-2026-10-07/network/desktop.png)

![Comparação de modelos GLB e procedurais](../output/playwright/gamepad-audit-2026-10-07/after.png)
