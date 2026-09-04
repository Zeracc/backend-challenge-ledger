import { describe, expect, it } from 'bun:test';

import {
  InvalidOpeningTransactionError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../errors/wallet.errors.js';
import { Money } from '../value-objects/money.js';
import {
  WagerTransaction,
  WagerFailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateExternalTransactionProps,
} from './wager-transaction.js';

describe('WagerTransaction.createOpening', () => {
  const createdAt = new Date('2026-09-04T12:00:00.000Z');

  it('cria OPENING já processada para um saldo positivo', () => {
    const transaction = WagerTransaction.createOpening({
      id: 'transaction-id',
      walletId: 'wallet-id',
      playerId: 'player-id',
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
      createdAt,
    });

    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toEqual(createdAt);
  });

  it('rejeita OPENING sem movimentação positiva', () => {
    expect(() =>
      WagerTransaction.createOpening({
        id: 'transaction-id',
        walletId: 'wallet-id',
        playerId: 'player-id',
        money: Money.zero('BRL'),
        createdAt,
      }),
    ).toThrow(InvalidOpeningTransactionError);
  });

  it('protege as datas internas contra mutação externa', () => {
    const inputDate = new Date(createdAt);
    const transaction = WagerTransaction.createOpening({
      id: 'transaction-id',
      walletId: 'wallet-id',
      playerId: 'player-id',
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      createdAt: inputDate,
    });

    inputDate.setUTCFullYear(2030);
    const exposedProcessedAt = transaction.processedAt;

    if (exposedProcessedAt === undefined) {
      throw new Error('OPENING deveria possuir data de processamento.');
    }

    exposedProcessedAt.setUTCFullYear(2031);

    expect(transaction.processedAt).toEqual(createdAt);
  });
});

describe('WagerTransaction.createBet', () => {
  const createdAt = new Date('2026-09-04T12:00:00.000Z');

  function createBet(): WagerTransaction {
    return WagerTransaction.createBet({
      id: 'transaction-id',
      providerId: 'provider-a',
      externalTransactionId: 'external-id',
      idempotencyKey: 'provider-a:external-id',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-id',
      gameId: 'game-id',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt,
    });
  }

  it('nasce pendente e reconhece o hash do payload', () => {
    const transaction = createBet();

    expect(transaction.kind).toBe(WagerTransactionKind.Bet);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it('marca a aposta como processada com o saldo observado', () => {
    const transaction = createBet();
    const processedAt = new Date('2026-09-04T12:01:00.000Z');
    const balance = Money.from({ amount: '75.00', currency: 'BRL' });

    transaction.markProcessed(balance, processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.resultBalance?.equals(balance)).toBe(true);
    expect(transaction.processedAt).toEqual(processedAt);
    expect(transaction.isTerminal()).toBe(true);
  });

  it('rejeita a aposta com código estável e sem movimentar saldo', () => {
    const transaction = createBet();
    const balance = Money.from({ amount: '20.00', currency: 'BRL' });

    transaction.reject(WagerFailureCode.InsufficientFunds, balance);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(WagerFailureCode.InsufficientFunds);
    expect(transaction.resultBalance?.equals(balance)).toBe(true);
    expect(transaction.isTerminal()).toBe(true);
  });

  it('impede transição depois de um estado terminal', () => {
    const transaction = createBet();
    const balance = Money.from({ amount: '75.00', currency: 'BRL' });

    transaction.markProcessed(balance, createdAt);

    expect(() =>
      transaction.reject(WagerFailureCode.InsufficientFunds, balance),
    ).toThrow(InvalidTransactionStateError);
  });

  it('rejeita saldo resultante em moeda diferente', () => {
    const transaction = createBet();

    expect(() =>
      transaction.markProcessed(
        Money.from({ amount: '75.00', currency: 'USD' }),
        createdAt,
      ),
    ).toThrow(InvalidWagerTransactionError);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  it('rejeita valor zero e identidades vazias', () => {
    expect(() =>
      WagerTransaction.createBet({
        id: 'transaction-id',
        providerId: '',
        externalTransactionId: 'external-id',
        idempotencyKey: 'provider-a:external-id',
        payloadHash: 'a'.repeat(64),
        walletId: 'wallet-id',
        playerId: 'player-id',
        roundId: 'round-id',
        gameId: 'game-id',
        money: Money.zero('BRL'),
        createdAt,
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction WIN e LOSS', () => {
  const createdAt = new Date('2026-09-04T12:00:00.000Z');
  const commonProps = {
    id: 'transaction-id',
    providerId: 'provider-a',
    externalTransactionId: 'external-id',
    idempotencyKey: 'provider-a:external-id',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-id',
    playerId: 'player-id',
    roundId: 'round-id',
    gameId: 'game-id',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt,
  };

  it('cria WIN e LOSS pendentes com suas identidades externas', () => {
    const win = WagerTransaction.createWin(commonProps);
    const loss = WagerTransaction.createLoss({
      ...commonProps,
      id: 'loss-id',
      externalTransactionId: 'loss-external-id',
      idempotencyKey: 'provider-a:loss-external-id',
    });

    expect(win.kind).toBe(WagerTransactionKind.Win);
    expect(loss.kind).toBe(WagerTransactionKind.Loss);
    expect(win.status).toBe(WagerTransactionStatus.Pending);
    expect(loss.status).toBe(WagerTransactionStatus.Pending);
  });

  it('exige valor positivo em WIN e LOSS', () => {
    expect(() =>
      WagerTransaction.createWin({
        ...commonProps,
        money: Money.zero('BRL'),
      }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.createLoss({
        ...commonProps,
        money: Money.zero('BRL'),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction referências e reversões', () => {
  const createdAt = new Date('2026-09-04T12:00:00.000Z');
  const baseProps: CreateExternalTransactionProps = {
    id: 'transaction-id',
    providerId: 'provider-a',
    externalTransactionId: 'external-id',
    idempotencyKey: 'provider-a:external-id',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-id',
    playerId: 'player-id',
    roundId: 'round-id',
    gameId: 'game-id',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt,
  };

  function processedBet(
    overrides: Partial<CreateExternalTransactionProps> = {},
  ): WagerTransaction {
    const transaction = WagerTransaction.createBet({
      ...baseProps,
      externalTransactionId: 'reference-id',
      idempotencyKey: 'provider-a:reference-id',
      ...overrides,
    });
    transaction.markProcessed(
      Money.from({ amount: '75.00', currency: 'BRL' }),
      createdAt,
    );
    return transaction;
  }

  it('exige referência em reversões e a proíbe em BET e LOSS', () => {
    expect(() => WagerTransaction.createRefund(baseProps)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => WagerTransaction.createRollback(baseProps)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      WagerTransaction.createBet({
        ...baseProps,
        referenceExternalTransactionId: 'reference-id',
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('mantém saldo e identidade externa ao aguardar referência', () => {
    const transaction = WagerTransaction.createRefund({
      ...baseProps,
      referenceExternalTransactionId: 'reference-id',
    });
    const balance = Money.from({ amount: '75.00', currency: 'BRL' });

    transaction.markPendingReference(balance);

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.resultBalance?.equals(balance)).toBe(true);
    expect(transaction.referenceExternalTransactionId).toBe('reference-id');
    expect(transaction.isTerminal()).toBe(false);
  });

  it('valida escopo, estado, tipo e valor da referência com códigos estáveis', () => {
    const refund = WagerTransaction.createRefund({
      ...baseProps,
      referenceExternalTransactionId: 'reference-id',
    });
    const pendingBet = WagerTransaction.createBet({
      ...baseProps,
      id: 'pending-bet',
      externalTransactionId: 'reference-id',
      idempotencyKey: 'provider-a:reference-id',
    });
    const wrongScope = processedBet({ roundId: 'other-round' });
    const win = WagerTransaction.createWin({
      ...baseProps,
      id: 'win-id',
      externalTransactionId: 'reference-id',
      idempotencyKey: 'provider-a:reference-id',
    });
    win.markProcessed(
      Money.from({ amount: '100.00', currency: 'BRL' }),
      createdAt,
    );
    const otherAmount = processedBet({
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    expect(refund.referenceFailureFor(wrongScope)).toBe(
      WagerFailureCode.ReferenceScopeMismatch,
    );
    expect(refund.referenceFailureFor(pendingBet)).toBe(
      WagerFailureCode.ReferenceNotProcessed,
    );
    expect(refund.referenceFailureFor(win)).toBe(
      WagerFailureCode.InvalidReferenceKind,
    );
    expect(refund.referenceFailureFor(otherAmount)).toBe(
      WagerFailureCode.ReferenceAmountMismatch,
    );
    expect(refund.referenceFailureFor(processedBet())).toBeUndefined();
  });

  it('permite ROLLBACK integral de BET, WIN ou REFUND processado', () => {
    const rollback = WagerTransaction.createRollback({
      ...baseProps,
      referenceExternalTransactionId: 'reference-id',
    });
    const bet = processedBet();
    const win = WagerTransaction.createWin({
      ...baseProps,
      id: 'win-id',
      externalTransactionId: 'reference-id',
      idempotencyKey: 'provider-a:reference-id',
    });
    const refund = WagerTransaction.createRefund({
      ...baseProps,
      id: 'refund-id',
      externalTransactionId: 'reference-id',
      idempotencyKey: 'provider-a:reference-id',
      referenceExternalTransactionId: 'bet-id',
    });
    win.markProcessed(
      Money.from({ amount: '100.00', currency: 'BRL' }),
      createdAt,
    );
    refund.markProcessed(
      Money.from({ amount: '100.00', currency: 'BRL' }),
      createdAt,
      bet.id,
    );

    expect(rollback.referenceFailureFor(bet)).toBeUndefined();
    expect(rollback.referenceFailureFor(win)).toBeUndefined();
    expect(rollback.referenceFailureFor(refund)).toBeUndefined();
  });
});
