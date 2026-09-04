import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

import type {
  ProcessWagerTransactionUseCase,
  ProcessWagerTransactionInput,
} from '../../src/modules/wallet/application/use-cases/process-wager-transaction.js';
import {
  WagerFailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { IdempotencyConflictError } from '../../src/modules/wallet/domain/errors/wallet.errors.js';
import type { IdGenerator } from '../../src/shared/application/ports/id-generator.js';
import {
  SequenceIdGenerator,
  WagerTestContext,
  captureRejection,
} from './support/wager-test-context.js';

const context = new WagerTestContext(
  `bet_test_${randomUUID().replaceAll('-', '')}`,
);

describe('BET processing with PostgreSQL', () => {
  beforeAll(async () => context.start());
  afterAll(async () => context.stop());

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
  return context.openWallet(playerId, amount);
}

function createBetUseCase(
  instance: MikroORM,
  idGenerator?: IdGenerator,
): ProcessWagerTransactionUseCase {
  return context.createUseCase(instance, idGenerator);
}

async function threeIndependentUseCases(): Promise<
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

function betInput(
  walletId: string,
  playerId: string,
  amount: string,
): ProcessWagerTransactionInput {
  return context.wagerInput(
    WagerTransactionKind.Bet,
    walletId,
    playerId,
    amount,
  );
}

const walletState = context.walletState.bind(context);

async function countBetTransactions(walletId: string): Promise<number> {
  return context.countTransactions(walletId, WagerTransactionKind.Bet);
}

async function countBetLedgerEntries(walletId: string): Promise<number> {
  return context.countLedgerEntries(walletId, WagerTransactionKind.Bet);
}

async function countTransactionOutbox(transactionId: string): Promise<number> {
  return context.countTransactionOutbox(transactionId);
}

const findOpeningOutboxId = context.findOpeningOutboxId.bind(context);
const expectReconciled = context.expectReconciled.bind(context);

function getOrm(): MikroORM {
  return context.getOrm();
}

async function runBetWorker(
  input: ProcessWagerTransactionInput,
  attempts: number,
): ReturnType<WagerTestContext['runWagerWorker']> {
  return context.runWagerWorker(input, attempts);
}
