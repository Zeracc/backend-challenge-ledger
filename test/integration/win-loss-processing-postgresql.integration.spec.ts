import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM, PostgreSqlConnection } from '@mikro-orm/postgresql';

import { OpenWalletUseCase } from '../../src/modules/wallet/application/use-cases/open-wallet.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
  type ProcessableWagerTransactionKind,
} from '../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { ExternalTransactionConflictError } from '../../src/modules/wallet/domain/errors/wallet.errors.js';
import { MikroOrmWagerTransactionProcessor } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import { MikroOrmWalletOpeningRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wallet-opening.repository.js';
import type { IdGenerator } from '../../src/shared/application/ports/id-generator.js';
import { SystemClock } from '../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../src/shared/infrastructure/system/uuid-generator.js';
import { Sha256PayloadHasher } from '../../src/shared/infrastructure/serialization/sha256-payload-hasher.js';
import { createWalletTestOrm } from './support/wallet-test-orm.js';

interface WalletRow {
  balance: string;
  version: number;
}

interface TransactionRow {
  kind: string;
  status: string;
  resultBalance: string;
}

interface LedgerRow {
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
}

interface WorkerResult {
  transactionId: string;
  idempotentReplay: boolean;
}

const schemaName = `win_loss_test_${randomUUID().replaceAll('-', '')}`;
const secondaryOrms: MikroORM[] = [];
let orm: MikroORM | undefined;

describe('WIN and LOSS processing with PostgreSQL', () => {
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
    await orm.em
      .getConnection()
      .execute(`drop schema if exists "${schemaName}" cascade`);
    await orm.close(true);
  });

  it('credita WIN e grava transação, ledger e dois eventos atomicamente', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const result = await createUseCase(getOrm()).execute(
      wagerInput(WagerTransactionKind.Win, wallet.id, playerId, '25.00'),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);
    expect(await walletState(wallet.id)).toEqual({
      balance: '125.00',
      version: 2,
    });
    expect(await transactionState(result.transactionId)).toEqual({
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.Processed,
      resultBalance: '125.00',
    });
    expect(await ledgerState(result.transactionId)).toEqual({
      direction: 'CREDIT',
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '125.00',
    });
    expect(await transactionOutboxTypes(result.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectReconciled(wallet.id);
  });

  it('processa LOSS sem alterar saldo, versão ou ledger', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const result = await createUseCase(getOrm()).execute(
      wagerInput(WagerTransactionKind.Loss, wallet.id, playerId, '25.00'),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await walletState(wallet.id)).toEqual({
      balance: '100.00',
      version: 1,
    });
    expect(await transactionState(result.transactionId)).toEqual({
      kind: WagerTransactionKind.Loss,
      status: WagerTransactionStatus.Processed,
      resultBalance: '100.00',
    });
    expect(await ledgerState(result.transactionId)).toBeUndefined();
    expect(await transactionOutboxTypes(result.transactionId)).toEqual([
      'WagerTransactionProcessed',
    ]);
    await expectReconciled(wallet.id);
  });

  it('impede pelo schema que LOSS receba lançamento de ledger', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const result = await createUseCase(getOrm()).execute(
      wagerInput(WagerTransactionKind.Loss, wallet.id, playerId, '25.00'),
    );

    const error = await captureRejection(
      connection().execute(
        `
          insert into "${schemaName}"."wallet_ledger_entries"
            ("id", "wallet_id", "transaction_id", "direction", "amount", "currency", "balance_before", "balance_after", "created_at")
          values (?, ?, ?, 'CREDIT', '25.00', 'BRL', '100.00', '125.00', now())
        `,
        [randomUUID(), wallet.id, result.transactionId],
      ),
    );

    expect(errorMessage(error)).toContain(
      'LOSS cannot create a wallet ledger entry',
    );
    await expectReconciled(wallet.id);
  });

  it('impede pelo schema direção ou valor incompatível com WIN', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const result = await createUseCase(getOrm()).execute(
      wagerInput(WagerTransactionKind.Win, wallet.id, playerId, '25.00'),
    );
    const invalidDirection = await captureRejection(
      connection().execute(
        `
          insert into "${schemaName}"."wallet_ledger_entries"
            ("id", "wallet_id", "transaction_id", "direction", "amount", "currency", "balance_before", "balance_after", "created_at")
          values (?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '75.00', now())
        `,
        [randomUUID(), wallet.id, result.transactionId],
      ),
    );
    const invalidAmount = await captureRejection(
      connection().execute(
        `
          insert into "${schemaName}"."wallet_ledger_entries"
            ("id", "wallet_id", "transaction_id", "direction", "amount", "currency", "balance_before", "balance_after", "created_at")
          values (?, ?, ?, 'CREDIT', '24.00', 'BRL', '100.00', '124.00', now())
        `,
        [randomUUID(), wallet.id, result.transactionId],
      ),
    );

    expect(errorMessage(invalidDirection)).toContain(
      'transaction requires a CREDIT wallet ledger entry',
    );
    expect(errorMessage(invalidAmount)).toContain(
      'wallet ledger amount differs from transaction amount',
    );
    expect(await countLedgerEntries(wallet.id, WagerTransactionKind.Win)).toBe(
      1,
    );
    await expectReconciled(wallet.id);
  });

  it('reverte o crédito WIN quando a gravação da outbox falha', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const existingOutboxId = await findOpeningOutboxId(wallet.id);
    const useCase = createUseCase(
      getOrm(),
      new SequenceIdGenerator([
        randomUUID(),
        randomUUID(),
        existingOutboxId,
        randomUUID(),
        randomUUID(),
      ]),
    );

    const error = await captureRejection(
      useCase.execute(
        wagerInput(WagerTransactionKind.Win, wallet.id, playerId, '25.00'),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect(await walletState(wallet.id)).toEqual({
      balance: '100.00',
      version: 1,
    });
    expect(await countTransactions(wallet.id, WagerTransactionKind.Win)).toBe(
      0,
    );
    expect(await countLedgerEntries(wallet.id, WagerTransactionKind.Win)).toBe(
      0,
    );
    await expectReconciled(wallet.id);
  });

  it('devolve no replay de WIN o saldo histórico sem duplicar o crédito', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const useCase = createUseCase(getOrm());
    const originalInput = wagerInput(
      WagerTransactionKind.Win,
      wallet.id,
      playerId,
      '25.00',
    );
    const first = await useCase.execute(originalInput);

    await useCase.execute(
      wagerInput(WagerTransactionKind.Win, wallet.id, playerId, '10.00'),
    );
    const replay = await useCase.execute(originalInput);

    expect(replay).toEqual({
      ...first,
      idempotentReplay: true,
    });
    expect(replay.balance).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(await walletState(wallet.id)).toEqual({
      balance: '135.00',
      version: 3,
    });
    expect(await countTransactions(wallet.id, WagerTransactionKind.Win)).toBe(
      2,
    );
    expect(await countLedgerEntries(wallet.id, WagerTransactionKind.Win)).toBe(
      2,
    );
    await expectReconciled(wallet.id);
  });

  it('rejeita a mesma identidade externa com outra chave de idempotência', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const useCase = createUseCase(getOrm());
    const input = wagerInput(
      WagerTransactionKind.Win,
      wallet.id,
      playerId,
      '25.00',
    );

    await useCase.execute(input);
    const error = await captureRejection(
      useCase.execute({ ...input, idempotencyKey: `other:${randomUUID()}` }),
    );

    expect(error).toBeInstanceOf(ExternalTransactionConflictError);
    expect(await walletState(wallet.id)).toEqual({
      balance: '125.00',
      version: 2,
    });
    expect(await countTransactions(wallet.id, WagerTransactionKind.Win)).toBe(
      1,
    );
    await expectReconciled(wallet.id);
  });

  it('processa um único crédito para 50 WIN duplicadas em três processos', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const input = wagerInput(
      WagerTransactionKind.Win,
      wallet.id,
      playerId,
      '10.00',
    );
    const groups = await Promise.all([
      runWagerWorker(input, 17),
      runWagerWorker(input, 17),
      runWagerWorker(input, 16),
    ]);
    const results = groups.flat();

    expect(results).toHaveLength(50);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(
      results.filter((result) => result.idempotentReplay === false),
    ).toHaveLength(1);
    expect(await walletState(wallet.id)).toEqual({
      balance: '110.00',
      version: 2,
    });
    expect(await countTransactions(wallet.id, WagerTransactionKind.Win)).toBe(
      1,
    );
    expect(await countLedgerEntries(wallet.id, WagerTransactionKind.Win)).toBe(
      1,
    );
    await expectReconciled(wallet.id);
  }, 15_000);

  it('serializa créditos WIN distintos sem perder atualizações', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const useCases = await independentUseCases();

    const results = await Promise.all([
      requiredUseCase(useCases, 0).execute(
        wagerInput(WagerTransactionKind.Win, wallet.id, playerId, '10.00'),
      ),
      requiredUseCase(useCases, 1).execute(
        wagerInput(WagerTransactionKind.Win, wallet.id, playerId, '20.00'),
      ),
    ]);

    expect(
      results.every(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toBe(true);
    expect(await walletState(wallet.id)).toEqual({
      balance: '130.00',
      version: 3,
    });
    expect(await countLedgerEntries(wallet.id, WagerTransactionKind.Win)).toBe(
      2,
    );
    await expectReconciled(wallet.id);
  });
});

