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
