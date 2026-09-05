# Backend Challenge Ledger

Processador distribuído de transações de apostas desenvolvido para o desafio
técnico de backend da Jungle Gaming.

> A solução está em desenvolvimento. A documentação complementar e o enunciado
> preservado serão incluídos na entrega final.

## Estado atual

O repositório contém uma fatia vertical de abertura de Wallet e processamento
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

O consumidor SQS/Inbox/DLQ e o publisher da outbox ainda não foram implementados.
A observabilidade completa também permanece pendente. Cada capacidade somente será marcada como
concluída após a comprovação de suas garantias por testes unitários, de integração
e de concorrência.

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
em formato Prometheus, por processo; os demais indicadores operacionais são futuros.

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md): fronteiras, estratégia de consistência e
  trade-offs.

A rastreabilidade completa dos critérios de aceite e o enunciado preservado
serão adicionados na entrega final.

## Fluxo de entrega

O desenvolvimento é dividido em branches locais de curta duração. Cada branch é
integrada somente depois que suas verificações passam e, em seguida, é excluída.
A entrega remota final manterá apenas a branch `main`, com um histórico linear e
conciso.
