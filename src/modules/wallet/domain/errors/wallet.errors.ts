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
