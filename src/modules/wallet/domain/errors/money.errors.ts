export class InvalidMoneyAmountError extends Error {
  public readonly code = 'INVALID_MONEY_AMOUNT';

  public constructor() {
    super(
      'O valor monetário deve ser uma string decimal canônica, não negativa e com exatamente duas casas decimais.',
    );
  }
}

export class InvalidCurrencyError extends Error {
  public readonly code = 'INVALID_CURRENCY';

  public constructor() {
    super('A moeda deve usar o formato ISO-4217 com três letras maiúsculas.');
  }
}

export class MoneyCurrencyMismatchError extends Error {
  public readonly code = 'MONEY_CURRENCY_MISMATCH';

  public constructor(leftCurrency: string, rightCurrency: string) {
    super(
      `Não é possível operar valores em moedas diferentes: ${leftCurrency} e ${rightCurrency}.`,
    );
  }
}

export class MoneyAmountOutOfRangeError extends Error {
  public readonly code = 'MONEY_AMOUNT_OUT_OF_RANGE';

  public constructor() {
    super('O valor monetário excede a precisão máxima de NUMERIC(20, 2).');
  }
}
