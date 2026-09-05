import type { MoneyProps } from '../../domain/value-objects/money.js';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId?: string;
  externalTransactionId?: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  status: string;
  money: MoneyProps;
  balance: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  createdAt: string;
  processedAt?: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** storedBalance - calculatedBalance; pode ser negativa. */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export abstract class WalletReadRepository {
  public abstract wallet(walletId: string): Promise<WalletView | null>;
  public abstract ledger(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<LedgerPage | null>;
  public abstract transaction(
    identity:
      { id: string } | { providerId: string; externalTransactionId: string },
  ): Promise<TransactionView | null>;
  public abstract reconcile(
    walletId: string,
  ): Promise<ReconciliationView | null>;
}

export abstract class ReconciliationObserver {
  public abstract checked(
    result: ReconciliationView,
    correlationId: string,
  ): void;
}

export class QueryResourceNotFoundError extends Error {
  public constructor(
    public readonly code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND',
  ) {
    super('Recurso não encontrado.');
  }
}

export class InvalidLedgerCursorError extends Error {
  public readonly code = 'INVALID_LEDGER_CURSOR';
  public constructor() {
    super('Cursor de ledger inválido para esta wallet.');
  }
}
