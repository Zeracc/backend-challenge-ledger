import { describe, expect, it } from 'bun:test';

import { NegativeInitialBalanceError } from '../errors/wallet.errors.js';
import { Money } from '../value-objects/money.js';
import { Wallet } from './wallet.js';

describe('Wallet', () => {
  const openedAt = new Date('2026-09-04T12:00:00.000Z');

  it('abre uma wallet com versão inicial 1 e moeda derivada do saldo', () => {
    const wallet = Wallet.open({
      id: 'wallet-id',
      playerId: 'player-id',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      openedAt,
    });

    expect(wallet.id).toBe('wallet-id');
    expect(wallet.playerId).toBe('player-id');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  it('permite saldo inicial zero', () => {
    const wallet = Wallet.open({
      id: 'wallet-id',
      playerId: 'player-id',
      initialBalance: Money.zero('BRL'),
      openedAt,
    });

    expect(wallet.balance.isZero()).toBe(true);
  });

  it('rejeita saldo inicial negativo produzido por uma operação de domínio', () => {
    const negativeBalance = Money.zero('BRL').subtract(
      Money.from({ amount: '0.01', currency: 'BRL' }),
    );

    expect(() =>
      Wallet.open({
        id: 'wallet-id',
        playerId: 'player-id',
        initialBalance: negativeBalance,
        openedAt,
      }),
    ).toThrow(NegativeInitialBalanceError);
  });

  it('protege as datas internas contra mutação externa', () => {
    const inputDate = new Date(openedAt);
    const wallet = Wallet.open({
      id: 'wallet-id',
      playerId: 'player-id',
      initialBalance: Money.zero('BRL'),
      openedAt: inputDate,
    });

    inputDate.setUTCFullYear(2030);
    wallet.createdAt.setUTCFullYear(2031);

    expect(wallet.createdAt).toEqual(openedAt);
  });
});
