# Rastreabilidade dos critérios de aceite

Este documento é um mapa vivo entre o enunciado oficial, a implementação e suas
evidências. O estado `Planejado` significa que ainda não existe uma declaração
de conformidade para aquele requisito.

| Área                          | Estado       | Implementação planejada                                                                                       | Evidência                                                 |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Stack obrigatória             | Em andamento | Bun, TypeScript estrito, NestJS, PostgreSQL, LocalStack, Docker Compose e migrations reversíveis com MikroORM | Migration de Wallet testada em `up` e `down`              |
| Money                         | Comprovado   | Objeto de valor imutável com `decimal.js`, escala fixa e limite compatível com `NUMERIC(20, 2)`               | Testes unitários e round trips exatos em PostgreSQL real  |
| Wallet                        | Em andamento | `open`, `rehydrate`, débito e crédito imutáveis, saldo não negativo, moeda e versionamento                    | Unidade, constraints e concorrência de débitos/créditos   |
| Transações de aposta          | Em andamento | `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, com estados e falhas persistidos                      | Unidade, rejeição auditável e PostgreSQL real             |
| Ledger                        | Em andamento | Créditos, débitos e efeitos inversos de reversão, com ausência em LOSS, imutabilidade e unicidade             | Constraints, rollback e reconciliação após cada cenário   |
| Idempotência persistente      | Em andamento | Chave única, SHA-256 do JSON canônico e resultado terminal com saldo histórico                                | Conflito, novo processo e 50 duplicatas em 3 processos    |
| Regras de referência          | Comprovado   | Escopo exato, tipos permitidos, valor integral e uma reversão processada por tipo e referência                | Matriz unitária, integração, concorrência e constraints   |
| Referências fora de ordem     | Em andamento | Persistência e evento de `PENDING_REFERENCE`; worker, backoff, tentativas e TTL permanecem planejados         | HTTP `202`, replay e PostgreSQL real; worker pendente     |
| API HTTP                      | Em andamento | `POST /wallets` e transações BET, WIN, LOSS, REFUND e ROLLBACK; consultas e readiness planejados              | E2E de sucesso, replay, pendência, conflito e rejeição    |
| Inbox do SQS                  | Planejado    | Mesmo caso de uso, inbox persistente, ack após commit e política de retry e DLQ                               | Redelivery e falhas com LocalStack real                   |
| Outbox transacional           | Em andamento | Eventos de todas as operações e de referência pendente; publisher e leases permanecem planejados              | Rollback integral de BET, WIN e REFUND em falha de outbox |
| Observabilidade               | Planejado    | Logs estruturados e seguros, métricas obrigatórias e health checks separados                                  | Asserções E2E de health e métricas                        |
| Concorrência entre instâncias | Em andamento | Lock pessimista por wallet no PostgreSQL, sem lock local ou global                                            | 50 BET/WIN duplicadas em 3 processos e disputa `80 + 80`  |
| Documentação                  | Em andamento | Setup honesto, decisões, trade-offs, limitações e este mapa de rastreabilidade                                | Validação a partir de um clone novo                       |
