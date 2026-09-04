# Proteções P0

As falhas eliminatórias abaixo são bloqueadores permanentes para a entrega. Uma
fase não poderá ser considerada concluída se enfraquecer alguma dessas garantias
ou não apresentar um teste confiável para o comportamento introduzido.

| P0   | Falha eliminatória                                 | Bloqueio de implementação                                                                                | Evidência obrigatória                                              |
| ---- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| P0-1 | Dinheiro representado por ponto flutuante          | Strings decimais nas fronteiras, `decimal.js` no domínio e mapeamento exato para `NUMERIC` no PostgreSQL | Testes unitários de Money e round trips de persistência            |
| P0-2 | Saldo negativo causado por race condition          | Coordenação no banco por wallet e constraint de saldo não negativo no schema                             | Cenário real e paralelo de disputa por saldo insuficiente          |
| P0-3 | Débito ou crédito duplicado                        | Identidade persistente do comando, constraints de unicidade e um único efeito no ledger por transação    | 50 apostas duplicadas concorrentes e testes de redelivery          |
| P0-4 | Idempotência apenas em memória                     | Resultado idempotente e hash do payload persistidos no PostgreSQL                                        | Testes de replay após reinício e entre múltiplos processos         |
| P0-5 | Correção limitada a uma instância                  | Nenhuma garantia depende da memória do processo; o PostgreSQL é o ponto de coordenação                   | Pelo menos três processos concorrentes                             |
| P0-6 | Publicação de evento antes do commit               | Outbox transacional incluída junto à alteração financeira                                                | Recuperação após queda entre o commit e a publicação               |
| P0-7 | Ausência de ledger auditável                       | Ledger somente de inclusão, imutabilidade no schema e escritas atômicas de wallet e ledger               | Testes de constraints e reconciliação após cada cenário financeiro |
| P0-8 | PostgreSQL e SQS totalmente substituídos por mocks | Suítes de integração executadas contra serviços reais em containers                                      | Suíte local e de CI com containers, falhas e recuperação           |

## Bloqueio por fase

Antes de integrar uma fase de desenvolvimento:

1. reler as seções relevantes de `docs/CHALLENGE.md`;
2. identificar quais garantias P0 são afetadas pela alteração;
3. adicionar ou atualizar as proteções no schema quando aplicável;
4. implementar o teste útil de menor nível e a comprovação necessária com
   infraestrutura real;
5. executar toda a suíte de verificação existente;
6. atualizar `docs/ACCEPTANCE-CRITERIA.md` sem declarar como comprovado um
   comportamento ainda não testado.

Funcionalidades opcionais não poderão ser iniciadas enquanto existir um defeito
P0 conhecido.

## Evidências implementadas

- **P0-1:** `money.spec.ts` cobre formato, precisão, operações, imutabilidade e
  conflito de moeda; `money-postgresql.integration.spec.ts` comprova round trips
  exatos em `NUMERIC(20, 2)` contra PostgreSQL real, incluindo o limite máximo.
- **P0-2 (parcial):** o schema rejeita saldo negativo; a disputa concorrente por
  saldo insuficiente permanece pendente até a implementação de `BET`.
- **P0-3 (parcial):** o schema limita o ledger a uma entrada por wallet e
  transação; duplicatas concorrentes de apostas permanecem pendentes.
- **P0-5 (parcial):** a unicidade de abertura foi comprovada por 12 chamadas em
  três conexões PostgreSQL independentes; a prova em três processos permanece
  pendente para o processamento de apostas.
- **P0-6 (parcial):** os eventos de abertura são incluídos na outbox dentro da
  transação financeira; publicação, leases e recuperação após queda permanecem
  pendentes.
- **P0-7 (parcial):** a abertura grava wallet, `OPENING` e ledger atomicamente;
  constraints validam a aritmética e um trigger rejeita atualização e exclusão.
  Os demais cenários financeiros ainda precisam da mesma prova de reconciliação.
- **P0-8 (parcial):** migrations, constraints, atomicidade e concorrência desta
  fase são testadas em PostgreSQL real. A comprovação com SQS permanece pendente.
