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

A reconciliação usa uma única consulta SQL que agrega créditos menos débitos e
compara com o saldo materializado. O snapshot da instrução garante consistência
durante commits concorrentes. A diferença é `storedBalance - calculatedBalance`,
calculada em NUMERIC e serializada como string, inclusive quando negativa. Não há
reparo automático. Divergências geram log com correlação e wallet, sem saldos, e
contador exportado em `/metrics`.

As leituras usam `WalletReadRepository`, separada do processador financeiro. A
API de ledger utiliza keyset por sequência bigint gerada no PostgreSQL e índice
único `(wallet_id, sequence)`. A primeira página fixa um teto em REPEATABLE READ;
as próximas mantêm esse teto, evitando incluir movimentações novas ou repetir
entradas. A serialização das escritas por wallet garante que novas sequências
daquela wallet sejam alocadas depois das anteriores. Timestamps não definem a
ordem, pois podem coincidir ou ter sido capturados antes da espera pelo lock.

A migration adiciona a identidade sem reescrever campos financeiros. Para dados
anteriores, a sequência estabelece uma ordem estável de paginação, sem prometer
reconstruir ordem histórica de commits. Reverter e reaplicar essa migration exige
reiniciar a paginação. O cursor Base64URL é versionado e validado por wallet e
intervalo; não é uma credencial nem é assinado. Os controles de identidade futura
devem ser aplicados pelo guard em todas as páginas.

## Mensageria e outbox transacional

Os eventos são incluídos na outbox dentro da transação financeira e publicados
somente depois do commit. Os publishers reservam registros pendentes por meio
de leases curtos no banco. Assim, chamadas de rede para o SQS não mantêm uma
transação financeira aberta. Uma queda pode provocar publicação duplicada;
portanto, os consumidores devem deduplicar eventId persistentemente.

O consumidor SQS confirma a mensagem somente após o commit. Falhas de negócio
são terminais e confirmadas; falhas transitórias usam retentativas com backoff
exponencial limitado; falhas permanentes de transporte ou payload seguem para
a DLQ. Durante o desligamento gracioso, o processo conclui o trabalho em
andamento ou devolve a visibilidade da mensagem.

## Referências fora de ordem

Uma referência ainda inexistente para `WIN`, `REFUND` ou `ROLLBACK` é persistida
como `PENDING_REFERENCE`, junto ao evento
`WagerTransactionPendingReference` na outbox. O HTTP distingue essa aceitação
assíncrona com status `202`, e o replay devolve o mesmo resultado persistido.

O worker executa a cada cinco segundos e mantém tentativas, próxima execução e
TTL no banco. A política usa oito tentativas, espera inicial de cinco segundos,
teto de cinco minutos e TTL de 24 horas. O limite de tentativas normalmente
encerra a pendência antes do TTL; 24 horas é um limite adicional, não uma promessa
de manter a pendência durante esse período.

Cada item bloqueia a transação pendente e sua wallet. O lote ordena candidatos por
próxima tentativa e ID, tenta os demais itens mesmo quando um falha, e reporta a
falha agregada ao scheduler. ROLLBACK rejeitado por saldo é contado como rejeição.
O scheduler registra falhas sem SQL/payload, impede sobreposição local e aguarda
o trabalho em andamento ao encerrar. A coordenação entre instâncias continua no
PostgreSQL, com locks bloqueantes; reserva por SKIP LOCKED permanece uma otimização
futura. O limite de cada lote é 100.

## Readiness e diagnóstico inicial

Liveness verifica o processo. Readiness consulta PostgreSQL e SQS (`ListQueues`)
em paralelo e retorna 503 se alguma verificação falha ou excede 1,5 segundo.
O SDK SQS é abortado ao atingir o timeout. O timeout da resposta PostgreSQL não
cancela uma eventual aquisição de conexão em andamento no driver; não implica
que a dependência tenha sido desligada. O CI provisiona PostgreSQL e LocalStack.

O bootstrap configura logs JSON. A instrumentação de reconciliação exporta
contadores por instância sem labels de alta cardinalidade. Métricas gerais de
transações, retries, DLQ, locks, lag de outbox e latência permanecem futuras.
Os endpoints financeiros reconhecem erros transitórios do PostgreSQL e retornam
503 com código estável; erros inesperados continuam distintos como 500.

## Consumidor SQS implementado

