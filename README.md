# Backend Challenge Ledger

Processador distribuído de transações de apostas desenvolvido para o desafio
técnico de backend da Jungle Gaming.

> A solução está em desenvolvimento. O enunciado original do desafio foi
> preservado integralmente em [`docs/CHALLENGE.md`](docs/CHALLENGE.md).

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
- idempotência persistente por chave e hash canônico SHA-256;
- rejeição auditável por saldo insuficiente, sem lançamento no ledger;
- endpoint `POST /wagering/transactions` com replay e conflitos distintos;
- testes de 50 duplicatas concorrentes em três processos Bun;
- documentos de arquitetura e rastreabilidade dos critérios de aceite.

Referências opcionais de `WIN`, `REFUND`, `ROLLBACK`, SQS e o publisher da outbox
ainda não foram implementados. Cada capacidade somente será marcada como
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
`GET http://localhost:3000/health/live`. O endpoint de readiness será adicionado
junto aos adaptadores do PostgreSQL e do SQS.

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

O mesmo contrato aceita `WIN` e `LOSS`. Nesta fase, campos de referência externa
ainda são rejeitados explicitamente.

## Verificações de qualidade

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run test:integration
bun run build
docker compose config --quiet
```

Os testes de integração exigem o PostgreSQL ativo e criam schemas isolados que
são removidos ao final da execução.

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md): fronteiras, estratégia de consistência e
  trade-offs.
- [`docs/ACCEPTANCE-CRITERIA.md`](docs/ACCEPTANCE-CRITERIA.md): rastreabilidade
  entre requisitos, implementação e evidências.
- [`docs/CHALLENGE.md`](docs/CHALLENGE.md): enunciado original da Jungle Gaming.

## Fluxo de entrega

O desenvolvimento é dividido em branches locais de curta duração. Cada branch é
integrada somente depois que suas verificações passam e, em seguida, é excluída.
A entrega remota final manterá apenas a branch `main`, com um histórico linear e
conciso.
