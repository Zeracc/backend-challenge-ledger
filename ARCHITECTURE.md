# Arquitetura

## Status

Este documento registra a arquitetura planejada e evoluirá junto com o código.
As decisões descritas aqui estabelecem restrições para a implementação; elas não
significam que uma funcionalidade já esteja concluída.

## Prioridades

A correção do sistema tem prioridade sobre o throughput. A ordem das preocupações
é:

1. invariantes financeiras e ledger auditável;
2. concorrência e idempotência persistente;
3. recuperação de falhas entre múltiplos processos;
4. operabilidade e desempenho.

As falhas eliminatórias são bloqueadores P0 permanentes para qualquer entrega.
A aplicação concreta dessas garantias e suas provas estão registradas em
[`docs/P0-GUARDRAILS.md`](docs/P0-GUARDRAILS.md).

## Fronteiras arquiteturais

O código é organizado por capacidade de negócio. Dentro de cada capacidade, as
dependências apontam para as camadas internas:

```text
HTTP / SQS
    -> casos de uso e portas da aplicação
        -> modelo de domínio independente de framework
    <- adaptadores PostgreSQL / SQS
A raiz de composição do NestJS conecta essas fronteiras
```

- **Domínio:** objetos de valor imutáveis, agregados, factories explícitas e
  transições de estado. Não importa NestJS nem o ORM.
- **Aplicação:** casos de uso e portas. HTTP e SQS invocam o mesmo caso de uso
  para processamento de transações.
- **Infraestrutura:** repositórios MikroORM/PostgreSQL, adaptadores SQS,
  migrations e workers de inbox e outbox.
- **Apresentação:** controllers HTTP e DTOs de transporte.

## Representação financeira

Os valores monetários nos contratos da aplicação e dos transportes serão strings
decimais com escala fixa. A aritmética de domínio utilizará `decimal.js`; o tipo
`number` do JavaScript é proibido para valores monetários. O PostgreSQL armazenará
os valores em colunas exatas `NUMERIC(..., 2)`, acompanhadas das constraints
adequadas. A precisão inicial será `NUMERIC(20, 2)`, permitindo até 18 dígitos
inteiros. O mapeamento do ORM deverá converter os valores por meio de strings,
nunca por um valor de ponto flutuante.

## Estratégia de transação e concorrência

O banco de dados é a fonte da verdade. Cada comando financeiro será executado em
uma única transação SQL e coordenado pelo seu `walletId` por meio de lock de linha
no PostgreSQL. Conforme a origem e o efeito do comando, a transação incluirá:

- consulta e inserção da idempotência persistente;
- registro de inbox para entradas recebidas pelo SQS;
- estado da transação de aposta;
- alteração do saldo da wallet;
- inclusão imutável no ledger;
- inclusão do evento na outbox.

Não haverá lock de wallet local ao processo nem lock global. Wallets diferentes
continuarão livres para progredir em paralelo. Constraints no banco de dados serão
a última linha de defesa para unicidade, saldo não negativo e, no máximo, um
efeito no ledger por transação.

O lock pessimista por wallet é a escolha inicial porque torna explícito o ponto
de serialização financeira e é naturalmente compartilhado por todas as instâncias
da aplicação. A contenção dos locks será medida. Retentativas limitadas serão
reservadas para falhas transitórias do banco, nunca para rejeições de negócio.

## Idempotência

O header `Idempotency-Key` representa a identidade de um comando HTTP. Para o
SQS, será acrescentada a identidade persistente de inbox
`(consumerName, messageId)`. O subconjunto canônico dos campos de negócio será
transformado em hash e persistido:

- mesma identidade e mesmo hash: devolver o resultado originalmente persistido;
- mesma identidade e hash diferente: devolver conflito estável de idempotência;
- duplicatas concorrentes: resolver pela unicidade do banco, nunca pela memória
  do processo.

A resposta original incluirá o saldo observado quando o comando foi concluído.
Um replay deverá devolver esse saldo histórico, e não o saldo mais recente da
wallet.

## Ledger e reconciliação

Cada alteração de saldo produzirá exatamente uma entrada no ledger dentro da
mesma transação. Operações sem efeito no saldo não produzirão lançamentos. As
linhas do ledger serão somente de inclusão: o schema rejeitará atualizações e
exclusões, sem depender apenas de uma convenção da aplicação.

A reconciliação comparará o saldo materializado da wallet com uma reconstrução
consistente a partir do ledger. Uma divergência nunca será corrigida de maneira
silenciosa.

## Mensageria e outbox transacional

Os eventos serão incluídos na outbox dentro da transação financeira e publicados
somente depois do commit. Os publishers reservarão registros pendentes por meio
de leases curtos no banco. Assim, chamadas de rede para o SQS não manterão uma
transação financeira aberta. Uma queda pode provocar publicação duplicada;
portanto, os consumidores continuarão idempotentes.

O consumidor SQS confirmará a mensagem somente após o commit. Falhas de negócio
serão terminais e confirmadas; falhas transitórias usarão retentativas com backoff
exponencial limitado; falhas permanentes de transporte ou payload seguirão para
a DLQ. Durante o desligamento gracioso, o processo concluirá o trabalho em
andamento ou devolverá a visibilidade da mensagem.

## Referências fora de ordem

Uma referência ainda inexistente para `REFUND` ou `ROLLBACK` será persistida como
`PENDING_REFERENCE`. Um worker agendado fará novas tentativas com backoff
exponencial limitado. Os limites de tentativas e de TTL serão configurações
explícitas. Ao esgotá-los, a transação será rejeitada de forma auditável, com
`failureCode` estável e o evento correspondente na outbox.

## Decisão sobre autenticação

A autenticação não pontua no desafio e não deve deslocar as garantias P0. A
implementação inicial disponibilizará uma `ProviderIdentityPort` com adaptador
no-op para o desenvolvimento local. Em produção, essa porta validaria um provedor
OIDC externo, como Keycloak ou Zitadel.

Os endpoints de health permanecerão públicos. O SQS será tratado como canal
interno confiável, mas a identidade do provedor contida em cada mensagem continuará
sujeita às validações de domínio.

## Estratégia de verificação

Testes unitários cobrirão as regras puras de domínio. Testes de integração e de
recuperação de falhas utilizarão containers reais de PostgreSQL e SQS compatível.
Os testes de concorrência executarão trabalho realmente paralelo em pelo menos
três processos da aplicação. Todo teste financeiro terminará verificando que o
saldo armazenado na wallet é igual ao saldo reconstruído a partir do ledger.