HTTP e SQS compartilham a validação do comando e `ProcessWagerTransactionUseCase`.
A identidade de transporte é o `messageId` lógico do envelope, separada do ID AWS
e da chave de idempotência financeira. A Inbox usa chave composta por consumidor
e mensagem, hash SHA-256 do comando canônico e FK para a transação resultante.
O timestamp do envelope é validado, mas não substitui o relógio confiável do
processamento nem integra o hash; reenviar o mesmo comando com outro timestamp
não cria efeito financeiro.

A primeira escrita da Inbox e sua conclusão ocorrem na mesma transação SQL do
financeiro e da Outbox. Corridas na unicidade repetem a transação para ler o
vencedor e concluir a Inbox do replay. O ack ocorre somente após o commit.
`PENDING_REFERENCE` é confirmado porque seu retry já está persistido no banco;
o scheduler existente assume a continuação.

Uma rejeição de negócio persistida recebe ack. Mensagens inválidas, conflitos de
payload/identidade, wallet ausente ou identidade incompatível seguem para DLQ.
Erros não classificados recebem retry com backoff limitado; na quinta entrega,
o consumidor envia à DLQ e somente então remove a origem. A DLQ mantém o corpo
original e atributos `failureCode`/`originalMessageId`. Falhas técnicas revertidas
não criam uma transação financeira `FAILED` artificial: o diagnóstico fica na
DLQ, e uma política operacional de redrive permanece futura.

O heartbeat renova a visibilidade e termina antes do ack ou mudança de destino.
O shutdown aborta o long polling e aguarda o processamento ativo. O timeout HTTP
de 25 segundos acomoda o long polling de 20 segundos. Locks têm timeout SQL de
5 segundos e statements de 10 segundos no caminho SQS. Uma interrupção forçada
deixa a mensagem reaparecer após o prazo de visibilidade; o teste com SIGKILL
comprova replay sem novo débito após commit. O teste de drenagem exercita o hook
do runner com processamento ativo, e o smoke Docker exercita SIGTERM em espera.

Não há garantia de publicação exatamente uma vez na DLQ: o ID de deduplicação
é estável, mas a janela FIFO é limitada. O publisher da Outbox segue a mesma
semântica de entrega pelo menos uma vez descrita abaixo.

## Publisher da Outbox implementado

`OutboxMessage` encapsula o envelope, as datas, o estado terminal e o backoff.
A porta `OutboxRepository` separa a reserva persistente do caso de uso;
`IntegrationEventPublisher` separa o transporte. A implementação SQL usa uma CTE
com `FOR UPDATE SKIP LOCKED` e `UPDATE RETURNING` em uma operação atômica curta.
Somente eventos confirmados e devidos são candidatos. Nenhum lock de wallet ou
transação financeira fica aberto durante a chamada de rede.

Cada reserva recebe um UUID novo como token de posse. Confirmação e retry exigem
esse token, evento ainda pendente e lease não expirado. As comparações de prazo
e a persistência de horários usam o relógio do PostgreSQL. Assim, um processo
atrasado não confirma nem reagenda o trabalho assumido por outro processo.
A migration valida pares de campos do lease, protege o envelope contra UPDATE
e impede transições de eventos já publicados.

O lease de 30s excede o timeout de envio de 5s do SDK, configurado com
`throwOnRequestTimeout=true`. Cada lote reserva até 20 eventos sequencialmente;
falha de envio reagenda aquele evento e permite continuar os demais. Falha no
banco após o envio deixa o lease recuperável por expiração. O shutdown impede
novas reservas e aguarda o envio ativo, sem aguardar os demais itens do lote.

Não há transação distribuída entre PostgreSQL e SQS. O intervalo entre envio e
marcação pode produzir duplicatas com o mesmo eventId. O destino é
`wager-events.fifo`, com aggregateId como grupo e eventId como chave FIFO, mas
o consumidor deve persistir sua própria deduplicação. A ordem de chegada não
representa necessariamente a ordem financeira; eventos WalletBalanceChanged
incluem walletVersion para descartar snapshots antigos.

Comprovações: transação financeira aberta não publica; commit torna eventos
visíveis; três processos publicam 60 eventos; SIGKILL após reserva e após envio
permite retomada; dono antigo não altera lease novo; falha de envio persiste
retry; todos os quatro tipos chegam ao SQS; shutdown drena apenas o envio ativo.
A política de retenção/arquivamento de eventos publicados permanece operacional
e não exclui registros automaticamente nesta implementação.

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
