import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM, PostgreSqlConnection } from '@mikro-orm/postgresql';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import { OpenWalletUseCase } from '../../src/modules/wallet/application/use-cases/open-wallet.js';
import {
  WagerFailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { IdempotencyConflictError } from '../../src/modules/wallet/domain/errors/wallet.errors.js';
import { MikroOrmWagerTransactionProcessor } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wager-transaction.processor.js';
import { MikroOrmWalletOpeningRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm/wallet-opening.repository.js';
import type { IdGenerator } from '../../src/shared/application/ports/id-generator.js';
import { SystemClock } from '../../src/shared/infrastructure/system/system-clock.js';
import { UuidGenerator } from '../../src/shared/infrastructure/system/uuid-generator.js';
import { Sha256PayloadHasher } from '../../src/shared/infrastructure/serialization/sha256-payload-hasher.js';
import { createWalletTestOrm } from './support/wallet-test-orm.js';

interface CountRow {
  count: number;
}

interface WalletRow {
  balance: string;
  version: number;
}

const schemaName = `bet_test_${randomUUID().replaceAll('-', '')}`;
const secondaryOrms: MikroORM[] = [];
let orm: MikroORM | undefined;

describe('BET processing with PostgreSQL', () => {
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

  it('debita a wallet e grava transação, ledger e dois eventos atomicamente', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const input = betInput(wallet.id, playerId, '25.00');

    const result = await createBetUseCase(getOrm()).execute(input);

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletState(wallet.id)).toEqual({
      balance: '75.00',
      version: 2,
    });
    expect(await countBetTransactions(wallet.id)).toBe(1);
    expect(await countBetLedgerEntries(wallet.id)).toBe(1);
    expect(await countTransactionOutbox(result.transactionId)).toBe(2);
    await expectReconciled(wallet.id);
  });

  it('devolve o resultado original no replay sem repetir o débito', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const input = betInput(wallet.id, playerId, '25.00');
    const useCase = createBetUseCase(getOrm());

    const first = await useCase.execute(input);
    const replay = await useCase.execute(input);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(await walletState(wallet.id)).toEqual({
      balance: '75.00',
      version: 2,
    });
    expect(await countBetTransactions(wallet.id)).toBe(1);
    expect(await countBetLedgerEntries(wallet.id)).toBe(1);
    expect(await countTransactionOutbox(first.transactionId)).toBe(2);
    await expectReconciled(wallet.id);
  });

  it('rejeita a mesma chave de idempotência com payload diferente', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const input = betInput(wallet.id, playerId, '25.00');
    const useCase = createBetUseCase(getOrm());

    await useCase.execute(input);

    const error = await captureRejection(
      useCase.execute({
        ...input,
        money: { amount: '26.00', currency: 'BRL' },
      }),
    );

    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(await walletState(wallet.id)).toMatchObject({ balance: '75.00' });
    expect(await countBetTransactions(wallet.id)).toBe(1);
    await expectReconciled(wallet.id);
  });

  it('persiste rejeição auditável quando o saldo é insuficiente', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '20.00');

    const result = await createBetUseCase(getOrm()).execute(
      betInput(wallet.id, playerId, '25.00'),
    );

    expect(result).toEqual({
      transactionId: result.transactionId,
      status: WagerTransactionStatus.Rejected,
      balance: { amount: '20.00', currency: 'BRL' },
      failureCode: WagerFailureCode.InsufficientFunds,
      idempotentReplay: false,
    });
    expect(await walletState(wallet.id)).toEqual({
      balance: '20.00',
      version: 1,
    });
    expect(await countBetTransactions(wallet.id)).toBe(1);
    expect(await countBetLedgerEntries(wallet.id)).toBe(0);
    expect(await countTransactionOutbox(result.transactionId)).toBe(1);
    await expectReconciled(wallet.id);
  });

  it('reverte wallet e transação quando a gravação da outbox falha', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const existingOutboxId = await findOpeningOutboxId(wallet.id);
    const useCase = createBetUseCase(
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
      useCase.execute(betInput(wallet.id, playerId, '25.00')),
    );

    expect(error).toBeInstanceOf(Error);
    expect(await walletState(wallet.id)).toEqual({
      balance: '100.00',
      version: 1,
    });
    expect(await countBetTransactions(wallet.id)).toBe(0);
    expect(await countBetLedgerEntries(wallet.id)).toBe(0);
    await expectReconciled(wallet.id);
  });

  it('processa uma única vez 50 apostas duplicadas em três processos', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const input = betInput(wallet.id, playerId, '25.00');

    const workerResults = await Promise.all([
      runBetWorker(input, 17),
      runBetWorker(input, 17),
      runBetWorker(input, 16),
    ]);
    const results = workerResults.flat();

    expect(results).toHaveLength(50);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(
      49,
    );
    expect(await walletState(wallet.id)).toMatchObject({ balance: '75.00' });
    expect(await countBetTransactions(wallet.id)).toBe(1);
    expect(await countBetLedgerEntries(wallet.id)).toBe(1);
    await expectReconciled(wallet.id);
  }, 15_000);

  it('mantém o replay depois que o processo original termina', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const input = betInput(wallet.id, playerId, '25.00');

    const first = await runBetWorker(input, 1);
    const replay = await runBetWorker(input, 1);
    const firstResult = first[0];

    if (firstResult === undefined) {
      throw new Error('O primeiro worker não devolveu resultado.');
    }

    expect(firstResult.idempotentReplay).toBe(false);
    expect(replay[0]).toEqual({ ...firstResult, idempotentReplay: true });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '75.00' });
    expect(await countBetLedgerEntries(wallet.id)).toBe(1);
    await expectReconciled(wallet.id);
  }, 15_000);

  it('serializa duas apostas de 80 e impede saldo negativo', async () => {
    const playerId = randomUUID();
    const wallet = await openWallet(playerId, '100.00');
    const useCases = await threeIndependentUseCases();

    const results = await Promise.all([
      requiredUseCase(useCases, 0).execute(
        betInput(wallet.id, playerId, '80.00'),
      ),
      requiredUseCase(useCases, 1).execute(
        betInput(wallet.id, playerId, '80.00'),
      ),
    ]);

    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(1);
    expect(await walletState(wallet.id)).toEqual({
      balance: '20.00',
      version: 2,
    });
    expect(await countBetTransactions(wallet.id)).toBe(2);
    expect(await countBetLedgerEntries(wallet.id)).toBe(1);
    await expectReconciled(wallet.id);
  });

  it('permite que wallets diferentes avancem em paralelo', async () => {
    const firstPlayerId = randomUUID();
    const secondPlayerId = randomUUID();
    const [firstWallet, secondWallet] = await Promise.all([
      openWallet(firstPlayerId, '100.00'),
      openWallet(secondPlayerId, '100.00'),
    ]);
    const useCases = await threeIndependentUseCases();

    const results = await Promise.all([
      requiredUseCase(useCases, 0).execute(
        betInput(firstWallet.id, firstPlayerId, '10.00'),
      ),
      requiredUseCase(useCases, 1).execute(
        betInput(secondWallet.id, secondPlayerId, '20.00'),
      ),
    ]);

    expect(
      results.every(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toBe(true);
    expect(await walletState(firstWallet.id)).toMatchObject({
      balance: '90.00',
    });
    expect(await walletState(secondWallet.id)).toMatchObject({
      balance: '80.00',
    });
    await expectReconciled(firstWallet.id);
    await expectReconciled(secondWallet.id);
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

function createBetUseCase(
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

async function threeIndependentUseCases(): Promise<
  ProcessWagerTransactionUseCase[]
> {
  const instances = await Promise.all([
    createWalletTestOrm(schemaName, false),
    createWalletTestOrm(schemaName, false),
    createWalletTestOrm(schemaName, false),
  ]);
  secondaryOrms.push(...instances);

  return instances.map((instance) => createBetUseCase(instance));
}

function requiredUseCase(
  useCases: ProcessWagerTransactionUseCase[],
  index: number,
): ProcessWagerTransactionUseCase {
  const useCase = useCases[index % useCases.length];

  if (useCase === undefined) {
    throw new Error('Caso de uso BET concorrente não encontrado.');
  }

  return useCase;
}

function betInput(
  walletId: string,
  playerId: string,
  amount: string,
): ProcessWagerTransactionInput {
  const externalTransactionId = randomUUID();

  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
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

async function countBetTransactions(walletId: string): Promise<number> {
  return count(
    `select count(*)::int as "count" from "${schemaName}"."wager_transactions" where "wallet_id" = ? and "kind" = 'BET'`,
    [walletId],
  );
}

async function countBetLedgerEntries(walletId: string): Promise<number> {
  return count(
    `select count(*)::int as "count" from "${schemaName}"."wallet_ledger_entries" l join "${schemaName}"."wager_transactions" t on t.id = l.transaction_id where l.wallet_id = ? and t.kind = 'BET'`,
    [walletId],
  );
}

async function countTransactionOutbox(transactionId: string): Promise<number> {
  return count(
    `select count(*)::int as "count" from "${schemaName}"."outbox_messages" where "payload"->>'correlationId' = ?`,
    [transactionId],
  );
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

async function count(query: string, parameters: unknown[]): Promise<number> {
  const rows = await connection().execute<CountRow[]>(query, parameters);

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

function connection(): PostgreSqlConnection {
  return getOrm().em.getConnection();
}

function getOrm(): MikroORM {
  if (orm === undefined) {
    throw new Error('O ORM BET de teste não foi inicializado.');
  }

  return orm;
}

interface WorkerResult {
  transactionId: string;
  idempotentReplay: boolean;
}

async function runBetWorker(
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
    throw new Error(`Worker BET terminou com código ${exitCode}: ${stderr}`);
  }

  return JSON.parse(stdout) as WorkerResult[];
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }

  throw new Error('A operação de teste deveria ter falhado.');
}

class SequenceIdGenerator implements IdGenerator {
  public constructor(private readonly ids: string[]) {}

  public generate(): string {
    const id = this.ids.shift();

    if (id === undefined) {
      throw new Error('A sequência de IDs do teste BET foi esgotada.');
    }

    return id;
  }
}