async function openWallet(
  playerId: string,
  amount: string,
): Promise<{ id: string }> {
  return new OpenWalletUseCase(
    new MikroOrmWalletOpeningRepository(getOrm().em.fork()),
    new UuidGenerator(),
    new SystemClock(),
  ).execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
}

function createUseCase(
  instance: MikroORM,
  idGenerator: IdGenerator = new UuidGenerator(),
): ProcessWagerTransactionUseCase {
  return new ProcessWagerTransactionUseCase(
    new MikroOrmWagerTransactionProcessor(instance.em.fork()),
    idGenerator,
    new SystemClock(),
    new Sha256PayloadHasher(),
  );
}

async function independentUseCases(): Promise<
  ProcessWagerTransactionUseCase[]
> {
  const instances = await Promise.all([
    createWalletTestOrm(schemaName, false),
    createWalletTestOrm(schemaName, false),
    createWalletTestOrm(schemaName, false),
  ]);
  secondaryOrms.push(...instances);

  return instances.map((instance) => createUseCase(instance));
}

function requiredUseCase(
  useCases: ProcessWagerTransactionUseCase[],
  index: number,
): ProcessWagerTransactionUseCase {
  const useCase = useCases[index % useCases.length];

  if (useCase === undefined) {
    throw new Error('Caso de uso WIN concorrente não encontrado.');
  }

  return useCase;
}

