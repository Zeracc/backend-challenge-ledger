import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM, PostgreSqlConnection } from '@mikro-orm/postgresql';

import type {
  ProcessWagerTransactionUseCase,
  ProcessWagerTransactionInput,
  ProcessableWagerTransactionKind,
} from '../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { ExternalTransactionConflictError } from '../../src/modules/wallet/domain/errors/wallet.errors.js';
import type { IdGenerator } from '../../src/shared/application/ports/id-generator.js';
import {
  SequenceIdGenerator,
  WagerTestContext,
  captureRejection,
  errorMessage,
} from './support/wager-test-context.js';

const schemaName = `win_loss_test_${randomUUID().replaceAll('-', '')}`;
const context = new WagerTestContext(schemaName);

describe('WIN and LOSS processing with PostgreSQL', () => {
  beforeAll(async () => context.start());
  afterAll(async () => context.stop());

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
    expect(await transactionState(result.transactionId)).toMatchObject({
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
    expect(await transactionState(result.transactionId)).toMatchObject({
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
  return context.openWallet(playerId, amount);
}

function createUseCase(
  instance: MikroORM,
  idGenerator?: IdGenerator,
): ProcessWagerTransactionUseCase {
  return context.createUseCase(instance, idGenerator);
}

async function independentUseCases(): Promise<
  ProcessWagerTransactionUseCase[]
> {
  return context.independentUseCases(3);
}

function requiredUseCase(
  useCases: ProcessWagerTransactionUseCase[],
  index: number,
): ProcessWagerTransactionUseCase {
  return context.requiredUseCase(useCases, index);
}

function wagerInput(
  kind: ProcessableWagerTransactionKind,
  walletId: string,
  playerId: string,
  amount: string,
  externalTransactionId = randomUUID(),
): ProcessWagerTransactionInput {
  return context.wagerInput(kind, walletId, playerId, amount, {
    externalTransactionId,
  });
}

const walletState = context.walletState.bind(context);
const transactionState = context.transactionState.bind(context);
const ledgerState = context.ledgerState.bind(context);
const transactionOutboxTypes = context.transactionOutboxTypes.bind(context);
const findOpeningOutboxId = context.findOpeningOutboxId.bind(context);

async function countTransactions(
  walletId: string,
  kind: WagerTransactionKind,
): Promise<number> {
  return context.countTransactions(walletId, kind);
}

async function countLedgerEntries(
  walletId: string,
  kind: WagerTransactionKind,
): Promise<number> {
  return context.countLedgerEntries(walletId, kind);
}

const expectReconciled = context.expectReconciled.bind(context);

async function runWagerWorker(
  input: ProcessWagerTransactionInput,
  attempts: number,
): ReturnType<WagerTestContext['runWagerWorker']> {
  return context.runWagerWorker(input, attempts);
}

function connection(): PostgreSqlConnection {
  return context.connection();
}

function getOrm(): MikroORM {
  return context.getOrm();
}
