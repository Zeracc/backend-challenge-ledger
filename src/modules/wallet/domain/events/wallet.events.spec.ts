import { describe, expect, it } from 'bun:test';

import { WagerTransactionKind } from '../entities/wager-transaction.js';
import { LedgerDirection } from '../entities/wallet-ledger-entry.js';
import {
  WagerTransactionProcessedEvent,
  WalletBalanceChangedEvent,
} from './wallet.events.js';

const occurredAt = new Date('2026-09-04T12:00:00.000Z');

describe('wallet integration events', () => {
  it('protege os dados de saldo contra mutacao externa', () => {
    const balanceAfter = { amount: '10.00', currency: 'BRL' };
    const event = new WalletBalanceChangedEvent({
      eventId: 'event-id',
      aggregateId: 'wallet-id',
      correlationId: 'transaction-id',
      occurredAt,
      data: {
        walletId: 'wallet-id',
        playerId: 'player-id',
        transactionId: 'transaction-id',
        direction: LedgerDirection.Credit,
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter,
        walletVersion: 1,
      },
    });

    balanceAfter.amount = '999.00';

    expect(event.data.balanceAfter.amount).toBe('10.00');
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.balanceAfter)).toBe(true);
  });

  it('gera envelope estavel e protege os dados da transacao', () => {
    const money = { amount: '10.00', currency: 'BRL' };
    const inputOccurredAt = new Date(occurredAt);
    const event = new WagerTransactionProcessedEvent({
      eventId: 'event-id',
      aggregateId: 'transaction-id',
      correlationId: 'transaction-id',
      occurredAt: inputOccurredAt,
      data: {
        transactionId: 'transaction-id',
        walletId: 'wallet-id',
        playerId: 'player-id',
        kind: WagerTransactionKind.Opening,
        money,
        balanceAfter: { amount: '10.00', currency: 'BRL' },
      },
    });

    money.amount = '999.00';
    inputOccurredAt.setUTCFullYear(2030);

    expect(event.toJSON()).toEqual({
      eventId: 'event-id',
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: 'transaction-id',
      correlationId: 'transaction-id',
      occurredAt: '2026-09-04T12:00:00.000Z',
      data: {
        transactionId: 'transaction-id',
        walletId: 'wallet-id',
        playerId: 'player-id',
        kind: WagerTransactionKind.Opening,
        money: { amount: '10.00', currency: 'BRL' },
        balanceAfter: { amount: '10.00', currency: 'BRL' },
      },
    });
    expect(Object.isFrozen(event.data.money)).toBe(true);
  });
});
