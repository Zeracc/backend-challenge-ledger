import { describe, expect, it } from 'bun:test';

import { InvalidLedgerEntryError } from '../errors/wallet.errors.js';
import { Money } from '../value-objects/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

describe('WalletLedgerEntry', () => {
  const createdAt = new Date('2026-09-04T12:00:00.000Z');

  it('cria um crédito quando a aritmética dos saldos fecha', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-id',
      walletId: 'wallet-id',
      transactionId: 'transaction-id',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceBefore: Money.zero('BRL'),
      balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }),
      createdAt,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('cria um débito quando a aritmética dos saldos fecha', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-id',
      walletId: 'wallet-id',
      transactionId: 'transaction-id',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '80.00', currency: 'BRL' }),
      createdAt,
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita lançamento cuja aritmética não fecha', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-id',
        walletId: 'wallet-id',
        transactionId: 'transaction-id',
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceBefore: Money.zero('BRL'),
        balanceAfter: Money.from({ amount: '99.99', currency: 'BRL' }),
        createdAt,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita valores em moedas diferentes', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-id',
        walletId: 'wallet-id',
        transactionId: 'transaction-id',
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }),
        createdAt,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
