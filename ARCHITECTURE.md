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
Essas garantias e suas provas são revalidadas antes da integração de cada fase.

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

## Abertura de wallet

A abertura é a primeira fatia vertical implementada. Uma wallet com saldo zero
é persistida sem movimentação financeira. Quando o saldo inicial é positivo, o
caso de uso constrói um pacote indivisível com:

- wallet na versão `1`;
- transação interna `OPENING` já processada;
- lançamento `CREDIT` partindo de zero;
- eventos `WagerTransactionProcessed` e `WalletBalanceChanged` na outbox.

O adaptador PostgreSQL persiste o pacote em uma única transação. Flushes internos
são ordenados pelas foreign keys, mas nenhum deles realiza commit isolado. Uma
falha em qualquer etapa reverte wallet, transação, ledger e outbox.

O schema reforça saldo não negativo, unicidade por player e moeda, coerência de
identidade entre wallet, transação e ledger, aritmética do lançamento e um único
lançamento por wallet e transação. Trigger no PostgreSQL rejeita `UPDATE` e
`DELETE` no ledger.

## Processamento de BET

`POST /wagering/transactions` processa `BET` de forma síncrona. O caso de uso
normaliza `Money`, calcula SHA-256 sobre um JSON canônico com chaves ordenadas e
cria a transação pendente. O header `Idempotency-Key` não entra no hash: ele é a
identidade do comando, enquanto o hash representa somente seu payload de negócio.

O adaptador inicia uma transação SQL e procura um resultado idempotente já
confirmado. Para um comando novo, adquire `SELECT FOR UPDATE` apenas na linha da
wallet, verifica novamente a idempotência e aplica a regra de domínio. Esse lock
serializa movimentações da mesma wallet entre processos, sem bloquear wallets
diferentes.

Uma aposta aceita atualiza saldo e versão, persiste `WagerTransaction`, inclui um
`DEBIT` no ledger e grava `WagerTransactionProcessed` e `WalletBalanceChanged` na
outbox. Saldo insuficiente persiste a transação `REJECTED` com
`INSUFFICIENT_FUNDS` e `WagerTransactionRejected`, sem alterar wallet ou ledger.
Qualquer falha reverte todo o conjunto.

O resultado terminal armazena o saldo observado no processamento. Assim, um
replay devolve a resposta histórica mesmo que movimentações posteriores alterem
a wallet. Índices únicos protegem `Idempotency-Key` e a identidade externa
`(providerId, externalTransactionId)`.

## Processamento de WIN e LOSS

O mesmo endpoint, caso de uso e processador transacional de `BET` também atendem
`WIN` e `LOSS`. O tipo da operação faz parte do payload canônico usado na
idempotência, impedindo que uma mesma chave seja reutilizada para trocar o efeito
financeiro do comando.

`WIN` adquire o lock da Wallet, aplica um crédito imutável, incrementa a versão e
persiste um ledger `CREDIT`. Os eventos `WagerTransactionProcessed` e
`WalletBalanceChanged` entram na outbox dentro da mesma transação. Créditos
duplicados são resolvidos pela identidade persistente, inclusive entre processos
distintos.

`LOSS` também passa pelo lock da Wallet para observar uma posição serializada do
saldo, mas não altera saldo ou versão e não cria ledger. Somente a transação
`PROCESSED` e o evento `WagerTransactionProcessed` são persistidos. Um trigger no
PostgreSQL impede a inclusão de ledger para `LOSS` e valida status, valor e
direção para os tipos financeiros já suportados.

Referências continuam proibidas em `BET` e `LOSS`. `WIN` aceita uma referência
opcional a uma `BET` processada no mesmo escopo.

## Referências, REFUND e ROLLBACK

A referência externa é resolvida por `(providerId,
referenceExternalTransactionId)`. Uma referência encontrada precisa pertencer
ao mesmo player, Wallet, moeda e rodada. `REFUND` aceita apenas `BET`; `ROLLBACK`
aceita `BET`, `WIN` ou `REFUND`. As reversões são integrais: seu `Money` precisa
ser exatamente igual ao da transação referenciada.

`REFUND` credita o valor da `BET`. `ROLLBACK` aplica o efeito inverso: credita ao
referenciar `BET` e debita ao referenciar `WIN` ou `REFUND`. Um débito de rollback
que deixaria saldo negativo é `REJECTED` com
`ROLLBACK_INSUFFICIENT_FUNDS`. Referência existente, mas inválida, também é
persistida como rejeição auditável, sem alterar Wallet ou ledger.

O lock pessimista da Wallet serializa a consulta de duplicidade e o efeito
financeiro. Um índice parcial único impede mais de uma reversão `PROCESSED` do
mesmo tipo para a mesma referência. A migration também valida a direção do
ledger de acordo com o tipo da transação e, no caso de `ROLLBACK`, com o tipo da
referência.

## Idempotência

O header `Idempotency-Key` representa a identidade de um comando HTTP. Para o
SQS, será acrescentada a identidade persistente de inbox
`(consumerName, messageId)`. No fluxo HTTP implementado, o subconjunto canônico
dos campos de negócio é transformado em hash e persistido:

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

Uma referência ainda inexistente para `WIN`, `REFUND` ou `ROLLBACK` é persistida
como `PENDING_REFERENCE`, junto ao evento
`WagerTransactionPendingReference` na outbox. O HTTP distingue essa aceitação
assíncrona com status `202`, e o replay devolve o mesmo resultado persistido.

O worker agendado de reprocessamento pertence à próxima fase. Ele fará novas
tentativas com backoff exponencial limitado; tentativas e TTL serão configurações
explícitas. Ao esgotá-los, a transação será rejeitada de forma auditável, com
`failureCode` estável e o evento correspondente na outbox.

## Decisão sobre autenticação

A autenticação não pontua no desafio e não deve deslocar as garantias P0. Os
endpoints de negócio usam inicialmente um `NoOpAuthGuard`, deixando explícito o
ponto de substituição. Em produção, esse guard delegaria a validação a um provedor
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
