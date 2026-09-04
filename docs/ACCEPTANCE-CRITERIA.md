# Rastreabilidade dos critérios de aceite

Este documento é um mapa vivo entre o enunciado oficial, a implementação e suas
evidências. O estado `Planejado` significa que ainda não existe uma declaração
de conformidade para aquele requisito.

| Área                          | Estado       | Implementação planejada                                                                                       | Evidência                                                |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Stack obrigatória             | Em andamento | Bun, TypeScript estrito, NestJS, PostgreSQL, LocalStack, Docker Compose e migrations reversíveis com MikroORM | Migration de Wallet testada em `up` e `down`             |
| Money                         | Comprovado   | Objeto de valor imutável com `decimal.js`, escala fixa e limite compatível com `NUMERIC(20, 2)`               | Testes unitários e round trips exatos em PostgreSQL real |
| Wallet                        | Em andamento | `open`, `rehydrate` e débito imutável, saldo não negativo, moeda e versionamento                              | Unidade, constraints e disputa concorrente de saldo      |
| Transações de aposta          | Em andamento | `OPENING` e `BET` implementados; demais operações e transições permanecem planejadas                          | Unidade, rejeição auditável e PostgreSQL real            |
| Ledger                        | Em andamento | `CREDIT` de abertura e `DEBIT` de BET imutáveis, balanceados e únicos por wallet/transação                    | Constraints, rollback e reconciliação após cada cenário  |
| Idempotência persistente      | Em andamento | Chave única, SHA-256 do JSON canônico e resultado terminal com saldo histórico                                | Conflito, novo processo e 50 duplicatas em 3 processos   |
| Regras de referência          | Planejado    | Escopo exato de provider, player, wallet, moeda e rodada, com uma única reversão integral                     | Matriz de regras em testes unitários e de integração     |
| Referências fora de ordem     | Planejado    | Worker de `PENDING_REFERENCE` com backoff exponencial e limites de tentativas e TTL                           | Testes de inversão de ordem, esgotamento e reinício      |
| API HTTP                      | Em andamento | `POST /wallets` e `POST /wagering/transactions` para BET; consultas e readiness permanecem planejados         | E2E de sucesso, replay, conflito, rejeição e validação   |
| Inbox do SQS                  | Planejado    | Mesmo caso de uso, inbox persistente, ack após commit e política de retry e DLQ                               | Redelivery e falhas com LocalStack real                  |
| Outbox transacional           | Em andamento | Eventos de abertura e BET incluídos na transação; publisher e leases permanecem planejados                    | Rollback integral em falha de outbox                     |
| Observabilidade               | Planejado    | Logs estruturados e seguros, métricas obrigatórias e health checks separados                                  | Asserções E2E de health e métricas                       |
| Concorrência entre instâncias | Em andamento | Lock pessimista por wallet no PostgreSQL, sem lock local ou global                                            | 50 duplicatas em 3 processos e disputa `80 + 80`         |
| Documentação                  | Em andamento | Setup honesto, decisões, trade-offs, limitações e este mapa de rastreabilidade                                | Validação a partir de um clone novo                      |

Consulte [`P0-GUARDRAILS.md`](P0-GUARDRAILS.md) para conhecer os bloqueios
associados às falhas eliminatórias.
