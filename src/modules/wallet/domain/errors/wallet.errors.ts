export class InvalidWalletIdentityError extends Error {
  public readonly code = 'INVALID_WALLET_IDENTITY';

  public constructor(field: 'id' | 'playerId') {
    super(`O campo ${field} da wallet não pode ser vazio.`);
  }
}

export class NegativeInitialBalanceError extends Error {
  public readonly code = 'NEGATIVE_INITIAL_BALANCE';

  public constructor() {
    super('O saldo inicial da wallet não pode ser negativo.');
  }
}

export class InvalidOpeningTransactionError extends Error {
  public readonly code = 'INVALID_OPENING_TRANSACTION';

  public constructor() {
    super('A transação OPENING exige um valor monetário positivo.');
  }
}

export class InvalidLedgerEntryError extends Error {
  public readonly code = 'INVALID_LEDGER_ENTRY';

  public constructor(reason: string) {
    super(`Lançamento de ledger inválido: ${reason}.`);
  }
}

export class WalletAlreadyExistsError extends Error {
  public readonly code = 'WALLET_ALREADY_EXISTS';

  public constructor() {
    super('Já existe uma wallet para este player e esta moeda.');
  }
}

export class IncompleteWalletOpeningBundleError extends Error {
  public readonly code = 'INCOMPLETE_WALLET_OPENING_BUNDLE';

  public constructor() {
    super(
      'Uma wallet com saldo positivo exige OPENING, ledger e eventos no mesmo pacote atômico.',
    );
  }
}

export class WalletCurrencyMismatchError extends Error {
  public readonly code = 'WALLET_CURRENCY_MISMATCH';

  public constructor(walletCurrency: string, operationCurrency: string) {
    super(
      `A wallet usa ${walletCurrency}, mas a operação usa ${operationCurrency}.`,
    );
  }
}

export class InsufficientWalletFundsError extends Error {
  public readonly code = 'INSUFFICIENT_FUNDS';

  public constructor() {
    super('A wallet não possui saldo suficiente para esta aposta.');
  }
}

export class InvalidWalletDebitError extends Error {
  public readonly code = 'INVALID_WALLET_DEBIT';

  public constructor() {
    super('Um débito da wallet exige valor monetário positivo.');
  }
}

export class InvalidWagerTransactionError extends Error {
  public readonly code = 'INVALID_WAGER_TRANSACTION';

  public constructor(reason: string) {
    super(`Transação de aposta inválida: ${reason}.`);
  }
}

export class InvalidTransactionStateError extends Error {
  public readonly code = 'INVALID_TRANSACTION_STATE';

  public constructor() {
    super('Uma transação terminal não pode mudar de estado.');
  }
}

export class WalletNotFoundError extends Error {
  public readonly code = 'WALLET_NOT_FOUND';

  public constructor() {
    super('A wallet informada não foi encontrada.');
  }
}

export class WalletPlayerMismatchError extends Error {
  public readonly code = 'WALLET_PLAYER_MISMATCH';

  public constructor() {
    super('A wallet não pertence ao player informado.');
  }
}

export class IdempotencyConflictError extends Error {
  public readonly code = 'IDEMPOTENCY_CONFLICT';

  public constructor() {
    super('A chave de idempotência já foi usada com outro payload.');
  }
}

export class ExternalTransactionConflictError extends Error {
  public readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';

  public constructor() {
    super('A transação externa já foi registrada com outra identidade.');
  }
}
