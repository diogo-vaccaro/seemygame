# Revisão dos novos commits remotos — 7 de outubro de 2026

## Estado local

`main` atualizada por fast-forward de `eac2c6b` para `81581d9` (`origin/main`).
As correções locais anteriores de Xbox, PlayStation e Switch foram preservadas.
As novas correções estão no workspace, sem commit ou push nesta etapa.
`dist` foi reconstruído e o executável atualizado em
`src-tauri/target/release/seemygame.exe`, com os recursos web incorporados.

## Escopo revisado

Nove commits: `6678d98`, `431244b`, `2c43b28`, `90d9000`, `4c368f3`,
`f466de1`, `85cb474`, `9cb2d9a` e `81581d9`.
Incluem ZIP, modo streamer, volume por participante, PiP, anotações,
enquetes, gravação multitrack e integração da interface da sala.

## Falhas corrigidas

1. **ZIP sem mídia:** `ZipBuilder.addFile` é assíncrono. O gravador montava
   o ZIP antes de concluir a leitura dos Blobs. Agora aguarda cada arquivo.
   O teste abre o ZIP, compara os nomes, tamanhos e CRCs com o manifesto,
   e decodifica as faixas de áudio para confirmar sinal e duração.
2. **Gravação incompleta:** os áudios dos participantes não eram fornecidos
   pela sessão, e o modal tratava um mapa de participantes como MediaStream.
   As faixas agora são individuais. Um espectador também pode gravar o
   stream remoto ativo. O início parcial é revertido se uma faixa falhar;
   entradas inválidas e tracks encerrados são rejeitados.
3. **Áudio RTC silencioso:** o mixer consumia o stream remoto somente por
   Web Audio. No Chromium testado, pacotes RTP chegavam sem decodificação
   de áudio. Um elemento de mídia mudo agora consome o stream original,
   enquanto o mixer continua controlando a reprodução. Ambos os elementos
   são descartados ao remover o participante. A gravação direta passou
   com RMS remoto aproximadamente 0,14 e 1,5 s de áudio, mesmo com volume
   local em zero, sem processamento adicional no gravador.
4. **Volume inacessível durante transmissão:** os controles estavam apenas
   no lobby e no palco de voz, que fica oculto ao transmitir. Agora também
   aparecem junto aos participantes na lista lateral do canal de voz.
   Os popovers se sincronizam e removem subscriptions/listeners ao serem
   substituídos ou descartados.
5. **Enquetes:** votos remotos agora usam a identidade da conexão, e o
   encerramento remoto exige o criador. Foram adicionadas validação de
   payloads, expiração, encerramento idempotente, anúncio automático
   apenas pelo criador e sincronização ao abrir o modal após entrada tardia.
   Um pedido inválido de substituição não encerra a enquete existente.
6. **Anotações:** mensagens identificam a transmissão para acertar o card
   com dois broadcasters simultâneos. As coordenadas excluem cabeçalho e
   letterboxing; o overlay remoto não intercepta interações. Desenhos são
   validados e deduplicados. Borracha e remoção automática enviam remoções
   específicas, incluindo bordas de figuras e interiores de segmentos.
   O descarte cancela strokes e timers pendentes.
7. **PiP:** restauração síncrona do card, remoção de streams em janela PiP,
   estilos com URLs absolutas, fallback para PiP de vídeo, cancelamento de
   abertura pendente e proteção contra eventos atrasados da janela anterior.
8. **Ciclo de vida:** listeners dos modais, timers de enquetes, callbacks
   do gravador, anotações e referências da sessão são limpos. O modo
   streamer restaura campos inseridos dinamicamente e mantém o badge da
   sala oculto quando sua identidade é atualizada.

## Validação

- Vitest completo: **1.462 testes passaram, 149 arquivos, zero falhas**.
  Relatório: `output/remote-review-vitest-final.json`.
- E2E da suíte de ferramentas com dois navegadores, voz e dados WebRTC reais:
  ZIP com vídeo, microfone local e áudio remoto; CRCs válidos; áudio decodificado
  com duração e sinal verificados. Evidência em
  `output/playwright/room-tools-suite-1791394961124/report.json`.
- E2E de regressões com três navegadores: entrada tardia, identidade de votos,
  duas transmissões, remoção automática, PiP e descarte. Evidência em
  `output/playwright/room-tools-regressions-1791394568250/report.json`.
- E2E adversarial: formas, borracha, voto alterado, enquetes consecutivas,
  modo streamer dinâmico e multitrack. Evidência em
  `output/playwright/room-tools-adversarial-1791395057454/report.json`.
- E2E de canais de voz: navegação, isolamento, lobby silencioso, áudio RTP,
  troca de canal e layout móvel. Evidência em
  `output/playwright/room-channels-1791394704702/report.json`.
- Grafo de módulos, templates HTML, CSS, smoke ESM, build de `dist`,
  `git diff --check` e compilação Rust release passaram.

A primeira execução completa teve uma falha de acesso localhost (`EACCES`)
no sandbox. O teste passou com acesso local permitido, assim como a execução
completa final. Os avisos de canvas/navigation do JSDOM são limitações de seus
mocks; os testes de desenho usam também um navegador real.

## Limites da validação

Captura e microfones dos E2Es são sintéticos. O lifecycle de Document PiP usa
uma janela simulada no teste, e o executável foi compilado, sem certificação
de chamadas entre dispositivos físicos ou de PiP no WebView desktop.
Hardware físico, NAT externo e publicação do site não foram feitos nesta etapa.
