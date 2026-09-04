# Backend Challenge Ledger

Processador distribuído de transações de apostas desenvolvido para o desafio
técnico de backend da Jungle Gaming.

> A solução está em desenvolvimento. O enunciado original do desafio foi
> preservado integralmente em [`docs/CHALLENGE.md`](docs/CHALLENGE.md).

## Estado atual

O repositório contém, neste momento, a fundação do projeto e o primeiro objeto
de valor do domínio:

- Bun 1.x como runtime, gerenciador de pacotes e executor de testes;
- NestJS com TypeScript em modo estrito;
- endpoint mínimo de liveness;
- infraestrutura local com PostgreSQL e LocalStack por Docker Compose;
- `Money` imutável, multi-moeda e sem aritmética de ponto flutuante;
- teste de round trip monetário contra PostgreSQL real;
- abertura de Wallet com `OPENING`, ledger e outbox atômicos;
- migration reversível com constraints financeiras no PostgreSQL;
- endpoint `POST /wallets` com respostas `201`, `400` e `409`;
- documentos de arquitetura e rastreabilidade dos critérios de aceite.

O processamento das transações de aposta ainda não foi implementado. Cada
capacidade somente será marcada como concluída após a comprovação de suas
garantias por testes unitários, de integração e de concorrência.

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
- [`docs/P0-GUARDRAILS.md`](docs/P0-GUARDRAILS.md): bloqueios associados às
  falhas eliminatórias.
- [`docs/ACCEPTANCE-CRITERIA.md`](docs/ACCEPTANCE-CRITERIA.md): rastreabilidade
  entre requisitos, implementação e evidências.
- [`docs/CHALLENGE.md`](docs/CHALLENGE.md): enunciado original da Jungle Gaming.

## Fluxo de entrega

O desenvolvimento é dividido em branches locais de curta duração. Cada branch é
integrada somente depois que suas verificações passam e, em seguida, é excluída.
A entrega remota final manterá apenas a branch `main`, com um histórico linear e
conciso.
