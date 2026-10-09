# Correção dos quatro achados das adições — 08/10/2026

Base: HEAD `942ff1f`, com correções locais solicitadas pelo usuário. Referência: [reavaliação](reavaliacao-adicoes-2026-10-08.md).

## Alterações

- **N01:** POST exige a chave registrada mesmo quando a chave recebida está ausente/vazia. DELETE e beacon recusam exclusão sem a chave correta. No Redis, scripts Lua validam a propriedade e realizam a mutação na mesma operação EVAL, evitando uma verificação separada sujeita a concorrência. Em memória, a propriedade também é conferida no momento da gravação.
- **N02:** falhas HTTP, de transporte, respostas de erro Redis e retornos inválidos são tratadas como indisponibilidade. A API retorna 503, sem confirmar publicação/exclusão ou usar memória silenciosamente quando Redis está configurado. Memória continua disponível para desenvolvimento sem Redis configurado.
- **N03:** alterações no alvo do controlador são enfileiradas para aplicar maxBitrate ao sender antes da guarda de cooldown. A regressão confirma 8 → 6 Mbps para WAN e restauração de 8 Mbps ao tornar-se LAN. O controlador também aceita a telemetria rtt na conversão para rttMs.
- **N04:** o publicador usa members.size diretamente, tanto na atualização de presença quanto nos ajustes da sala. O E2E existente agora aguarda dois membros admitidos e força um heartbeat antes de conferir a listagem.

## Validação

| Verificação | Resultado | Evidência |
| --- | --- | --- |
| Regressões de autorização/Redis/bitrate + suítes existentes de diretório e LAN | 59 testes aprovados em quatro arquivos | [Log](../output/fixes-2026-10-08-targeted.log) |
| npm run verify | 1.626 testes / 169 arquivos aprovados; módulos, HTML, CSS, smoke ESM e build aprovados | [Log](../output/fixes-2026-10-08-verify.log) |
| E2E diretório adversarial | Seis grupos aprovados, incluindo PIN, admissão, heartbeat com contagem correta e despublicação | [Evidência](../output/playwright/rooms-directory-adversarial-1791507178052/evidence.json) |
| E2E qualidade | Sete verificações aprovadas | [Relatório](../output/playwright/room-quality-1791507177442/report.json) |
| Reprodução de contagem com host e convidado reais | Dois participantes na sala e dois publicados no diretório | [Log](../output/fixes-2026-10-08-member-count.log) |
| git diff --check | Aprovado | Sem erros de formatação no diff |

As 16 novas regressões automatizadas estão em `tests/additions-fixes-regression.test.js`. O probe de contagem foi atualizado para exigir o comportamento corrigido; o probe isolado histórico que demonstra os defeitos anteriores foi preservado.

Limites: Chrome com sinalização local e dispositivos sintéticos; Redis REST foi instrumentado em testes, sem acesso a uma instância de produção. A semântica de resposta e os comandos EVAL são cobertos pelos testes; não houve homologação do Lua em Redis de produção, E2E pela janela Tauri nem teste entre máquinas físicas. Não houve alterações Rust.
