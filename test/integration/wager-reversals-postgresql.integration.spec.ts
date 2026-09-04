import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  WagerFailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wallet/domain/entities/wager-transaction.js';
import { IdempotencyConflictError } from '../../src/modules/wallet/domain/errors/wallet.errors.js';
import {
  SequenceIdGenerator,
  WagerTestContext,
  captureRejection,
  errorMessage,
} from './support/wager-test-context.js';

const context = new WagerTestContext(
  `reversal_test_${randomUUID().replaceAll('-', '')}`,
);

describe('REFUND, ROLLBACK e referências com PostgreSQL', () => {
  beforeAll(async () => context.start());
  afterAll(async () => context.stop());

  it('credita REFUND integral de BET e registra a referência resolvida', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const betInput = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      playerId,
      '25.00',
    );
    const bet = await context.createUseCase().execute(betInput);
    const refund = await context
      .createUseCase()
      .execute(
        context.wagerInput(
          WagerTransactionKind.Refund,
          wallet.id,
          playerId,
          '25.00',
          { referenceExternalTransactionId: betInput.externalTransactionId },
        ),
      );

    expect(refund).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await context.transactionState(refund.transactionId)).toMatchObject({
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.Processed,
      referenceExternalTransactionId: betInput.externalTransactionId,
      referenceTransactionId: bet.transactionId,
    });
    expect(await context.ledgerState(refund.transactionId)).toEqual({
      direction: 'CREDIT',
      amount: '25.00',
      balanceBefore: '75.00',
      balanceAfter: '100.00',
    });
    expect(await context.transactionOutboxTypes(refund.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await context.expectReconciled(wallet.id);
  });

  it('faz ROLLBACK com o efeito inverso de BET, WIN e REFUND', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const useCase = context.createUseCase();
    const betInput = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      playerId,
      '10.00',
    );
    await useCase.execute(betInput);
    const rollbackBet = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Rollback,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: betInput.externalTransactionId },
      ),
    );
    const winInput = context.wagerInput(
      WagerTransactionKind.Win,
      wallet.id,
      playerId,
      '20.00',
    );
    await useCase.execute(winInput);
    const rollbackWin = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Rollback,
        wallet.id,
        playerId,
        '20.00',
        { referenceExternalTransactionId: winInput.externalTransactionId },
      ),
    );
    const secondBetInput = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      playerId,
      '15.00',
    );
    await useCase.execute(secondBetInput);
    const refundInput = context.wagerInput(
      WagerTransactionKind.Refund,
      wallet.id,
      playerId,
      '15.00',
      { referenceExternalTransactionId: secondBetInput.externalTransactionId },
    );
    await useCase.execute(refundInput);
    const rollbackRefund = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Rollback,
        wallet.id,
        playerId,
        '15.00',
        { referenceExternalTransactionId: refundInput.externalTransactionId },
      ),
    );

    expect(await context.ledgerState(rollbackBet.transactionId)).toMatchObject({
      direction: 'CREDIT',
    });
    expect(await context.ledgerState(rollbackWin.transactionId)).toMatchObject({
      direction: 'DEBIT',
    });
    expect(
      await context.ledgerState(rollbackRefund.transactionId),
    ).toMatchObject({ direction: 'DEBIT' });
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '85.00',
      version: 8,
    });
    await context.expectReconciled(wallet.id);
  });

  it('persiste referência ausente como PENDING_REFERENCE e repete o resultado', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const input = context.wagerInput(
      WagerTransactionKind.Refund,
      wallet.id,
      playerId,
      '25.00',
      { referenceExternalTransactionId: 'bet-ainda-inexistente' },
    );
    const useCase = context.createUseCase();
    const first = await useCase.execute(input);
    const replay = await useCase.execute(input);
    const conflict = await captureRejection(
      useCase.execute({
        ...input,
        referenceExternalTransactionId: 'outra-referencia',
      }),
    );

    expect(first).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(conflict).toBeInstanceOf(IdempotencyConflictError);
    expect(await context.ledgerState(first.transactionId)).toBeUndefined();
    expect(await context.transactionOutboxTypes(first.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '100.00',
      version: 1,
    });
    await context.expectReconciled(wallet.id);
  });

  it('aceita WIN referenciada a BET e deixa WIN pendente quando ela ainda não existe', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const useCase = context.createUseCase();
    const betInput = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      playerId,
      '10.00',
    );
    const bet = await useCase.execute(betInput);
    const referencedWin = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Win,
        wallet.id,
        playerId,
        '30.00',
        { referenceExternalTransactionId: betInput.externalTransactionId },
      ),
    );
    const pendingWin = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Win,
        wallet.id,
        playerId,
        '5.00',
        { referenceExternalTransactionId: 'bet-futura' },
      ),
    );

    expect(referencedWin.status).toBe(WagerTransactionStatus.Processed);
    expect(
      await context.transactionState(referencedWin.transactionId),
    ).toMatchObject({ referenceTransactionId: bet.transactionId });
    expect(pendingWin.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '120.00',
      version: 3,
    });
    await context.expectReconciled(wallet.id);
  });

  it('rejeita referência fora do escopo, tipo inválido e valor parcial sem movimentar saldo', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const otherPlayerId = randomUUID();
    const otherWallet = await context.openWallet(otherPlayerId, '100.00');
    const useCase = context.createUseCase();
    const foreignBet = context.wagerInput(
      WagerTransactionKind.Bet,
      otherWallet.id,
      otherPlayerId,
      '10.00',
    );
    await useCase.execute(foreignBet);
    const localWin = context.wagerInput(
      WagerTransactionKind.Win,
      wallet.id,
      playerId,
      '10.00',
    );
    await useCase.execute(localWin);
    const localBet = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      playerId,
      '20.00',
    );
    await useCase.execute(localBet);
    const balanceBefore = await context.walletState(wallet.id);

    const scopeMismatch = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Refund,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: foreignBet.externalTransactionId },
      ),
    );
    const invalidKind = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Refund,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: localWin.externalTransactionId },
      ),
    );
    const amountMismatch = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Refund,
        wallet.id,
        playerId,
        '19.00',
        { referenceExternalTransactionId: localBet.externalTransactionId },
      ),
    );

    expect(scopeMismatch.failureCode).toBe(
      WagerFailureCode.ReferenceScopeMismatch,
    );
    expect(invalidKind.failureCode).toBe(WagerFailureCode.InvalidReferenceKind);
    expect(amountMismatch.failureCode).toBe(
      WagerFailureCode.ReferenceAmountMismatch,
    );
    expect(await context.walletState(wallet.id)).toEqual(balanceBefore);
    expect(
      await context.ledgerState(scopeMismatch.transactionId),
    ).toBeUndefined();
    expect(
      await context.ledgerState(invalidKind.transactionId),
    ).toBeUndefined();
    expect(
      await context.ledgerState(amountMismatch.transactionId),
    ).toBeUndefined();
    await context.expectReconciled(wallet.id);
  });

  it('serializa duas reversões do mesmo tipo e aplica somente uma', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const betInput = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      playerId,
      '25.00',
    );
    await context.createUseCase().execute(betInput);
    const useCases = await context.independentUseCases(2);
    const results = await Promise.all(
      useCases.map((useCase) =>
        useCase.execute(
          context.wagerInput(
            WagerTransactionKind.Refund,
            wallet.id,
            playerId,
            '25.00',
            { referenceExternalTransactionId: betInput.externalTransactionId },
          ),
        ),
      ),
    );

    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.failureCode === WagerFailureCode.DuplicateReversal,
      ),
    ).toHaveLength(1);
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '100.00',
      version: 3,
    });
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Refund),
    ).toBe(1);
    await context.expectReconciled(wallet.id);
  });

  it('mantém unicidade da reversão e direção do ROLLBACK como defesas do schema', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const useCase = context.createUseCase();
    const betInput = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      playerId,
      '10.00',
    );
    await useCase.execute(betInput);
    await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Refund,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: betInput.externalTransactionId },
      ),
    );
    const duplicate = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Refund,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: betInput.externalTransactionId },
      ),
    );
    const uniqueError = await captureRejection(
      context
        .connection()
        .execute(
          `update "${context.schemaName}"."wager_transactions" set "status" = 'PROCESSED', "failure_code" = null, "processed_at" = now() where "id" = ?`,
          [duplicate.transactionId],
        ),
    );
    const rollback = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Rollback,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: betInput.externalTransactionId },
      ),
    );
    const directionError = await captureRejection(
      context
        .connection()
        .execute(
          `insert into "${context.schemaName}"."wallet_ledger_entries" ("id", "wallet_id", "transaction_id", "direction", "amount", "currency", "balance_before", "balance_after", "created_at") values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '110.00', '100.00', now())`,
          [randomUUID(), wallet.id, rollback.transactionId],
        ),
    );

    expect(errorMessage(uniqueError)).toContain(
      'wager_transactions_processed_reversal_unique',
    );
    expect(errorMessage(directionError)).toContain(
      'ROLLBACK of BET requires a CREDIT wallet ledger entry',
    );
    await context.expectReconciled(wallet.id);
  });

  it('rejeita ROLLBACK de crédito sem saldo com failureCode específico', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '0.00');
    const useCase = context.createUseCase();
    const winInput = context.wagerInput(
      WagerTransactionKind.Win,
      wallet.id,
      playerId,
      '10.00',
    );
    await useCase.execute(winInput);
    await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Bet,
        wallet.id,
        playerId,
        '10.00',
      ),
    );
    const rollback = await useCase.execute(
      context.wagerInput(
        WagerTransactionKind.Rollback,
        wallet.id,
        playerId,
        '10.00',
        { referenceExternalTransactionId: winInput.externalTransactionId },
      ),
    );

    expect(rollback).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: WagerFailureCode.RollbackInsufficientFunds,
      balance: { amount: '0.00', currency: 'BRL' },
    });
    expect(await context.ledgerState(rollback.transactionId)).toBeUndefined();
    await context.expectReconciled(wallet.id);
  });

  it('reverte wallet, transação e ledger quando a outbox de REFUND falha', async () => {
    const playerId = randomUUID();
    const wallet = await context.openWallet(playerId, '100.00');
    const betInput = context.wagerInput(
      WagerTransactionKind.Bet,
      wallet.id,
      playerId,
      '25.00',
    );
    await context.createUseCase().execute(betInput);
    const existingOutboxId = await context.findOpeningOutboxId(wallet.id);
    const useCase = context.createUseCase(
      context.getOrm(),
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
        context.wagerInput(
          WagerTransactionKind.Refund,
          wallet.id,
          playerId,
          '25.00',
          { referenceExternalTransactionId: betInput.externalTransactionId },
        ),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect(await context.walletState(wallet.id)).toEqual({
      balance: '75.00',
      version: 2,
    });
    expect(
      await context.countTransactions(wallet.id, WagerTransactionKind.Refund),
    ).toBe(0);
    expect(
      await context.countLedgerEntries(wallet.id, WagerTransactionKind.Refund),
    ).toBe(0);
    await context.expectReconciled(wallet.id);
  });
});
