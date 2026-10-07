# Tela preta entre desktop e web — 7 de outubro de 2026

## Defeito confirmado na produção

O navegador em `https://seemygame.vercel.app` recebe HTTP 403 de `/api/turn`.
A API exigia `Origin` em produção. Uma requisição GET do navegador ao próprio
site não envia esse cabeçalho. O cliente então usa o fallback de produção,
que contém apenas STUN, sem TURN.

Um navegador Edge isolado confirmou:

| Condição | Resposta da API | Servidores TURN | Candidatos relay |
| --- | --- | --- | --- |
| Site publicado, configuração normal | 403 | 0 | 0 |
| Site publicado, `iceTransportPolicy: relay` | 403 | 0 | 0 |
| API corrigida em servidor local, configuração normal | 200 | 3 | 4 |
| API corrigida em servidor local, `iceTransportPolicy: relay` | 200 | 3 | 4 |

O teste local usou HTTP real e os cabeçalhos enviados pelo navegador:
`Origin` ausente, `Sec-Fetch-Site: same-origin`, `Referer` correspondendo ao
host. A correção exige essa combinação e continua validando a origem pela
lista permitida. Origens externas explícitas e referências incompatíveis
continuam recebendo 403. A autenticação do provedor privado foi preservada.

Sem relay disponível no web, redes que exigem TURN podem impedir a conexão
de mídia, mesmo que a entrada na sala funcione. Isso explica o sintoma
relatado; não foi feita uma reprodução na rede do amigo para provar que seu
NAT exige esse caminho.

## Falhas adicionais corrigidas

- O popup usava `iceConnectionState`, mas o monitor não coletava essa
  propriedade. Agora as amostras e a exportação incluem os estados do
  navegador e da ponte nativa. O HUD distingue conexão em andamento,
  conexão interrompida e falha ICE.
- O host descartava ICE recebido antes da oferta. Agora uma negociação
  autorizada pode encaminhar esses candidatos à fila existente no Rust.
  Parar ou desconectar também cancela negociações que ainda aguardam a
  oferta. No teste real observado, a oferta chegou antes dos candidatos;
  essa falha adicional foi reproduzida nos testes de regressão.

Os logs locais disponíveis mostram a ponte de preview recebendo vídeo
1080p/60 FPS e uma ponte remota permanecendo em Checking/Connecting.
Esses logs, isoladamente, não identificam a rede ou a sessão do amigo.

## Validação e entrega

- Testes focados iniciais: 71 aprovados.
- Testes focados após a correção da API: 72 aprovados.
- Suíte completa antes da alteração da API: 1375 aprovados; um teste de
  servidor local falhou por `EACCES` do sandbox. O arquivo correspondente,
  com 16 testes, passou ao repetir com acesso à rede local.
- `check:modules`, `git diff --check`, `build:dist`, `cargo check` e
  `cargo build --release --locked --offline`: aprovados.
- Executável recompilado: `src-tauri/target/release/seemygame.exe`.

A API corrigida ainda não foi publicada. O teste do site público continuou
mostrando 403; os resultados 200 são da correção local. É necessário publicar
a API e recarregar o web para que o amigo obtenha TURN.

A coleta de candidatos relay comprova a obtenção de endereços TURN, não a
entrega de vídeo entre duas redes. Houve erros 701 em algumas tentativas de
resolução dos servidores, mas outras produziram candidatos relay.

Evidência local (ignorada pelo Git):
`output/playwright/negotiation-investigation/browser-ice-report.json`.
Script:
`output/playwright/negotiation-investigation/ice-order-probe.mjs`.
