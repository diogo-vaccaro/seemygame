# Resolução e adaptação web — correções e limites

Data: 06/10/2026. Revisão após a auditoria.

## Comportamento implementado

O envio WebRTC do navegador usa maintain-resolution como preferência inicial: prioriza resolução e pode reduzir FPS. Ela não garante imagem nítida, bitrate constante ou 60/120 FPS. O usuário pode escolher maintain-framerate ou balanced. Essa configuração pertence ao envio pelo navegador; não configura a adaptação do encoder Rust no envio nativo direto.

A proporção da captura efetiva e o perfil escolhido determinam scaleResolutionDownBy. O cálculo compartilhado considera largura **e** altura, preserva proporção e não arredonda antecipadamente. Assim, uma fonte 1080p pode ser enviada a 720p mesmo quando a track recusa constraints.

## Correções de integração

- Restaurado o evento change do controlador compartilhado.
- Qualidade, bitrate e adaptação atualizam os senders ativos; codec exige reinício e informa isso.
- Constraints só são aplicadas na troca de perfil. Mudar apenas bitrate/adaptação não redimensiona a fonte.
- Após constraints aceitas, recusadas ou ignoradas, a escala usa os settings reais. Uma mudança de bitrate/adaptação não desfaz o limite de resolução.
- A opção de adaptação foi retirada da reconfiguração nativa: sua mudança não para/reinicia o worker.
- O handler adicional de perfil da página streamer foi consolidado no controlador compartilhado, evitando aplicação duplicada e escala inconsistente.
- Fallback de prioridade tenta retirar networkPriority e priority em etapas, preservando degradationPreference quando ela é suportada.
- Se a preferência realmente não for aplicada, o HUD e o diagnóstico exportado mostram solicitado/efetivo e o fallback. O limite de bitrate continua sendo aplicado quando possível.

## O que os testes comprovam

O E2E tests/e2e-room-quality.mjs usa duas sessões reais do Chrome, código da sala, PeerJS/WebRTC e uma fonte sintética 1080p que recusa redimensionamento. Ele verifica:

1. Recepção inicial de 1080p.
2. Seleção de 720p propagada ao estado, sender e dimensões recebidas.
3. Bitrate e adaptação aplicados sem perder a escala de 720p.
4. Retorno a 1080p na mesma conexão.
5. Encerramento e liberação da captura.

É um teste de integração funcional na mesma máquina. Não é homologação de desempenho com jogo, capture APIs reais ou rede remota.

O runner tools/e2e/verify-web-resolution-fps.mjs é **smoke de componente canvas WebRTC**, sem Rust ou UI da sala. Seus casos já não são rotulados como captura nativa. Ele verifica todas as amostras estáveis, largura/altura, codec efetivo, preferência aplicada e cadência de decode/apresentação. A fonte tem limite temporal e usa requestFrame explícito, evitando um segundo relógio de captura. ICE é enfileirado até o SDP remoto, readiness tem timeout e os recursos são encerrados em finally. O JSON exporta versão do browser, hashes, amostras e motivos de falha.

Na primeira revalidação, a fonte desenhava cerca de 60 FPS, mas captureStream(60) entregou 52–54 FPS em dois casos, corretamente reprovados pelo critério novo. Com a única mudança para captureStream(0) + requestFrame a cada desenho, os cinco casos passaram perto de 60 FPS, sem relaxar thresholds. Isso sustenta a hipótese de interferência do segundo limitador no fixture, não uma conclusão sobre getDisplayMedia ou captura nativa.

## Limites

Um navegador pode recusar opções ou adaptar a transmissão sob limitações de rede/hardware. Uma preferência não equivale a certificado de qualidade. Capturas portrait e ultrawide preservam proporção dentro do perfil, portanto não precisam preencher exatamente 1920×1080 ou 1280×720. A resolução efetiva do receptor e as métricas do HUD permanecem a referência operacional.

A evidência da falha original e os critérios de correção estão em [auditoria-alteracoes-2026-10-06.md](auditoria-alteracoes-2026-10-06.md).
