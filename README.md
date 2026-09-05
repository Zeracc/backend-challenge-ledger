# Backend Challenge Ledger

Processador distribuído de transações de apostas desenvolvido para o desafio
técnico de backend da Jungle Gaming.

Implementação do [desafio oficial da Jungle Gaming](https://github.com/junglegaming/backend-challenge).
As decisões, garantias e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Estado atual

O repositório contém abertura de Wallet e processamento
concorrente de apostas:

- Bun 1.x como runtime, gerenciador de pacotes e executor de testes;
- NestJS com TypeScript em modo estrito;
- endpoint mínimo de liveness;
- infraestrutura local com PostgreSQL e LocalStack por Docker Compose;
- `Money` imutável, multi-moeda e sem aritmética de ponto flutuante;
- teste de round trip monetário contra PostgreSQL real;
- abertura de Wallet com `OPENING`, ledger e outbox atômicos;
- migration reversível com constraints financeiras no PostgreSQL;
- endpoint `POST /wallets` com respostas `201`, `400` e `409`;
- processamento de `BET` com lock por Wallet no PostgreSQL;
- processamento de `WIN` com crédito, ledger e outbox atômicos;
- processamento de `LOSS` sem alteração de saldo, versão ou ledger;
- referência opcional de `WIN` a uma `BET` da mesma rodada;
- `REFUND` integral de `BET` e `ROLLBACK` com efeito financeiro inverso;
- referências ausentes persistidas como `PENDING_REFERENCE`, com resposta `202`;
- reprocessamento agendado de referências com backoff e expiração persistidos;
- consultas de wallet, ledger paginado e transações por identidade interna/externa;
- reconciliação consistente, sem correção automática de divergências;
- readiness real de PostgreSQL/SQS e métricas de reconciliação;
- idempotência persistente por chave e hash canônico SHA-256;
- rejeição auditável por saldo insuficiente, sem lançamento no ledger;
- endpoint `POST /wagering/transactions` com replay e conflitos distintos;
- testes de 50 duplicatas concorrentes em três processos Bun;
- documentos de arquitetura e rastreabilidade dos critérios de aceite.

O consumidor SQS usa Inbox atômica, retry limitado, DLQ e confirmação após commit.
O publisher da Outbox usa leases no PostgreSQL, retry persistido e publicação SQS.
As métricas operacionais obrigatórias são expostas em `/metrics`. As garantias
são verificadas por testes unitários, de integração, concorrência e recuperação.

## Pré-requisitos

- [Bun 1.x](https://bun.sh/)
- Docker com Docker Compose

As versões usadas para validar este repositório estão registradas no
`package.json` e nas tags das imagens do `compose.yml`.

## Configuração local

No Linux ou macOS:

```bash
cp .env.example .env
```

No Windows com PowerShell:

```powershell
Copy-Item .env.example .env
```

Em seguida:

```bash
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run db:migrate
bun run start:dev
```

Para ativar os workers ao executar com Bun, defina `SQS_CONSUMER_ENABLED=true`
e `OUTBOX_PUBLISHER_ENABLED=true` no `.env`. No Compose, ambos já são ativados.
O scheduler de referências pendentes é iniciado com a aplicação.

O endpoint de liveness estará disponível em
`GET http://localhost:3000/health/live`. `GET /health/ready` retorna `200` quando
PostgreSQL e SQS respondem e `503` quando algum deles falha ou excede 1,5 segundo.
As verificações de dependências são paralelas; liveness permanece independente.
O probe SQS usa `ListQueues` e exige credenciais com essa permissão.

Para subir a API por Docker, o serviço one-shot `migrate` aplica as migrations
antes da inicialização:

```bash
docker compose up --build api
```

Para execução em segundo plano, use `docker compose up -d --build api`.
API: `http://localhost:3000`; PostgreSQL: `localhost:55432`; LocalStack:
`http://localhost:4566`. Pare com `docker compose stop`; os volumes preservam
wallets, ledger e eventos. Não remova os volumes para reiniciar a aplicação.

Moedas suportadas: **BRL, USD e EUR**, todas com escala fixa de duas casas.
Outros códigos são rejeitados, inclusive códigos ISO válidos fora dessa política.
O modelo continua multi-moeda e nunca converte valores entre moedas.

### Criar uma wallet

```http
POST /wallets
Content-Type: application/json

{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

### Processar uma transação de aposta

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json

{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

O mesmo contrato aceita `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. `WIN` aceita
`referenceExternalTransactionId` opcional; as duas reversões o exigem. Quando a
referência ainda não existe, a API persiste a solicitação e responde `202` com
status `PENDING_REFERENCE`. `REFUND` e `ROLLBACK` são sempre integrais.

## Verificações de qualidade

Os testes de integração usam PostgreSQL e LocalStack reais. Inicie ambos com
`docker compose up -d postgres localstack` e configure as variáveis da
`.env.example` antes de executar a suíte.

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run test:integration
bun run build
docker compose config --quiet
```

Os testes de integração criam schemas isolados no PostgreSQL que
são removidos ao final da execução.

O CI executa a mesma suíte no Linux com PostgreSQL 17 e LocalStack reais.
Para os cenários de fechamento: `bun test test/integration/final-delivery.integration.spec.ts`.
Esse arquivo cobre falha terminal, corrida com processamento normal, política de
moedas e scheduler reiniciado com três processos. Os demais testes comprovam
50 duplicatas, hot wallet, Inbox/Outbox, falhas de commit/ack, leases e reconciliação.

## Consultas e reconciliação

```http
GET /wallets/:walletId
GET /wallets/:walletId/ledger?limit=50
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
GET /metrics
```

O ledger retorna `{ "items": [...], "nextCursor": "..." }`. Envie `nextCursor`
como parâmetro `cursor` até receber `null`. O limite padrão é 50, máximo 100.
O cursor é opaco, vinculado à wallet e percorre o conjunto delimitado na primeira
página; novas movimentações aparecem ao iniciar outra consulta sem cursor.

A consulta de uma transação retorna seu estado atual e o saldo observado no seu
processamento. Esse saldo pode diferir do saldo atual da wallet. Transações
internas `OPENING` também podem ser consultadas pelo ID.

A reconciliação retorna `storedBalance`, `calculatedBalance`, `difference`,
`consistent` e `checkedEntries`. A diferença é saldo armazenado menos saldo do
ledger e pode ser negativa. Uma divergência retorna `200` com `consistent: false`,
gera log sem valores financeiros e incrementa uma métrica; nunca altera os dados.
O header opcional `X-Correlation-Id` permite identificar esse diagnóstico.

Recursos ausentes retornam `404`, parâmetros inválidos `400` e falhas transitórias
reconhecidas do PostgreSQL `503` com `INFRASTRUCTURE_UNAVAILABLE`. Nos comandos,
um reenvio deve preservar `Idempotency-Key`. As métricas de reconciliação estão
em formato Prometheus, junto aos indicadores operacionais descritos abaixo.

## Consumo SQS

No Compose, o consumidor inicia junto com a API. Para execução local com Bun,
configure `SQS_CONSUMER_ENABLED=true`. As filas são `wager-transactions.fifo` e
`wager-transactions-dlq.fifo`; `SQS_QUEUE_URL` e `SQS_DLQ_URL` permitem substituir
as URLs padrão do LocalStack.

O corpo da mensagem contém `messageId`, `type: "WagerTransactionRequested"`,
`occurredAt` em ISO UTC e `data`. O objeto `data` segue o corpo do comando HTTP,
acrescido de `idempotencyKey`. `OPENING` não é aceito por esse canal.
Preserve o `messageId` lógico no reenvio e forneça os atributos FIFO
`MessageGroupId` e `MessageDeduplicationId` ao publicar.

A Inbox identifica `(consumerName, messageId)` no PostgreSQL e participa da mesma
transação de wallet, transação de aposta, ledger e outbox. Rejeições de negócio
e referências pendentes persistidas são confirmadas. Erros de infraestrutura
recebem backoff de 1 a 60 segundos, com limite de cinco entregas. Payload inválido,
conflitos de identidade e tentativas esgotadas seguem à DLQ antes do ack da origem.
Uma falha ao enviar à DLQ preserva a mensagem original para nova entrega.

O consumidor renova a visibilidade durante o processamento e aguarda o trabalho
ativo no shutdown. A suíte verifica 50 duplicatas em três processos, queda após
commit antes do ack, rollback da Inbox e financeiro, heartbeat e drenagem.
O transporte tem entrega pelo menos uma vez; a unicidade financeira é garantida
pelo PostgreSQL. Reprocessamento operacional da DLQ permanece pendente.

## Publicação da Outbox

No Compose, o publisher inicia com a API e publica em `wager-events.fifo`,
separada da fila de comandos. Para executar pelo Bun, configure
`OUTBOX_PUBLISHER_ENABLED=true`. `SQS_EVENTS_QUEUE_URL` substitui a URL padrão
do LocalStack na execução local.

Cada instância reserva um evento por vez com `FOR UPDATE SKIP LOCKED`, lease de
30 segundos e token exclusivo. O envio acontece fora da transação financeira;
`publishedAt` só é gravado após a confirmação do SQS e se o lease ainda pertence
à tentativa. O scheduler roda a cada segundo, com até 20 eventos por lote.

Falhas de envio persistem `attempts` e backoff de 1 segundo até 5 minutos.
Eventos confirmados não são descartados ao atingir um número de tentativas.
Após corrigir a dependência, o publisher retoma automaticamente os eventos devidos.
`attempts` conta falhas registradas; uma queda abrupta é recuperada pela expiração
do lease, sem necessariamente incrementar esse contador.

O transporte oferece entrega **pelo menos uma vez**: se houver queda após o envio
e antes da marcação no banco, o mesmo `eventId` pode ser enviado novamente.
Consumidores devem deduplicar esse ID persistentemente na mesma transação dos
seus efeitos. A deduplicação FIFO tem janela limitada e não substitui essa regra.
A ordem financeira global não é garantida pelo publisher; consumidores de saldo
devem considerar `walletVersion` para não aplicar um snapshot antigo.

## Métricas e diagnóstico

`GET /metrics` expõe Prometheus sem dependência de um servidor de métricas externo.

| Métrica                                   | Significado                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `wager_transactions_total{source,status}` | Resultados confirmados de comandos HTTP/SQS e transições do worker de referências; replay não soma |
| `wager_duplicates_total{source}`          | Replays financeiros detectados                                                                     |
| `wager_processing_failures_total{source}` | Tentativas que falharam no processador financeiro                                                  |
| `wager_processing_duration_seconds`       | Histograma do tempo no processador, incluindo espera no banco e replays                            |
| `wager_retries_total{component}`          | Reagendamentos confirmados de SQS, Outbox e referências                                            |
| `wager_dlq_messages_total`                | Encaminhamentos à DLQ concluídos com ack da origem                                                 |
| `wager_lock_conflicts_total{source,code}` | Lock timeout, deadlock e falha de serialização observados                                          |
| `outbox_publications_total{outcome}`      | Publicações, retries e leases perdidos                                                             |
| `outbox_pending_messages`                 | Eventos ainda não marcados como publicados no banco                                                |
| `outbox_lag_seconds`                      | Idade do evento pendente mais antigo, incluindo eventos em retry ou lease                          |
| `operational_metrics_collection_success`  | `1` se a coleta PostgreSQL funcionou; `0` se os gauges não puderam ser coletados                   |

Contadores e histogramas são por processo e reiniciam com ele. Não substituem a
auditoria do ledger: não incluem OPENING, comandos recusados antes de chegar ao
processador ou operações confirmadas imediatamente antes de uma queda que impeça
o registro da métrica. Uma referência pode contar primeiro como pendente e depois
como processada/rejeitada. Lotes de referências que falham parcialmente podem
subcontar resultados; o banco continua sendo a fonte auditável.

Os gauges da Outbox consultam o estado compartilhado no PostgreSQL; não os some
entre réplicas. Se a coleta falhar, os contadores continuam disponíveis e o lag
é omitido, acompanhado de `operational_metrics_collection_success 0`, em vez de
informar um zero enganoso. O timeout SQL dessa coleta é de 1 segundo.

Exemplos de consulta: `rate(wager_transactions_total[5m])`,
`rate(wager_duplicates_total[5m])` e
`histogram_quantile(0.95, sum by (le) (rate(wager_processing_duration_seconds_bucket[5m])))`.
Investigue `operational_metrics_collection_success == 0`, crescimento contínuo
de `outbox_lag_seconds`, novos eventos de DLQ e aumento de conflitos de lock.

Os labels são fixos e não incluem IDs de clientes/wallets. Logs JSON carregam
identificadores para correlação, sem payload financeiro; erros HTTP inesperados
são sanitizados para impedir exposição de SQL/parâmetros. Falhas de telemetria
não alteram resultados financeiros confirmados.

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md): fronteiras, estratégia de consistência e
  trade-offs.

## Respostas e falhas terminais

| Situação                                    | HTTP  |
| ------------------------------------------- | ----- |
| Wallet criada                               | `201` |
| Transação processada ou replay processado   | `200` |
| Referência aguardada de forma persistente   | `202` |
| Entrada inválida ou moeda não suportada     | `400` |
| Recurso ausente                             | `404` |
| Identidade/payload conflitante              | `409` |
| Rejeição de negócio                         | `422` |
| Replay de falha técnica terminal `FAILED`   | `424` |
| Infraestrutura temporariamente indisponível | `503` |
| Erro inesperado sanitizado                  | `500` |

Após esgotar as tentativas técnicas do SQS, o consumidor tenta persistir `FAILED`
com `PROCESSING_ATTEMPTS_EXHAUSTED`, Inbox e `WagerTransactionFailed` na mesma
transação. Não altera saldo nem ledger. Se outra execução já confirmou o comando,
seu resultado prevalece. O evento de falha é adicional aos quatro eventos mínimos.
O comando segue à DLQ antes do ack; replay de FAILED nunca aplica dinheiro.

Se o banco também impedir a gravação terminal, o corpo original e o código ficam
duravelmente na DLQ, com log `sqs_failed_audit_unavailable`. Nenhum status SQL é
inventado. O redrive deve consultar primeiro a identidade da transação: resultados
terminais são imutáveis. Se não houver registro, corrija a dependência e reenvie o
mesmo comando com os mesmos IDs/chave, considerando que ele poderá ser aplicado.

## Critérios e provas

| Garantia                                                              | Evidência no repositório                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Precisão monetária e conflitos de moeda                               | `money.spec.ts`, `money-postgresql.integration.spec.ts`                                                                                                 |
| Saldo não negativo, concorrência, 50 duplicatas em três processos     | `bet-processing-postgresql.integration.spec.ts`, `win-loss-processing-postgresql.integration.spec.ts`                                                   |
| Reversões, referências fora de ordem e restart do scheduler           | `wager-reversals-postgresql.integration.spec.ts`, `pending-reference-reprocessing-postgresql.integration.spec.ts`, `final-delivery.integration.spec.ts` |
| Inbox, redelivery, queda entre commit/ack, retry/DLQ                  | `sqs-inbox.integration.spec.ts`                                                                                                                         |
| Outbox sem envio pré-commit, publishers concorrentes e crash recovery | `outbox-publishing.integration.spec.ts`                                                                                                                 |
| Consultas, paginação e reconciliação                                  | `wallet-queries-http.integration.spec.ts`                                                                                                               |
| Métricas, logs sanitizados e falhas de coleta                         | `operational-observability.integration.spec.ts`                                                                                                         |
| Liveness e dependências reais                                         | `readiness-http.integration.spec.ts`                                                                                                                    |

## Limites deliberados

- Autenticação usa `NoOpAuthGuard`, opção aceita no desafio; não é controle de acesso de produção.
- Entrega de eventos é pelo menos uma vez; consumidores deduplicam `eventId` no próprio banco.
- Não há redrive automático de DLQ, arquivamento da Outbox ou reparo automático de saldo.
- Não há dashboard/OpenTelemetry ou benchmark de carga; esses itens são opcionais.
- Readiness mede alcance das dependências, não verifica permissões de todas as operações nem todas as filas.
- Contadores são best effort por processo; reconciliação e ledger são a fonte auditável.

## Fluxo de entrega

`main` é a referência de entrega. As features são revisadas por PR e integradas
após aprovação do CI; o histórico preserva as decisões e as validações por etapa.
