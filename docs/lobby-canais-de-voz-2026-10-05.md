# Lobby e canais de voz — 05/10/2026

## Comportamento

- Entrar na sala coloca a pessoa no lobby, sem solicitar microfone nem conectar chamadas de voz.
- O chat de texto é compartilhado por todos os participantes, independentemente do canal de voz.
- Existem inicialmente **Bate-papo 1** e **Bate-papo 2**. Clique no canal para ouvir e falar; a permissão do microfone só é solicitada nessa ação.
- Trocar de canal encerra as chamadas anteriores. Voltar ao lobby ou desconectar encerra também as trilhas de captura, inclusive uma solicitação de microfone ainda pendente.
- Participantes admitidos podem criar canais de voz. O coordenador valida e distribui o catálogo, com nomes de até 32 caracteres, sem duplicação e limite de 12 canais. Quem entra depois recebe o catálogo e a presença atual, mas começa no lobby.
- O catálogo pertence à sessão da sala; não há persistência nova em servidor ou banco de dados.
- Chamadas recebidas e eventos de mídia atrasados só são aceitos quando ambos estão no mesmo canal. Soundboard também respeita o canal e o estado do fone silenciado.
- O áudio de uma transmissão continua independente da conversa. É possível assistir ou transmitir no lobby sem ingressar na voz.

## Organização da interface

Esquerda: lobby, canais e participantes; rodapé com configurações de voz, controles, microfone e fone. Centro: transmissão ou participantes do canal selecionado. Direita: chat de texto permanente em telas maiores; botão único para abrir em janelas compactas.

Emojis, sons, transmissão, qualidade, lousa e saída ficam na barra inferior. A antiga barra lateral flutuante e os acessos duplicados foram removidos. Convite tem uma única ação, e o cabeçalho mostra separadamente o estado de conexão. O clipe fica no cartão da transmissão; parar a transmissão local fica somente na barra inferior.

## Evidências

- `npm run verify`: 131 arquivos / 1.284 testes aprovados, imports ESM, grafo de módulos, HTML e CSS verificados, frontend gerado.
- Testes direcionados após o último ajuste de cartão: 73 testes aprovados; `git diff --check` sem erros.
- `npm run test:e2e:room-channels`: quatro contextos isolados de Chrome, transporte real PeerJS/WebRTC, microfone e captura sintéticos. Verifica lobby silencioso, texto global, isolamento de chamadas, recepção de RTP de áudio, troca de canal, criação por convidado, entrada tardia, encerramento das trilhas, isolamento do soundboard e transmissão web iniciada no lobby. Layout verificado em 1440, 900 e 600 pixels.
  - Evidência: `output/playwright/room-channels-1791245489748/report.json` e imagens na mesma pasta.
- E2E de controles: microfone, fone, propagação do estado remoto, configurações de voz e reconexão da sinalização aprovados.
  - Evidência: `output/playwright/room-controls-1791244913569/report.json`.
- E2E de negociação: áudio bidirecional aprovado nas duas ordens de entrada.
  - Evidência: `output/playwright/room-findings-1791245040432/report.json`.
- E2E de lousa: abertura pelo botão único da sala, fechamento, Escape e retorno à sala aprovados; página streamer clássica preservada.
- Desktop → desktop com H.264 e áudio de sistema: controles de voz aprovados em ambos os executáveis, recepção e continuidade do vídeo aprovadas durante 15 segundos, sinalização de produção e perfis isolados.
  - Evidência: `output/playwright/2026-10-06T00-09-29-338Z-bbfee6/report.json`.

Os testes de áudio utilizam microfones sintéticos; não homologam hardware de áudio físico. Os testes desta alteração são funcionais, em uma máquina, e não constituem comparação de latência ou benchmark sob carga de jogos.

O executável debug foi atualizado. O release estava aberto pelo usuário; sua reconstrução foi interrompida pelo bloqueio de arquivos do Windows, sem encerrar a instância do usuário. As validações acima foram realizadas antes dos commits e da publicação na main.
