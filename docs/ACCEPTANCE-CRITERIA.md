# Rastreabilidade dos critérios de aceite

Este documento é um mapa vivo entre o enunciado oficial, a implementação e suas
evidências. O estado `Planejado` significa que ainda não existe uma declaração
de conformidade para aquele requisito.

| Área                          | Estado       | Implementação planejada                                                                                       | Evidência                                                |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Stack obrigatória             | Fundação     | Bun, TypeScript estrito, NestJS, PostgreSQL, LocalStack, Docker Compose e migrations reversíveis com MikroORM | Versões, build e testes de integração das migrations     |
| Money                         | Comprovado   | Objeto de valor imutável com `decimal.js`, escala fixa e limite compatível com `NUMERIC(20, 2)`               | Testes unitários e round trips exatos em PostgreSQL real |
| Wallet                        | Planejado    | Aggregate com factories, saldo não negativo, invariante de moeda e versionamento                              | Testes unitários, de constraints e de concorrência       |
| Transações de aposta          | Planejado    | Estados e transições explícitos para `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`                              | Testes unitários e do caso de uso com banco real         |
| Ledger                        | Planejado    | Lançamentos imutáveis e somente de inclusão; no máximo um por wallet e transação                              | Testes de constraints e reconciliação                    |
| Idempotência persistente      | Planejado    | Chave, hash do payload canônico e resultado original persistido                                               | Conflito, replay, reinício e 50 duplicatas concorrentes  |
| Regras de referência          | Planejado    | Escopo exato de provider, player, wallet, moeda e rodada, com uma única reversão integral                     | Matriz de regras em testes unitários e de integração     |
| Referências fora de ordem     | Planejado    | Worker de `PENDING_REFERENCE` com backoff exponencial e limites de tentativas e TTL                           | Testes de inversão de ordem, esgotamento e reinício      |
| API HTTP                      | Planejado    | Endpoints obrigatórios de wallet, ledger, transação, reconciliação, liveness e readiness                      | Testes E2E dos contratos                                 |
| Inbox do SQS                  | Planejado    | Mesmo caso de uso, inbox persistente, ack após commit e política de retry e DLQ                               | Redelivery e falhas com LocalStack real                  |
| Outbox transacional           | Planejado    | Inclusão atômica e publishers concorrentes com leases                                                         | Dois publishers e recuperação após queda                 |
| Observabilidade               | Planejado    | Logs estruturados e seguros, métricas obrigatórias e health checks separados                                  | Asserções E2E de health e métricas                       |
| Concorrência entre instâncias | Planejado    | Coordenação por wallet no PostgreSQL, sem lock global                                                         | Cenários obrigatórios em pelo menos três processos       |
| Documentação                  | Em andamento | Setup honesto, decisões, trade-offs, limitações e este mapa de rastreabilidade                                | Validação a partir de um clone novo                      |

Consulte [`P0-GUARDRAILS.md`](P0-GUARDRAILS.md) para conhecer os bloqueios
associados às falhas eliminatórias.