function wagerInput(
  kind: ProcessableWagerTransactionKind,
  walletId: string,
  playerId: string,
  amount: string,
  externalTransactionId = randomUUID(),
): ProcessWagerTransactionInput {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function walletState(walletId: string): Promise<WalletRow | undefined> {
  const rows = await connection().execute<WalletRow[]>(
    `select "balance", "version" from "${schemaName}"."wallets" where "id" = ?`,
    [walletId],
  );

  return rows[0];
}

async function transactionState(
  transactionId: string,
): Promise<TransactionRow | undefined> {
  const rows = await connection().execute<TransactionRow[]>(
    `select "kind", "status", "result_balance" as "resultBalance" from "${schemaName}"."wager_transactions" where "id" = ?`,
    [transactionId],
  );

  return rows[0];
}

async function ledgerState(
  transactionId: string,
): Promise<LedgerRow | undefined> {
  const rows = await connection().execute<LedgerRow[]>(
    `select "direction", "amount", "balance_before" as "balanceBefore", "balance_after" as "balanceAfter" from "${schemaName}"."wallet_ledger_entries" where "transaction_id" = ?`,
    [transactionId],
  );

  return rows[0];
}

async function transactionOutboxTypes(
  transactionId: string,
): Promise<string[]> {
  const rows = await connection().execute<Array<{ eventType: string }>>(
    `select "event_type" as "eventType" from "${schemaName}"."outbox_messages" where "payload"->>'correlationId' = ? order by "event_type"`,
    [transactionId],
  );

  return rows.map((row) => row.eventType);
}

async function findOpeningOutboxId(walletId: string): Promise<string> {
  const rows = await connection().execute<Array<{ id: string }>>(
    `select "id" from "${schemaName}"."outbox_messages" where "payload"->'data'->>'walletId' = ? limit 1`,
    [walletId],
  );
  const id = rows[0]?.id;

  if (id === undefined) {
    throw new Error(
      'Evento de abertura não encontrado para o teste de rollback.',
    );
  }

  return id;
}

async function countTransactions(
  walletId: string,
  kind: WagerTransactionKind,
): Promise<number> {
  const rows = await connection().execute<Array<{ count: number }>>(
    `select count(*)::int as "count" from "${schemaName}"."wager_transactions" where "wallet_id" = ? and "kind" = ?`,
    [walletId, kind],
  );

  return rows[0]?.count ?? 0;
}

async function countLedgerEntries(
  walletId: string,
  kind: WagerTransactionKind,
): Promise<number> {
  const rows = await connection().execute<Array<{ count: number }>>(
    `select count(*)::int as "count" from "${schemaName}"."wallet_ledger_entries" l join "${schemaName}"."wager_transactions" t on t.id = l.transaction_id where l.wallet_id = ? and t.kind = ?`,
    [walletId, kind],
  );

  return rows[0]?.count ?? 0;
}

async function expectReconciled(walletId: string): Promise<void> {
  const rows = await connection().execute<
    Array<{ ledgerBalance: string; walletBalance: string }>
  >(
    `
      select
        w.balance as "walletBalance",
        coalesce(sum(case l.direction when 'CREDIT' then l.amount when 'DEBIT' then -l.amount end), 0)::numeric(20, 2) as "ledgerBalance"
      from "${schemaName}"."wallets" w
      left join "${schemaName}"."wallet_ledger_entries" l on l.wallet_id = w.id
      where w.id = ?
      group by w.id
    `,
    [walletId],
  );

  expect(rows[0]?.walletBalance).toBe(rows[0]?.ledgerBalance);
}

async function runWagerWorker(
  input: ProcessWagerTransactionInput,
  attempts: number,
): Promise<WorkerResult[]> {
  const workerPath = fileURLToPath(
    new URL('./fixtures/wager-process-worker.ts', import.meta.url),
  );
  const child = Bun.spawn([process.execPath, workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WAGER_WORKER_SCHEMA: schemaName,
      WAGER_WORKER_INPUT: JSON.stringify(input),
      WAGER_WORKER_ATTEMPTS: attempts.toString(),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Worker WIN terminou com código ${exitCode}: ${stderr}`);
  }

  return JSON.parse(stdout) as WorkerResult[];
}

function connection(): PostgreSqlConnection {
  return getOrm().em.getConnection();
}

function getOrm(): MikroORM {
  if (orm === undefined) {
    throw new Error('O ORM WIN/LOSS de teste não foi inicializado.');
  }

  return orm;
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
  return error instanceof Error ? error.message : String(error);
}

class SequenceIdGenerator implements IdGenerator {
  public constructor(private readonly ids: string[]) {}

  public generate(): string {
    const id = this.ids.shift();

    if (id === undefined) {
      throw new Error('A sequência de IDs do teste WIN foi esgotada.');
    }

    return id;
  }
}
