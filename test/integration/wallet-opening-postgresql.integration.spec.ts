import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM, PostgreSqlConnection } from '@mikro-orm/postgresql';

import type { IdGenerator } from '../../src/shared/application/ports/id-generator.js';
import { SystemClock } from '../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../src/shared/infrastructure/system/uuid-generator.js';
import { OpenWalletUseCase } from '../../src/modules/wallet/application/use-cases/open-wallet.js';
import { WalletAlreadyExistsError } from '../../src/modules/wallet/domain/errors/wallet.errors.js';
import { MikroOrmWalletOpeningRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wallet-opening.repository.js';
import { createWalletTestOrm } from './support/wallet-test-orm.js';

interface CountRow {
  count: number;
}

interface OpeningRow {
  amount: string;
  currency: string;
  kind: string;
  status: string;
}

interface LedgerRow {
  amount: string;
  balanceAfter: string;
  balanceBefore: string;
  direction: string;
}

interface ReconciliationRow {
  ledgerBalance: string;
  walletBalance: string;
}

interface OutboxRow {
  eventType: string;
  payload: unknown;
}

const schemaName = `wallet_test_${randomUUID().replaceAll('-', '')}`;
const secondaryOrms: MikroORM[] = [];
let orm: MikroORM | undefined;

describe('Wallet opening with PostgreSQL', () => {
  beforeAll(async () => {
    orm = await createWalletTestOrm(schemaName, true);
  });

  afterAll(async () => {
    await Promise.all(
      secondaryOrms.map(async (instance) => instance.close(true)),
    );

    if (orm === undefined) {
      return;
    }

    await orm.migrator.down({ schema: schemaName, to: 0 });

    const remainingTables = await orm.em
      .getConnection()
      .execute<CountRow[]>(
        `select count(*)::int as "count" from information_schema.tables where table_schema = ? and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages')`,
        [schemaName],
      );

    expect(remainingTables[0]?.count).toBe(0);
    await orm.em
      .getConnection()
      .execute(`drop schema if exists "${schemaName}" cascade`);
    await orm.close(true);
  });

  it('aplica a migration com as quatro tabelas obrigatórias desta fase', async () => {
    const rows = await connection().execute<CountRow[]>(
      `select count(*)::int as "count" from information_schema.tables where table_schema = ? and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages')`,
      [schemaName],
    );

    expect(rows[0]?.count).toBe(4);
  });

  it('persiste somente a wallet quando o saldo inicial é zero', async () => {
    const playerId = randomUUID();
    const useCase = createUseCase(getOrm());

    const result = await useCase.execute({
      playerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(result.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(await countByWallet('wallets', result.id)).toBe(1);
    expect(await countByWallet('wager_transactions', result.id)).toBe(0);
    expect(await countByWallet('wallet_ledger_entries', result.id)).toBe(0);
    expect(await countByAggregate('outbox_messages', result.id)).toBe(0);
    await expectReconciled(result.id);
  });

  it('persiste wallet, OPENING, ledger e outbox na mesma transação', async () => {
    const useCase = createUseCase(getOrm());
    const result = await useCase.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    const transactions = await connection().execute<OpeningRow[]>(
      `select "kind", "status", "amount", "currency" from "${schemaName}"."wager_transactions" where "wallet_id" = ?`,
      [result.id],
    );
    const ledger = await connection().execute<LedgerRow[]>(
      `select "direction", "amount", "balance_before" as "balanceBefore", "balance_after" as "balanceAfter" from "${schemaName}"."wallet_ledger_entries" where "wallet_id" = ?`,
      [result.id],
    );

    expect(transactions).toEqual([
      {
        kind: 'OPENING',
        status: 'PROCESSED',
        amount: '1000.00',
        currency: 'BRL',
      },
    ]);
    expect(ledger).toEqual([
      {
        direction: 'CREDIT',
        amount: '1000.00',
        balanceBefore: '0.00',
        balanceAfter: '1000.00',
      },
    ]);
    expect(await countByWallet('wallet_ledger_entries', result.id)).toBe(1);
    expect(await countOutboxForOpening(result.id)).toBe(2);

    const outbox = await connection().execute<OutboxRow[]>(
      `select "event_type" as "eventType", "payload" from "${schemaName}"."outbox_messages" where "payload"->'data'->>'walletId' = ? order by "event_type"`,
      [result.id],
    );

    expect(outbox.map((message) => message.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const openingTransactionId = await findOpeningTransactionId(result.id);

    expect(outbox[1]?.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      correlationId: openingTransactionId,
      data: {
        walletId: result.id,
        playerId: result.playerId,
        transactionId: openingTransactionId,
        direction: 'CREDIT',
        money: { amount: '1000.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '1000.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
    await expectReconciled(result.id);
  });

  it('reverte toda a abertura quando uma escrita intermediária falha', async () => {
    const existing = await createUseCase(getOrm()).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    const existingTransactionId = await findOpeningTransactionId(existing.id);
    const walletId = randomUUID();
    const ids = new SequenceIdGenerator([
      walletId,
      existingTransactionId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ]);
    const useCase = createUseCase(getOrm(), ids);

    const error = await captureRejection(
      useCase.execute({
        playerId: randomUUID(),
        initialBalance: { amount: '2.00', currency: 'BRL' },
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(await countByWallet('wallets', walletId)).toBe(0);
    expect(await countByWallet('wallet_ledger_entries', walletId)).toBe(0);
    expect(await countByAggregate('outbox_messages', walletId)).toBe(0);
    await expectReconciled(existing.id);
  });

  it('rejeita saldo negativo diretamente no schema', async () => {
    const error = await captureRejection(
      connection().execute(
        `insert into "${schemaName}"."wallets" ("id", "player_id", "currency", "balance", "version", "created_at", "updated_at") values (?, ?, 'BRL', '-0.01', 1, now(), now())`,
        [randomUUID(), randomUUID()],
      ),
    );

    expect(error).toBeInstanceOf(Error);
  });

  it('rejeita transação cuja identidade diverge da wallet', async () => {
    const result = await createUseCase(getOrm()).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const error = await captureRejection(
      connection().execute(
        `insert into "${schemaName}"."wager_transactions" ("id", "wallet_id", "player_id", "kind", "status", "amount", "currency", "result_balance", "result_currency", "created_at", "processed_at") values (?, ?, ?, 'OPENING', 'PROCESSED', '1.00', 'USD', '1.00', 'USD', now(), now())`,
        [randomUUID(), result.id, result.playerId],
      ),
    );

    expect(error).toBeInstanceOf(Error);
    await expectReconciled(result.id);
  });

  it('rejeita ledger aritmeticamente inconsistente no schema', async () => {
    const result = await createUseCase(getOrm()).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const transactionId = randomUUID();

    await connection().execute(
      `insert into "${schemaName}"."wager_transactions" ("id", "wallet_id", "player_id", "kind", "status", "amount", "currency", "result_balance", "result_currency", "created_at", "processed_at") values (?, ?, ?, 'OPENING', 'PROCESSED', '10.00', 'BRL', '10.00', 'BRL', now(), now())`,
      [transactionId, result.id, result.playerId],
    );
    const error = await captureRejection(
      connection().execute(
        `insert into "${schemaName}"."wallet_ledger_entries" ("id", "wallet_id", "transaction_id", "direction", "amount", "currency", "balance_before", "balance_after", "created_at") values (?, ?, ?, 'CREDIT', '10.00', 'BRL', '0.00', '9.99', now())`,
        [randomUUID(), result.id, transactionId],
      ),
    );

    expect(error).toBeInstanceOf(Error);
    await connection().execute(
      `delete from "${schemaName}"."wager_transactions" where "id" = ?`,
      [transactionId],
    );
    await expectReconciled(result.id);
  });

  it('rejeita mais de um ledger para a mesma wallet e transação', async () => {
    const result = await createUseCase(getOrm()).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const transactionId = await findOpeningTransactionId(result.id);
    const error = await captureRejection(
      connection().execute(
        `insert into "${schemaName}"."wallet_ledger_entries" ("id", "wallet_id", "transaction_id", "direction", "amount", "currency", "balance_before", "balance_after", "created_at") values (?, ?, ?, 'CREDIT', '10.00', 'BRL', '0.00', '10.00', now())`,
        [randomUUID(), result.id, transactionId],
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect(await countByWallet('wallet_ledger_entries', result.id)).toBe(1);
    await expectReconciled(result.id);
  });

  it('rejeita atualização e exclusão de ledger no schema', async () => {
    const result = await createUseCase(getOrm()).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    const updateError = await captureRejection(
      connection().execute(
        `update "${schemaName}"."wallet_ledger_entries" set "amount" = '11.00' where "wallet_id" = ?`,
        [result.id],
      ),
    );
    const deleteError = await captureRejection(
      connection().execute(
        `delete from "${schemaName}"."wallet_ledger_entries" where "wallet_id" = ?`,
        [result.id],
      ),
    );

    expect(errorMessage(updateError)).toContain(
      'wallet ledger entries are immutable',
    );
    expect(errorMessage(deleteError)).toContain(
      'wallet ledger entries are immutable',
    );
    expect(await countByWallet('wallet_ledger_entries', result.id)).toBe(1);
    await expectReconciled(result.id);
  });

  it('serializa criações concorrentes pela unicidade do PostgreSQL', async () => {
    const playerId = randomUUID();
    const additionalOrms = await Promise.all([
      createWalletTestOrm(schemaName, false),
      createWalletTestOrm(schemaName, false),
    ]);
    secondaryOrms.push(...additionalOrms);
    const useCases = [getOrm(), ...additionalOrms].map((instance) =>
      createUseCase(instance),
    );

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => {
        const useCase = useCases[index % useCases.length];

        if (useCase === undefined) {
          throw new Error('Caso de uso concorrente não encontrado.');
        }

        return useCase.execute({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });
      }),
    );
    const fulfilled = attempts.filter(
      (attempt) => attempt.status === 'fulfilled',
    );
    const rejected = attempts.filter(
      (attempt) => attempt.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    expect(
      rejected.every(
        (attempt) =>
          attempt.status === 'rejected' &&
          attempt.reason instanceof WalletAlreadyExistsError,
      ),
    ).toBe(true);

    const walletRows = await connection().execute<Array<{ id: string }>>(
      `select "id" from "${schemaName}"."wallets" where "player_id" = ? and "currency" = 'BRL'`,
      [playerId],
    );
    const walletId = walletRows[0]?.id;

    expect(walletRows).toHaveLength(1);
    expect(walletId).toBeDefined();
    expect(await countByWallet('wager_transactions', walletId ?? '')).toBe(1);
    expect(await countByWallet('wallet_ledger_entries', walletId ?? '')).toBe(
      1,
    );
    expect(await countOutboxForOpening(walletId ?? '')).toBe(2);
    await expectReconciled(walletId ?? '');
  });
});

function createUseCase(
  instance: MikroORM,
  idGenerator: IdGenerator = new UuidGenerator(),
): OpenWalletUseCase {
  return new OpenWalletUseCase(
    new MikroOrmWalletOpeningRepository(instance.em.fork()),
    idGenerator,
    new SystemClock(),
  );
}

function connection(): PostgreSqlConnection {
  return getOrm().em.getConnection();
}

function getOrm(): MikroORM {
  if (orm === undefined) {
    throw new Error('O ORM de teste não foi inicializado.');
  }

  return orm;
}

async function countByWallet(table: string, walletId: string): Promise<number> {
  const rows = await connection().execute<CountRow[]>(
    `select count(*)::int as "count" from "${schemaName}"."${table}" where "${table === 'wallets' ? 'id' : 'wallet_id'}" = ?`,
    [walletId],
  );

  return rows[0]?.count ?? 0;
}

async function countByAggregate(
  table: string,
  aggregateId: string,
): Promise<number> {
  const rows = await connection().execute<CountRow[]>(
    `select count(*)::int as "count" from "${schemaName}"."${table}" where "aggregate_id" = ?`,
    [aggregateId],
  );

  return rows[0]?.count ?? 0;
}

async function countOutboxForOpening(walletId: string): Promise<number> {
  const rows = await connection().execute<CountRow[]>(
    `select count(*)::int as "count" from "${schemaName}"."outbox_messages" where "payload"->'data'->>'walletId' = ?`,
    [walletId],
  );

  return rows[0]?.count ?? 0;
}

async function expectReconciled(walletId: string): Promise<void> {
  const rows = await connection().execute<ReconciliationRow[]>(
    `
      select
        "wallets"."balance" as "walletBalance",
        coalesce(sum(
          case "wallet_ledger_entries"."direction"
            when 'CREDIT' then "wallet_ledger_entries"."amount"
            when 'DEBIT' then -"wallet_ledger_entries"."amount"
          end
        ), 0)::numeric(20, 2) as "ledgerBalance"
      from "${schemaName}"."wallets"
      left join "${schemaName}"."wallet_ledger_entries"
        on "wallet_ledger_entries"."wallet_id" = "wallets"."id"
      where "wallets"."id" = ?
      group by "wallets"."id"
    `,
    [walletId],
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]?.walletBalance).toBe(rows[0]?.ledgerBalance);
}

async function findOpeningTransactionId(walletId: string): Promise<string> {
  const rows = await connection().execute<Array<{ id: string }>>(
    `select "id" from "${schemaName}"."wager_transactions" where "wallet_id" = ? and "kind" = 'OPENING'`,
    [walletId],
  );
  const id = rows[0]?.id;

  if (id === undefined) {
    throw new Error('Transação OPENING de teste não encontrada.');
  }

  return id;
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }

  throw new Error('A operação de teste deveria ter falhado.');
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    throw new Error('A rejeição capturada não é uma instância de Error.');
  }

  return error.message;
}

class SequenceIdGenerator implements IdGenerator {
  public constructor(private readonly values: string[]) {}

  public generate(): string {
    const value = this.values.shift();

    if (value === undefined) {
      throw new Error('A sequência de IDs de teste foi esgotada.');
    }

    return value;
  }
}
