import { Decimal } from 'decimal.js';

import {
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  MoneyAmountOutOfRangeError,
  MoneyCurrencyMismatchError,
} from '../errors/money.errors.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

const CANONICAL_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,17})\.\d{2}$/;
const SUPPORTED_CURRENCIES = new Set(['BRL', 'USD', 'EUR']);
const MAXIMUM_ABSOLUTE_AMOUNT = new MoneyDecimal('999999999999999999.99');

/**
 * Valor monetário imutável e independente de framework.
 *
 * Entradas públicas são positivas ou zero e usam a mesma precisão planejada
 * para NUMERIC(20, 2). Operações internas podem produzir valores negativos.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  public static from(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);

    if (!CANONICAL_AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyAmountError();
    }

    return Money.fromResult(new MoneyDecimal(props.amount), props.currency);
  }

  public static zero(currency: string): Money {
    Money.assertValidCurrency(currency);

    return new Money(new MoneyDecimal('0.00'), currency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromResult(this.value.plus(other.value), this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromResult(this.value.minus(other.value), this.currency);
  }

  public negate(): Money {
    return Money.fromResult(this.value.negated(), this.currency);
  }

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  public isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  public equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  public toString(): string {
    return this.value.isZero() ? '0.00' : this.value.toFixed(2);
  }

  private static fromResult(value: Decimal, currency: string): Money {
    if (value.decimalPlaces() > 2) {
      throw new InvalidMoneyAmountError();
    }

    if (value.abs().greaterThan(MAXIMUM_ABSOLUTE_AMOUNT)) {
      throw new MoneyAmountOutOfRangeError();
    }

    const normalizedValue = value.isZero() ? new MoneyDecimal('0.00') : value;

    return new Money(normalizedValue, currency);
  }

  private static assertValidCurrency(currency: string): void {
    if (!SUPPORTED_CURRENCIES.has(currency)) {
      throw new InvalidCurrencyError();
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, other.currency);
    }
  }
}
