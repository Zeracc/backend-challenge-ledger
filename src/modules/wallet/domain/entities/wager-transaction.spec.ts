import { describe, expect, it } from 'bun:test';

import { InvalidOpeningTransactionError } from '../errors/wallet.errors.js';
import { Money } from '../value-objects/money.js';
import {
  WagerTransaction,
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
    transaction.processedAt.setUTCFullYear(2031);

    expect(transaction.processedAt).toEqual(createdAt);
  });
});
