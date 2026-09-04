import { describe, expect, it } from 'bun:test';

import {
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  MoneyAmountOutOfRangeError,
  MoneyCurrencyMismatchError,
} from '../errors/money.errors.js';
import { Money } from './money.js';

describe('Money', () => {
  it('cria e serializa um valor monetário canônico', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });

    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(money.toString()).toBe('25.00');
    expect(Object.isFrozen(money)).toBe(true);
  });

  it.each([
    '',
    'NaN',
    'Infinity',
    '1e2',
    '-1.00',
    '1',
    '1.0',
    '1.001',
    '01.00',
    ' 1.00',
    '1.00 ',
  ])('rejeita a entrada monetária inválida %s', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
      InvalidMoneyAmountError,
    );
  });

  it('rejeita uma entrada acima da precisão planejada', () => {
    expect(() =>
      Money.from({ amount: '1000000000000000000.00', currency: 'BRL' }),
    ).toThrow(InvalidMoneyAmountError);
  });

  it.each(['', 'BR', 'BRLL', 'brl', ' BRL', 'BRL '])(
    'rejeita a moeda inválida %s',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidCurrencyError,
      );
    },
  );

  it('cria zero com escala fixa', () => {
    const zero = Money.zero('BRL');

    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  it('soma valores sem aritmética de ponto flutuante', () => {
    const first = Money.from({ amount: '0.10', currency: 'BRL' });
    const second = Money.from({ amount: '0.20', currency: 'BRL' });

    const result = first.add(second);

    expect(result.toString()).toBe('0.30');
    expect(first.toString()).toBe('0.10');
    expect(result).not.toBe(first);
  });

  it('subtrai e permite resultado negativo somente pela operação interna', () => {
    const result = Money.from({ amount: '10.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '25.00', currency: 'BRL' }),
    );

    expect(result.toString()).toBe('-15.00');
    expect(result.isNegative()).toBe(true);
  });

  it('nega valores sem produzir zero negativo', () => {
    const negative = Money.from({ amount: '2.50', currency: 'BRL' }).negate();
    const zero = Money.zero('BRL').negate();

    expect(negative.toString()).toBe('-2.50');
    expect(negative.isNegative()).toBe(true);
    expect(zero.toString()).toBe('0.00');
    expect(zero.isNegative()).toBe(false);
  });

  it('compara valores da mesma moeda', () => {
    const lower = Money.from({ amount: '1.00', currency: 'BRL' });
    const equal = Money.from({ amount: '1.00', currency: 'BRL' });
    const higher = Money.from({ amount: '2.00', currency: 'BRL' });

    expect(lower.isLessThan(higher)).toBe(true);
    expect(lower.equals(equal)).toBe(true);
    expect(higher.isPositive()).toBe(true);
  });

  it('rejeita qualquer operação binária entre moedas diferentes', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(MoneyCurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(MoneyCurrencyMismatchError);
  });

  it('rejeita overflow produzido por uma operação', () => {
    const maximum = Money.from({
      amount: '999999999999999999.99',
      currency: 'BRL',
    });
    const cent = Money.from({ amount: '0.01', currency: 'BRL' });

    expect(() => maximum.add(cent)).toThrow(MoneyAmountOutOfRangeError);
  });
});
