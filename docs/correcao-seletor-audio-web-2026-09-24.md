# Seletor de compartilhamento sem opção de áudio

Relato: com o fone wireless, a opção de áudio desaparece em guia, janela e tela inteira no SeeMyGame; com cabo ela aparece. O usuário relata áudio disponível no Meet com wireless.

## Evidência no código

O caminho web enviava `windowAudio: "include"`, valor inválido para essa opção. Os valores definidos são `window`, `system` e `exclude`. Em navegador que reconheça a opção, a conversão pode rejeitar a chamada antes do seletor.

O catch tratava qualquer mensagem contendo “audio” como falha de driver e repetia `getDisplayMedia` com `audio: false`. Uma mensagem sobre `windowAudio` também atende esse filtro. Essa segunda chamada explica como o próprio aplicativo pode apresentar um seletor sem opção de som em todas as categorias.

Isso demonstra um defeito de software, mas não comprova a relação com a mudança cabo/wireless: falta capturar o erro original no equipamento durante a reprodução. Não foi encontrada uma checagem de enumeração do dongle controlando essa solicitação.

## Alterações

- Extração da construção e solicitação para `js/browser-capture.js`, utilizado por `startLocalStream`.
- `system` solicita `windowAudio: system`; `process` solicita `windowAudio: window`. São preferências sujeitas ao suporte do navegador, não garantias de isolamento.
- `none` e `mic` continuam sem solicitar áudio do compartilhamento.
- Removida preferência de dois canais; o dispositivo/browser pode fornecer seu formato disponível.
- Removida repetição automática com áudio desativado. Falhas retornam ao tratamento de erro e deixam nova tentativa sob ação do usuário.
- Logs de opções antes da solicitação e nome/mensagem/constraint do erro. Nenhum rótulo de driver é inventado.
- Resultado legitimamente sem trilha de áudio continua permitido, com mensagem explícita sobre o resultado do navegador.

## Teste no equipamento

1. Recarregar a versão web local atualizada; a versão publicada não foi implantada nesta tarefa.
2. Selecionar áudio do sistema, conectar wireless e abrir compartilhamento.
3. Conferir guia/janela/tela; escolher uma fonte com som e marcar áudio quando disponível.
4. Verificar som no espectador e quantidade/configuração de trilhas no log `[Capture Browser]`.
5. Repetir com cabo, mesma versão do Chrome e mesma fonte. Se faltar opção, conservar os logs da solicitação e da falha.
6. Conferir cancelamento e modo apenas vídeo: uma ação deve abrir no máximo um seletor.

Testes adicionados cobrem enums/modos, opções do E2E, ausência de imposição de canais/dispositivo, propagação de erros sem segunda chamada e retorno sem áudio. Não substituem validação com hardware e seletor reais.

Validação executada: 10/10 testes novos aprovados; sintaxe de `app.js` e `browser-capture.js` e `git diff --check` sem erros. Suíte completa: 509/510 testes aprovados. A falha em `tests/coop.test.js:247` espera `true`, mas `triggerGamepadRumble` retorna uma Promise; esse módulo não foi alterado nesta correção.

Referência: [W3C Screen Capture — WindowAudioPreferenceEnum](https://www.w3.org/TR/screen-capture/#dom-windowaudiopreferenceenum).
