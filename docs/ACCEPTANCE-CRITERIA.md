# Rastreabilidade dos critérios de aceite

Este documento é um mapa vivo entre o enunciado oficial, a implementação e suas
evidências. O estado `Planejado` significa que ainda não existe uma declaração
de conformidade para aquele requisito.

| Área                          | Estado       | Implementação planejada                                                                                       | Evidência                                                 |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Stack obrigatória             | Em andamento | Bun, TypeScript estrito, NestJS, PostgreSQL, LocalStack, Docker Compose e migrations reversíveis com MikroORM | Migration de Wallet testada em `up` e `down`              |
| Money                         | Comprovado   | Objeto de valor imutável com `decimal.js`, escala fixa e limite compatível com `NUMERIC(20, 2)`               | Testes unitários e round trips exatos em PostgreSQL real  |
| Wallet                        | Em andamento | `open` e `rehydrate`, saldo não negativo, moeda, versão 1 e unicidade por player/moeda                        | Unidade, constraints e 12 aberturas em 3 conexões reais   |
| Transações de aposta          | Em andamento | `OPENING` interno implementado; operações externas e suas transições permanecem planejadas                    | Unidade e abertura atômica com PostgreSQL real            |
| Ledger                        | Em andamento | Crédito de abertura imutável, aritmeticamente validado e único por wallet/transação                           | Unidade, constraints, trigger e reconciliação da abertura |
| Idempotência persistente      | Planejado    | Chave, hash do payload canônico e resultado original persistido                                               | Conflito, replay, reinício e 50 duplicatas concorrentes   |
| Regras de referência          | Planejado    | Escopo exato de provider, player, wallet, moeda e rodada, com uma única reversão integral                     | Matriz de regras em testes unitários e de integração      |
| Referências fora de ordem     | Planejado    | Worker de `PENDING_REFERENCE` com backoff exponencial e limites de tentativas e TTL                           | Testes de inversão de ordem, esgotamento e reinício       |
| API HTTP                      | Em andamento | `POST /wallets` implementado; consultas, transações, reconciliação e readiness permanecem planejados          | E2E de criação, contrato inválido e conflito              |
| Inbox do SQS                  | Planejado    | Mesmo caso de uso, inbox persistente, ack após commit e política de retry e DLQ                               | Redelivery e falhas com LocalStack real                   |
| Outbox transacional           | Em andamento | Eventos de abertura incluídos na mesma transação; publisher e leases permanecem planejados                    | Rollback integral e duas mensagens por saldo positivo     |
| Observabilidade               | Planejado    | Logs estruturados e seguros, métricas obrigatórias e health checks separados                                  | Asserções E2E de health e métricas                        |
| Concorrência entre instâncias | Planejado    | Coordenação por wallet no PostgreSQL, sem lock global                                                         | Cenários obrigatórios em pelo menos três processos        |
| Documentação                  | Em andamento | Setup honesto, decisões, trade-offs, limitações e este mapa de rastreabilidade                                | Validação a partir de um clone novo                       |

Consulte [`P0-GUARDRAILS.md`](P0-GUARDRAILS.md) para conhecer os bloqueios
associados às falhas eliminatórias.
